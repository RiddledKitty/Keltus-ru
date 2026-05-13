package analytics

import (
	"context"
	"database/sql"
	"fmt"
	"io"
	"sort"
	"strings"
	"time"

	"github.com/xuri/excelize/v2"
)

// Report generation for advertisers / sponsors. Produces a multi-sheet
// Excel workbook with the full set of dimensions we record. All queries
// are over [from, to] inclusive against the rolled-up daily tables —
// no raw events involved, so the report can cover an arbitrary range
// (raw retention is only 30 days; daily aggregates are kept forever).

// ReportPeriod is the inclusive date range the workbook covers.
type ReportPeriod struct {
	From time.Time // start of day, UTC
	To   time.Time // start of day, UTC; included
}

func (p ReportPeriod) Days() int {
	return int(p.To.Sub(p.From).Hours()/24) + 1
}

// dailyTotal is one row from analytics_daily_totals.
type dailyTotal struct {
	Day           time.Time
	Views         int64
	HumanViews    int64
	Visitors      int64
	HumanVisitors int64
}

// breakdownRow is one summed value from analytics_daily_breakdown for
// the given period.
type breakdownRow struct {
	Value         string
	Views         int64
	HumanViews    int64
	Visitors      int64
	HumanVisitors int64
}

// styles bundles re-usable cell formats for the workbook.
type styles struct {
	title    int
	subtitle int
	header   int
	num      int
	pct      int
	dateCell int
}

func mkStyles(f *excelize.File) (styles, error) {
	var s styles
	var err error

	s.title, err = f.NewStyle(&excelize.Style{
		Font:      &excelize.Font{Bold: true, Size: 18, Color: "1F2937"},
		Alignment: &excelize.Alignment{Horizontal: "left", Vertical: "center"},
	})
	if err != nil {
		return s, err
	}
	s.subtitle, err = f.NewStyle(&excelize.Style{
		Font:      &excelize.Font{Size: 11, Color: "6B7280"},
		Alignment: &excelize.Alignment{Horizontal: "left"},
	})
	if err != nil {
		return s, err
	}
	s.header, err = f.NewStyle(&excelize.Style{
		Font:      &excelize.Font{Bold: true, Color: "FFFFFF", Size: 11},
		Fill:      excelize.Fill{Type: "pattern", Color: []string{"1F2937"}, Pattern: 1},
		Alignment: &excelize.Alignment{Horizontal: "left", Vertical: "center"},
		Border: []excelize.Border{
			{Type: "bottom", Color: "111827", Style: 1},
		},
	})
	if err != nil {
		return s, err
	}
	s.num, err = f.NewStyle(&excelize.Style{
		NumFmt:    3, // #,##0
		Alignment: &excelize.Alignment{Horizontal: "right"},
	})
	if err != nil {
		return s, err
	}
	s.pct, err = f.NewStyle(&excelize.Style{
		NumFmt:    10, // 0.00%
		Alignment: &excelize.Alignment{Horizontal: "right"},
	})
	if err != nil {
		return s, err
	}
	s.dateCell, err = f.NewStyle(&excelize.Style{
		NumFmt: 14, // mm-dd-yy
	})
	if err != nil {
		return s, err
	}
	return s, nil
}

