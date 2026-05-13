/**
 * directus-extension-pagespeed
 *
 * Public endpoint behind nginx → /api/.. for the /benchmark/ page on the
 * keltus.io site. Takes a URL, calls Google PageSpeed Insights v5 (keyless
 * free tier), and streams the audit progression as SSE so the UI can show a
 * live terminal exactly like the contact-form endpoint.
 *
 * Mounted at: /pagespeed/run-stream
 *
 * The PSI call itself is one fetch that blocks 20-40s while Google runs a
 * full Lighthouse audit on its own infrastructure. The stream emits ambient
 * status updates on a timer so the user has something to read while waiting.
 *
 * Privacy + abuse mitigation:
 *  - In-memory rate limit: 8 audits / hour / IP
 *  - URL must parse as http(s) and resolve to a public hostname
 *  - Loopback, RFC1918, link-local, ULA destinations are rejected
 *
 * No API key required for low volume (Google permits anonymous PSI calls).
 * If we ever hit the shared quota, set GOOGLE_PSI_API_KEY in cms/.env.
 */

const PSI_URL = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed';

const RATE = new Map();
const RATE_WINDOW_MS = 60 * 60 * 1000;
const RATE_MAX = 8;
function rateLimited(ip) {
  const now = Date.now();
  const arr = (RATE.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  if (arr.length >= RATE_MAX) { RATE.set(ip, arr); return true; }
  arr.push(now);
  RATE.set(ip, arr);
  return false;
}

function sseEmit(res, event) {
  if (res.writableEnded || res.closed) return;
  try { res.write(`data: ${JSON.stringify(event)}\n\n`); } catch (_) {}
}

function validateUrl(raw) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) {
    return { error: 'Please paste a full URL (https://example.com)' };
  }
  let u;
  try { u = new URL(/^https?:\/\//.test(raw) ? raw : `https://${raw}`); }
  catch { return { error: 'That doesn\'t look like a valid URL' }; }
  if (!/^https?:$/.test(u.protocol)) return { error: 'URL must use http or https' };
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' ||
      host === '127.0.0.1'  || host === '::1' ||
      /^10\./.test(host) ||
      /^192\.168\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
      /^169\.254\./.test(host) ||
      /^fc[0-9a-f]{2}:/i.test(host) ||
      /^fe80:/i.test(host)) {
    return { error: 'URL must be a public, internet-reachable address' };
  }
  return { url: u.toString() };
}

function pickScore(lhr, id) {
  // categories[id].score is 0..1 from PSI; null when audit failed
  const c = lhr && lhr.categories && lhr.categories[id];
  if (!c || c.score == null) return 0;
  return Math.round(c.score * 100);
}

