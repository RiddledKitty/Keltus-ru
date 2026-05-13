// Convert /var/www/keltus.ru/analytics/world-atlas-countries-110m.json into
// a stripped, equirectangular-projected SVG saved at
// web/public/data/world.svg. Run once at build time (or manually).
//
// Output is ~30 KB unminified, gzips well, and uses `currentColor` for the
// stroke so CSS controls the look.
import { feature } from '/var/www/keltus.ru/cms/extensions/directus-extension-keltus-ru-analytics/node_modules/topojson-client/src/index.js';
import fs from 'node:fs';
import path from 'node:path';

const TOPO_IN  = '/var/www/keltus.ru/analytics/world-atlas-countries-110m.json';
const SVG_OUT  = '/var/www/keltus.ru/web/public/data/world.svg';

const W = 1000;
const H = 500;
const proj = ([lon, lat]) => [
  ((lon + 180) / 360) * W,
  ((90 - lat) / 180) * H,
];

const topo = JSON.parse(fs.readFileSync(TOPO_IN, 'utf8'));
const objName = Object.keys(topo.objects)[0];
const geo = feature(topo, topo.objects[objName]);

const paths = [];
for (const f of geo.features) {
  let d = '';
  const type = f.geometry.type;
  const polygons = type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
  for (const polygon of polygons) {
    for (const ring of polygon) {
      if (ring.length < 2) continue;
      const pts = ring.map(proj).map(p => `${p[0].toFixed(1)},${p[1].toFixed(1)}`);
      d += 'M' + pts.join('L') + 'Z';
    }
  }
  if (d) paths.push(d);
}

// Color baked into the SVG file because we embed via <object>, which
// breaks CSS inheritance from the host page. Soft cyan to live in the
// same accent family as the dots without competing with them.
const svg =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" aria-hidden="true">` +
  `<g fill="none" stroke="#38bdf8" stroke-opacity="0.42" stroke-width="0.7" stroke-linejoin="round">` +
  paths.map(d => `<path d="${d}"/>`).join('') +
  `</g></svg>`;

fs.mkdirSync(path.dirname(SVG_OUT), { recursive: true });
fs.writeFileSync(SVG_OUT, svg);
console.log(`wrote ${SVG_OUT} (${(svg.length / 1024).toFixed(1)} KB, ${paths.length} country paths)`);
