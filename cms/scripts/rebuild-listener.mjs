#!/usr/bin/env node
/**
 * Tiny HTTP listener that triggers `npm run build` in the web/ directory
 * on demand. Directus' rebuild-hook extension POSTs here when content
 * changes, with ~2s debounce so a flurry of edits = one rebuild.
 *
 * Listens on 127.0.0.1 only (Directus is on the same box).
 *
 * Env:
 *   REBUILD_PORT          (default 4327)
 *   REBUILD_SECRET        (required — Bearer token Directus must send)
 *   STATIC_API_TOKEN      (passed through to the build step so it can read Directus)
 *   SITE_ROOT             (default /var/www/keltus.ru)
 *   CLOUDFLARE_API_TOKEN  (optional — scoped Zone:Cache Purge token)
 *   CLOUDFLARE_ZONE_ID    (optional — keltus.ru zone id; required when token is set)
 *
 * Endpoints:
 *   POST /rebuild  — runs the build, then purges caches on success
 *   POST /purge    — purges caches only (no rebuild)
 *   GET  /healthz  — JSON status
 */

import http from 'node:http';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

const PORT       = Number(process.env.REBUILD_PORT || 4327);
const SECRET     = process.env.REBUILD_SECRET || '';
const SITE_ROOT  = process.env.SITE_ROOT || '/var/www/keltus.ru';
const WEB_DIR    = join(SITE_ROOT, 'web');
const CACHE_HOME = join(SITE_ROOT, '.cache');
const DIRECTUS_URL = process.env.DIRECTUS_URL || 'http://127.0.0.1:8055';

if (!SECRET) {
  console.error('[rebuild] REBUILD_SECRET not set — refusing to start');
  process.exit(1);
}

try { mkdirSync(CACHE_HOME, { recursive: true }); } catch (e) {
  console.error(`[rebuild] WARN: could not ensure ${CACHE_HOME}: ${e.message}`);
}

let running = false;
let queued = false;
let lastFinishedAt = null;
let lastDurationMs = null;
let lastExitCode = null;
let lastPurge = null; // { at, ok, detail }

async function purgeCloudflare() {
  const token  = process.env.CLOUDFLARE_API_TOKEN || '';
  const zoneId = process.env.CLOUDFLARE_ZONE_ID  || '';
  if (!token || !zoneId) {
    console.log('[purge] cloudflare skipped — CLOUDFLARE_API_TOKEN/ZONE_ID not configured');
    return { skipped: true, reason: 'no-credentials' };
  }
  try {
    const r = await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/purge_cache`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ purge_everything: true }),
    });
    const data = await r.json().catch(() => ({}));
    if (r.ok && data.success) {
      console.log(`[purge] cloudflare OK (zone ${zoneId.slice(0, 8)}…)`);
      return { ok: true };
    } else {
      const detail = JSON.stringify(data.errors || data).slice(0, 300);
      console.warn(`[purge] cloudflare failed (${r.status}): ${detail}`);
      return { ok: false, detail };
    }
  } catch (e) {
    console.warn(`[purge] cloudflare error: ${e.message}`);
    return { ok: false, detail: e.message };
  }
}

async function purgeAll() {
  const cf = await purgeCloudflare();
  // Future: directus query cache, asset transforms, etc. could go here.
  lastPurge = { at: new Date().toISOString(), cloudflare: cf };
  return lastPurge;
}

function runBuild() {
  if (running) { queued = true; return; }
  running = true;
  const t0 = Date.now();
  console.log(`[rebuild] starting (${new Date().toISOString()})`);

  // web/.env is the canonical source for DIRECTUS_TOKEN. Node 20's
  // --env-file refuses to overwrite already-set env vars, so strip any
  // inherited DIRECTUS_TOKEN so .env wins.
  const env = {
    ...process.env,
    DIRECTUS_URL,
    HOME: CACHE_HOME,
    ASTRO_TELEMETRY_DISABLED: '1',
  };
  delete env.DIRECTUS_TOKEN;

  const proc = spawn('bash', ['-c', 'npm run build'], {
    cwd: WEB_DIR,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', (b) => process.stdout.write(`[rebuild] ${b}`));
  proc.stderr.on('data', (b) => process.stderr.write(`[rebuild] ${b}`));
  proc.on('exit', async (code) => {
    lastExitCode = code;
    lastDurationMs = Date.now() - t0;
    lastFinishedAt = new Date().toISOString();
    console.log(`[rebuild] done in ${lastDurationMs}ms (exit ${code})`);
    if (code === 0) {
      await purgeAll();
    }
    running = false;
    if (queued) {
      queued = false;
      setTimeout(runBuild, 1000);
    }
  });
}

const server = http.createServer((req, res) => {
  const peer = req.socket.remoteAddress || '?';
  const ts = new Date().toISOString();
  const send = (status, body, contentType = 'text/plain') => {
    if (req.url !== '/healthz') {
      console.log(`[rebuild] ${ts} ${req.method} ${req.url} ${status} from=${peer}`);
    }
    res.writeHead(status, { 'Content-Type': contentType });
    res.end(body);
  };

  if (req.url === '/healthz') {
    return send(200, JSON.stringify({
      ok: true,
      running,
      queued,
      lastFinishedAt,
      lastDurationMs,
      lastExitCode,
      lastPurge,
    }) + '\n', 'application/json');
  }

  if (req.url !== '/rebuild' && req.url !== '/purge') return send(404, 'not found\n');
  if (req.method !== 'POST') return send(405, 'POST required\n');

  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ') || auth.slice(7) !== SECRET) {
    const tokenInfo = auth
      ? `token=${auth.slice(0, 15)}…(len ${auth.length - 7})`
      : 'no Authorization header';
    console.log(`[rebuild] AUTH FAIL — ${tokenInfo}`);
    return send(401, 'unauthorized\n');
  }

  if (req.url === '/purge') {
    req.on('data', () => {});
    req.on('end', async () => {
      const result = await purgeAll();
      send(200, JSON.stringify({ accepted: true, ...result }) + '\n', 'application/json');
    });
    return;
  }

  req.on('data', () => {});
  req.on('end', () => {
    runBuild();
    send(202, JSON.stringify({ accepted: true, runningAlready: running, willQueue: queued }) + '\n', 'application/json');
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[rebuild] listening on 127.0.0.1:${PORT}  (POST /rebuild + GET /healthz)`);
});

const stop = (sig) => () => {
  console.log(`[rebuild] ${sig} — shutting down`);
  server.close(() => process.exit(0));
};
process.on('SIGINT', stop('SIGINT'));
process.on('SIGTERM', stop('SIGTERM'));