function registerRoutes(router, { logger }) {
  router.post('/run-stream', async (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    if (req.headers.origin) {
      res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Vary', 'Origin');
    }
    if (typeof res.flushHeaders === 'function') res.flushHeaders();

    const emit  = (e) => sseEmit(res, e);
    const log   = (level, text) => emit({ type: 'log', level, text });
    const stage = (n, label) => log('stage', `── ${n}. ${label} ──`);

    const ip =
      (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
      req.ip || req.socket?.remoteAddress || 'unknown';

    try {
      const body = req.body || {};

      stage(1, 'Validate target URL');
      log('prompt', `validate POST /pagespeed/run-stream`);
      const { url, error } = validateUrl(body.url);
      if (error) {
        log('err', error);
        emit({ type: 'done', ok: false, error });
        return res.end();
      }
      log('ok', `url   ${url}`);

      if (rateLimited(ip)) {
        log('err', 'rate limit exceeded (8/hour/IP)');
        emit({ type: 'done', ok: false, error: 'Too many audits from this address. Please try again later.' });
        return res.end();
      }

      stage(2, 'Call Google PageSpeed Insights');
      const apiKey = process.env.GOOGLE_PSI_API_KEY || '';
      const qs = new URLSearchParams({
        url,
        strategy: 'desktop',
        category: 'performance',
      });
      // PSI's repeated `category` key — URLSearchParams collapses duplicates, so append by hand.
      const psiUrl = `${PSI_URL}?${qs}&category=accessibility&category=best-practices&category=seo${apiKey ? `&key=${encodeURIComponent(apiKey)}` : ''}`;

      log('http',   `GET ${PSI_URL} HTTP/1.1`);
      log('header', `host: www.googleapis.com`);
      log('header', `accept: application/json`);
      log('header', `auth: ${apiKey ? 'api key (private)' : 'anonymous (keyless tier)'}`);
      log('send',   `?url=${encodeURIComponent(url)}`);
      log('send',   `&strategy=desktop`);
      log('send',   `&category=performance&category=accessibility&category=best-practices&category=seo`);

      log('info', `Google is now spinning up a headless Chrome in their datacenter…`);
      log('info', `…running Lighthouse against ${url} on a simulated desktop.`);
      log('info', `This typically takes 20–40 seconds. Sit tight.`);

      // Ambient status pings while we wait, so the terminal feels alive.
      const tStart = Date.now();
      const pings = [
        { at: 5000,  text: 'Lighthouse is loading the page…' },
        { at: 12000, text: 'Capturing the main thread profile…' },
        { at: 20000, text: 'Measuring LCP, FID, CLS, TBT…' },
        { at: 30000, text: 'Running accessibility & best-practices audits…' },
        { at: 45000, text: 'Still going. Some sites take a while.' },
      ];
      let pingIdx = 0;
      const pingTimer = setInterval(() => {
        const elapsed = Date.now() - tStart;
        while (pingIdx < pings.length && pings[pingIdx].at <= elapsed) {
          log('info', pings[pingIdx].text);
          pingIdx++;
        }
        if (pingIdx >= pings.length) clearInterval(pingTimer);
      }, 1000);

      let psiResp = null;
      let psiErr  = null;
      try {
        const r = await fetch(psiUrl, { method: 'GET' });
        clearInterval(pingTimer);
        const dt = Date.now() - tStart;
        log('recv', `HTTP/1.1 ${r.status} ${r.statusText || ''}  (${(dt / 1000).toFixed(1)} s)`);
        const text = await r.text();
        if (!r.ok) {
          psiErr = `PSI ${r.status}: ${text.slice(0, 300)}`;
          log('err', psiErr);
        } else {
          try { psiResp = JSON.parse(text); }
          catch (e) { psiErr = `bad JSON from PSI: ${e.message}`; log('err', psiErr); }
        }
      } catch (e) {
        clearInterval(pingTimer);
        psiErr = e && e.message ? e.message : String(e);
        log('err', `Network error reaching PSI: ${psiErr}`);
      }

      if (psiErr) {
        emit({ type: 'done', ok: false, error: psiErr });
        return res.end();
      }

      stage(3, 'Parse Lighthouse scores');
      const lhr = psiResp.lighthouseResult || {};
      const perf = pickScore(lhr, 'performance');
      const a11y = pickScore(lhr, 'accessibility');
      const bp   = pickScore(lhr, 'best-practices');
      const seo  = pickScore(lhr, 'seo');

      const audits = lhr.audits || {};
      const lcp = audits['largest-contentful-paint']?.displayValue || '?';
      const tbt = audits['total-blocking-time']?.displayValue       || '?';
      const cls = audits['cumulative-layout-shift']?.displayValue   || '?';
      const fcp = audits['first-contentful-paint']?.displayValue    || '?';

      log('recv', `performance:     ${perf}/100`);
      log('recv', `accessibility:   ${a11y}/100`);
      log('recv', `best-practices:  ${bp}/100`);
      log('recv', `seo:             ${seo}/100`);
      log('info', `LCP: ${lcp}   TBT: ${tbt}   CLS: ${cls}   FCP: ${fcp}`);

      logger.info(`[pagespeed] ${ip} audited ${url} → ${perf}/${a11y}/${bp}/${seo}`);
      emit({
        type: 'done',
        ok:    true,
        url,
        scores: [perf, a11y, bp, seo],
        vitals: { lcp, tbt, cls, fcp },
      });
    } catch (err) {
      log('err', `Unexpected error: ${err && err.message ? err.message : err}`);
      emit({ type: 'done', ok: false, error: 'Unexpected error.' });
    } finally {
      try { res.end(); } catch (_) {}
    }
  });
}

export default {
  id: 'pagespeed',
  handler: registerRoutes,
};
