package analytics

import (
	"context"
	"database/sql"
	"time"
)

// Read-side queries powering the admin dashboard. All of them
// hit the rolled-up tables (analytics_minute_views, analytics_
// daily_breakdown, analytics_daily_totals, analytics_visitor_days)
// — never analytics_events_raw, which is allowed to be empty
// between rollup runs. The one exception is ActiveVisitors, which
// reads analytics_events_raw so the "users in the last few minutes"
// tile is real-time.
//
// Every aggregate row carries two pairs of counts: total (humans
// + bots) and human-only. The dashboard defaults to human-only;
// the operator can flip to "all" to inspect bot traffic. Queries
// return both pairs and let the caller pick.

// DayPoint is the daily KPI source. Returned by GetOverview.
type DayPoint struct {
	Day           time.Time `json:"day"`
	Views         int64     `json:"views"`
	HumanViews    int64     `json:"human_views"`
	Visitors      int64     `json:"visitors"`
	HumanVisitors int64     `json:"human_visitors"`
}

// Overview is the chronological per-day series.
type Overview struct {
	Days []DayPoint `json:"days"`
}

func GetOverview(ctx context.Context, db *sql.DB, days int) (Overview, error) {
	if days < 1 {
		days = 7
	}
	if days > 365 {
		days = 365
	}
	rows, err := db.QueryContext(ctx, `
SELECT day, views, human_views, visitors, human_visitors
FROM analytics_daily_totals
WHERE day >= UTC_DATE() - INTERVAL ? DAY
ORDER BY day ASC
`, days)
	if err != nil {
		return Overview{}, err
	}
	defer rows.Close()
	// Initialize Days as an empty slice so a no-data response
	// JSON-serialises as `[]`, not `null`. The dashboard guards
	// for null too, but defaulting here keeps the wire shape
	// honest for any other future consumer.
	out := Overview{Days: []DayPoint{}}
	for rows.Next() {
		var p DayPoint
		if err := rows.Scan(&p.Day, &p.Views, &p.HumanViews, &p.Visitors, &p.HumanVisitors); err != nil {
			return Overview{}, err
		}
		out.Days = append(out.Days, p)
	}
	return out, rows.Err()
}

// MinutePoint is one 5-minute bucket summed across all paths.
type MinutePoint struct {
	Bucket        time.Time `json:"bucket"`
	Views         int64     `json:"views"`
	HumanViews    int64     `json:"human_views"`
	Visitors      int64     `json:"visitors"`
	HumanVisitors int64     `json:"human_visitors"`
}

// MinuteSeries is the time-series data backing the live chart.
type MinuteSeries struct {
	Buckets []MinutePoint `json:"buckets"`
}

func GetMinutely(ctx context.Context, db *sql.DB, since time.Time) (MinuteSeries, error) {
	rows, err := db.QueryContext(ctx, `
SELECT bucket,
       SUM(views)          AS views,
       SUM(human_views)    AS human_views,
       SUM(visitors)       AS visitors,
       SUM(human_visitors) AS human_visitors
FROM analytics_minute_views
WHERE bucket >= ?
GROUP BY bucket
ORDER BY bucket ASC
`, since.UTC())
	if err != nil {
		return MinuteSeries{}, err
	}
	defer rows.Close()
	out := MinuteSeries{Buckets: []MinutePoint{}}
	for rows.Next() {
		var p MinutePoint
		if err := rows.Scan(&p.Bucket, &p.Views, &p.HumanViews, &p.Visitors, &p.HumanVisitors); err != nil {
			return MinuteSeries{}, err
		}
		out.Buckets = append(out.Buckets, p)
	}
	return out, rows.Err()
}

// BreakdownItem is one row in a "top X" table.
type BreakdownItem struct {
	Value         string `json:"value"`
	Views         int64  `json:"views"`
	HumanViews    int64  `json:"human_views"`
	Visitors      int64  `json:"visitors"`
	HumanVisitors int64  `json:"human_visitors"`
}

// Breakdown is the unified shape for every "top X" panel.
type Breakdown struct {
	Items []BreakdownItem `json:"items"`
}

