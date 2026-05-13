// One-off Russia-centered world SVG generator for keltus.ru.
// Same projection family as the upstream build (plate carrée), but rotated
// so longitude 90°E sits at the centre of the canvas. Rings are split at
// the new antimeridian (now at lon = -90°) so polygons don't draw long
// straight lines across the map.

import { feature } from '/var/www/keltus.ru/cms/extensions/directus-extension-keltus-analytics/node_modules/topojson-client/src/index.js';
import fs from 'node:fs';
import path from 'node:path';

const TOPO_IN   = '/var/www/keltus.ru/analytics/world-atlas-countries-110m.json';
const SVG_OUT   = '/var/www/keltus.ru/web/public/data/world.svg';
const W         = 1000;
const H         = 500;
const CENTER_LON = 90;       // ° east — recentres the map on Russia
// Russia is high-latitude (41–82 °N), so even with horizontal centring its
// content clusters in the upper third of the canvas. VERT_OFFSET shifts the
// whole projection down by this many SVG units so the visible content lands
// in a vertically-centred band. Anything south of ~lat -50° gets clipped —
// fine for a decorative map (Antarctica disappears, southern tip of SA + AU
// just barely).
const VERT_OFFSET = 80;

// shift longitude so CENTER_LON lands at x = W/2
function shiftLon(lon) {
  return ((lon - CENTER_LON + 540) % 360) - 180;
}
function proj([lon, lat]) {
  return [
    ((shiftLon(lon) + 180) / 360) * W,
    ((90 - lat) / 180) * H + VERT_OFFSET,
  ];
}

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
      // Walk the ring. If two consecutive projected points jump > W/2 in x,
      // that means the line segment wraps around the new antimeridian — break
      // the subpath there rather than drawing the straight line across.
      let prevX = null;
      let segStart = true;
      for (const point of ring) {
        const [x, y] = proj(point);
        if (prevX !== null && Math.abs(x - prevX) > W / 2) {
          // Wrapped — end the current subpath without closing (no Z so
          // we don't connect the wrap; the visible ring on each side
          // remains an open stroke. Good enough for a decorative map).
          segStart = true;
        }
        d += (segStart ? 'M' : 'L') + x.toFixed(1) + ',' + y.toFixed(1);
        segStart = false;
        prevX = x;
      }
    }
  }
  if (d) paths.push(d);
}

const svg =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" aria-hidden="true">` +
  `<g fill="none" stroke="#38bdf8" stroke-opacity="0.42" stroke-width="0.7" stroke-linejoin="round">` +
  paths.map(d => `<path d="${d}"/>`).join('') +
  `</g></svg>`;

fs.mkdirSync(path.dirname(SVG_OUT), { recursive: true });
fs.writeFileSync(SVG_OUT, svg);
console.log(`wrote ${SVG_OUT} (${(svg.length / 1024).toFixed(1)} KB, ${paths.length} country paths, centred on ${CENTER_LON}°E)`);
