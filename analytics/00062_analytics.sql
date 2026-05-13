-- +goose Up
--
-- Self-hosted, privacy-respecting page analytics.
--
-- Two-tier storage so the database doesn't bloat:
--
--   1. analytics_events_raw — every page view, kept only until the
--      next rollup run (≤ 10 min). The rollup reads this table once,
--      writes the rolled rows to analytics_minute_views, analytics_
--      daily_breakdown, analytics_daily_totals, and analytics_visitor_
--      days, then deletes the raw rows. The live "active users (last
--      5 min)" tile is the only reason this table exists at all —
--      without that we could write straight to aggregates.
--
--   2. Aggregates — narrow, indexed for the dashboard queries we
--      know we'll run.
--        * analytics_minute_views (5-minute buckets, 14 d retention)
--          drives the live time-series chart.
--        * analytics_daily_breakdown is dimensional (country / device
--          / browser / OS / referrer / path) and kept forever.
--        * analytics_daily_totals is the per-day KPI source, kept
--          forever.
--        * analytics_visitor_days is the per-day distinct-visitor
--          index for the correct daily-uniques number, retained 35 d
--          so the salt-hashed visitor identifier ages out cleanly.
--
-- Privacy posture (per docs/feedback_privacy_first.md):
--
--   * No raw IPs ever land in the database. The Go ingest layer
--     hashes (ip || user-agent || daily salt) → 32 bytes. The salt
--     rotates every 24 h and is forgotten after 7 days, so a recent
--     visitor_hash can't be re-derived from a fresh request, and an
--     older one can't be re-derived at all.
--
--   * Visitor hashes are NOT joined to user_id. We store one
--     dimension-keyed audience tally and that's all. The breakdowns
--     (country, browser, OS, device, referrer) are summed across
--     bucket-level distinct counts — that over-counts a daily unique
--     slightly but never under-counts and never lets the admin pivot
--     a specific user against a specific page.
--
--   * Path is stripped of query string and fragment before storage.
--     The exception is /search where we keep `?q=` because the
--     admin will reasonably want "what are people searching for?".
--
-- Human vs bot:
--
--   The Go ingest layer's ClassifyUA returns a boolean is_bot flag.
--   Every aggregate row carries two pairs of counts: views / visitors
--   (everyone) and human_views / human_visitors (humans only). The
--   admin dashboard defaults to humans but lets the operator flip to
--   the all-traffic view to see scraper noise. visitor_days only
--   indexes humans, so the daily-uniques number on the dashboard is
--   automatically human-only.

CREATE TABLE analytics_salts (
  day        DATE         NOT NULL,
  salt       BINARY(32)   NOT NULL,
  created_at TIMESTAMP(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  PRIMARY KEY (day)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE analytics_events_raw (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  occurred_at   TIMESTAMP(6)    NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  visitor_hash  BINARY(32)      NOT NULL,
  path          VARCHAR(255)    NOT NULL,
  referrer_host VARCHAR(128)    NOT NULL DEFAULT '',
  country       CHAR(2)         NOT NULL DEFAULT '',
  region        VARCHAR(64)     NOT NULL DEFAULT '',
  city          VARCHAR(80)     NOT NULL DEFAULT '',
  device_class  ENUM('desktop','mobile','tablet','bot','other')
                                NOT NULL DEFAULT 'other',
  browser       VARCHAR(32)     NOT NULL DEFAULT '',
  os            VARCHAR(32)     NOT NULL DEFAULT '',
  is_bot        BOOLEAN         NOT NULL DEFAULT FALSE,
  PRIMARY KEY (id),
  KEY analytics_events_raw_occurred_idx (occurred_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 5-minute time-series. PK (bucket, path) so the dashboard's
-- "top live pages" panel can group by path cheaply and the
-- chart's "all paths" view sums by bucket.
CREATE TABLE analytics_minute_views (
  bucket         DATETIME     NOT NULL,                -- floor(occurred_at, 5min) UTC
  path           VARCHAR(255) NOT NULL,
  views          INT UNSIGNED NOT NULL DEFAULT 0,      -- humans + bots
  human_views    INT UNSIGNED NOT NULL DEFAULT 0,
  visitors       INT UNSIGNED NOT NULL DEFAULT 0,      -- distinct hashes within bucket
  human_visitors INT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, path),
  KEY analytics_minute_bucket_idx (bucket)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE analytics_daily_breakdown (
  day            DATE         NOT NULL,
  kind           ENUM('country','region','device','browser','os','referrer','path')
                              NOT NULL,
  value          VARCHAR(255) NOT NULL,
  views          INT UNSIGNED NOT NULL DEFAULT 0,
  human_views    INT UNSIGNED NOT NULL DEFAULT 0,
  visitors       INT UNSIGNED NOT NULL DEFAULT 0,
  human_visitors INT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (day, kind, value),
  KEY analytics_daily_day_idx (day)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE analytics_daily_totals (
  day            DATE         NOT NULL,
  views          INT UNSIGNED NOT NULL DEFAULT 0,
  human_views    INT UNSIGNED NOT NULL DEFAULT 0,
  visitors       INT UNSIGNED NOT NULL DEFAULT 0,
  human_visitors INT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (day)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE analytics_visitor_days (
  day          DATE       NOT NULL,
  visitor_hash BINARY(32) NOT NULL,
  PRIMARY KEY (day, visitor_hash)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- +goose Down
DROP TABLE analytics_visitor_days;
DROP TABLE analytics_daily_totals;
DROP TABLE analytics_daily_breakdown;
DROP TABLE analytics_minute_views;
DROP TABLE analytics_events_raw;
DROP TABLE analytics_salts;
