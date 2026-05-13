package analytics

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"sort"
	"strings"
	"sync/atomic"
	"time"
)

// AffiliateImpressionEvent is one captured affiliate-frame impression
// — i.e. a pageview that rendered a particular AffiliateBox slug. The
// static site posts a {path, slugs[]} body per pageview; the handler
// expands that into one event per unique slug on the page and submits
// here.
type AffiliateImpressionEvent struct {
	OccurredAt  time.Time
	VisitorHash [32]byte
	Slug        string
	Path        string
	IsBot       bool
}

// AffiliateBuffer parallels Buffer (pageview events) but for affiliate
// impressions. Same bounded-channel + flusher-goroutine pattern;
// separate buffer because the two streams have different schemas and
// pushing them through one channel would force a runtime type
// discriminator on every write.
type AffiliateBuffer struct {
	db    *sql.DB
	in    chan AffiliateImpressionEvent
	flush time.Duration

	dropped uint64 // atomic
}

func NewAffiliateBuffer(db *sql.DB) *AffiliateBuffer {
	return &AffiliateBuffer{
		db: db,
		// Smaller cap than the pageview buffer. Impressions only fire
		// on pages that actually rendered an affiliate frame, and the
		// volume tracks pageviews 1:1 with at most a few slugs per
		// page, so a 2k cap soaks up bursts without holding a lot of
		// memory.
		in:    make(chan AffiliateImpressionEvent, 2048),
		flush: 2 * time.Second,
	}
}

// Submit is non-blocking; drops on full. Impression counts are
// best-effort like pageviews.
func (b *AffiliateBuffer) Submit(ev AffiliateImpressionEvent) {
	if b == nil {
		return
	}
	select {
	case b.in <- ev:
	default:
		atomic.AddUint64(&b.dropped, 1)
	}
}

func (b *AffiliateBuffer) Dropped() uint64 {
	if b == nil {
		return 0
	}
	return atomic.LoadUint64(&b.dropped)
}

// Run drains into MariaDB until ctx is done. Same shape as Buffer.Run.
func (b *AffiliateBuffer) Run(ctx context.Context) {
	const batchSize = 256
	batch := make([]AffiliateImpressionEvent, 0, batchSize)
	ticker := time.NewTicker(b.flush)
	defer ticker.Stop()

	flush := func(reason string) {
		if len(batch) == 0 {
			return
		}
		if err := b.write(ctx, batch); err != nil {
			slog.Warn("affiliate impression flush failed", "reason", reason, "n", len(batch), "err", err.Error())
		} else {
			slog.Debug("affiliate impression flush ok", "reason", reason, "n", len(batch))
		}
		batch = batch[:0]
	}

	for {
		select {
		case <-ctx.Done():
			flush("shutdown")
			return
		case ev := <-b.in:
			batch = append(batch, ev)
			if len(batch) >= batchSize {
				flush("full")
			}
		case <-ticker.C:
			flush("tick")
		}
	}
}

func (b *AffiliateBuffer) write(ctx context.Context, batch []AffiliateImpressionEvent) error {
	if len(batch) == 0 {
		return nil
	}
	const cols = 5
	var sb strings.Builder
	sb.WriteString(`INSERT INTO affiliate_impression_raw
	(occurred_at, visitor_hash, slug, path, is_bot) VALUES `)
	args := make([]any, 0, len(batch)*cols)
	for i, ev := range batch {
		if i > 0 {
			sb.WriteByte(',')
		}
		sb.WriteString("(?,?,?,?,?)")
		args = append(args,
			ev.OccurredAt.UTC(),
			ev.VisitorHash[:],
			ev.Slug,
			ev.Path,
			ev.IsBot,
		)
	}
	_, err := b.db.ExecContext(ctx, sb.String(), args...)
	if err != nil && !errors.Is(err, context.Canceled) {
		return err
	}
	return nil
}

// --- Rollup ----------------------------------------------------------------