// GetBreakdown returns the top `limit` (default 10) values for
// the given dimension over the last `days` days. Empty values
// are kept so the dashboard can render "(direct)" / "(unknown)".
// Sort order is human_views DESC — the dashboard's primary lens.
func GetBreakdown(ctx context.Context, db *sql.DB, kind string, days, limit int) (Breakdown, error) {
	if days < 1 {
		days = 7
	}
	if limit < 1 {
		limit = 10
	}
	rows, err := db.QueryContext(ctx, `
SELECT value,
       SUM(views)          AS views,
       SUM(human_views)    AS human_views,
       SUM(visitors)       AS visitors,
       SUM(human_visitors) AS human_visitors
FROM analytics_daily_breakdown
WHERE kind = ? AND day >= UTC_DATE() - INTERVAL ? DAY
GROUP BY value
ORDER BY human_views DESC, views DESC
LIMIT ?
`, kind, days, limit)
	if err != nil {
		return Breakdown{}, err
	}
	defer rows.Close()
	out := Breakdown{Items: []BreakdownItem{}}
	for rows.Next() {
		var it BreakdownItem
		if err := rows.Scan(&it.Value, &it.Views, &it.HumanViews, &it.Visitors, &it.HumanVisitors); err != nil {
			return Breakdown{}, err
		}
		out.Items = append(out.Items, it)
	}
	return out, rows.Err()
}

// ActiveSnapshot is the live tile + leaderboard. Reads the raw
// table so it sees data within the rollup latency.
type ActiveSnapshot struct {
	WindowMinutes  int          `json:"window_minutes"`
	ActiveHumans   int64        `json:"active_humans"`
	ActiveBots     int64        `json:"active_bots"`
	RecentViews    int64        `json:"recent_views"`
	HumanViews     int64        `json:"human_views"`
	ActivePages    []ActiveItem `json:"active_pages"`
}

type ActiveItem struct {
	Path     string `json:"path"`
	Views    int64  `json:"views"`
	Visitors int64  `json:"visitors"`
}

// FreshTotals are window totals computed by combining the
// rolled-up daily totals (which are accurate but stale by up to
// the rollup interval) with the live raw-events count (which
// covers everything that hasn't been aggregated yet). The two
// time ranges don't overlap because the rollup deletes raw events
// as it writes them into aggregates, so summing them is safe.
type FreshTotals struct {
	Days          int   `json:"days"`
	Views         int64 `json:"views"`
	HumanViews    int64 `json:"human_views"`
	Visitors      int64 `json:"visitors"`
	HumanVisitors int64 `json:"human_visitors"`
}

// GetFreshTotals returns up-to-the-second window totals. Hits
// two indexes (analytics_daily_totals.day and analytics_events_raw.
// occurred_at) so it's cheap enough to be polled at the dashboard's
// 15 s cadence even on a busy site.
func GetFreshTotals(ctx context.Context, db *sql.DB, days int) (FreshTotals, error) {
	if days < 1 {
		days = 7
	}
	if days > 365 {
		days = 365
	}
	out := FreshTotals{Days: days}

	// Rolled-up portion: every day in the window that's already
	// been aggregated. The rollup writes today's row on every pass,
	// so this includes everything older than ~10 minutes ago.
	var rolledV, rolledHV, rolledVis, rolledHVis int64
	if err := db.QueryRowContext(ctx, `
SELECT
  COALESCE(SUM(views), 0),
  COALESCE(SUM(human_views), 0),
  COALESCE(SUM(visitors), 0),
  COALESCE(SUM(human_visitors), 0)
FROM analytics_daily_totals
WHERE day >= UTC_DATE() - INTERVAL ? DAY
`, days-1).Scan(&rolledV, &rolledHV, &rolledVis, &rolledHVis); err != nil {
		return out, err
	}

	// Live portion: every raw event currently in the table. These
	// rows haven't been rolled up yet — by definition, since the
	// rollup deletes them as it processes them. Counting them all
	// (rather than filtering by `occurred_at >= window_start`)
	// is correct because raw retention is bounded at ~10 minutes;
	// nothing in the table predates the window for any
	// realistic `days` value.
	var liveV, liveHV, liveVis, liveHVis int64
	if err := db.QueryRowContext(ctx, `
SELECT
  COUNT(*),
  COALESCE(SUM(CASE WHEN is_bot = FALSE THEN 1 ELSE 0 END), 0),
  COUNT(DISTINCT visitor_hash),
  COUNT(DISTINCT CASE WHEN is_bot = FALSE THEN visitor_hash END)
FROM analytics_events_raw
`).Scan(&liveV, &liveHV, &liveVis, &liveHVis); err != nil {
		return out, err
	}

	out.Views = rolledV + liveV
	out.HumanViews = rolledHV + liveHV
	out.Visitors = rolledVis + liveVis
	out.HumanVisitors = rolledHVis + liveHVis
	return out, nil
}

