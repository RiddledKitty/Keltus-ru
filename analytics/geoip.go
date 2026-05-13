package analytics

import (
	"net"
	"sync"

	"github.com/oschwald/geoip2-golang"
)

// GeoLookup wraps a MaxMind GeoLite2-City database. The lookup
// is read-only and the underlying maxminddb library is goroutine-
// safe; the wrapper is just a typed bag plus a Close hook.
//
// When DB is nil (operator hasn't set GEO_DB_PATH or the file
// failed to open), Lookup returns zero values — every event
// gets country/region/city = "" and the dashboard shows
// "Unknown" for the geo breakdown.
type GeoLookup struct {
	db *geoip2.Reader
}

// OpenGeoLookup opens the supplied .mmdb file. Empty path
// returns a nil GeoLookup; the caller's Lookup calls become
// silent no-ops.
func OpenGeoLookup(path string) (*GeoLookup, error) {
	if path == "" {
		return nil, nil
	}
	r, err := geoip2.Open(path)
	if err != nil {
		return nil, err
	}
	return &GeoLookup{db: r}, nil
}

// GeoResult is the structured return from a city-level lookup.
// All fields are best-effort and may be empty/zero. The lat/lon
// fields are the city centroid as reported by GeoLite2 (typical
// accuracy ~50 km — fine for "draw a dot here," not fine for
// anything geofence-shaped). HasCoords is true iff the lookup
// returned non-zero coordinates.
type GeoResult struct {
	Country   string
	Region    string
	City      string
	Lat       float64
	Lon       float64
	HasCoords bool
}

// Lookup returns the city-level geocode for an IP. All fields
// are best-effort and may be empty. Concurrency: maxminddb-golang
// is documented as safe for concurrent readers.
func (g *GeoLookup) Lookup(ip string) GeoResult {
	if g == nil || g.db == nil {
		return GeoResult{}
	}
	parsed := net.ParseIP(canonicalIP(ip))
	if parsed == nil {
		return GeoResult{}
	}
	rec, err := g.db.City(parsed)
	if err != nil || rec == nil {
		return GeoResult{}
	}
	out := GeoResult{
		Country: rec.Country.IsoCode,
		City:    rec.City.Names["en"],
	}
	if len(rec.Subdivisions) > 0 {
		out.Region = rec.Subdivisions[0].Names["en"]
	}
	// Latitude/Longitude are float64 zero-valued when missing.
	// (0, 0) is technically a valid coordinate (off the coast of
	// Africa) but it's also the sentinel GeoLite2 returns for
	// "no answer" — exclude it from the map so a misconfigured
	// lookup doesn't paint a dot in the Atlantic.
	if rec.Location.Latitude != 0 || rec.Location.Longitude != 0 {
		out.Lat = rec.Location.Latitude
		out.Lon = rec.Location.Longitude
		out.HasCoords = true
	}
	return out
}

// Close releases the .mmdb file handle. Safe on a nil receiver.
func (g *GeoLookup) Close() error {
	if g == nil || g.db == nil {
		return nil
	}
	return g.db.Close()
}

// guard against accidental import-cycle of sync.Once we don't need
var _ = sync.Once{}
