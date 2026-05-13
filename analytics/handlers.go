package analytics

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"math"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Handlers wires the HTTP surface for ingest + read.
type Handlers struct {
	DB                   *sql.DB
	Salts                *SaltCache
	Geo                  *GeoLookup
	Buffer               *Buffer
	AffiliateBuffer      *AffiliateBuffer
	AffiliateClickBuffer *AffiliateClickBuffer
	// OwnHost is the canonical site host (e.g. "keltus.ru"). Used to
	// collapse self-referrals to "(direct)".
	OwnHost string
	// AdminToken, when non-empty, is required as a Bearer header on the
	// /admin/* endpoints. The Directus admin extension sends it.
	AdminToken string
}

// Mux returns an http.ServeMux with all routes installed:
//
//	POST /beacon                       — receives a page-view
//	POST /affiliate-impression         — receives the slugs of affiliate frames on a pageview
//	POST /affiliate-click              — receives a click on a /go/<slug>/ redirect
//	GET  /summary?days=N               — overview + recent minute series
//	GET  /breakdown?kind=X&days=N      — top values for a dimension
//	GET  /active?window=N&days=N       — live tile + fresh totals
//	GET  /cities?window=N              — geocoded city dots for the live map
//	GET  /report?from=YYYY-MM-DD&to=…  — comprehensive XLSX traffic report
//	GET  /healthz                      — liveness check
func (h *Handlers) Mux() *http.ServeMux {
	m := http.NewServeMux()
	m.HandleFunc("POST /beacon", h.beacon)
	m.HandleFunc("POST /affiliate-impression", h.affiliateImpression)
	m.HandleFunc("POST /affiliate-click", h.affiliateClick)
	m.HandleFunc("GET /summary", h.adminAuth(h.summary))
	m.HandleFunc("GET /breakdown", h.adminAuth(h.breakdown))
	m.HandleFunc("GET /active", h.adminAuth(h.active))
	m.HandleFunc("GET /cities", h.adminAuth(h.cities))
	m.HandleFunc("GET /public-map", h.publicMap)
	m.HandleFunc("GET /report", h.adminAuth(h.report))
	m.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"ok":true}`+"\n")
	})
	return m
}

// adminAuth gates a handler behind the AdminToken Bearer if one is set.
// In dev it's empty (we lean on nginx + Directus session cookies for auth);
// in prod set it via the env var.
func (h *Handlers) adminAuth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if h.AdminToken == "" {
			cors(w, r)
			next(w, r)
			return
		}
		got := r.Header.Get("Authorization")
		if !strings.HasPrefix(got, "Bearer ") || got[7:] != h.AdminToken {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		cors(w, r)
		next(w, r)
	}
}

// cors lets the Directus extension call /admin/* from the browser even
// though it's served from /cms/admin/ instead of the bare /admin-analytics/.
// We allow same-origin and the dev origin; tighten when going prod.
func cors(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", r.Header.Get("Origin"))
	w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
	w.Header().Set("Access-Control-Allow-Credentials", "true")
	w.Header().Set("Vary", "Origin")
}

// --- POST /beacon ----------------------------------------------------------

type beaconBody struct {
	Path     string `json:"path"`
	Referrer string `json:"referrer"`
}

// beacon is the inbound page-view endpoint. The static site posts here
// from a tiny inline script. We hash IP+UA+salt, classify the UA, geocode,
// and submit to the buffer. Best-effort: any failure short-circuits silently
// so the browser never sees an error from the beacon.
func (h *Handlers) beacon(w http.ResponseWriter, r *http.Request) {
	defer r.Body.Close()
	var body beaconBody
	if err := json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&body); err != nil {
		// Some browsers send the beacon as a Blob without parsing as JSON;
		// in that case body.Path is empty and we silently drop. Don't 4xx
		// — the beacon is fire-and-forget.
		slog.Debug("beacon: bad json", "err", err.Error())
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if body.Path == "" {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	path := NormalizePath(body.Path)
	if path == "" || !IsTrackable(path) {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	when := time.Now().UTC()
	ua := r.Header.Get("User-Agent")
	ip := ClientIP(r)
	device, browser, os, isBot := ClassifyUA(ua)

	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()

	salt, err := h.Salts.Today(ctx, when)
	if err != nil {
		slog.Warn("beacon: salt", "err", err.Error())
		w.WriteHeader(http.StatusNoContent)
		return
	}
	hash := VisitorHash(ip, ua, salt)
	geo := h.Geo.Lookup(ip)
	host := ReferrerHost(body.Referrer, h.OwnHost)

	h.Buffer.Submit(Event{
		OccurredAt:   when,
		VisitorHash:  hash,
		Path:         path,
		ReferrerHost: host,
		Country:      geo.Country,
		Region:       geo.Region,
		City:         geo.City,
		Lat:          geo.Lat,
		Lon:          geo.Lon,
		HasCoords:    geo.HasCoords,
		Device:       device,
		Browser:      browser,
		OS:           os,
		IsBot:        isBot,
	})
	w.WriteHeader(http.StatusNoContent)
}

// --- POST /affiliate-impression --------------------------------------------

type affiliateImpressionBody struct {
	Path  string   `json:"path"`
	Slugs []string `json:"slugs"`
}

// Reasonable upper bounds to avoid garbage payloads ballooning the
// raw table. A page never legitimately renders more than a handful
// of affiliate frames; we cap at 16 to be safe.
const (
	maxImpressionSlugs    = 16
	maxImpressionSlugLen  = 128
	maxImpressionBodySize = 4096
)

// affiliateImpression receives the slugs of AffiliateBox frames that
// were visible on a pageview. The static site's BaseLayout enumerates
// [data-affiliate-slug] attributes in the rendered DOM and posts them
// here once per page-load (incl. SPA transitions). One row per (slug,
// visitor) lands in affiliate_impression_raw; the rollup folds them
// into a per-(day, slug) daily aggregate.
//
// Same privacy posture as /beacon: we hash IP+UA+daily-salt and drop
// the rest. No path-level personalization is recorded beyond the
// path string (which is the page being viewed, e.g. /shows/foo/).
func (h *Handlers) affiliateImpression(w http.ResponseWriter, r *http.Request) {
	defer r.Body.Close()
	var body affiliateImpressionBody
	if err := json.NewDecoder(io.LimitReader(r.Body, maxImpressionBodySize)).Decode(&body); err != nil {
		slog.Debug("affiliate-impression: bad json", "err", err.Error())
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if len(body.Slugs) == 0 {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if len(body.Slugs) > maxImpressionSlugs {
		body.Slugs = body.Slugs[:maxImpressionSlugs]
	}

	path := NormalizePath(body.Path)
	// IsTrackable filters out /api, /cms, /img etc. — same set the page-
	// view beacon skips. We also skip when path is empty (some browsers
	// send the beacon mid-navigation).
	if path == "" || !IsTrackable(path) {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	when := time.Now().UTC()
	ua := r.Header.Get("User-Agent")
	ip := ClientIP(r)
	_, _, _, isBot := ClassifyUA(ua)

	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()

	salt, err := h.Salts.Today(ctx, when)
	if err != nil {
		slog.Warn("affiliate-impression: salt", "err", err.Error())
		w.WriteHeader(http.StatusNoContent)
		return
	}
	hash := VisitorHash(ip, ua, salt)

	// Deduplicate within this single payload — the client already
	// dedupes, but a defensive check costs nothing and protects against
	// future-client changes that forget to.
	seen := make(map[string]bool, len(body.Slugs))
	for _, slug := range body.Slugs {
		slug = strings.TrimSpace(slug)
		if slug == "" || len(slug) > maxImpressionSlugLen || seen[slug] {
			continue
		}
		seen[slug] = true
		h.AffiliateBuffer.Submit(AffiliateImpressionEvent{
			OccurredAt:  when,
			VisitorHash: hash,
			Slug:        slug,
			Path:        path,
			IsBot:       isBot,
		})
	}
	w.WriteHeader(http.StatusNoContent)
}

// --- POST /affiliate-click -------------------------------------------------

type affiliateClickBody struct {
	Slug string `json:"slug"`
}

const maxClickBodySize = 512

// affiliateClick receives a single click on a /go/<slug>/ redirect. The
// Astro stub posts here via navigator.sendBeacon BEFORE the meta-
// refresh fires, so the click is recorded even though the user is on
// their way to the affiliate's destination.
//
// Privacy posture matches /beacon: hash(IP, UA, daily-salt) is the
// only visitor identifier stored. Referer is taken from the HTTP
// header (set by the originating page), not from the body, so a
// malicious caller can't spoof it.
func (h *Handlers) affiliateClick(w http.ResponseWriter, r *http.Request) {
	defer r.Body.Close()
	var body affiliateClickBody
	if err := json.NewDecoder(io.LimitReader(r.Body, maxClickBodySize)).Decode(&body); err != nil {
		slog.Debug("affiliate-click: bad json", "err", err.Error())
		w.WriteHeader(http.StatusNoContent)
		return
	}
	slug := strings.TrimSpace(body.Slug)
	if slug == "" || len(slug) > maxImpressionSlugLen {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	when := time.Now().UTC()
	ua := r.Header.Get("User-Agent")
	ip := ClientIP(r)
	_, _, _, isBot := ClassifyUA(ua)

	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()

	salt, err := h.Salts.Today(ctx, when)
	if err != nil {
		slog.Warn("affiliate-click: salt", "err", err.Error())
		w.WriteHeader(http.StatusNoContent)
		return
	}
	hash := VisitorHash(ip, ua, salt)

	// Capture the referer so we can later answer "which show drove the
	// most clicks on miles-franklin?" — header-derived, not body-
	// supplied. ReferrerHost would collapse it; we keep the full
	// referer here because click sources are usually internal paths
	// and the path component carries the signal.
	referer := r.Header.Get("Referer")
	if len(referer) > 255 {
		referer = referer[:255]
	}

	h.AffiliateClickBuffer.Submit(AffiliateClickEvent{
		OccurredAt:  when,
		VisitorHash: hash,
		Slug:        slug,
		Referer:     referer,
		IsBot:       isBot,
	})
	w.WriteHeader(http.StatusNoContent)
}

// ClientIP picks the client IP from X-Forwarded-For / X-Real-IP / RemoteAddr.
// Trust the proxy headers because nginx sits in front in production.
func ClientIP(r *http.Request) string {
	if v := r.Header.Get("X-Forwarded-For"); v != "" {
		if i := strings.IndexByte(v, ','); i >= 0 {
			v = v[:i]
		}
		return strings.TrimSpace(v)
	}
	if v := r.Header.Get("X-Real-IP"); v != "" {
		return strings.TrimSpace(v)
	}
	return r.RemoteAddr
}

// --- GET /summary?days=N ---------------------------------------------------

type summaryResp struct {
	Days     int           `json:"days"`
	Overview Overview      `json:"overview"`
	Minute   MinuteSeries  `json:"minute"`
	Active   ActiveSnapshot `json:"active"`
	Totals   FreshTotals    `json:"totals"`
}

func (h *Handlers) summary(w http.ResponseWriter, r *http.Request) {
	days := intParam(r, "days", 7, 1, 365)
	overview, err := GetOverview(r.Context(), h.DB, days)
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	// Minute series: cap the window at the rolled-up table's retention (14 d).
	// The chart shows 5-min buckets across whatever range the dashboard has
	// selected, falling back to the daily series for the 30/90-day views.
	minuteDays := days
	if minuteDays > 14 {
		minuteDays = 14
	}
	since := time.Now().UTC().Add(-time.Duration(minuteDays) * 24 * time.Hour)
	minute, err := GetMinutely(r.Context(), h.DB, since)
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	active, err := GetActive(r.Context(), h.DB, 5*time.Minute, 8)
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	totals, err := GetFreshTotals(r.Context(), h.DB, days)
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	writeJSON(w, summaryResp{Days: days, Overview: overview, Minute: minute, Active: active, Totals: totals})
}

// --- GET /breakdown?kind=X&days=N&limit=N ----------------------------------

func (h *Handlers) breakdown(w http.ResponseWriter, r *http.Request) {
	kind := r.URL.Query().Get("kind")
	if kind == "" {
		http.Error(w, "missing kind", 400)
		return
	}
	days := intParam(r, "days", 7, 1, 365)
	limit := intParam(r, "limit", 10, 1, 100)
	bd, err := GetBreakdown(r.Context(), h.DB, kind, days, limit)
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	writeJSON(w, bd)
}

// --- GET /active?window=N&days=N -------------------------------------------

type activeResp struct {
	Active ActiveSnapshot `json:"active"`
	Totals FreshTotals    `json:"totals"`
}

func (h *Handlers) active(w http.ResponseWriter, r *http.Request) {
	windowMin := intParam(r, "window", 5, 1, 60)
	days := intParam(r, "days", 7, 1, 365)
	active, err := GetActive(r.Context(), h.DB, time.Duration(windowMin)*time.Minute, 8)
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	totals, err := GetFreshTotals(r.Context(), h.DB, days)
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	writeJSON(w, activeResp{Active: active, Totals: totals})
}

// --- GET /cities?window=N (minutes) ---------------------------------------

type citiesResp struct {
	WindowMinutes int         `json:"window_minutes"`
	Cities        []CityPoint `json:"cities"`
}

func (h *Handlers) cities(w http.ResponseWriter, r *http.Request) {
	// window is in minutes; allow up to 30 days (43200 min)
	windowMin := intParam(r, "window", 5, 1, 60*24*30)
	cities, err := GetActiveCities(r.Context(), h.DB, time.Duration(windowMin)*time.Minute, 500)
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	writeJSON(w, citiesResp{WindowMinutes: windowMin, Cities: cities})
}

// --- GET /public-map?window=N (minutes) -----------------------------------
//
// Public, unauthenticated city-points endpoint for the visitor map on the
// marketing site. Window capped at 60 min, results coarse-binned to 1°
// (~110 km) and city/region fields stripped so the response can't be used
// to single anyone out. Cached in-process for 5 s to absorb a thundering
// herd of polling clients without slamming the DB.
type publicMapPoint struct {
	Country string  `json:"country"`
	Lat     float64 `json:"lat"`
	Lon     float64 `json:"lon"`
	Hits    int64   `json:"hits"`
}
type publicMapResp struct {
	WindowMinutes int              `json:"window_minutes"`
	Points        []publicMapPoint `json:"points"`
}

var (
	publicMapMu       sync.Mutex
	publicMapCache    publicMapResp
	publicMapCacheAt  time.Time
	publicMapCacheKey int
)

func (h *Handlers) publicMap(w http.ResponseWriter, r *http.Request) {
	windowMin := intParam(r, "window", 30, 1, 60) // public cap: 60 min
	publicMapMu.Lock()
	fresh := time.Since(publicMapCacheAt) < 5*time.Second && publicMapCacheKey == windowMin
	if fresh {
		resp := publicMapCache
		publicMapMu.Unlock()
		w.Header().Set("Cache-Control", "public, max-age=5")
		writeJSON(w, resp)
		return
	}
	publicMapMu.Unlock()

	cities, err := GetActiveCities(r.Context(), h.DB, time.Duration(windowMin)*time.Minute, 200)
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	// Re-bin to coarser 1° buckets and drop city/region for privacy.
	type key struct {
		Country string
		Lat     float64
		Lon     float64
	}
	bucket := make(map[key]int64)
	for _, c := range cities {
		k := key{
			Country: c.Country,
			Lat:     math.Round(c.Lat),
			Lon:     math.Round(c.Lon),
		}
		bucket[k] += c.Views
	}
	out := make([]publicMapPoint, 0, len(bucket))
	for k, hits := range bucket {
		out = append(out, publicMapPoint{Country: k.Country, Lat: k.Lat, Lon: k.Lon, Hits: hits})
	}
	resp := publicMapResp{WindowMinutes: windowMin, Points: out}

	publicMapMu.Lock()
	publicMapCache = resp
	publicMapCacheAt = time.Now()
	publicMapCacheKey = windowMin
	publicMapMu.Unlock()

	w.Header().Set("Cache-Control", "public, max-age=5")
	writeJSON(w, resp)
}

// --- GET /report?from=YYYY-MM-DD&to=YYYY-MM-DD -----------------------------

// report streams an XLSX workbook with comprehensive traffic data for the
// requested period. The default is the last 30 complete days (yesterday-
// inclusive), capped at one year to keep the workbook reasonable.
func (h *Handlers) report(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	today := time.Now().UTC().Truncate(24 * time.Hour)
	defaultTo := today.AddDate(0, 0, -1) // yesterday — today's row is incomplete
	defaultFrom := defaultTo.AddDate(0, 0, -29)

	from, err := parseDay(q.Get("from"), defaultFrom)
	if err != nil {
		http.Error(w, "bad 'from' (expected YYYY-MM-DD)", 400)
		return
	}
	to, err := parseDay(q.Get("to"), defaultTo)
	if err != nil {
		http.Error(w, "bad 'to' (expected YYYY-MM-DD)", 400)
		return
	}
	if to.Before(from) {
		from, to = to, from
	}
	// Clamp the range. A year of daily rows is ~366 rows × a few breakdown
	// queries — comfortably small.
	if to.Sub(from) > 366*24*time.Hour {
		from = to.AddDate(-1, 0, 0)
	}

	siteName := h.OwnHost
	if v := q.Get("site"); v != "" {
		siteName = v
	}

	period := ReportPeriod{From: from, To: to}
	filename := fmt.Sprintf("traffic-report_%s_to_%s.xlsx", from.Format("2006-01-02"), to.Format("2006-01-02"))

	w.Header().Set("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
	w.Header().Set("Content-Disposition", `attachment; filename="`+filename+`"`)
	w.Header().Set("Cache-Control", "no-store")

	if err := GenerateReport(r.Context(), h.DB, period, siteName, w); err != nil {
		slog.Error("report generation", "err", err.Error())
		// At this point we may have already started streaming, so we can't
		// switch to a 500. Fail loudly in the log; the client gets a partial
		// or zero-byte download.
		return
	}
}

func parseDay(s string, dflt time.Time) (time.Time, error) {
	if s == "" {
		return dflt, nil
	}
	t, err := time.ParseInLocation("2006-01-02", s, time.UTC)
	if err != nil {
		return time.Time{}, err
	}
	return t, nil
}

// --- helpers ---------------------------------------------------------------

func intParam(r *http.Request, key string, dflt, lo, hi int) int {
	v := r.URL.Query().Get(key)
	if v == "" {
		return dflt
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return dflt
	}
	if n < lo {
		return lo
	}
	if n > hi {
		return hi
	}
	return n
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(v)
}