// rollupAffiliateImpressions reads raw impressions older than `cutoff`
// (a 5-minute boundary, same as pageview rollup), groups them per
// (day, slug), and merges into affiliate_impression_daily with
// human/total + visitor counts. Then deletes the rolled rows.
//
// Idempotent: re-running over the same cutoff yields zero new rows
// because the source raw rows are deleted at the end of each pass.
// If the delete step errors after the upsert, the next pass will
// double-count — same hazard the pageview rollup has and acceptable
// for non-financial telemetry.
func rollupAffiliateImpressions(ctx context.Context, db *sql.DB, cutoff time.Time) error {
	const upsert = `
INSERT INTO affiliate_impression_daily
  (day, slug, impressions, human_impressions, visitors, human_visitors)
SELECT
  DATE(occurred_at)                                                AS day,
  slug,
  COUNT(*)                                                         AS impressions,
  SUM(CASE WHEN is_bot = FALSE THEN 1 ELSE 0 END)                  AS human_impressions,
  COUNT(DISTINCT visitor_hash)                                     AS visitors,
  COUNT(DISTINCT CASE WHEN is_bot = FALSE THEN visitor_hash END)   AS human_visitors
FROM affiliate_impression_raw
WHERE occurred_at < ?
GROUP BY day, slug
ON DUPLICATE KEY UPDATE
  impressions       = impressions       + VALUES(impressions),
  human_impressions = human_impressions + VALUES(human_impressions),
  visitors          = visitors          + VALUES(visitors),
  human_visitors    = human_visitors    + VALUES(human_visitors)
`
	if _, err := db.ExecContext(ctx, upsert, cutoff); err != nil {
		return fmt.Errorf("upsert daily: %w", err)
	}
	if _, err := db.ExecContext(ctx, `DELETE FROM affiliate_impression_raw WHERE occurred_at < ?`, cutoff); err != nil {
		return fmt.Errorf("delete raw: %w", err)
	}
	return nil
}

// --- Clicks: mirror of the impression machinery ----------------------------

// AffiliateClickEvent is one captured click on a /go/<slug>/ redirect.
// The Astro stub fires sendBeacon to /api/analytics/affiliate-click
// before the meta-refresh navigates, so the click is recorded even
// though the user is on their way to the affiliate's destination.
type AffiliateClickEvent struct {
	OccurredAt  time.Time
	VisitorHash [32]byte
	Slug        string
	Referer     string
	IsBot       bool
}

// AffiliateClickBuffer parallels AffiliateBuffer — same bounded-channel
// + flusher pattern, separate buffer because clicks and impressions
// have different schemas and rollup destinations.
type AffiliateClickBuffer struct {
	db    *sql.DB
	in    chan AffiliateClickEvent
	flush time.Duration

	dropped uint64
}

func NewAffiliateClickBuffer(db *sql.DB) *AffiliateClickBuffer {
	return &AffiliateClickBuffer{
		db: db,
		// Smaller cap than impressions because clicks are a fraction of
		// impressions (CTR rarely exceeds a few percent). 1k entries is
		// many seconds of click bursts; over that we drop rather than
		// block the request handler.
		in:    make(chan AffiliateClickEvent, 1024),
		flush: 2 * time.Second,
	}
}

func (b *AffiliateClickBuffer) Submit(ev AffiliateClickEvent) {
	if b == nil {
		return
	}
	select {
	case b.in <- ev:
	default:
		atomic.AddUint64(&b.dropped, 1)
	}
}

func (b *AffiliateClickBuffer) Dropped() uint64 {
	if b == nil {
		return 0
	}
	return atomic.LoadUint64(&b.dropped)
}

func (b *AffiliateClickBuffer) Run(ctx context.Context) {
	const batchSize = 128
	batch := make([]AffiliateClickEvent, 0, batchSize)
	ticker := time.NewTicker(b.flush)
	defer ticker.Stop()

	flush := func(reason string) {
		if len(batch) == 0 {
			return
		}
		if err := b.write(ctx, batch); err != nil {
			slog.Warn("affiliate click flush failed", "reason", reason, "n", len(batch), "err", err.Error())
		} else {
			slog.Debug("affiliate click flush ok", "reason", reason, "n", len(batch))
		}
		batch = batch[:0]
	}

	for {
		select {
		case <-ctx.Done():
			flush("shutdown")
			return
		case ev := <-b.in:
			batch = append(batch, ev)
			if len(batch) >= batchSize {
				flush("full")
			}
		case <-ticker.C:
			flush("tick")
		}
	}
}

