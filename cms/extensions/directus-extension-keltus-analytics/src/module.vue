<template>
  <private-view title="Analytics">
    <template #headline>
      Self-hosted page-view stats — refreshed every {{ refreshSec }}s
    </template>

    <template #actions>
      <div class="sw-an__lens">
        <button
          :class="['sw-an__lens-btn', { active: lens === 'humans' }]"
          @click="lens = 'humans'">Humans</button>
        <button
          :class="['sw-an__lens-btn', { active: lens === 'all' }]"
          @click="lens = 'all'">All</button>
      </div>
      <select v-model="rangeKey" class="range-select">
        <option value="1d">Last 24 h</option>
        <option value="7d">Last 7 days</option>
        <option value="30d">Last 30 days</option>
        <option value="90d">Last 90 days</option>
      </select>
      <button class="reports-btn" @click="reportsOpen = !reportsOpen">
        <v-icon name="description" />
        Reports
      </button>
      <button class="refresh-btn" @click="loadAll" :disabled="loading">
        <v-icon name="refresh" />
        Refresh
      </button>
    </template>

    <div class="sw-an">
      <div v-if="error" class="sw-an__error">
        <strong>Couldn't load analytics:</strong> {{ error }}
      </div>

      <!-- Reports panel — opens from the Reports button in the header.
           Generates an Excel workbook with every dimension we track for
           the chosen date range. Aimed at advertisers / sponsors. -->
      <transition name="sw-rp-slide">
        <div v-if="reportsOpen" class="sw-rp">
          <div class="sw-rp__head">
            <h3 class="sw-rp__title">Generate Analytics Report</h3>
            <button class="sw-rp__close" @click="reportsOpen = false" aria-label="Close">
              <v-icon name="close" />
            </button>
          </div>
          <p class="sw-rp__sub">
            Download a comprehensive Excel workbook with daily traffic, top pages,
            countries, devices, browsers, referrers and more — ready to share with
            advertisers.
          </p>

          <div class="sw-rp__presets">
            <button
              v-for="pre in presets"
              :key="pre.key"
              :class="['sw-rp__preset', { active: activePreset === pre.key }]"
              @click="applyPreset(pre.key)"
            >{{ pre.label }}</button>
          </div>

          <div class="sw-rp__dates">
            <label class="sw-rp__field">
              <span>From</span>
              <input type="date" v-model="reportFrom" :max="reportTo" />
            </label>
            <label class="sw-rp__field">
              <span>To</span>
              <input type="date" v-model="reportTo" :min="reportFrom" :max="yesterdayISO" />
            </label>
            <div class="sw-rp__span">{{ rangeSpanLabel }}</div>
          </div>

          <div v-if="reportError" class="sw-rp__error">{{ reportError }}</div>

          <div class="sw-rp__actions">
            <button class="sw-rp__cancel" @click="reportsOpen = false">Cancel</button>
            <button class="sw-rp__download" @click="downloadReport" :disabled="reportLoading || !canDownload">
              <v-icon v-if="!reportLoading" name="file_download" />
              <v-icon v-else name="hourglass_empty" />
              {{ reportLoading ? 'Generating…' : 'Download Excel' }}
            </button>
          </div>
        </div>
      </transition>

      <!-- KPI cards -->
      <div class="sw-an__kpis">
        <div class="sw-an__kpi">
          <div class="sw-an__kpi-label">Visitors</div>
          <div class="sw-an__kpi-value">{{ fmt(currentVisitors) }}</div>
          <div class="sw-an__kpi-foot">{{ lens === 'humans' ? 'humans only' : 'humans + bots' }}</div>
        </div>
        <div class="sw-an__kpi">
          <div class="sw-an__kpi-label">Page views</div>
          <div class="sw-an__kpi-value">{{ fmt(currentViews) }}</div>
          <div class="sw-an__kpi-foot">over {{ rangeDays }} day{{ rangeDays === 1 ? '' : 's' }}</div>
        </div>
        <div class="sw-an__kpi">
          <div class="sw-an__kpi-label">Bot share</div>
          <div class="sw-an__kpi-value">{{ botPct }}%</div>
          <div class="sw-an__kpi-foot">{{ fmt(botViews) }} bot views</div>
        </div>
        <div class="sw-an__kpi sw-an__kpi--live">
          <div class="sw-an__kpi-label">
            <span class="sw-an__live-dot" /> Live (last 5 min)
          </div>
          <div class="sw-an__kpi-value">{{ fmt(active?.active_humans) }}</div>
          <div class="sw-an__kpi-foot">{{ fmt(active?.recent_views) }} views, {{ fmt(active?.active_bots) }} bots</div>
        </div>
      </div>

      <!-- Active pages live tile -->
      <div class="sw-an__panel">
        <h3 class="sw-an__panel-h">Active pages — last 5 min</h3>
        <table v-if="active?.active_pages?.length" class="sw-an__table">
          <thead>
            <tr><th>Path</th><th class="num">Views</th><th class="num">Visitors</th></tr>
          </thead>
          <tbody>
            <tr v-for="p in active.active_pages" :key="p.path">
              <td><code>{{ p.path }}</code></td>
              <td class="num">{{ fmt(p.views) }}</td>
              <td class="num">{{ fmt(p.visitors) }}</td>
            </tr>
          </tbody>
        </table>
        <div v-else class="sw-an__empty">No active visitors right now.</div>
      </div>

      <!-- World map -->
      <CityMap />

      <!-- Traffic — 5-minute buckets across the selected range (capped at 14 days
           by the rolled-up table's retention; for 30/90-day ranges we still show
           14 d at 5-min resolution since that's where the data lives) -->
      <TimeChart
        :buckets="minute?.buckets ?? []"
        :lens="lens"
        :height="320"
      />

      <!-- Donut row: device, browser, OS -->
      <div class="sw-an__row sw-an__row--three">
        <DonutChart title="Devices" :items="devices" :lens="lens" empty="No device data yet." />
        <DonutChart title="Browsers" :items="browsers" :lens="lens" empty="No browser data yet." />
        <DonutChart title="Operating systems" :items="oses" :lens="lens" empty="No OS data yet." />
      </div>

      <!-- Bar breakdowns: paths, countries, referrers -->
      <div class="sw-an__row">
        <Breakdown title="Top pages" :items="paths" :lens="lens" empty="No pages tracked yet." />
        <Breakdown title="Countries" :items="countries" :lens="lens" empty="No country data yet." />
      </div>
      <div class="sw-an__row">
        <Breakdown title="Referrers" :items="referrers" :lens="lens" empty="No referrers yet — most traffic is direct." direct />
        <div /><!-- spacer to keep two-column grid -->
      </div>

      <p class="sw-an__foot">
        Visitor counts use a daily-rotated salted hash (no raw IPs stored). Aggregates are over the full {{ rangeDays }}-day window.
      </p>
    </div>
  </private-view>
</template>

<script setup lang="ts">
import { computed, defineComponent, h, onMounted, onUnmounted, ref, watch } from 'vue';
import CityMap from './CityMap.vue';
import TimeChart from './TimeChart.vue';
import DonutChart from './DonutChart.vue';

/* ---------- Types ----------------------------------------------------- */
type DayPoint = { day: string; views: number; human_views: number; visitors: number; human_visitors: number };
type Overview = { days: DayPoint[] };
type MinutePoint = { bucket: string; views: number; human_views: number; visitors: number; human_visitors: number };
type ActiveItem = { path: string; views: number; visitors: number };
type ActiveSnapshot = {
  window_minutes: number;
  active_humans: number;
  active_bots: number;
  recent_views: number;
  human_views: number;
  active_pages: ActiveItem[];
};
type FreshTotals = {
  days: number; views: number; human_views: number; visitors: number; human_visitors: number;
};
type BreakdownItem = { value: string; views: number; human_views: number; visitors: number; human_visitors: number };

const RANGE_DAYS: Record<string, number> = { '1d': 1, '7d': 7, '30d': 30, '90d': 90 };
const refreshSec = 30;

const rangeKey = ref<'1d' | '7d' | '30d' | '90d'>('7d');
const rangeDays = computed(() => RANGE_DAYS[rangeKey.value]);

/* lens: 'humans' = humans-only series + counts (default).
         'all'    = humans + bots stacked. */
const lens = ref<'humans' | 'all'>('humans');

const overview = ref<Overview | null>(null);
const minute = ref<{ buckets: MinutePoint[] } | null>(null);
const active = ref<ActiveSnapshot | null>(null);
const totals = ref<FreshTotals | null>(null);
const paths = ref<BreakdownItem[]>([]);
const countries = ref<BreakdownItem[]>([]);
const referrers = ref<BreakdownItem[]>([]);
const devices = ref<BreakdownItem[]>([]);
const browsers = ref<BreakdownItem[]>([]);
const oses = ref<BreakdownItem[]>([]);
const error = ref<string | null>(null);
const loading = ref(false);

let timer: number | null = null;

/* ---------- Reports state -------------------------------------------- */
const reportsOpen = ref(false);
const reportLoading = ref(false);
const reportError = ref<string | null>(null);

function toISO(d: Date): string {
  // Local-day ISO string — the user picks dates in their own calendar,
  // and the server treats them as UTC days. Within a few hours of UTC
  // boundaries this is "close enough" — advertisers won't notice.
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

const today = new Date();
const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
const yesterdayISO = toISO(yesterday);

function presetRange(key: string): { from: string; to: string } {
  const t = new Date(); t.setHours(0, 0, 0, 0);
  const y = new Date(t); y.setDate(t.getDate() - 1);
  const to = toISO(y);
  if (key === 'last7')  { const f = new Date(t); f.setDate(t.getDate() - 7);  return { from: toISO(f), to }; }
  if (key === 'last30') { const f = new Date(t); f.setDate(t.getDate() - 30); return { from: toISO(f), to }; }
  if (key === 'last90') { const f = new Date(t); f.setDate(t.getDate() - 90); return { from: toISO(f), to }; }
  if (key === 'thismonth') {
    const f = new Date(t.getFullYear(), t.getMonth(), 1);
    return { from: toISO(f), to };
  }
  if (key === 'lastmonth') {
    const f = new Date(t.getFullYear(), t.getMonth() - 1, 1);
    const lst = new Date(t.getFullYear(), t.getMonth(), 0);
    return { from: toISO(f), to: toISO(lst) };
  }
  if (key === 'ytd') {
    const f = new Date(t.getFullYear(), 0, 1);
    return { from: toISO(f), to };
  }
  // Default: last 30 days
  const f = new Date(t); f.setDate(t.getDate() - 30); return { from: toISO(f), to };
}

const presets = [
  { key: 'last7',     label: 'Last 7 days' },
  { key: 'last30',    label: 'Last 30 days' },
  { key: 'last90',    label: 'Last 90 days' },
  { key: 'thismonth', label: 'This month' },
  { key: 'lastmonth', label: 'Last month' },
  { key: 'ytd',       label: 'Year to date' },
];

const initial = presetRange('last30');
const reportFrom = ref<string>(initial.from);
const reportTo = ref<string>(initial.to);
const activePreset = ref<string>('last30');

function applyPreset(key: string) {
  const r = presetRange(key);
  reportFrom.value = r.from;
  reportTo.value = r.to;
  activePreset.value = key;
}

// If the user types a custom range, clear the active preset highlight.
watch([reportFrom, reportTo], () => {
  for (const p of presets) {
    const r = presetRange(p.key);
    if (r.from === reportFrom.value && r.to === reportTo.value) {
      activePreset.value = p.key;
      return;
    }
  }
  activePreset.value = 'custom';
});

const canDownload = computed(() => !!reportFrom.value && !!reportTo.value && reportFrom.value <= reportTo.value);
const rangeSpanLabel = computed(() => {
  if (!canDownload.value) return '';
  const a = new Date(reportFrom.value); const b = new Date(reportTo.value);
  const ms = b.getTime() - a.getTime();
  const days = Math.round(ms / 86400000) + 1;
  return `${days} day${days === 1 ? '' : 's'}`;
});

async function downloadReport() {
  if (!canDownload.value) return;
  reportLoading.value = true;
  reportError.value = null;
  try {
    const url = `/api/analytics/report?from=${reportFrom.value}&to=${reportTo.value}`;
    const r = await fetch(url, { method: 'GET', credentials: 'include' });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      throw new Error(body || `HTTP ${r.status}`);
    }
    const blob = await r.blob();
    const filename = `traffic-report_${reportFrom.value}_to_${reportTo.value}.xlsx`;
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  } catch (e: any) {
    reportError.value = e?.message || String(e);
  } finally {
    reportLoading.value = false;
  }
}

async function api<T>(path: string): Promise<T> {
  const r = await fetch(`/api/analytics${path}`, {
    method: 'GET',
    credentials: 'include',
    headers: { 'Accept': 'application/json' },
  });
  if (!r.ok) throw new Error(`${path} → ${r.status}`);
  return await r.json() as T;
}

async function loadAll() {
  loading.value = true;
  error.value = null;
  try {
    const days = rangeDays.value;
    const [s, c, dv, br, o, rf, p] = await Promise.all([
      api<{ days: number; overview: Overview; minute: { buckets: MinutePoint[] }; active: ActiveSnapshot; totals: FreshTotals }>(`/summary?days=${days}`),
      api<{ items: BreakdownItem[] }>(`/breakdown?kind=country&days=${days}&limit=10`),
      api<{ items: BreakdownItem[] }>(`/breakdown?kind=device&days=${days}&limit=10`),
      api<{ items: BreakdownItem[] }>(`/breakdown?kind=browser&days=${days}&limit=10`),
      api<{ items: BreakdownItem[] }>(`/breakdown?kind=os&days=${days}&limit=10`),
      api<{ items: BreakdownItem[] }>(`/breakdown?kind=referrer&days=${days}&limit=10`),
      api<{ items: BreakdownItem[] }>(`/breakdown?kind=path&days=${days}&limit=10`),
    ]);
    overview.value = s.overview;
    minute.value = s.minute;
    active.value = s.active;
    totals.value = s.totals;
    countries.value = c.items;
    devices.value = dv.items;
    browsers.value = br.items;
    oses.value = o.items;
    referrers.value = rf.items;
    paths.value = p.items;
  } catch (e: any) {
    error.value = e?.message || String(e);
  } finally {
    loading.value = false;
  }
}

async function pollActive() {
  try {
    const r = await api<{ active: ActiveSnapshot; totals: FreshTotals }>(`/active?window=5&days=${rangeDays.value}`);
    active.value = r.active;
    totals.value = r.totals;
  } catch (e: any) {
    /* silent */
  }
}

onMounted(() => {
  loadAll();
  timer = window.setInterval(pollActive, refreshSec * 1000);
});
onUnmounted(() => { if (timer) window.clearInterval(timer); });

watch(rangeKey, () => loadAll());

/* ---------- Derived values ------------------------------------------- */
const currentVisitors = computed(() => totals.value
  ? (lens.value === 'humans' ? totals.value.human_visitors : totals.value.visitors)
  : 0);
const currentViews = computed(() => totals.value
  ? (lens.value === 'humans' ? totals.value.human_views : totals.value.views)
  : 0);

const botViews = computed(() => {
  if (!totals.value) return 0;
  return Math.max(0, totals.value.views - totals.value.human_views);
});
const botPct = computed(() => {
  if (!totals.value || totals.value.views === 0) return 0;
  return Math.round((botViews.value / totals.value.views) * 100);
});

function fmt(n: number | undefined | null): string {
  if (n == null) return '–';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return (n / 1000).toFixed(n < 10000 ? 1 : 0) + 'K';
  return (n / 1_000_000).toFixed(1) + 'M';
}

/* ---------- Local Breakdown component (bar-table for high-cardinality dims) -- */
const Breakdown = defineComponent({
  props: {
    title: { type: String, required: true },
    items: { type: Array, required: true },
    lens: { type: String, default: 'humans' },
    empty: { type: String, default: 'No data.' },
    direct: { type: Boolean, default: false },
  },
  setup(props: any) {
    const max = computed(() => {
      const list = (props.items as BreakdownItem[]) || [];
      const accessor = (i: BreakdownItem) => props.lens === 'humans' ? i.human_views : i.views;
      return list.length ? Math.max(...list.map(accessor), 1) : 1;
    });
    return () => h('div', { class: 'sw-an__panel' }, [
      h('h3', { class: 'sw-an__panel-h' }, props.title),
      ((props.items as BreakdownItem[]) || []).length === 0
        ? h('div', { class: 'sw-an__empty' }, props.empty)
        : h('table', { class: 'sw-an__table sw-an__table--bd' }, [
            h('tbody', ((props.items as BreakdownItem[]) || []).map((it: BreakdownItem) => {
              const v = props.lens === 'humans' ? it.human_views : it.views;
              return h('tr', { key: it.value }, [
                h('td', { class: 'sw-an__bd-label' }, [
                  h('span', { class: 'sw-an__bd-name' }, props.direct && it.value === '' ? '(direct)' : (it.value || '(empty)')),
                  h('div', { class: 'sw-an__bd-bar', style: { width: (v / max.value * 100).toFixed(1) + '%' } }),
                ]),
                h('td', { class: 'num sw-an__bd-num' }, fmt(v)),
              ]);
            })),
          ]),
    ]);
  },
});
</script>

<style scoped>
.sw-an { padding: 0 32px 60px; }

.sw-an__lens {
  display: inline-flex;
  background: var(--background-subdued);
  border: 1px solid var(--border-subdued);
  border-radius: 6px;
  padding: 2px;
  margin-right: 8px;
  overflow: hidden;
}
.sw-an__lens-btn {
  background: transparent;
  border: 0;
  padding: 4px 12px;
  font-size: 12px;
  font-weight: 600;
  color: var(--foreground-subdued);
  cursor: pointer;
  border-radius: 4px;
  transition: background 0.15s ease, color 0.15s ease;
}
.sw-an__lens-btn:hover { color: var(--foreground-normal); }
.sw-an__lens-btn.active {
  background: var(--primary);
  color: var(--primary-foreground, white);
}

.range-select {
  background: var(--background-subdued);
  border: 1px solid var(--border-subdued);
  color: var(--foreground-normal);
  padding: 6px 10px;
  border-radius: 6px;
  font-size: 13px;
  margin-right: 8px;
}
.refresh-btn {
  background: var(--primary);
  color: var(--primary-foreground, white);
  border: 0;
  padding: 6px 14px;
  border-radius: 6px;
  font-weight: 600;
  font-size: 13px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.refresh-btn:disabled { opacity: 0.5; cursor: wait; }

.reports-btn {
  background: var(--background-subdued);
  color: var(--foreground-normal);
  border: 1px solid var(--border-subdued);
  padding: 6px 14px;
  border-radius: 6px;
  font-weight: 600;
  font-size: 13px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-right: 8px;
}
.reports-btn:hover {
  background: var(--background-normal);
  border-color: var(--primary);
  color: var(--primary);
}

/* Reports panel */
.sw-rp {
  background: var(--background-subdued);
  border: 1px solid var(--border-subdued);
  border-radius: 8px;
  padding: 24px 28px 20px;
  margin-bottom: 24px;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.08);
}
.sw-rp__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}
.sw-rp__title {
  margin: 0;
  font-size: 18px;
  font-weight: 700;
  color: var(--foreground-normal);
  letter-spacing: -0.2px;
}
.sw-rp__close {
  background: transparent;
  border: 0;
  color: var(--foreground-subdued);
  cursor: pointer;
  padding: 4px;
  border-radius: 4px;
  display: inline-flex;
  align-items: center;
}
.sw-rp__close:hover { background: var(--background-normal); color: var(--foreground-normal); }
.sw-rp__sub {
  margin: 0 0 18px;
  color: var(--foreground-subdued);
  font-size: 13px;
  line-height: 1.5;
  max-width: 720px;
}
.sw-rp__presets {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 18px;
}
.sw-rp__preset {
  background: transparent;
  color: var(--foreground-normal);
  border: 1px solid var(--border-subdued);
  padding: 6px 14px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s, color 0.15s, border-color 0.15s;
}
.sw-rp__preset:hover { border-color: var(--primary); color: var(--primary); }
.sw-rp__preset.active {
  background: var(--primary);
  color: var(--primary-foreground, white);
  border-color: var(--primary);
}
.sw-rp__dates {
  display: flex;
  flex-wrap: wrap;
  gap: 18px;
  align-items: flex-end;
  margin-bottom: 16px;
}
.sw-rp__field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.sw-rp__field span {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--foreground-subdued);
  font-weight: 700;
}
.sw-rp__field input {
  background: var(--background-normal);
  border: 1px solid var(--border-subdued);
  color: var(--foreground-normal);
  padding: 8px 12px;
  border-radius: 6px;
  font-size: 13px;
  min-width: 160px;
}
.sw-rp__field input:focus {
  outline: 0;
  border-color: var(--primary);
}
.sw-rp__span {
  padding: 8px 0;
  font-size: 13px;
  color: var(--foreground-subdued);
}
.sw-rp__error {
  background: var(--danger-25, rgba(239,68,68,0.1));
  color: var(--danger);
  border: 1px solid var(--danger);
  padding: 8px 12px;
  border-radius: 6px;
  font-size: 13px;
  margin-bottom: 12px;
}
.sw-rp__actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  border-top: 1px solid var(--border-subdued);
  padding-top: 14px;
}
.sw-rp__cancel {
  background: transparent;
  border: 1px solid var(--border-subdued);
  color: var(--foreground-normal);
  padding: 8px 16px;
  border-radius: 6px;
  font-weight: 600;
  font-size: 13px;
  cursor: pointer;
}
.sw-rp__download {
  background: var(--primary);
  color: var(--primary-foreground, white);
  border: 0;
  padding: 8px 18px;
  border-radius: 6px;
  font-weight: 700;
  font-size: 13px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.sw-rp__download:disabled { opacity: 0.5; cursor: wait; }

.sw-rp-slide-enter-active, .sw-rp-slide-leave-active {
  transition: opacity 0.18s ease, transform 0.18s ease;
}
.sw-rp-slide-enter-from, .sw-rp-slide-leave-to {
  opacity: 0;
  transform: translateY(-8px);
}

.sw-an__error {
  background: var(--danger-25, rgba(239,68,68,0.1));
  border: 1px solid var(--danger);
  color: var(--danger);
  padding: 12px 16px;
  border-radius: 6px;
  margin-bottom: 24px;
}

.sw-an__kpis {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 16px;
  margin-top: 24px;
  margin-bottom: 32px;
}
.sw-an__kpi {
  background: var(--background-subdued);
  border: 1px solid var(--border-subdued);
  border-radius: 8px;
  padding: 16px 20px;
}
.sw-an__kpi--live { border-color: var(--success); }
.sw-an__kpi-label {
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--foreground-subdued);
  margin-bottom: 8px;
  display: flex;
  align-items: center;
  gap: 6px;
}
.sw-an__kpi-value {
  font-size: 32px;
  font-weight: 700;
  color: var(--foreground-normal);
  line-height: 1;
}
.sw-an__kpi-foot {
  font-size: 12px;
  color: var(--foreground-subdued);
  margin-top: 6px;
}
.sw-an__live-dot {
  display: inline-block;
  width: 8px; height: 8px; border-radius: 50%;
  background: var(--success);
  box-shadow: 0 0 0 0 var(--success);
  animation: sw-an-pulse 2s infinite;
}
@keyframes sw-an-pulse {
  0% { box-shadow: 0 0 0 0 rgba(34,197,94,0.6); }
  70% { box-shadow: 0 0 0 8px rgba(34,197,94,0); }
  100% { box-shadow: 0 0 0 0 rgba(34,197,94,0); }
}