// CityPoint is one geocoded marker on the live map. Lat/lon
// come from GeoLite2's city centroid (~50 km accuracy).
type CityPoint struct {
	Country  string  `json:"country"`
	Region   string  `json:"region"`
	City     string  `json:"city"`
	Lat      float64 `json:"lat"`
	Lon      float64 `json:"lon"`
	Views    int64   `json:"views"`
	Visitors int64   `json:"visitors"`
}

// GetActiveCities returns geocoded markers for the last `window`
// of human traffic. Reads analytics_events_raw so it surfaces
// fresh-within-a-buffer-flush data. Bots are excluded — the map
// is meant for "who is on the site right now," not "what scrapers
// are crawling us".
//
// Buckets are keyed by rounded (lat, lon) so multiple visitors
// in the same neighbourhood show up as a single hotter dot rather
// than a thicket of tiny ones.
func GetActiveCities(ctx context.Context, db *sql.DB, window time.Duration, limit int) ([]CityPoint, error) {
	if window <= 0 {
		window = 5 * time.Minute
	}
	if limit < 1 {
		limit = 200
	}
	since := time.Now().UTC().Add(-window)
	rows, err := db.QueryContext(ctx, `
SELECT
  COALESCE(country, '')             AS country,
  COALESCE(region, '')              AS region,
  COALESCE(city, '')                AS city,
  ROUND(lat, 1)                     AS lat_b,
  ROUND(lon, 1)                     AS lon_b,
  COUNT(*)                          AS views,
  COUNT(DISTINCT visitor_hash)      AS visitors
FROM analytics_events_raw
WHERE occurred_at >= ?
  AND lat IS NOT NULL AND lon IS NOT NULL
  AND is_bot = FALSE
GROUP BY country, region, city, lat_b, lon_b
ORDER BY views DESC, visitors DESC
LIMIT ?
`, since, limit)
	if err != nil {
		return []CityPoint{}, err
	}
	defer rows.Close()
	out := []CityPoint{}
	for rows.Next() {
		var c CityPoint
		if err := rows.Scan(&c.Country, &c.Region, &c.City, &c.Lat, &c.Lon, &c.Views, &c.Visitors); err != nil {
			return out, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// GetActive snapshots the activity in the last `window`. Defaults
// to 5 minutes. Numbers cover both humans and bots as labelled.
func GetActive(ctx context.Context, db *sql.DB, window time.Duration, limit int) (ActiveSnapshot, error) {
	if window <= 0 {
		window = 5 * time.Minute
	}
	if limit < 1 {
		limit = 8
	}
	since := time.Now().UTC().Add(-window)

	out := ActiveSnapshot{
		WindowMinutes: int(window / time.Minute),
		ActivePages:   []ActiveItem{},
	}
	row := db.QueryRowContext(ctx, `
SELECT
  COUNT(DISTINCT CASE WHEN is_bot = FALSE THEN visitor_hash END) AS humans,
  COUNT(DISTINCT CASE WHEN is_bot = TRUE  THEN visitor_hash END) AS bots,
  COUNT(*)                                                       AS recent_views,
  SUM(CASE WHEN is_bot = FALSE THEN 1 ELSE 0 END)                AS human_views
FROM analytics_events_raw
WHERE occurred_at >= ?
`, since)
	var humanViews sql.NullInt64
	if err := row.Scan(&out.ActiveHumans, &out.ActiveBots, &out.RecentViews, &humanViews); err != nil {
		return out, err
	}
	if humanViews.Valid {
		out.HumanViews = humanViews.Int64
	}

	rows, err := db.QueryContext(ctx, `
SELECT path,
       COUNT(*)                     AS views,
       COUNT(DISTINCT visitor_hash) AS visitors
FROM analytics_events_raw
WHERE occurred_at >= ? AND is_bot = FALSE
GROUP BY path
ORDER BY views DESC
LIMIT ?
`, since, limit)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	for rows.Next() {
		var it ActiveItem
		if err := rows.Scan(&it.Path, &it.Views, &it.Visitors); err != nil {
			return out, err
		}
		out.ActivePages = append(out.ActivePages, it)
	}
	return out, rows.Err()
}