// GenerateReport builds the full workbook in memory and writes it to w.
// SiteName is shown on the cover page (e.g. "keltus.ru").
func GenerateReport(ctx context.Context, db *sql.DB, period ReportPeriod, siteName string, w io.Writer) error {
	f := excelize.NewFile()
	defer f.Close()
	// Default sheet is named "Sheet1"; we'll rename it on the way in.

	st, err := mkStyles(f)
	if err != nil {
		return fmt.Errorf("styles: %w", err)
	}

	daily, err := fetchDailyTotals(ctx, db, period)
	if err != nil {
		return fmt.Errorf("daily totals: %w", err)
	}

	// Sheet order. We rename Sheet1 to the first sheet and add the rest.
	type sheetFn func(*excelize.File, styles) error
	sheets := []struct {
		name string
		fn   sheetFn
	}{
		{"Overview", func(f *excelize.File, st styles) error { return writeOverview(f, st, period, siteName, daily) }},
		{"Daily Traffic", func(f *excelize.File, st styles) error { return writeDaily(f, st, daily) }},
		{"Top Pages", func(f *excelize.File, st styles) error {
			rows, err := fetchBreakdown(ctx, db, period, "path", 100)
			if err != nil {
				return err
			}
			return writeBreakdown(f, st, "Top Pages", []string{"Rank", "Path", "Views", "Human Views", "Visitors", "Human Visitors", "% of Views"}, rows, []float64{6, 60, 14, 14, 14, 16, 14}, true)
		}},
		{"Countries", func(f *excelize.File, st styles) error {
			rows, err := fetchBreakdown(ctx, db, period, "country", 250)
			if err != nil {
				return err
			}
			// Country code → name expansion would need a lookup table; ship
			// the ISO-2 codes raw. Most advertisers reading this know them
			// and Excel doesn't care.
			return writeBreakdown(f, st, "Countries", []string{"Rank", "Country", "Views", "Human Views", "Visitors", "Human Visitors", "% of Views"}, rows, []float64{6, 18, 14, 14, 14, 16, 14}, true)
		}},
		{"Regions", func(f *excelize.File, st styles) error {
			rows, err := fetchBreakdown(ctx, db, period, "region", 250)
			if err != nil {
				return err
			}
			return writeBreakdown(f, st, "Regions / States", []string{"Rank", "Region", "Views", "Human Views", "Visitors", "Human Visitors", "% of Views"}, rows, []float64{6, 28, 14, 14, 14, 16, 14}, true)
		}},
		{"Devices", func(f *excelize.File, st styles) error {
			rows, err := fetchBreakdown(ctx, db, period, "device", 50)
			if err != nil {
				return err
			}
			return writeBreakdown(f, st, "Devices", []string{"Rank", "Device", "Views", "Human Views", "Visitors", "Human Visitors", "% of Views"}, rows, []float64{6, 14, 14, 14, 14, 16, 14}, true)
		}},
		{"Browsers", func(f *excelize.File, st styles) error {
			rows, err := fetchBreakdown(ctx, db, period, "browser", 50)
			if err != nil {
				return err
			}
			return writeBreakdown(f, st, "Browsers", []string{"Rank", "Browser", "Views", "Human Views", "Visitors", "Human Visitors", "% of Views"}, rows, []float64{6, 18, 14, 14, 14, 16, 14}, true)
		}},
		{"Operating Systems", func(f *excelize.File, st styles) error {
			rows, err := fetchBreakdown(ctx, db, period, "os", 50)
			if err != nil {
				return err
			}
			return writeBreakdown(f, st, "Operating Systems", []string{"Rank", "OS", "Views", "Human Views", "Visitors", "Human Visitors", "% of Views"}, rows, []float64{6, 18, 14, 14, 14, 16, 14}, true)
		}},
		{"Referrers", func(f *excelize.File, st styles) error {
			rows, err := fetchBreakdown(ctx, db, period, "referrer", 100)
			if err != nil {
				return err
			}
			// Blank referrer → "(direct)" so spreadsheet readers don't think
			// it's a missing row.
			for i := range rows {
				if rows[i].Value == "" {
					rows[i].Value = "(direct)"
				}
			}
			return writeBreakdown(f, st, "Top Referrers", []string{"Rank", "Source", "Views", "Human Views", "Visitors", "Human Visitors", "% of Views"}, rows, []float64{6, 36, 14, 14, 14, 16, 14}, true)
		}},
		{"Day of Week", func(f *excelize.File, st styles) error { return writeDayOfWeek(f, st, daily) }},
		{"Affiliates", func(f *excelize.File, st styles) error {
			rows, err := GetAffiliatePerformance(ctx, db, period.From, period.To)
			if err != nil {
				return err
			}
			return writeAffiliates(f, st, rows)
		}},
	}

	// Rename Sheet1 to the first sheet name; create the remaining sheets.
	if err := f.SetSheetName("Sheet1", sheets[0].name); err != nil {
		return err
	}
	for _, s := range sheets[1:] {
		if _, err := f.NewSheet(s.name); err != nil {
			return err
		}
	}
	for _, s := range sheets {
		if err := s.fn(f, st); err != nil {
			return fmt.Errorf("sheet %q: %w", s.name, err)
		}
	}

	// Make the cover sheet active.
	idx, err := f.GetSheetIndex(sheets[0].name)
	if err == nil {
		f.SetActiveSheet(idx)
	}

	return f.Write(w)
}