func (b *AffiliateClickBuffer) write(ctx context.Context, batch []AffiliateClickEvent) error {
	if len(batch) == 0 {
		return nil
	}
	const cols = 5
	var sb strings.Builder
	sb.WriteString(`INSERT INTO affiliate_click_raw
	(occurred_at, visitor_hash, slug, referer, is_bot) VALUES `)
	args := make([]any, 0, len(batch)*cols)
	for i, ev := range batch {
		if i > 0 {
			sb.WriteByte(',')
		}
		sb.WriteString("(?,?,?,?,?)")
		args = append(args,
			ev.OccurredAt.UTC(),
			ev.VisitorHash[:],
			ev.Slug,
			ev.Referer,
			ev.IsBot,
		)
	}
	_, err := b.db.ExecContext(ctx, sb.String(), args...)
	if err != nil && !errors.Is(err, context.Canceled) {
		return err
	}
	return nil
}

// rollupAffiliateClicks: same shape as the impression rollup. Reads
// raw clicks older than cutoff, groups per (day, slug), upserts into
// affiliate_click_daily, deletes the raw rows.
func rollupAffiliateClicks(ctx context.Context, db *sql.DB, cutoff time.Time) error {
	const upsert = `
INSERT INTO affiliate_click_daily
  (day, slug, clicks, human_clicks, visitors, human_visitors)
SELECT
  DATE(occurred_at)                                                AS day,
  slug,
  COUNT(*)                                                         AS clicks,
  SUM(CASE WHEN is_bot = FALSE THEN 1 ELSE 0 END)                  AS human_clicks,
  COUNT(DISTINCT visitor_hash)                                     AS visitors,
  COUNT(DISTINCT CASE WHEN is_bot = FALSE THEN visitor_hash END)   AS human_visitors
FROM affiliate_click_raw
WHERE occurred_at < ?
GROUP BY day, slug
ON DUPLICATE KEY UPDATE
  clicks         = clicks         + VALUES(clicks),
  human_clicks   = human_clicks   + VALUES(human_clicks),
  visitors       = visitors       + VALUES(visitors),
  human_visitors = human_visitors + VALUES(human_visitors)
`
	if _, err := db.ExecContext(ctx, upsert, cutoff); err != nil {
		return fmt.Errorf("upsert daily: %w", err)
	}
	if _, err := db.ExecContext(ctx, `DELETE FROM affiliate_click_raw WHERE occurred_at < ?`, cutoff); err != nil {
		return fmt.Errorf("delete raw: %w", err)
	}
	return nil
}

// --- Read queries (used by the XLSX dashboard panel) -----------------------

// AffiliateImpressionTotal aggregates the daily table over a date
// range, returning one row per slug. Used by the analytics report.
type AffiliateImpressionTotal struct {
	Slug             string `json:"slug"`
	Impressions      int64  `json:"impressions"`
	HumanImpressions int64  `json:"human_impressions"`
	Visitors         int64  `json:"visitors"`
	HumanVisitors    int64  `json:"human_visitors"`
}

