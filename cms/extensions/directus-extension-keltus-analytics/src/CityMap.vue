<template>
  <div class="sw-map">
    <div class="sw-map__head">
      <h3 class="sw-an__panel-h">Where visitors are coming from</h3>
      <div class="sw-map__controls">
        <span v-if="loading" class="sw-map__loading">loading…</span>
        <span v-else class="sw-map__count">{{ cities.length }} location{{ cities.length === 1 ? '' : 's' }}</span>
        <select v-model="windowKey" class="sw-map__select">
          <option value="5">Live (5 min)</option>
          <option value="60">Last hour</option>
          <option value="240">Last 4 hours</option>
          <option value="1440">Last 24 hours</option>
          <option value="10080">Last 7 days</option>
          <option value="43200">Last 30 days</option>
        </select>
      </div>
    </div>

    <div class="sw-map__svg-wrap">
      <svg :viewBox="`0 0 ${W} ${H}`" preserveAspectRatio="xMidYMid meet" class="sw-map__svg">
        <!-- ocean -->
        <rect :width="W" :height="H" class="sw-map__ocean" />
        <!-- countries -->
        <g class="sw-map__countries">
          <path v-for="(d, i) in countryPaths" :key="i" :d="d" class="sw-map__country" />
        </g>
        <!-- city dots -->
        <g class="sw-map__dots">
          <g v-for="(c, i) in cityDots" :key="i" class="sw-map__dot-group">
            <!-- pulsing halo only on live -->
            <circle v-if="isLive" :cx="c.x" :cy="c.y" :r="c.r * 2.2" class="sw-map__halo" />
            <circle :cx="c.x" :cy="c.y" :r="c.r" class="sw-map__dot">
              <title>{{ c.label }} — {{ c.views }} view{{ c.views === 1 ? '' : 's' }}, {{ c.visitors }} visitor{{ c.visitors === 1 ? '' : 's' }}</title>
            </circle>
          </g>
        </g>
      </svg>
      <div v-if="!loading && cities.length === 0" class="sw-map__empty">
        No geocoded visits in this window yet.
      </div>
    </div>

    <p v-if="!hasGeoIP" class="sw-map__note">
      ⚠ Geo lookups disabled — install GeoLite2-City.mmdb on the server to populate this map.
    </p>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { geoNaturalEarth1, geoPath } from 'd3-geo';
// @ts-expect-error topojson-client has no provided types in older versions
import { feature } from 'topojson-client';
// @ts-expect-error inline JSON import (bundler handles it)
import worldTopo from './world-110m.json';

type CityPoint = {
  country: string;
  region: string;
  city: string;
  lat: number;
  lon: number;
  views: number;
  visitors: number;
};

const W = 960;
const H = 480;

/* d3-geo's natural-earth projection — rounded edges, gentle distortion at the
 * poles, classic "atlas" feel. Fit to our viewBox so the dots line up with
 * the country paths. */
const projection = geoNaturalEarth1().fitSize([W, H], { type: 'Sphere' } as any);
const pathGen = geoPath(projection as any);

const countriesGeo = computed(() => {
  const t: any = worldTopo;
  return feature(t, t.objects.countries);
});
const countryPaths = computed(() => {
  const fc: any = countriesGeo.value;
  return (fc.features || []).map((f: any) => pathGen(f) || '').filter(Boolean);
});

const windowKey = ref<'5' | '60' | '240' | '1440' | '10080' | '43200'>('5');
const cities = ref<CityPoint[]>([]);
const loading = ref(false);
const hasGeoIP = ref(true);

const isLive = computed(() => windowKey.value === '5');

/* Project + size each city dot. Radius scales with sqrt(views) so a city with
 * 100x more views shows ~10x bigger dot — the eye reads area, not radius. */
const cityDots = computed(() => {
  const list = cities.value;
  if (list.length === 0) return [];
  const maxV = Math.max(...list.map((c) => c.views), 1);
  return list
    .map((c) => {
      const projected = (projection as any)([c.lon, c.lat]);
      if (!projected) return null;
      const [x, y] = projected;
      return {
        x,
        y,
        r: Math.max(2.5, Math.sqrt(c.views / maxV) * 14),
        views: c.views,
        visitors: c.visitors,
        label: [c.city, c.region, c.country].filter(Boolean).join(', ') || 'Unknown',
      };
    })
    .filter((p): p is NonNullable<typeof p> => !!p);
});

