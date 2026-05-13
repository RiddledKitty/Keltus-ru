package analytics

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"time"
)

// Retention windows + cadence. Defaults; the operator could
// override later via env vars but the values below are sensible
// for a small site.
const (
	saltRetention         = 7 * 24 * time.Hour  // analytics_salts
	rawRollupSafetyMargin = 30 * time.Second    // never aggregate the live bucket
	visitorDaysRetention  = 35 * 24 * time.Hour // analytics_visitor_days
	minuteViewsRetention  = 14 * 24 * time.Hour // 5-minute buckets
	rawEventsRetention    = 30 * 24 * time.Hour // analytics_events_raw — kept for the live map
	rollupInterval        = 10 * time.Minute    // user spec — rollup cadence
	bucketSize            = 5 * time.Minute     // 5-minute aggregation buckets
)

// StartRollup launches the rollup goroutine. Cancelable via ctx.
// errs receives non-fatal errors (logging hook) — same shape as
// chat.StartSweeper and push.StartDeviceGC.
func StartRollup(ctx context.Context, db *sql.DB, errs func(error)) {
	if errs == nil {
		errs = func(err error) { slog.Warn("analytics rollup", "err", err.Error()) }
	}

	// Run once shortly after boot so dev clicks show up in the
	// dashboard within a couple of minutes, then settle into the
	// configured cadence.
	t := time.NewTimer(30 * time.Second)
	defer t.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		if err := RollupOnce(ctx, db, time.Now().UTC()); err != nil {
			errs(err)
		}
		t.Reset(rollupInterval)
	}
}

// RollupOnce runs the full aggregation pipeline a single time.
// Exposed for tests and an admin "Rollup now" button.
//
// Pipeline:
//
//   1. cutoff = now - 30 s, floored to a 5-minute boundary. Only
//      raw events strictly before this cutoff are eligible — we
//      never aggregate the in-progress bucket because a later
//      pass would otherwise double-count visitors that span the
//      cut.
//
//   2. Aggregate raw → analytics_minute_views (per (bucket, path))
//      with human / total split.
//   3. Aggregate raw → analytics_daily_breakdown (per dimension).
//   4. Insert distinct (day, visitor_hash) into analytics_visitor_days
//      for human traffic only — bots get filtered out so the
//      daily-uniques number is human-only by construction.
//   5. Recompute analytics_daily_totals from analytics_daily_
//      breakdown's path rows + analytics_visitor_days. We re-derive
//      from aggregates rather than from raw because raw will be
//      gone by the next pass.
//   6. Delete raw events strictly before the cutoff.
//   7. Prune retention: salts > 7 d, visitor_days > 35 d,
//      minute_views > 14 d.
//
// All steps are idempotent. Step 6 bounds the table size; the
// rest preserve the numbers it discards.
func RollupOnce(ctx context.Context, db *sql.DB, now time.Time) error {
	cutoff := floorToBucket(now.UTC().Add(-rawRollupSafetyMargin), bucketSize)

	if err := rollupMinute(ctx, db, cutoff); err != nil {
		return fmt.Errorf("minute: %w", err)
	}
	touchedDays, err := rollupDailyBreakdown(ctx, db, cutoff)
	if err != nil {
		return fmt.Errorf("daily breakdown: %w", err)
	}
	if err := rollupVisitorDays(ctx, db, cutoff); err != nil {
		return fmt.Errorf("visitor days: %w", err)
	}
	if err := recomputeDailyTotals(ctx, db, touchedDays); err != nil {
		return fmt.Errorf("daily totals: %w", err)
	}
	if err := markRolled(ctx, db, cutoff, now); err != nil {
		return fmt.Errorf("mark rolled: %w", err)
	}
	// Affiliate impressions: aggregate raw → daily and drop the raw
	// rows in the same step. No live-map equivalent for impressions
	// means no need to retain raw beyond rollup.
	if err := rollupAffiliateImpressions(ctx, db, cutoff); err != nil {
		return fmt.Errorf("affiliate impressions: %w", err)
	}
	// Same shape for affiliate clicks. The raw click table holds the
	// referer header for a future "which show drove the most clicks"
	// report; we'll preserve it once that report exists.
	if err := rollupAffiliateClicks(ctx, db, cutoff); err != nil {
		return fmt.Errorf("affiliate clicks: %w", err)
	}
	if err := pruneRetention(ctx, db, now); err != nil {
		return fmt.Errorf("prune retention: %w", err)
	}
	return nil
}