func GetAffiliateImpressionTotals(ctx context.Context, db *sql.DB, from, to time.Time) ([]AffiliateImpressionTotal, error) {
	const q = `
SELECT slug,
       SUM(impressions)       AS impressions,
       SUM(human_impressions) AS human_impressions,
       SUM(visitors)          AS visitors,
       SUM(human_visitors)    AS human_visitors
FROM affiliate_impression_daily
WHERE day BETWEEN ? AND ?
GROUP BY slug
ORDER BY human_impressions DESC, slug ASC
`
	rows, err := db.QueryContext(ctx, q, from.Format("2006-01-02"), to.Format("2006-01-02"))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []AffiliateImpressionTotal
	for rows.Next() {
		var t AffiliateImpressionTotal
		if err := rows.Scan(&t.Slug, &t.Impressions, &t.HumanImpressions, &t.Visitors, &t.HumanVisitors); err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// AffiliatePerformance combines the impression + click counts for the
// period into one row per slug, with CTR computed by the consumer.
// Used by the Affiliates sheet of the XLSX report.
type AffiliatePerformance struct {
	Slug             string  `json:"slug"`
	Impressions      int64   `json:"impressions"`
	HumanImpressions int64   `json:"human_impressions"`
	ImpressionVisitors int64 `json:"impression_visitors"`
	HumanImpressionVisitors int64 `json:"human_impression_visitors"`
	Clicks           int64   `json:"clicks"`
	HumanClicks      int64   `json:"human_clicks"`
	ClickVisitors    int64   `json:"click_visitors"`
	HumanClickVisitors int64 `json:"human_click_visitors"`
}

// CTR returns clicks/impressions (humans only) for the slug, or 0
// when there are no impressions. Lets the renderer present a single
// "click-through rate" cell without doing math in the writer.
func (p AffiliatePerformance) CTR() float64 {
	if p.HumanImpressions <= 0 {
		return 0
	}
	return float64(p.HumanClicks) / float64(p.HumanImpressions)
}

// GetAffiliatePerformance merges per-slug impression and click totals
// for the period. MariaDB has no FULL OUTER JOIN, so we run two
// independent aggregate queries and merge in Go — straightforward and
// no risk of the SUM × LEFT JOIN double-counting bugs you can hit
// trying to coerce both sides into one statement.
func GetAffiliatePerformance(ctx context.Context, db *sql.DB, from, to time.Time) ([]AffiliatePerformance, error) {
	f := from.Format("2006-01-02")
	t := to.Format("2006-01-02")

	bySlug := map[string]*AffiliatePerformance{}
	get := func(slug string) *AffiliatePerformance {
		p, ok := bySlug[slug]
		if !ok {
			p = &AffiliatePerformance{Slug: slug}
			bySlug[slug] = p
		}
		return p
	}

	// Impressions.
	{
		const q = `
SELECT slug,
       SUM(impressions),       SUM(human_impressions),
       SUM(visitors),          SUM(human_visitors)
FROM affiliate_impression_daily
WHERE day BETWEEN ? AND ?
GROUP BY slug
`
		rows, err := db.QueryContext(ctx, q, f, t)
		if err != nil {
			return nil, fmt.Errorf("impressions: %w", err)
		}
		for rows.Next() {
			var slug string
			var imp, himp, vis, hvis int64
			if err := rows.Scan(&slug, &imp, &himp, &vis, &hvis); err != nil {
				rows.Close()
				return nil, err
			}
			p := get(slug)
			p.Impressions = imp
			p.HumanImpressions = himp
			p.ImpressionVisitors = vis
			p.HumanImpressionVisitors = hvis
		}
		rows.Close()
	}

	// Clicks. Same slugs as above + any clicks-only slugs (rare; e.g.
	// legacy bookmarks to /go/<slug>/ from before impression tracking
	// went live) get folded into the map.
	{
		const q = `
SELECT slug,
       SUM(clicks),       SUM(human_clicks),
       SUM(visitors),     SUM(human_visitors)
FROM affiliate_click_daily
WHERE day BETWEEN ? AND ?
GROUP BY slug
`
		rows, err := db.QueryContext(ctx, q, f, t)
		if err != nil {
			return nil, fmt.Errorf("clicks: %w", err)
		}
		for rows.Next() {
			var slug string
			var clk, hclk, vis, hvis int64
			if err := rows.Scan(&slug, &clk, &hclk, &vis, &hvis); err != nil {
				rows.Close()
				return nil, err
			}
			p := get(slug)
			p.Clicks = clk
			p.HumanClicks = hclk
			p.ClickVisitors = vis
			p.HumanClickVisitors = hvis
		}
		rows.Close()
	}

	// Sort: human impressions DESC, then human clicks DESC, then slug.
	out := make([]AffiliatePerformance, 0, len(bySlug))
	for _, p := range bySlug {
		out = append(out, *p)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].HumanImpressions != out[j].HumanImpressions {
			return out[i].HumanImpressions > out[j].HumanImpressions
		}
		if out[i].HumanClicks != out[j].HumanClicks {
			return out[i].HumanClicks > out[j].HumanClicks
		}
		return out[i].Slug < out[j].Slug
	})
	return out, nil
}
