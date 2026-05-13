-- +goose Up
--
-- Extends analytics_events_raw retention from "purge after each rollup"
-- (~5-10 min) to 30 days so the live map view can show 4h / 24h / 7d / 30d
-- windows. The rollup pipeline now MARKS events as rolled rather than
-- deleting them, and a separate retention step purges events older than 30 d.
--
-- Trade-off: storage. At Sarah's scale (~50-200K page views/month) this is
-- ~3-20 MB extra. The win is a real-time map that doesn't lose history.

ALTER TABLE analytics_events_raw
  ADD COLUMN rolled_up_at DATETIME(6) NULL DEFAULT NULL AFTER occurred_at,
  ADD INDEX analytics_events_raw_rolled_idx (rolled_up_at);

-- +goose Down
ALTER TABLE analytics_events_raw
  DROP INDEX analytics_events_raw_rolled_idx,
  DROP COLUMN rolled_up_at;