async function load() {
  loading.value = true;
  try {
    const r = await fetch(`/api/analytics/cities?window=${windowKey.value}`, {
      credentials: 'include',
      headers: { Accept: 'application/json' },
    });
    if (!r.ok) throw new Error('cities ' + r.status);
    const j = await r.json();
    cities.value = j.cities || [];
    /* If we get empty across all windows AND the public site is being hit,
       it's almost always a missing GeoLite2 mmdb. Heuristic: blank everything
       across the longest window means geoip is off. */
    if (windowKey.value === '43200' && cities.value.length === 0) {
      // (don't unilaterally flip the flag — the install script flags it on its own)
    }
  } catch (e) {
    cities.value = [];
  } finally {
    loading.value = false;
  }
}

let pollTimer: number | null = null;

onMounted(() => {
  load();
  /* Refresh live window every 20 s. Longer windows refresh on selector change only. */
  pollTimer = window.setInterval(() => {
    if (isLive.value) load();
  }, 20_000);
});
onUnmounted(() => {
  if (pollTimer) window.clearInterval(pollTimer);
});

watch(windowKey, () => load());
</script>

<style scoped>
.sw-map {
  background: var(--background-subdued);
  border: 1px solid var(--border-subdued);
  border-radius: 8px;
  padding: 20px 24px;
  margin-bottom: 20px;
}
.sw-map__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
  gap: 16px;
  flex-wrap: wrap;
}
.sw-an__panel-h {
  margin: 0;
  font-size: 14px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--foreground-subdued);
  font-weight: 700;
}
.sw-map__controls {
  display: flex;
  align-items: center;
  gap: 12px;
}
.sw-map__loading,
.sw-map__count {
  font-size: 12px;
  color: var(--foreground-subdued);
}
.sw-map__select {
  background: var(--background-subdued);
  border: 1px solid var(--border-subdued);
  color: var(--foreground-normal);
  padding: 6px 10px;
  border-radius: 6px;
  font-size: 13px;
}

.sw-map__svg-wrap {
  position: relative;
  width: 100%;
  background: var(--background-page, #0a0e1a);
  border-radius: 6px;
  overflow: hidden;
}
.sw-map__svg {
  display: block;
  width: 100%;
  height: auto;
}
.sw-map__ocean { fill: var(--background-page, #0e1525); }
.sw-map__country {
  fill: var(--background-subdued, #1a2238);
  stroke: var(--border-subdued, #2a3654);
  stroke-width: 0.5;
  vector-effect: non-scaling-stroke;
  transition: fill 0.15s ease;
}
.sw-map__country:hover { fill: var(--border-subdued, #2a3654); }

.sw-map__dot {
  fill: var(--primary, #4099ff);
  fill-opacity: 0.85;
  stroke: white;
  stroke-width: 1;
  vector-effect: non-scaling-stroke;
  cursor: pointer;
  transition: r 0.2s ease, fill-opacity 0.2s ease;
}
.sw-map__dot-group:hover .sw-map__dot {
  fill: var(--success, #22c55e);
  fill-opacity: 1;
}
.sw-map__halo {
  fill: var(--primary, #4099ff);
  fill-opacity: 0.18;
  pointer-events: none;
  transform-origin: center;
  animation: sw-map-pulse 2s infinite ease-in-out;
}
@keyframes sw-map-pulse {
  0%   { opacity: 0.6; transform: scale(0.7); }
  70%  { opacity: 0;   transform: scale(1.3); }
  100% { opacity: 0;   transform: scale(1.3); }
}

.sw-map__empty {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--foreground-subdued);
  font-size: 14px;
  background: rgba(0,0,0,0.2);
  pointer-events: none;
}
.sw-map__note {
  font-size: 12px;
  color: var(--foreground-subdued);
  margin: 12px 0 0;
  font-style: italic;
}
</style>
