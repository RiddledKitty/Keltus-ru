<template>
  <div class="sw-donut">
    <h3 class="sw-an__panel-h">{{ title }}</h3>
    <v-chart v-if="hasData" :option="option" autoresize :style="`height: ${height}px;`" />
    <div v-else class="sw-donut__empty">{{ empty }}</div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import VChart from 'vue-echarts';
import { use } from 'echarts/core';
import { PieChart } from 'echarts/charts';
import { TooltipComponent, LegendComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';

use([PieChart, TooltipComponent, LegendComponent, CanvasRenderer]);

const theme = ref({ fg: '#e0e6ed', bgPanel: '#1a2238' });
onMounted(() => {
  const cs = getComputedStyle(document.documentElement);
  const v = (n: string, f: string) => (cs.getPropertyValue(n) || '').trim() || f;
  theme.value = {
    fg: v('--foreground-normal', '#e0e6ed'),
    bgPanel: v('--background-subdued', '#1a2238'),
  };
});

interface Item {
  value: string;
  views: number;
  human_views: number;
  visitors: number;
  human_visitors: number;
}

const props = defineProps<{
  title: string;
  items: Item[];
  lens: 'humans' | 'all';
  empty?: string;
  height?: number;
}>();

const PALETTE = [
  '#4099ff', '#8b5cf6', '#06b6d4', '#22c55e',
  '#f59e0b', '#ef4444', '#ec4899', '#14b8a6',
  '#a855f7', '#0ea5e9',
];

const data = computed(() =>
  props.items
    .map((i) => ({
      name: i.value || '(empty)',
      value: props.lens === 'humans' ? i.human_views : i.views,
      _visitors: props.lens === 'humans' ? i.human_visitors : i.visitors,
    }))
    .filter((d) => d.value > 0)
);

const hasData = computed(() => data.value.length > 0);

const option = computed(() => ({
  color: PALETTE,
  tooltip: {
    trigger: 'item',
    backgroundColor: 'rgba(15,23,42,0.95)',
    borderWidth: 0,
    textStyle: { color: '#fff', fontSize: 12 },
    padding: [8, 12],
    formatter: (p: any) => {
      const v = (p.data as any)._visitors;
      return `<b>${p.name}</b><br/>${p.value.toLocaleString()} views (${p.percent}%)<br/>${v?.toLocaleString() ?? '–'} visitors`;
    },
  },
  legend: {
    orient: 'vertical',
    right: 0,
    top: 'middle',
    itemWidth: 10,
    itemHeight: 10,
    textStyle: { color: theme.value.fg, fontSize: 12 },
    formatter: (name: string) => (name.length > 14 ? name.slice(0, 14) + '…' : name),
  },
  series: [
    {
      type: 'pie',
      radius: ['52%', '78%'],
      center: ['38%', '50%'],
      avoidLabelOverlap: true,
      itemStyle: {
        borderRadius: 4,
        borderColor: theme.value.bgPanel,
        borderWidth: 2,
      },
      label: { show: false },
      labelLine: { show: false },
      emphasis: {
        scaleSize: 6,
        itemStyle: { shadowBlur: 12, shadowColor: 'rgba(64,153,255,0.4)' },
      },
      data: data.value,
    },
  ],
}));

const height = computed(() => props.height || 220);
</script>

<style scoped>
.sw-donut {
  background: var(--background-subdued);
  border: 1px solid var(--border-subdued);
  border-radius: 8px;
  padding: 20px 24px;
}
.sw-donut__empty {
  color: var(--foreground-subdued);
  font-size: 14px;
  text-align: center;
  padding: 60px 0;
}
.sw-an__panel-h {
  margin: 0 0 12px;
  font-size: 14px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--foreground-subdued);
  font-weight: 700;
}
</style>
