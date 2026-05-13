<template>
  <div class="sw-tc">
    <div class="sw-tc__head">
      <h3 class="sw-tc__title">Traffic</h3>
      <div class="sw-tc__sub">
        5-minute buckets · {{ lens === 'humans' ? 'Humans only' : 'Humans + bots' }}
      </div>
    </div>
    <v-chart
      v-if="hasData"
      :option="option"
      autoresize
      :style="`height: ${height}px;`"
    />
    <div v-else class="sw-tc__empty">
      No tracked traffic in this window yet.
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import VChart from 'vue-echarts';
import { use } from 'echarts/core';
import { LineChart } from 'echarts/charts';
import {
  GridComponent,
  TooltipComponent,
  LegendComponent,
  AxisPointerComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';

use([LineChart, GridComponent, TooltipComponent, LegendComponent, AxisPointerComponent, CanvasRenderer]);

interface MinutePoint {
  bucket: string;          // ISO datetime
  views: number;
  human_views: number;
  visitors: number;
  human_visitors: number;
}

const props = defineProps<{
  buckets: MinutePoint[];
  lens: 'humans' | 'all';
  height?: number;
}>();

/* Sample Directus theme tokens at mount — canvas can't resolve CSS vars,
 * and falling back to ECharts defaults is what made the line invisible. */
const theme = ref({
  fg: '#e0e6ed',
  fgSubtle: '#94a3b8',
  grid: 'rgba(148, 163, 184, 0.15)',
});
onMounted(() => {
  const cs = getComputedStyle(document.documentElement);
  const v = (n: string, f: string) => (cs.getPropertyValue(n) || '').trim() || f;
  theme.value = {
    fg: v('--foreground-normal', '#e0e6ed'),
    fgSubtle: v('--foreground-subdued', '#94a3b8'),
    grid: v('--border-subdued', 'rgba(148, 163, 184, 0.15)'),
  };
});

/* Two series styled like the screenshot: bright cyan line for views (filled
 * area underneath), dimmer line on top for visitors. Keep them visible
 * regardless of theme. */
const VIEWS_LINE = '#22d3ee';
const VIEWS_FILL_TOP = 'rgba(34, 211, 238, 0.35)';
const VIEWS_FILL_BOTTOM = 'rgba(34, 211, 238, 0.02)';
const VISITORS_LINE = '#0284c7';

const hasData = computed(() => props.buckets && props.buckets.length > 0);

const xs = computed(() => props.buckets.map((b) => new Date(b.bucket).getTime()));
const viewsData = computed(() =>
  props.buckets.map((b, i) => [xs.value[i], props.lens === 'humans' ? b.human_views : b.views])
);
const visitorsData = computed(() =>
  props.buckets.map((b, i) => [xs.value[i], props.lens === 'humans' ? b.human_visitors : b.visitors])
);

const option = computed(() => ({
  grid: { left: 48, right: 24, top: 24, bottom: 36, containLabel: true },
  legend: { show: false },
  tooltip: {
    trigger: 'axis',
    axisPointer: {
      type: 'cross',
      lineStyle: { color: theme.value.fgSubtle, type: 'dashed', width: 1 },
      crossStyle: { color: theme.value.fgSubtle },
      label: { backgroundColor: '#0f172a', color: '#fff', fontSize: 11, padding: [4, 8] },
    },
    backgroundColor: 'rgba(15, 23, 42, 0.96)',
    borderWidth: 0,
    textStyle: { color: '#fff', fontSize: 12 },
    padding: [10, 14],
    formatter: (params: any[]) => {
      if (!params || !params.length) return '';
      const t = new Date(params[0].value[0]);
      const head = t.toLocaleString(undefined, {
        month: 'short', day: 'numeric',
        hour: 'numeric', minute: '2-digit', hour12: true,
      });
      const lines = params.map((p) =>
        `<span style="display:inline-block;width:8px;height:8px;background:${p.color};border-radius:50%;margin-right:6px;"></span>${p.seriesName}: <b>${(p.value[1] || 0).toLocaleString()}</b>`,
      );
      return `<div style="font-weight:600;margin-bottom:4px;font-size:11px;color:#cbd5e1;">${head}</div>${lines.join('<br/>')}`;
    },
  },
  xAxis: {
    type: 'time',
    axisLine: { lineStyle: { color: theme.value.grid } },
    axisLabel: {
      color: theme.value.fgSubtle,
      fontSize: 11,
      hideOverlap: true,
      formatter: {
        year: '{yyyy}',
        month: '{MMM}',
        day: '{MMM} {d}',
        hour: '{h}:{mm} {a}',
        minute: '{h}:{mm} {a}',
      },
    },
    axisTick: { show: false },
    splitLine: { show: false },
  },
  yAxis: {
    type: 'value',
    splitLine: { lineStyle: { color: theme.value.grid, type: 'dashed' } },
    axisLine: { show: false },
    axisLabel: {
      color: theme.value.fgSubtle,
      fontSize: 11,
      formatter: (v: number) => (v >= 1000 ? (v / 1000).toFixed(v >= 10000 ? 0 : 1) + 'K' : String(v)),
    },
    axisTick: { show: false },
    minInterval: 1,
  },
  series: [
    {
      name: 'Views',
      type: 'line',
      smooth: 0.25,
      symbol: 'none',
      sampling: 'lttb',
      lineStyle: { width: 1.5, color: VIEWS_LINE, shadowColor: 'rgba(34, 211, 238, 0.4)', shadowBlur: 6 },
      itemStyle: { color: VIEWS_LINE },
      areaStyle: {
        color: {
          type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
          colorStops: [
            { offset: 0, color: VIEWS_FILL_TOP },
            { offset: 1, color: VIEWS_FILL_BOTTOM },
          ],
        },
      },
      emphasis: { focus: 'series' },
      data: viewsData.value,
    },
    {
      name: 'Visitors',
      type: 'line',
      smooth: 0.25,
      symbol: 'none',
      sampling: 'lttb',
      lineStyle: { width: 1.5, color: VISITORS_LINE, opacity: 0.85 },
      itemStyle: { color: VISITORS_LINE },
      emphasis: { focus: 'series' },
      data: visitorsData.value,
    },
  ],
}));

const height = computed(() => props.height || 300);
</script>

<style scoped>
.sw-tc {
  background: var(--background-subdued);
  border: 1px solid var(--border-subdued);
  border-radius: 8px;
  padding: 18px 24px 14px;
  margin-bottom: 20px;
}
.sw-tc__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: 10px;
  gap: 16px;
}
.sw-tc__title {
  margin: 0;
  font-size: 18px;
  font-weight: 700;
  color: var(--foreground-normal);
  letter-spacing: -0.2px;
}
.sw-tc__sub {
  font-size: 12px;
  color: var(--foreground-subdued);
  letter-spacing: 0.2px;
}
.sw-tc__empty {
  color: var(--foreground-subdued);
  font-size: 14px;
  text-align: center;
  padding: 80px 0;
}
</style>