.sw-an__panel {
  background: var(--background-subdued);
  border: 1px solid var(--border-subdued);
  border-radius: 8px;
  padding: 20px 24px;
  margin-bottom: 20px;
}
.sw-an__panel-h {
  margin: 0 0 16px;
  font-size: 14px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--foreground-subdued);
  font-weight: 700;
}
.sw-an__empty {
  color: var(--foreground-subdued);
  font-size: 14px;
  padding: 24px 0;
  text-align: center;
}

.sw-an__row {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(360px, 1fr));
  gap: 20px;
  margin-bottom: 20px;
}
.sw-an__row--three {
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
}

.sw-an__table { width: 100%; border-collapse: collapse; font-size: 14px; }
.sw-an__table th, .sw-an__table td { padding: 8px 10px; text-align: left; }
.sw-an__table th { color: var(--foreground-subdued); font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; }
.sw-an__table td.num, .sw-an__table th.num { text-align: right; font-variant-numeric: tabular-nums; }
.sw-an__table tr { border-bottom: 1px solid var(--border-subdued); }
.sw-an__table tr:last-child { border-bottom: 0; }
.sw-an__table code { font-size: 13px; color: var(--foreground-normal); }

.sw-an__table--bd .sw-an__bd-label { width: 100%; padding-right: 12px; }
.sw-an__bd-name { display: block; }
.sw-an__bd-bar {
  height: 4px;
  background: var(--primary);
  border-radius: 2px;
  margin-top: 4px;
  transition: width 0.3s ease;
}
.sw-an__bd-num { white-space: nowrap; }

.sw-an__foot {
  margin-top: 32px;
  padding-top: 16px;
  border-top: 1px solid var(--border-subdued);
  font-size: 12px;
  color: var(--foreground-subdued);
  text-align: center;
}
</style>
