package analytics

import (
	"context"
	"database/sql"
	"errors"
	"log/slog"
	"strings"
	"sync/atomic"
	"time"
)

// Event is one captured page view, ready for insertion. Built
// by the middleware, fanned to the buffer, drained to MariaDB
// in batches.
type Event struct {
	OccurredAt   time.Time
	VisitorHash  [32]byte
	Path         string
	ReferrerHost string
	Country      string
	Region       string
	City         string
	Lat          float64
	Lon          float64
	HasCoords    bool // false → lat/lon written as NULL
	Device       DeviceClass
	Browser      string
	OS           string
	IsBot        bool
}

// Buffer is a bounded channel + flusher goroutine. Sized to
// soak up several seconds of traffic burst; if it fills (caller
// would block) we drop the event rather than slowing the
// request handler. Page-view counts are best-effort.
type Buffer struct {
	db    *sql.DB
	in    chan Event
	flush time.Duration

	dropped uint64 // atomic; inspected by health/metrics later
}

// NewBuffer returns an unstarted buffer with a default capacity
// (4096) and flush interval (2 s) tuned for a single-process
// deployment. Call Run on a goroutine.
func NewBuffer(db *sql.DB) *Buffer {
	return &Buffer{
		db:    db,
		in:    make(chan Event, 4096),
		flush: 2 * time.Second,
	}
}

// Submit hands an event to the buffer. Non-blocking; drops on
// full. Caller must not retain or mutate `ev` after the call.
func (b *Buffer) Submit(ev Event) {
	if b == nil {
		return
	}
	select {
	case b.in <- ev:
	default:
		atomic.AddUint64(&b.dropped, 1)
	}
}

// Dropped reports the number of events dropped due to backpressure
// since process start. Useful for the future ops dashboard / metrics
// endpoint; the analytics admin page doesn't surface it today.
func (b *Buffer) Dropped() uint64 {
	if b == nil {
		return 0
	}
	return atomic.LoadUint64(&b.dropped)
}

// Run drains the buffer into MariaDB until ctx is done. Must be
// called on its own goroutine. Flushes either when batchSize is
// reached or the flush interval elapses with at least one event
// pending — whichever comes first.
func (b *Buffer) Run(ctx context.Context) {
	const batchSize = 256
	batch := make([]Event, 0, batchSize)
	ticker := time.NewTicker(b.flush)
	defer ticker.Stop()

	flush := func(reason string) {
		if len(batch) == 0 {
			return
		}
		if err := b.write(ctx, batch); err != nil {
			// Don't crash on a transient DB hiccup — the events are
			// non-critical telemetry. Log and drop the batch.
			slog.Warn("analytics flush failed", "reason", reason, "n", len(batch), "err", err.Error())
		} else {
			slog.Info("analytics flush ok", "reason", reason, "n", len(batch))
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

// write inserts the batch with a single multi-row VALUES list.
// MariaDB places no hard cap on this beyond max_allowed_packet,
// which is ~16MB by default; 256 events × ~600 bytes each is
// well within budget.
func (b *Buffer) write(ctx context.Context, batch []Event) error {
	if len(batch) == 0 {
		return nil
	}
	// Build a single INSERT ... VALUES (?,?,?,...), (?,?,?,...), ...
	const cols = 13
	var sb strings.Builder
	sb.WriteString(`INSERT INTO analytics_events_raw
	(occurred_at, visitor_hash, path, referrer_host, country, region, city,
	 lat, lon, device_class, browser, os, is_bot) VALUES `)
	args := make([]any, 0, len(batch)*cols)
	for i, ev := range batch {
		if i > 0 {
			sb.WriteByte(',')
		}
		sb.WriteString("(?,?,?,?,?,?,?,?,?,?,?,?,?)")
		// nil for lat/lon when geo lookup didn't produce a coord —
		// the column is NULL, the map filters them out.
		var lat, lon any
		if ev.HasCoords {
			lat, lon = ev.Lat, ev.Lon
		}
		args = append(args,
			ev.OccurredAt.UTC(),
			ev.VisitorHash[:],
			ev.Path,
			ev.ReferrerHost,
			ev.Country,
			ev.Region,
			ev.City,
			lat,
			lon,
			string(ev.Device),
			ev.Browser,
			ev.OS,
			ev.IsBot,
		)
	}
	_, err := b.db.ExecContext(ctx, sb.String(), args...)
	if err != nil && !errors.Is(err, context.Canceled) {
		return err
	}
	return nil
}
