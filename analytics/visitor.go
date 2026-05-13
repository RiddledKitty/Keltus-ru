// Package analytics owns the self-hosted page-view counter:
// privacy-respecting ingest, batched writes, periodic rollup,
// and the read-side aggregations the admin dashboard hits.
//
// Why custom rather than Plausible/Umami/etc.: the deployment
// already has a Go server, MariaDB, and a GeoLite2 database on
// disk; adding a fourth service for a 200-line aggregator is
// not worth the operational tax. The dashboard surface is small
// and the privacy posture (per docs/feedback_privacy_first.md)
// is non-negotiable, so a from-scratch implementation gives
// tighter control than wrapping an off-the-shelf tool.
package analytics

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"errors"
	"fmt"
	"net"
	"strings"
	"sync"
	"time"
)

// SaltCache caches the day's salt in process memory. The salt
// rotates every 24 h and is forgotten from the DB after 7 d
// (see rollup.go). The cache is a simple struct guarded by
// its own mutex; misses go to the DB and double-write defends
// against a race where two goroutines both miss for the same
// day (the second INSERT IGNORE no-ops).
type SaltCache struct {
	db *sql.DB

	mu      sync.RWMutex
	currDay time.Time // truncated to a UTC date, midnight
	curr    [32]byte
}

func NewSaltCache(db *sql.DB) *SaltCache { return &SaltCache{db: db} }

// Today returns today's salt, generating one if absent. The
// argument is dependency-injected for tests; pass time.Now().UTC().
func (s *SaltCache) Today(ctx context.Context, now time.Time) ([32]byte, error) {
	day := utcDay(now)

	s.mu.RLock()
	if s.currDay.Equal(day) {
		v := s.curr
		s.mu.RUnlock()
		return v, nil
	}
	s.mu.RUnlock()

	s.mu.Lock()
	defer s.mu.Unlock()
	// Double-check under write lock — another goroutine may have raced us.
	if s.currDay.Equal(day) {
		return s.curr, nil
	}

	salt, err := loadOrCreateSalt(ctx, s.db, day)
	if err != nil {
		return [32]byte{}, err
	}
	s.currDay = day
	s.curr = salt
	return salt, nil
}

func loadOrCreateSalt(ctx context.Context, db *sql.DB, day time.Time) ([32]byte, error) {
	var salt [32]byte
	row := db.QueryRowContext(ctx, `SELECT salt FROM analytics_salts WHERE day = ?`, day)
	var b []byte
	switch err := row.Scan(&b); {
	case err == nil:
		if len(b) != 32 {
			return salt, fmt.Errorf("analytics_salts.salt: want 32 bytes, got %d", len(b))
		}
		copy(salt[:], b)
		return salt, nil
	case errors.Is(err, sql.ErrNoRows):
		// fall through to insert
	default:
		return salt, err
	}

	if _, err := rand.Read(salt[:]); err != nil {
		return salt, err
	}
	// INSERT IGNORE: another node (or another goroutine) may have raced.
	if _, err := db.ExecContext(ctx,
		`INSERT IGNORE INTO analytics_salts (day, salt) VALUES (?, ?)`,
		day, salt[:],
	); err != nil {
		return salt, err
	}
	// Re-read in case IGNORE collapsed the insert.
	row = db.QueryRowContext(ctx, `SELECT salt FROM analytics_salts WHERE day = ?`, day)
	var b2 []byte
	if err := row.Scan(&b2); err != nil {
		return salt, err
	}
	if len(b2) != 32 {
		return salt, fmt.Errorf("analytics_salts.salt re-read: want 32 bytes, got %d", len(b2))
	}
	copy(salt[:], b2)
	return salt, nil
}

// VisitorHash returns SHA-256(ip || 0x00 || user-agent || 0x00 || salt).
// The 0x00 separators stop two distinct (ip, ua) pairs from
// collapsing to the same input string. The IP is canonicalised
// via net.ParseIP.String() so v4-in-v6 / IPv6-with-zone variants
// all hash to the same value.
func VisitorHash(ip, userAgent string, salt [32]byte) [32]byte {
	canonical := canonicalIP(ip)
	h := sha256.New()
	h.Write([]byte(canonical))
	h.Write([]byte{0})
	h.Write([]byte(userAgent))
	h.Write([]byte{0})
	h.Write(salt[:])
	var out [32]byte
	copy(out[:], h.Sum(nil))
	return out
}

func canonicalIP(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return ""
	}
	// Strip a trailing :port if present (X-Forwarded-For lists never have one,
	// but RemoteAddr does).
	if i := strings.LastIndex(s, ":"); i >= 0 && strings.Count(s, ":") == 1 {
		s = s[:i]
	}
	if ip := net.ParseIP(s); ip != nil {
		return ip.String()
	}
	return s
}

func utcDay(t time.Time) time.Time {
	t = t.UTC()
	return time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, time.UTC)
}