// ---- Data fetching -------------------------------------------------------

func fetchDailyTotals(ctx context.Context, db *sql.DB, p ReportPeriod) ([]dailyTotal, error) {
	rows, err := db.QueryContext(ctx, `
SELECT day, views, human_views, visitors, human_visitors
FROM analytics_daily_totals
WHERE day BETWEEN ? AND ?
ORDER BY day ASC
`, p.From.Format("2006-01-02"), p.To.Format("2006-01-02"))
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	byDay := map[string]dailyTotal{}
	for rows.Next() {
		var d dailyTotal
		if err := rows.Scan(&d.Day, &d.Views, &d.HumanViews, &d.Visitors, &d.HumanVisitors); err != nil {
			return nil, err
		}
		byDay[d.Day.Format("2006-01-02")] = d
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	// Densify so missing days show up as zero rows. Advertisers expect
	// a continuous calendar.
	out := make([]dailyTotal, 0, p.Days())
	for d := p.From; !d.After(p.To); d = d.AddDate(0, 0, 1) {
		key := d.Format("2006-01-02")
		if dt, ok := byDay[key]; ok {
			out = append(out, dt)
		} else {
			out = append(out, dailyTotal{Day: d})
		}
	}
	return out, nil
}

func fetchBreakdown(ctx context.Context, db *sql.DB, p ReportPeriod, kind string, limit int) ([]breakdownRow, error) {
	rows, err := db.QueryContext(ctx, `
SELECT value,
       SUM(views)          AS views,
       SUM(human_views)    AS human_views,
       SUM(visitors)       AS visitors,
       SUM(human_visitors) AS human_visitors
FROM analytics_daily_breakdown
WHERE kind = ? AND day BETWEEN ? AND ?
GROUP BY value
ORDER BY human_views DESC, views DESC
LIMIT ?
`, kind, p.From.Format("2006-01-02"), p.To.Format("2006-01-02"), limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []breakdownRow{}
	for rows.Next() {
		var r breakdownRow
		if err := rows.Scan(&r.Value, &r.Views, &r.HumanViews, &r.Visitors, &r.HumanVisitors); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// ---- Sheet writers -------------------------------------------------------

func writeOverview(f *excelize.File, st styles, p ReportPeriod, site string, daily []dailyTotal) error {
	const s = "Overview"

	var totalViews, humanViews, visitors, humanVisitors int64
	var peakDay, quietDay dailyTotal
	hasAny := false
	for _, d := range daily {
		totalViews += d.Views
		humanViews += d.HumanViews
		visitors += d.Visitors
		humanVisitors += d.HumanVisitors
		if !hasAny || d.Views > peakDay.Views {
			peakDay = d
		}
		if !hasAny || d.Views < quietDay.Views {
			quietDay = d
		}
		hasAny = true
	}
	botViews := totalViews - humanViews
	if botViews < 0 {
		botViews = 0
	}
	botPct := 0.0
	if totalViews > 0 {
		botPct = float64(botViews) / float64(totalViews)
	}
	days := p.Days()
	avgViews := 0.0
	avgVisitors := 0.0
	if days > 0 {
		avgViews = float64(totalViews) / float64(days)
		avgVisitors = float64(visitors) / float64(days)
	}

	title := site
	if title == "" {
		title = "Traffic Report"
	} else {
		title = site + " — Traffic Report"
	}

	_ = f.SetCellValue(s, "A1", title)
	_ = f.SetCellStyle(s, "A1", "A1", st.title)
	_ = f.MergeCell(s, "A1", "E1")
	_ = f.SetRowHeight(s, 1, 28)

	periodLine := fmt.Sprintf("Period: %s – %s  (%d day%s)",
		p.From.Format("Mon, Jan 2, 2006"),
		p.To.Format("Mon, Jan 2, 2006"),
		days,
		plural(days),
	)
	_ = f.SetCellValue(s, "A2", periodLine)
	_ = f.SetCellStyle(s, "A2", "A2", st.subtitle)
	_ = f.MergeCell(s, "A2", "E2")

	_ = f.SetCellValue(s, "A3", "Generated: "+time.Now().UTC().Format("2006-01-02 15:04 UTC"))
	_ = f.SetCellStyle(s, "A3", "A3", st.subtitle)
	_ = f.MergeCell(s, "A3", "E3")

	// Section header
	_ = f.SetCellValue(s, "A5", "Summary")
	_ = f.SetCellStyle(s, "A5", "B5", st.header)
	_ = f.SetCellValue(s, "B5", "")
	_ = f.SetRowHeight(s, 5, 22)

	rows := [][]any{
		{"Total page views", totalViews},
		{"Human page views", humanViews},
		{"Bot page views", botViews},
		{"Bot share", botPct},
		{"Unique daily visitors (summed)", visitors},
		{"Human visitors (summed)", humanVisitors},
		{"Average daily page views", avgViews},
		{"Average daily visitors", avgVisitors},
	}
	if hasAny {
		rows = append(rows,
			[]any{"Peak day", peakDay.Day.Format("Mon, Jan 2, 2006") + fmt.Sprintf("  (%s views)", commaInt(peakDay.Views))},
			[]any{"Quietest day", quietDay.Day.Format("Mon, Jan 2, 2006") + fmt.Sprintf("  (%s views)", commaInt(quietDay.Views))},
		)
	}

	startRow := 6
	for i, r := range rows {
		row := startRow + i
		_ = f.SetCellValue(s, fmt.Sprintf("A%d", row), r[0])
		switch v := r[1].(type) {
		case int64:
			_ = f.SetCellInt(s, fmt.Sprintf("B%d", row), v)
			_ = f.SetCellStyle(s, fmt.Sprintf("B%d", row), fmt.Sprintf("B%d", row), st.num)
		case float64:
			if r[0] == "Bot share" {
				_ = f.SetCellFloat(s, fmt.Sprintf("B%d", row), v, 4, 64)
				_ = f.SetCellStyle(s, fmt.Sprintf("B%d", row), fmt.Sprintf("B%d", row), st.pct)
			} else {
				_ = f.SetCellFloat(s, fmt.Sprintf("B%d", row), v, 1, 64)
				_ = f.SetCellStyle(s, fmt.Sprintf("B%d", row), fmt.Sprintf("B%d", row), st.num)
			}
		default:
			_ = f.SetCellValue(s, fmt.Sprintf("B%d", row), v)
		}
	}

	// Notes
	notesRow := startRow + len(rows) + 2
	_ = f.SetCellValue(s, fmt.Sprintf("A%d", notesRow), "Notes")
	_ = f.SetCellStyle(s, fmt.Sprintf("A%d", notesRow), fmt.Sprintf("B%d", notesRow), st.header)
	notes := []string{
		"All times are UTC.",
		"Visitor counts are daily-unique, summed across the period — a person who visits on two different days counts as two visitors.",
		"\"Human\" excludes traffic with bot-like user-agents (search-engine crawlers, monitoring tools, scrapers).",
		"Privacy: no raw IPs are stored. Visitors are identified by a daily-rotated salted hash that ages out after seven days.",
	}
	for i, n := range notes {
		_ = f.SetCellValue(s, fmt.Sprintf("A%d", notesRow+1+i), "•")
		_ = f.SetCellValue(s, fmt.Sprintf("B%d", notesRow+1+i), n)
		_ = f.MergeCell(s, fmt.Sprintf("B%d", notesRow+1+i), fmt.Sprintf("E%d", notesRow+1+i))
	}

	_ = f.SetColWidth(s, "A", "A", 36)
	_ = f.SetColWidth(s, "B", "B", 32)
	_ = f.SetColWidth(s, "C", "E", 18)
	return nil
}

func writeDaily(f *excelize.File, st styles, daily []dailyTotal) error {
	const s = "Daily Traffic"
	headers := []string{"Date", "Day of Week", "Page Views", "Human Views", "Bot Views", "Visitors", "Human Visitors"}
	for i, h := range headers {
		col, _ := excelize.ColumnNumberToName(i + 1)
		_ = f.SetCellValue(s, fmt.Sprintf("%s1", col), h)
	}
	_ = f.SetCellStyle(s, "A1", "G1", st.header)
	_ = f.SetRowHeight(s, 1, 22)

	for i, d := range daily {
		row := i + 2
		bot := d.Views - d.HumanViews
		if bot < 0 {
			bot = 0
		}
		_ = f.SetCellValue(s, fmt.Sprintf("A%d", row), d.Day.Format("2006-01-02"))
		_ = f.SetCellValue(s, fmt.Sprintf("B%d", row), d.Day.Weekday().String())
		_ = f.SetCellInt(s, fmt.Sprintf("C%d", row), d.Views)
		_ = f.SetCellInt(s, fmt.Sprintf("D%d", row), d.HumanViews)
		_ = f.SetCellInt(s, fmt.Sprintf("E%d", row), bot)
		_ = f.SetCellInt(s, fmt.Sprintf("F%d", row), d.Visitors)
		_ = f.SetCellInt(s, fmt.Sprintf("G%d", row), d.HumanVisitors)
	}
	_ = f.SetCellStyle(s, "C2", fmt.Sprintf("G%d", len(daily)+1), st.num)

	_ = f.SetColWidth(s, "A", "A", 14)
	_ = f.SetColWidth(s, "B", "B", 14)
	_ = f.SetColWidth(s, "C", "G", 16)

	// Freeze header row + add filter.
	_ = f.SetPanes(s, &excelize.Panes{
		Freeze:      true,
		Split:       false,
		YSplit:      1,
		TopLeftCell: "A2",
		ActivePane:  "bottomLeft",
	})
	_ = f.AutoFilter(s, fmt.Sprintf("A1:G%d", len(daily)+1), nil)
	return nil
}

func writeBreakdown(f *excelize.File, st styles, sheet string, headers []string, rows []breakdownRow, colWidths []float64, addRank bool) error {
	for i, h := range headers {
		col, _ := excelize.ColumnNumberToName(i + 1)
		_ = f.SetCellValue(sheet, fmt.Sprintf("%s1", col), h)
	}
	lastColIdx := len(headers)
	lastCol, _ := excelize.ColumnNumberToName(lastColIdx)
	_ = f.SetCellStyle(sheet, "A1", fmt.Sprintf("%s1", lastCol), st.header)
	_ = f.SetRowHeight(sheet, 1, 22)

	var totalViews int64
	for _, r := range rows {
		totalViews += r.Views
	}

	for i, r := range rows {
		row := i + 2
		colIdx := 1
		if addRank {
			_ = f.SetCellInt(sheet, fmt.Sprintf("A%d", row), int64(i+1))
			colIdx = 2
		}
		valCol, _ := excelize.ColumnNumberToName(colIdx)
		_ = f.SetCellValue(sheet, fmt.Sprintf("%s%d", valCol, row), valueOrEmpty(r.Value))

		numStart := colIdx + 1
		colName := func(c int) string { n, _ := excelize.ColumnNumberToName(c); return n }
		_ = f.SetCellInt(sheet, fmt.Sprintf("%s%d", colName(numStart), row), r.Views)
		_ = f.SetCellInt(sheet, fmt.Sprintf("%s%d", colName(numStart+1), row), r.HumanViews)
		_ = f.SetCellInt(sheet, fmt.Sprintf("%s%d", colName(numStart+2), row), r.Visitors)
		_ = f.SetCellInt(sheet, fmt.Sprintf("%s%d", colName(numStart+3), row), r.HumanVisitors)

		pct := 0.0
		if totalViews > 0 {
			pct = float64(r.Views) / float64(totalViews)
		}
		pctCol := colName(numStart + 4)
		_ = f.SetCellFloat(sheet, fmt.Sprintf("%s%d", pctCol, row), pct, 4, 64)
	}

	if len(rows) > 0 {
		numFirstCol := "B"
		numLastCol := "F"
		pctCol := "G"
		if addRank {
			numFirstCol = "C"
			numLastCol = "F"
			pctCol = "G"
		}
		_ = f.SetCellStyle(sheet, fmt.Sprintf("%s2", numFirstCol), fmt.Sprintf("%s%d", numLastCol, len(rows)+1), st.num)
		_ = f.SetCellStyle(sheet, fmt.Sprintf("%s2", pctCol), fmt.Sprintf("%s%d", pctCol, len(rows)+1), st.pct)
	}

	for i, w := range colWidths {
		col, _ := excelize.ColumnNumberToName(i + 1)
		_ = f.SetColWidth(sheet, col, col, w)
	}
	_ = f.SetPanes(sheet, &excelize.Panes{
		Freeze:      true,
		Split:       false,
		YSplit:      1,
		TopLeftCell: "A2",
		ActivePane:  "bottomLeft",
	})
	_ = f.AutoFilter(sheet, fmt.Sprintf("A1:%s%d", lastCol, len(rows)+1), nil)
	return nil
}

// writeDayOfWeek aggregates the daily totals by weekday so advertisers can
// see when their audience is most active. Showing both total and average
// (per-occurrence) lets a 4-Sunday month compare cleanly to a 5-Sunday one.
func writeDayOfWeek(f *excelize.File, st styles, daily []dailyTotal) error {
	const s = "Day of Week"

	type wk struct {
		count                          int
		views, human, vis, humanVis    int64
		avgViews, avgHuman, avgVis, av float64
	}
	week := [7]wk{}
	for _, d := range daily {
		w := int(d.Day.Weekday())
		week[w].count++
		week[w].views += d.Views
		week[w].human += d.HumanViews
		week[w].vis += d.Visitors
		week[w].humanVis += d.HumanVisitors
	}
	// Reorder: Monday-first feels more natural to most readers than Sun-first.
	order := []int{1, 2, 3, 4, 5, 6, 0}
	names := []string{"Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"}

	headers := []string{"Day", "Occurrences in Period", "Total Views", "Total Human Views", "Total Visitors", "Avg Views", "Avg Human Views", "Avg Visitors"}
	for i, h := range headers {
		col, _ := excelize.ColumnNumberToName(i + 1)
		_ = f.SetCellValue(s, fmt.Sprintf("%s1", col), h)
	}
	lastCol, _ := excelize.ColumnNumberToName(len(headers))
	_ = f.SetCellStyle(s, "A1", fmt.Sprintf("%s1", lastCol), st.header)
	_ = f.SetRowHeight(s, 1, 22)

	for i, dayIdx := range order {
		row := i + 2
		w := week[dayIdx]
		_ = f.SetCellValue(s, fmt.Sprintf("A%d", row), names[i])
		_ = f.SetCellInt(s, fmt.Sprintf("B%d", row), int64(w.count))
		_ = f.SetCellInt(s, fmt.Sprintf("C%d", row), w.views)
		_ = f.SetCellInt(s, fmt.Sprintf("D%d", row), w.human)
		_ = f.SetCellInt(s, fmt.Sprintf("E%d", row), w.vis)
		denom := w.count
		if denom == 0 {
			denom = 1
		}
		_ = f.SetCellFloat(s, fmt.Sprintf("F%d", row), float64(w.views)/float64(denom), 1, 64)
		_ = f.SetCellFloat(s, fmt.Sprintf("G%d", row), float64(w.human)/float64(denom), 1, 64)
		_ = f.SetCellFloat(s, fmt.Sprintf("H%d", row), float64(w.vis)/float64(denom), 1, 64)
	}
	_ = f.SetCellStyle(s, "B2", fmt.Sprintf("%s8", lastCol), st.num)

	_ = f.SetColWidth(s, "A", "A", 14)
	_ = f.SetColWidth(s, "B", "H", 20)
	return nil
}

// writeAffiliates emits the per-slug performance breakdown for the
// period. One row per slug, ranked by human impressions DESC, with:
//
//	Rank | Slug | Impressions | Human Impressions | Clicks |
//	Human Clicks | CTR (humans) | Imp Visitors | Click Visitors |
//	% of Impressions
//
// CTR is computed humans-only — bot traffic inflates both impressions
// AND clicks but in different ratios, so the human-only ratio is the
// only one that's a meaningful conversion signal for advertisers.
func writeAffiliates(f *excelize.File, st styles, rows []AffiliatePerformance) error {
	const s = "Affiliates"
	headers := []string{
		"Rank", "Affiliate Slug",
		"Impressions", "Human Impressions",
		"Clicks", "Human Clicks",
		"CTR (humans)",
		"Imp Visitors", "Click Visitors",
		"% of Impressions",
	}
	for i, h := range headers {
		col, _ := excelize.ColumnNumberToName(i + 1)
		_ = f.SetCellValue(s, fmt.Sprintf("%s1", col), h)
	}
	lastHeaderCol, _ := excelize.ColumnNumberToName(len(headers))
	_ = f.SetCellStyle(s, "A1", fmt.Sprintf("%s1", lastHeaderCol), st.header)
	_ = f.SetRowHeight(s, 1, 22)

	var total int64
	for _, r := range rows {
		total += r.Impressions
	}

	for i, r := range rows {
		row := i + 2
		_ = f.SetCellInt(s, fmt.Sprintf("A%d", row), int64(i+1))
		_ = f.SetCellValue(s, fmt.Sprintf("B%d", row), valueOrEmpty(r.Slug))
		_ = f.SetCellInt(s, fmt.Sprintf("C%d", row), r.Impressions)
		_ = f.SetCellInt(s, fmt.Sprintf("D%d", row), r.HumanImpressions)
		_ = f.SetCellInt(s, fmt.Sprintf("E%d", row), r.Clicks)
		_ = f.SetCellInt(s, fmt.Sprintf("F%d", row), r.HumanClicks)
		_ = f.SetCellFloat(s, fmt.Sprintf("G%d", row), r.CTR(), 4, 64)
		_ = f.SetCellInt(s, fmt.Sprintf("H%d", row), r.HumanImpressionVisitors)
		_ = f.SetCellInt(s, fmt.Sprintf("I%d", row), r.HumanClickVisitors)
		share := 0.0
		if total > 0 {
			share = float64(r.Impressions) / float64(total)
		}
		_ = f.SetCellFloat(s, fmt.Sprintf("J%d", row), share, 4, 64)
	}

	if len(rows) > 0 {
		// Counts (Impressions, Human Impressions, Clicks, Human Clicks,
		// Imp Visitors, Click Visitors) → number format.
		_ = f.SetCellStyle(s, "C2", fmt.Sprintf("F%d", len(rows)+1), st.num)
		_ = f.SetCellStyle(s, "H2", fmt.Sprintf("I%d", len(rows)+1), st.num)
		// CTR + % share → percent format.
		_ = f.SetCellStyle(s, "G2", fmt.Sprintf("G%d", len(rows)+1), st.pct)
		_ = f.SetCellStyle(s, "J2", fmt.Sprintf("J%d", len(rows)+1), st.pct)
	}

	// Column widths matched to typical content. Slug column is the wide
	// one — affiliate slugs can run 30-40 chars (e.g.
	// "subscribe-to-apple-podcasts"). Header text width drives the
	// numeric columns.
	for i, w := range []float64{6, 36, 14, 18, 12, 14, 14, 14, 16, 18} {
		col, _ := excelize.ColumnNumberToName(i + 1)
		_ = f.SetColWidth(s, col, col, w)
	}
	_ = f.SetPanes(s, &excelize.Panes{
		Freeze:      true,
		Split:       false,
		YSplit:      1,
		TopLeftCell: "A2",
		ActivePane:  "bottomLeft",
	})
	_ = f.AutoFilter(s, fmt.Sprintf("A1:%s%d", lastHeaderCol, len(rows)+1), nil)

	noteRow := len(rows) + 3
	if len(rows) == 0 {
		_ = f.SetCellValue(s, "A2", "No affiliate impressions or clicks recorded for this period.")
		_ = f.MergeCell(s, "A2", fmt.Sprintf("%s2", lastHeaderCol))
		noteRow = 4
	}
	_ = f.SetCellValue(s, fmt.Sprintf("A%d", noteRow), "Notes")
	_ = f.SetCellStyle(s, fmt.Sprintf("A%d", noteRow), fmt.Sprintf("B%d", noteRow), st.header)
	notes := []string{
		"Impressions count each pageview that rendered the affiliate's frame, including SPA navigations and bot-classified hits — humans-only views are the bot-filtered subset.",
		"Clicks count outbound /go/<slug>/ redirects, fired via sendBeacon before the meta-refresh navigates so the click is captured even though the user immediately leaves the page.",
		"CTR is human clicks ÷ human impressions. Bots inflate both numbers but in different ratios, so the humans-only ratio is the meaningful conversion signal.",
		"\"Imp Visitors\" and \"Click Visitors\" are daily-unique humans (salted-hash) summed across the period — a person seeing or clicking on two different days counts twice.",
	}
	for i, n := range notes {
		_ = f.SetCellValue(s, fmt.Sprintf("A%d", noteRow+1+i), "•")
		_ = f.SetCellValue(s, fmt.Sprintf("B%d", noteRow+1+i), n)
		_ = f.MergeCell(s, fmt.Sprintf("B%d", noteRow+1+i), fmt.Sprintf("%s%d", lastHeaderCol, noteRow+1+i))
	}
	return nil
}

// ---- helpers -------------------------------------------------------------

func plural(n int) string {
	if n == 1 {
		return ""
	}
	return "s"
}

func valueOrEmpty(v string) string {
	if v == "" {
		return "(empty)"
	}
	return v
}

func commaInt(n int64) string {
	s := fmt.Sprintf("%d", n)
	if n < 0 {
		return "-" + commaInt(-n)
	}
	if len(s) <= 3 {
		return s
	}
	var b strings.Builder
	pre := len(s) % 3
	if pre > 0 {
		b.WriteString(s[:pre])
		if len(s) > pre {
			b.WriteByte(',')
		}
	}
	for i := pre; i < len(s); i += 3 {
		b.WriteString(s[i : i+3])
		if i+3 < len(s) {
			b.WriteByte(',')
		}
	}
	return b.String()
}

// SortedBreakdownByVisitors lets callers sort by an alternative metric.
// Currently unused but cheap to keep — advertisers occasionally ask
// "what about by visitors not views?".
func SortedBreakdownByVisitors(rows []breakdownRow) []breakdownRow {
	out := make([]breakdownRow, len(rows))
	copy(out, rows)
	sort.Slice(out, func(i, j int) bool { return out[i].Visitors > out[j].Visitors })
	return out
}
