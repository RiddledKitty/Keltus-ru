-- +goose Up
--
-- Geocode raw analytics events so the admin dashboard can plot
-- live traffic on a world map. GeoLite2-City returns lat/lon for
-- the city centroid (typical accuracy ~50 km — fine for plotting
-- but coarse enough that we're not pinpointing anyone). Columns
-- are nullable: an event geocoded against an empty mmdb leaves
-- lat/lon NULL, and the map filters those out.

ALTER TABLE analytics_events_raw
  ADD COLUMN lat DECIMAL(8,4) NULL AFTER city,
  ADD COLUMN lon DECIMAL(9,4) NULL AFTER lat;

-- +goose Down
ALTER TABLE analytics_events_raw
  DROP COLUMN lon,
  DROP COLUMN lat;