func rollupMinute(ctx context.Context, db *sql.DB, cutoff time.Time) error {
	// Bucket = occurred_at floored to 5-minute boundary, computed
	// in MariaDB so the rollup is server-time-zone-independent.
	// The CASE expressions split human/bot counts inline.
	const q = `
INSERT INTO analytics_minute_views (bucket, path, views, human_views, visitors, human_visitors)
SELECT
  FROM_UNIXTIME(FLOOR(UNIX_TIMESTAMP(occurred_at) / 300) * 300)         AS bucket,
  path,
  COUNT(*)                                                              AS views,
  SUM(CASE WHEN is_bot = FALSE THEN 1 ELSE 0 END)                       AS human_views,
  COUNT(DISTINCT visitor_hash)                                          AS visitors,
  COUNT(DISTINCT CASE WHEN is_bot = FALSE THEN visitor_hash END)        AS human_visitors
FROM analytics_events_raw
WHERE occurred_at < ? AND rolled_up_at IS NULL
GROUP BY bucket, path
ON DUPLICATE KEY UPDATE
  views          = views          + VALUES(views),
  human_views    = human_views    + VALUES(human_views),
  visitors       = visitors       + VALUES(visitors),
  human_visitors = human_visitors + VALUES(human_visitors)
`
	_, err := db.ExecContext(ctx, q, cutoff)
	return err
}

// rollupDailyBreakdown emits one row per (day, dimension_kind, value)
// with COUNT(*) and COUNT(DISTINCT visitor_hash), split human/total.
// Returns the days touched so the totals recompute knows what to
// refresh.
func rollupDailyBreakdown(ctx context.Context, db *sql.DB, cutoff time.Time) ([]time.Time, error) {
	dimensions := []struct {
		kind string
		expr string // SELECT expression for the dimension value
	}{
		{"path", "path"},
		{"country", "country"},
		{"region", "CONCAT_WS(', ', NULLIF(region, ''), NULLIF(country, ''))"},
		{"device", "device_class"},
		{"browser", "browser"},
		{"os", "os"},
		{"referrer", "referrer_host"},
	}

	for _, d := range dimensions {
		q := fmt.Sprintf(`
INSERT INTO analytics_daily_breakdown (day, kind, value, views, human_views, visitors, human_visitors)
SELECT
  DATE(occurred_at)                                                    AS day,
  ?                                                                    AS kind,
  COALESCE(%s, '')                                                     AS value,
  COUNT(*)                                                             AS views,
  SUM(CASE WHEN is_bot = FALSE THEN 1 ELSE 0 END)                      AS human_views,
  COUNT(DISTINCT visitor_hash)                                         AS visitors,
  COUNT(DISTINCT CASE WHEN is_bot = FALSE THEN visitor_hash END)       AS human_visitors
FROM analytics_events_raw
WHERE occurred_at < ? AND rolled_up_at IS NULL
GROUP BY day, value
ON DUPLICATE KEY UPDATE
  views          = views          + VALUES(views),
  human_views    = human_views    + VALUES(human_views),
  visitors       = visitors       + VALUES(visitors),
  human_visitors = human_visitors + VALUES(human_visitors)
`, d.expr)
		if _, err := db.ExecContext(ctx, q, d.kind, cutoff); err != nil {
			return nil, fmt.Errorf("kind=%s: %w", d.kind, err)
		}
	}

	rows, err := db.QueryContext(ctx, `
SELECT DISTINCT DATE(occurred_at) FROM analytics_events_raw WHERE occurred_at < ? AND rolled_up_at IS NULL`, cutoff)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var days []time.Time
	for rows.Next() {
		var d time.Time
		if err := rows.Scan(&d); err != nil {
			return nil, err
		}
		days = append(days, d)
	}
	return days, rows.Err()
}

func rollupVisitorDays(ctx context.Context, db *sql.DB, cutoff time.Time) error {
	const q = `
INSERT IGNORE INTO analytics_visitor_days (day, visitor_hash)
SELECT DISTINCT DATE(occurred_at), visitor_hash
FROM analytics_events_raw
WHERE occurred_at < ? AND is_bot = FALSE AND rolled_up_at IS NULL
`
	_, err := db.ExecContext(ctx, q, cutoff)
	return err
}

func recomputeDailyTotals(ctx context.Context, db *sql.DB, days []time.Time) error {
	if len(days) == 0 {
		return nil
	}
	for _, d := range days {
		// views (total + human) come from the path breakdown SUM.
		// visitors (human-only) come from analytics_visitor_days.
		// The "all visitors" daily figure is approximated as "humans + bot views"
		// — bots tend to rotate UAs, so a bot distinct-count is meaningless;
		// using the bot view count instead is the honest signal.
		const q = `
INSERT INTO analytics_daily_totals (day, views, human_views, visitors, human_visitors) VALUES (
  ?,
  COALESCE((SELECT SUM(views)       FROM analytics_daily_breakdown WHERE day = ? AND kind = 'path'), 0),
  COALESCE((SELECT SUM(human_views) FROM analytics_daily_breakdown WHERE day = ? AND kind = 'path'), 0),
  COALESCE((SELECT COUNT(*)         FROM analytics_visitor_days     WHERE day = ?), 0),
  COALESCE((SELECT COUNT(*)         FROM analytics_visitor_days     WHERE day = ?), 0)
) ON DUPLICATE KEY UPDATE
  views          = VALUES(views),
  human_views    = VALUES(human_views),
  visitors       = VALUES(visitors),
  human_visitors = VALUES(human_visitors)
`
		if _, err := db.ExecContext(ctx, q, d, d, d, d, d); err != nil {
			return err
		}
	}
	return nil
}

// markRolled tags raw events that have been aggregated into the rollup tables
// so the next pass doesn't double-count them. We keep the rows on disk (up to
// rawEventsRetention) so the live-map endpoint can serve any window from 5 min
// to 30 days against real city-level data.
func markRolled(ctx context.Context, db *sql.DB, cutoff time.Time, now time.Time) error {
	_, err := db.ExecContext(ctx,
		`UPDATE analytics_events_raw SET rolled_up_at = ? WHERE occurred_at < ? AND rolled_up_at IS NULL`,
		now.UTC(), cutoff,
	)
	return err
}

// purgeRawRetention drops raw events older than rawEventsRetention. Called
// from pruneRetention; bounded so the table doesn't grow indefinitely.
func purgeRawRetention(ctx context.Context, db *sql.DB, now time.Time) error {
	cutoff := now.Add(-rawEventsRetention)
	_, err := db.ExecContext(ctx, `DELETE FROM analytics_events_raw WHERE occurred_at < ?`, cutoff)
	return err
}

func pruneRetention(ctx context.Context, db *sql.DB, now time.Time) error {
	if _, err := db.ExecContext(ctx,
		`DELETE FROM analytics_salts WHERE day < ?`,
		utcDay(now.Add(-saltRetention)),
	); err != nil {
		return err
	}
	if _, err := db.ExecContext(ctx,
		`DELETE FROM analytics_visitor_days WHERE day < ?`,
		utcDay(now.Add(-visitorDaysRetention)),
	); err != nil {
		return err
	}
	if _, err := db.ExecContext(ctx,
		`DELETE FROM analytics_minute_views WHERE bucket < ?`,
		now.Add(-minuteViewsRetention),
	); err != nil {
		return err
	}
	if err := purgeRawRetention(ctx, db, now); err != nil {
		return err
	}
	return nil
}

// floorToBucket rounds t down to the nearest multiple of bucket
// (in UTC seconds since epoch). Used so a 5-minute bucket boundary
// is the same regardless of process start time.
func floorToBucket(t time.Time, bucket time.Duration) time.Time {
	return t.UTC().Truncate(bucket)
}

// silence unused-import linter in build flavors that strip errors
var _ = errors.Is
