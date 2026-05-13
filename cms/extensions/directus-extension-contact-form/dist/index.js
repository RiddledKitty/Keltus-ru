import { format as utilFormat } from 'node:util';

/**
 * directus-extension-contact-form
 *
 * Public endpoint that accepts contact-form submissions from the
 * keltus.io Astro site. Public URL via nginx:
 *   POST https://admin.keltus.io/contact-form/submit
 *
 * For every valid submission it:
 *   1. Persists a row to the `contact_requests` collection (status =
 *      'pending'). The row is created BEFORE we attempt to send mail
 *      so a failed delivery never loses the submission.
 *   2. Sends a notification email to CONTACT_TO_EMAIL (Brevo API if
 *      BREVO_API_KEY is set, otherwise Directus's MailService / SMTP).
 *   3. Updates the row with `email_delivered` + `email_error` so the
 *      admin dashboard surfaces failed deliveries.
 *
 * Required env (cms/.env):
 *   CONTACT_TO_EMAIL — where the form submission lands (falls back
 *                      to ADMIN_EMAIL).
 *
 * Optional env:
 *   GEO_DB_PATH — path to the GeoLite2-City.mmdb file. When set, every
 *                 submission is enriched with geo_country, geo_region,
 *                 geo_city, geo_postal, geo_timezone, geo_lat, geo_lon.
 *                 Defaults to /var/lib/GeoIP/GeoLite2-City.mmdb (the
 *                 same path the analytics service uses).
 *
 * Brevo path (recommended):
 *   BREVO_API_KEY      — transactional API key from app.brevo.com
 *   BREVO_FROM_EMAIL   — verified sender address
 *   BREVO_FROM_NAME    — friendly From name
 *
 * SMTP path (Directus mailer):
 *   EMAIL_TRANSPORT, EMAIL_FROM, EMAIL_SMTP_HOST, EMAIL_SMTP_PORT,
 *   EMAIL_SMTP_USER, EMAIL_SMTP_PASSWORD, EMAIL_SMTP_SECURE
 *
 * Source-of-truth is dist/index.js (no build step) — same convention
 * as directus-extension-rebuild-hook.
 */

const COLLECTION = 'contact_requests';
const GEO_DB_PATH = process.env.GEO_DB_PATH || '/var/lib/GeoIP/GeoLite2-City.mmdb';

// Lazily-initialized maxmind reader. We open it on first lookup so a
// missing .mmdb doesn't crash extension boot — submissions still land
// in the DB without geo fields.
let geoReaderPromise = null;
async function getGeoReader(logger) {
  if (geoReaderPromise) return geoReaderPromise;
  geoReaderPromise = (async () => {
    try {
      const { default: maxmind } = await import('maxmind');
      const reader = await maxmind.open(GEO_DB_PATH);
      logger.info(`[contact-form] geo lookup enabled (${GEO_DB_PATH})`);
      return reader;
    } catch (e) {
      logger.warn(`[contact-form] geo lookup disabled — could not open ${GEO_DB_PATH}: ${e && e.message ? e.message : e}`);
      return null;
    }
  })();
  return geoReaderPromise;
}

/* Pull a city-level geocode out of the maxmind record. All fields are
 * best-effort — GeoLite2 frequently returns partial records (country
 * but no city, etc). The 0,0 lat/lon sentinel from "no answer" is
 * filtered out so we never write a dot in the Atlantic. */
function shapeGeo(rec) {
  if (!rec) return null;
  const country_name = rec.country?.names?.en || rec.registered_country?.names?.en || null;
  const region = rec.subdivisions?.[0]?.names?.en || null;
  const city = rec.city?.names?.en || null;
  const postal = rec.postal?.code || null;
  const timezone = rec.location?.time_zone || null;
  let lat = null, lon = null;
  if (rec.location && (rec.location.latitude || rec.location.longitude)) {
    lat = rec.location.latitude ?? null;
    lon = rec.location.longitude ?? null;
  }
  return {
    geo_country_name: country_name,
    geo_region:       region,
    geo_city:         city,
    geo_postal:       postal,
    geo_timezone:     timezone,
    geo_lat:          lat,
    geo_lon:          lon,
  };
}

/* Skip lookups for IPs that GeoLite2 can't resolve to a public location
 * (loopback, link-local, RFC1918) — those would just clutter the row
 * with nulls and make logs noisy. */
function isPublicIp(ip) {
  if (!ip) return false;
  if (ip === 'unknown' || ip === '::1' || ip === '127.0.0.1') return false;
  if (/^10\./.test(ip)) return false;
  if (/^192\.168\./.test(ip)) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return false;
  if (/^169\.254\./.test(ip)) return false;
  if (/^fc[0-9a-f]{2}:/i.test(ip)) return false; // fc00::/7 ULA
  if (/^fe80:/i.test(ip)) return false;          // link-local
  return true;
}

async function geoLookup(ip, logger) {
  if (!isPublicIp(ip)) return null;
  try {
    const reader = await getGeoReader(logger);
    if (!reader) return null;
    return shapeGeo(reader.get(ip));
  } catch (e) {
    logger.warn(`[contact-form] geo lookup failed for ${ip}: ${e && e.message ? e.message : e}`);
    return null;
  }
}

const MAX = {
  name:    120,
  email:   200,
  phone:   20,   // E.164 max is 16 chars (+ and up to 15 digits); leave headroom
  subject: 200,
  topic:   60,
  message: 6000,
};

/* Coerce a client-submitted phone to a strict E.164-ish form: leading +
 * followed by 7-15 digits. Anything else (including a stray '+' prefix
 * with no digits) becomes empty so the column stays clean. The frontend
 * already normalizes this, but the server must not trust the client. */
function normalizePhone(raw) {
  if (typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  if (!trimmed) return '';
  const digits = trimmed.replace(/\D+/g, '');
  if (digits.length < 7 || digits.length > 15) return '';
  return `+${digits}`;
}

const TOPIC_LABELS = {
  general:     'General message',
  'new-build': 'New project / build inquiry',
  quote:       'Quote request',
  partnership: 'Partnership / collaboration',
  press:       'Press / media',
  technical:   'Site / technical issue',
};

// In-memory rate limit: max 5 submissions per IP per hour.
// Resets when the process restarts — fine for a low-volume contact form.
const RATE = new Map();
const RATE_WINDOW_MS = 60 * 60 * 1000;
const RATE_MAX = 5;

function rateLimited(ip) {
  const now = Date.now();
  const arr = (RATE.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  if (arr.length >= RATE_MAX) {
    RATE.set(ip, arr);
    return true;
  }
  arr.push(now);
  RATE.set(ip, arr);
  return false;
}

function s(v, max) {
  if (typeof v !== 'string') return '';
  const t = v.trim();
  return t.length > max ? t.slice(0, max) : t;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function redactKey(key) {
  if (!key) return '';
  if (key.length < 12) return '***';
  return key.slice(0, 10) + '…' + key.slice(-4);
}

function escJsonStr(s) {
  return String(s ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

async function sendViaBrevo({ to, replyToEmail, replyToName, subject, text, html, emit }) {
  const apiKey    = process.env.BREVO_API_KEY;
  const fromEmail = process.env.BREVO_FROM_EMAIL;
  const fromName  = process.env.BREVO_FROM_NAME || 'Keltus';
  if (!apiKey || !fromEmail) {
    throw new Error('BREVO_API_KEY and BREVO_FROM_EMAIL must both be set');
  }
  const payload = {
    sender:   { name: fromName, email: fromEmail },
    to:       [{ email: to }],
    replyTo:  { email: replyToEmail, name: replyToName },
    subject,
    htmlContent: html,
    textContent: text,
  };

  if (emit) {
    emit({ type:'log', level:'http',   text: 'POST https://api.brevo.com/v3/smtp/email HTTP/1.1' });
    emit({ type:'log', level:'header', text: 'host: api.brevo.com' });
    emit({ type:'log', level:'header', text: `api-key: ${redactKey(apiKey)}` });
    emit({ type:'log', level:'header', text: 'content-type: application/json' });
    emit({ type:'log', level:'header', text: 'accept: application/json' });
    emit({ type:'log', level:'send',   text: '{' });
    emit({ type:'log', level:'send',   text: `  "sender":      { "name": "${escJsonStr(fromName)}", "email": "${escJsonStr(fromEmail)}" },` });
    emit({ type:'log', level:'send',   text: `  "to":          [{ "email": "${escJsonStr(to)}" }],` });
    emit({ type:'log', level:'send',   text: `  "replyTo":     { "email": "${escJsonStr(replyToEmail)}", "name": "${escJsonStr(replyToName)}" },` });
    emit({ type:'log', level:'send',   text: `  "subject":     "${escJsonStr(subject)}",` });
    emit({ type:'log', level:'send',   text: `  "htmlContent": "<table>…" (${html.length} bytes),` });
    emit({ type:'log', level:'send',   text: `  "textContent": "${escJsonStr(text.slice(0, 60))}…" (${text.length} bytes)` });
    emit({ type:'log', level:'send',   text: '}' });
  }

  const t0 = Date.now();
  const r = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'api-key':      apiKey,
      'content-type': 'application/json',
      'accept':       'application/json',
    },
    body: JSON.stringify(payload),
  });
  const dt = Date.now() - t0;

  if (emit) {
    emit({ type:'log', level:'recv',   text: `HTTP/1.1 ${r.status} ${r.statusText || ''}  (${dt} ms)` });
    for (const [k, v] of r.headers) {
      if (['content-type','date','x-mailin-message-id','x-mailin-request-id','x-sib-id'].includes(k.toLowerCase())) {
        emit({ type:'log', level:'header', text: `${k}: ${v}` });
      }
    }
  }

  if (!r.ok) {
    const body = await r.text().catch(() => '');
    if (emit) emit({ type:'log', level:'err', text: `body: ${body.slice(0, 400)}` });
    throw new Error(`Brevo API ${r.status}: ${body.slice(0, 300)}`);
  }

  const body = await r.json().catch(() => ({}));
  if (emit) {
    if (body && body.messageId) emit({ type:'log', level:'recv', text: `{ "messageId": "${body.messageId}" }` });
    else emit({ type:'log', level:'recv', text: '{ }' });
  }
}

/* ----- SSE streaming helpers ---------------------------------------------
 *
 * The /submit-stream endpoint emits Server-Sent Events as the pipeline runs
 * (validate → geo → persist → mail). Each event is one JSON object on a
 * "data:" line. Nodemailer's debug:true wire log is forwarded verbatim so
 * the user sees the real SMTP conversation (EHLO/STARTTLS/AUTH/MAIL FROM…)
 * in real time. SMTP timeouts capped so a blocked port fails in ~10s
 * instead of hanging the connection until the browser gives up.
 */
function escSql(v) {
  return String(v ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n');
}

function sseEmit(res, event) {
  if (res.writableEnded || res.closed) return;
  try { res.write(`data: ${JSON.stringify(event)}\n\n`); } catch (_) {}
}

function fmtArgs(args) {
  if (!args || args.length === 0) return '';
  try { return utilFormat(...args).replace(/\s+$/, ''); }
  catch { return args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' '); }
}

async function sendViaSmtpStreaming({ from, to, replyTo, replyToName, subject, text, html, emit }) {
  const { default: nodemailer } = await import('nodemailer');
  const host = process.env.EMAIL_SMTP_HOST;
  const port = parseInt(process.env.EMAIL_SMTP_PORT || '587', 10);
  const secure = String(process.env.EMAIL_SMTP_SECURE || 'false').toLowerCase() === 'true';
  const user = process.env.EMAIL_SMTP_USER;
  const pass = process.env.EMAIL_SMTP_PASSWORD;

  emit({ type: 'log', level: 'info', text: `Build transporter → ${host}:${port} secure=${secure} auth=${user ? 'login' : 'none'}` });

  const transporter = nodemailer.createTransport({
    host, port, secure,
    auth: user && pass ? { user, pass } : undefined,
    connectionTimeout: 10000,
    greetingTimeout:   10000,
    socketTimeout:     30000,
    logger: {
      level: 'debug',
      debug: (_meta, ...args) => emit({ type:'log', level:'wire', text: fmtArgs(args) }),
      info:  (_meta, ...args) => emit({ type:'log', level:'info', text: fmtArgs(args) }),
      warn:  (_meta, ...args) => emit({ type:'log', level:'warn', text: fmtArgs(args) }),
      error: (_meta, ...args) => emit({ type:'log', level:'err',  text: fmtArgs(args) }),
      trace: (_meta, ...args) => emit({ type:'log', level:'wire', text: fmtArgs(args) }),
      fatal: (_meta, ...args) => emit({ type:'log', level:'err',  text: fmtArgs(args) }),
    },
    debug: true,
  });

  const result = await transporter.sendMail({
    from,
    to,
    replyTo: replyToName ? `"${replyToName}" <${replyTo}>` : replyTo,
    subject, text, html,
  });
  emit({ type: 'log', level: 'ok', text: `Accepted: ${(result.response || 'ok').replace(/\s+/g, ' ').slice(0, 200)}` });
  if (result.messageId) emit({ type: 'log', level: 'info', text: `Message-ID: ${result.messageId}` });
}

function registerRoutes(router, { services, getSchema, logger }) {
  const TO = process.env.CONTACT_TO_EMAIL || process.env.ADMIN_EMAIL || '';
  const useBrevo = Boolean(process.env.BREVO_API_KEY && process.env.BREVO_FROM_EMAIL);
  if (!TO) {
    logger.warn('[contact-form] CONTACT_TO_EMAIL (or ADMIN_EMAIL fallback) not set — submissions will fail.');
  } else {
    logger.info(`[contact-form] mounted; submissions go to ${TO} via ${useBrevo ? 'Brevo API' : 'Directus mailer (SMTP)'}`);
  }

  router.post('/submit', async (req, res) => {
    try {
      const body = req.body || {};

      // Honeypot — bots fill `website`. Pretend success.
      if (typeof body.website === 'string' && body.website.trim() !== '') {
        return res.status(200).json({ ok: true });
      }

      const name    = s(body.name,    MAX.name);
      const email   = s(body.email,   MAX.email);
      const phone   = normalizePhone(s(body.phone, MAX.phone));
      const subject = s(body.subject, MAX.subject);
      const topic   = s(body.topic,   MAX.topic) || 'general';
      const message = s(body.message, MAX.message);

      if (!name || !email || !subject || !message) {
        return res.status(400).json({ error: 'Please fill in name, email, subject, and message.' });
      }
      if (!EMAIL_RE.test(email)) {
        return res.status(400).json({ error: 'Please enter a valid email address.' });
      }

      const ip =
        (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
        req.ip ||
        req.socket?.remoteAddress ||
        'unknown';

      if (rateLimited(ip)) {
        return res.status(429).json({ error: 'Too many submissions from this address. Please try again later.' });
      }

      const userAgent = (req.headers['user-agent'] || '').slice(0, 500);

      // Geo-IP enrichment (best effort — never blocks the request).
      const geo = await geoLookup(ip, logger);

      // 1) Persist FIRST so the submission is captured even if mail fails.
      const { ItemsService, MailService } = services;
      const schema = await getSchema();
      // accountability:null = run as system; the Public role doesn't get
      // write permission on this collection.
      const items = new ItemsService(COLLECTION, { schema, accountability: null });

      let recordId = null;
      try {
        recordId = await items.createOne({
          status: 'pending',
          name,
          email,
          phone: phone || null,
          topic,
          subject,
          message,
          ip,
          user_agent: userAgent,
          email_delivered: false,
          ...(geo || {}),
        });
      } catch (dbErr) {
        logger.error(`[contact-form] DB insert failed: ${dbErr && dbErr.message ? dbErr.message : dbErr}`);
        return res.status(500).json({ error: 'We could not save your message right now. Please try again later.' });
      }

      // 2) Send notification email (best-effort).
      const topicLabel = TOPIC_LABELS[topic] || topic;
      const safeSubject = `[Contact] ${subject}`;
      const text =
        `New contact form submission\n\n` +
        `Topic:   ${topicLabel}\n` +
        `Name:    ${name}\n` +
        `Email:   ${email}\n` +
        (phone ? `Phone:   ${phone}\n` : '') +
        `Subject: ${subject}\n` +
        `IP:      ${ip}\n\n` +
        `--- Message ---\n${message}\n`;

      const html =
        `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;line-height:1.55;color:#222;max-width:640px;">` +
          `<h2 style="margin:0 0 16px;font-size:18px;color:#0a0a0a;">New contact form submission</h2>` +
          `<table style="border-collapse:collapse;width:100%;margin-bottom:18px;font-size:14px;">` +
            `<tr><td style="padding:6px 10px;background:#f7f7f7;font-weight:600;width:90px;">Topic</td><td style="padding:6px 10px;background:#fff;">${escapeHtml(topicLabel)}</td></tr>` +
            `<tr><td style="padding:6px 10px;background:#f7f7f7;font-weight:600;">Name</td><td style="padding:6px 10px;background:#fff;">${escapeHtml(name)}</td></tr>` +
            `<tr><td style="padding:6px 10px;background:#f7f7f7;font-weight:600;">Email</td><td style="padding:6px 10px;background:#fff;"><a href="mailto:${escapeHtml(email)}">${escapeHtml(email)}</a></td></tr>` +
            (phone ? `<tr><td style="padding:6px 10px;background:#f7f7f7;font-weight:600;">Phone</td><td style="padding:6px 10px;background:#fff;">${escapeHtml(phone)}</td></tr>` : '') +
            `<tr><td style="padding:6px 10px;background:#f7f7f7;font-weight:600;">Subject</td><td style="padding:6px 10px;background:#fff;">${escapeHtml(subject)}</td></tr>` +
            `<tr><td style="padding:6px 10px;background:#f7f7f7;font-weight:600;">IP</td><td style="padding:6px 10px;background:#fff;color:#888;font-size:12px;">${escapeHtml(ip)}</td></tr>` +
          `</table>` +
          `<div style="border-left:3px solid #38bdf8;padding:8px 14px;background:#f0f9ff;white-space:pre-wrap;">${escapeHtml(message)}</div>` +
        `</div>`;

      let mailErrMsg = null;
      if (!TO) {
        mailErrMsg = 'CONTACT_TO_EMAIL (and ADMIN_EMAIL fallback) not configured';
      } else {
        try {
          if (useBrevo) {
            await sendViaBrevo({
              to: TO,
              replyToEmail: email,
              replyToName:  name,
              subject:      safeSubject,
              text,
              html,
            });
          } else {
            const mail = new MailService({ schema });
            await mail.send({
              to:      TO,
              replyTo: email,
              subject: safeSubject,
              text,
              html,
            });
          }
        } catch (mailErr) {
          mailErrMsg = (mailErr && mailErr.message) ? mailErr.message : String(mailErr);
        }
      }

      // 3) Reflect delivery outcome on the row.
      try {
        await items.updateOne(recordId, {
          email_delivered: !mailErrMsg,
          email_error:     mailErrMsg ? mailErrMsg.slice(0, 500) : null,
        });
      } catch (updErr) {
        logger.warn(`[contact-form] couldn't update delivery status on #${recordId}: ${updErr && updErr.message ? updErr.message : updErr}`);
      }

      if (mailErrMsg) {
        logger.warn(`[contact-form] saved #${recordId} from ${email} but mail failed: ${mailErrMsg}`);
      } else {
        logger.info(`[contact-form] saved #${recordId} from ${email} (${topic}) and notified via ${useBrevo ? 'Brevo' : 'SMTP'}`);
      }

      // Always tell the submitter we got the message — the row is in the
      // database either way, and Sarah's team will see the delivery flag.
      return res.status(200).json({ ok: true, id: recordId });
    } catch (err) {
      logger.error(`[contact-form] handler error: ${err && err.message ? err.message : err}`);
      return res.status(500).json({ error: 'Unexpected error. Please try again later.' });
    }
  });

  // ---------------------------------------------------------------------------
  // POST /submit-stream — same pipeline as /submit but emits SSE events so the
  // client can render a live terminal of the SMTP conversation. Same DB write,
  // same Brevo/SMTP branching, same rate limit. Final `done` event carries the
  // success/failure verdict.
  router.post('/submit-stream', async (req, res) => {
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

    let recordId = null;
    let mailErrMsg = null;

    try {
      const body = req.body || {};

      if (typeof body.website === 'string' && body.website.trim() !== '') {
        log('ok', 'Honeypot tripped — silently succeeded');
        emit({ type: 'done', ok: true });
        return res.end();
      }

      // -------- Stage 1: Validate ------------------------------------------
      stage(1, 'Validate request');
      log('prompt', 'validate POST /contact-form/submit-stream');

      const name    = s(body.name,    MAX.name);
      const email   = s(body.email,   MAX.email);
      const phone   = normalizePhone(s(body.phone, MAX.phone));
      const subject = s(body.subject, MAX.subject);
      const topic   = s(body.topic,   MAX.topic) || 'general';
      const message = s(body.message, MAX.message);

      log('ok', `name    "${name}"`);
      log('ok', `email   "${email}"`);
      if (phone) log('ok', `phone   ${phone}`);
      log('ok', `topic   ${topic}`);
      log('ok', `subject "${subject}"`);
      log('ok', `message ${message.length} chars`);

      if (!name || !email || !subject || !message) {
        log('err', 'missing required fields');
        emit({ type: 'done', ok: false, error: 'Please fill in name, email, subject, and message.' });
        return res.end();
      }
      if (!EMAIL_RE.test(email)) {
        log('err', `invalid email syntax: ${email}`);
        emit({ type: 'done', ok: false, error: 'Please enter a valid email address.' });
        return res.end();
      }

      const ip =
        (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
        req.ip ||
        req.socket?.remoteAddress ||
        'unknown';
      const userAgent = (req.headers['user-agent'] || '').slice(0, 500);
      log('info', `source ip: ${ip}`);

      if (rateLimited(ip)) {
        log('err', 'rate limit exceeded (5/hour/IP)');
        emit({ type: 'done', ok: false, error: 'Too many submissions from this address. Please try again later.' });
        return res.end();
      }

      // -------- Stage 2: GeoIP ---------------------------------------------
      stage(2, 'GeoIP enrichment');
      log('prompt', `geoip ${ip} < /var/lib/GeoIP/GeoLite2-City.mmdb`);
      const geo = await geoLookup(ip, logger);
      if (geo && (geo.geo_country_name || geo.geo_city)) {
        log('recv', `country: ${geo.geo_country_name || '∅'}`);
        if (geo.geo_region) log('recv', `region:  ${geo.geo_region}`);
        if (geo.geo_city)   log('recv', `city:    ${geo.geo_city}`);
        if (geo.geo_postal) log('recv', `postal:  ${geo.geo_postal}`);
        if (geo.geo_timezone) log('recv', `tz:      ${geo.geo_timezone}`);
        if (geo.geo_lat != null) log('recv', `coords:  ${geo.geo_lat}, ${geo.geo_lon}`);
      } else {
        log('info', 'no enrichment (private IP or no match)');
      }

      // -------- Stage 3: Persist -------------------------------------------
      stage(3, 'Persist to MariaDB');
      log('prompt', 'mariadb keltus_cms (127.0.0.1:3306)');

      const cols = [
        ['status', `'pending'`],
        ['name', `'${escSql(name)}'`],
        ['email', `'${escSql(email)}'`],
        ['phone', phone ? `'${escSql(phone)}'` : 'NULL'],
        ['topic', `'${escSql(topic)}'`],
        ['subject', `'${escSql(subject)}'`],
        ['message', `'${escSql(message.length > 60 ? message.slice(0, 57) + '…' : message)}'`],
        ['ip', `'${escSql(ip)}'`],
        ['user_agent', `'${escSql(userAgent.length > 40 ? userAgent.slice(0, 37) + '…' : userAgent)}'`],
        ['email_delivered', '0'],
      ];
      if (geo) {
        for (const k of Object.keys(geo)) {
          const v = geo[k];
          if (v == null) continue;
          cols.push([k, typeof v === 'number' ? String(v) : `'${escSql(v)}'`]);
        }
      }
      log('sql', 'INSERT INTO contact_requests');
      log('sql', `  (${cols.map(c => c[0]).join(', ')})`);
      log('sql', 'VALUES');
      log('sql', `  (${cols.map(c => c[1]).join(', ')});`);

      const { ItemsService } = services;
      const schema = await getSchema();
      const items = new ItemsService(COLLECTION, { schema, accountability: null });

      const tDb0 = Date.now();
      try {
        recordId = await items.createOne({
          status: 'pending',
          name, email, phone: phone || null, topic, subject, message,
          ip, user_agent: userAgent, email_delivered: false,
          ...(geo || {}),
        });
        log('recv', `Query OK, 1 row affected (${Date.now() - tDb0} ms)  →  id = ${recordId}`);
      } catch (dbErr) {
        log('err', `DB insert failed: ${dbErr && dbErr.message ? dbErr.message : dbErr}`);
        emit({ type: 'done', ok: false, error: 'Could not save your message right now. Please try again later.' });
        return res.end();
      }

      // -------- Stage 4: Notify --------------------------------------------
      const topicLabel = TOPIC_LABELS[topic] || topic;
      const safeSubject = `[Contact] ${subject}`;
      const text =
        `New contact form submission\n\n` +
        `Topic:   ${topicLabel}\n` +
        `Name:    ${name}\n` +
        `Email:   ${email}\n` +
        (phone ? `Phone:   ${phone}\n` : '') +
        `Subject: ${subject}\n` +
        `IP:      ${ip}\n\n` +
        `--- Message ---\n${message}\n`;
      const html =
        `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;line-height:1.55;color:#222;max-width:640px;">` +
          `<h2 style="margin:0 0 16px;font-size:18px;color:#0a0a0a;">New contact form submission</h2>` +
          `<table style="border-collapse:collapse;width:100%;margin-bottom:18px;font-size:14px;">` +
            `<tr><td style="padding:6px 10px;background:#f7f7f7;font-weight:600;width:90px;">Topic</td><td style="padding:6px 10px;background:#fff;">${escapeHtml(topicLabel)}</td></tr>` +
            `<tr><td style="padding:6px 10px;background:#f7f7f7;font-weight:600;">Name</td><td style="padding:6px 10px;background:#fff;">${escapeHtml(name)}</td></tr>` +
            `<tr><td style="padding:6px 10px;background:#f7f7f7;font-weight:600;">Email</td><td style="padding:6px 10px;background:#fff;"><a href="mailto:${escapeHtml(email)}">${escapeHtml(email)}</a></td></tr>` +
            (phone ? `<tr><td style="padding:6px 10px;background:#f7f7f7;font-weight:600;">Phone</td><td style="padding:6px 10px;background:#fff;">${escapeHtml(phone)}</td></tr>` : '') +
            `<tr><td style="padding:6px 10px;background:#f7f7f7;font-weight:600;">Subject</td><td style="padding:6px 10px;background:#fff;">${escapeHtml(subject)}</td></tr>` +
            `<tr><td style="padding:6px 10px;background:#f7f7f7;font-weight:600;">IP</td><td style="padding:6px 10px;background:#fff;color:#888;font-size:12px;">${escapeHtml(ip)}</td></tr>` +
          `</table>` +
          `<div style="border-left:3px solid #38bdf8;padding:8px 14px;background:#f0f9ff;white-space:pre-wrap;">${escapeHtml(message)}</div>` +
        `</div>`;

      const TO = process.env.CONTACT_TO_EMAIL || process.env.ADMIN_EMAIL || '';
      const useBrevo = Boolean(process.env.BREVO_API_KEY && process.env.BREVO_FROM_EMAIL);
      if (!TO) {
        stage(4, 'Notify (skipped — no recipient)');
        mailErrMsg = 'CONTACT_TO_EMAIL (and ADMIN_EMAIL fallback) not configured';
        log('err', mailErrMsg);
      } else if (useBrevo) {
        stage(4, 'Notify via Brevo HTTPS API');
        try {
          await sendViaBrevo({ to: TO, replyToEmail: email, replyToName: name, subject: safeSubject, text, html, emit });
          log('ok', 'Brevo accepted the message');
        } catch (e) {
          mailErrMsg = (e && e.message) ? e.message : String(e);
          log('err', `Brevo error: ${mailErrMsg}`);
        }
      } else {
        stage(4, `Notify via SMTP (${process.env.EMAIL_SMTP_HOST}:${process.env.EMAIL_SMTP_PORT || 587})`);
        try {
          await sendViaSmtpStreaming({
            from: process.env.EMAIL_FROM || process.env.EMAIL_SMTP_USER,
            to: TO,
            replyTo: email,
            replyToName: name,
            subject: safeSubject,
            text, html,
            emit,
          });
        } catch (e) {
          mailErrMsg = (e && e.message) ? e.message : String(e);
          log('err', `SMTP error: ${mailErrMsg}`);
        }
      }

      // -------- Stage 5: Reflect on the row --------------------------------
      stage(5, 'Update delivery flag');
      log('sql', `UPDATE contact_requests SET email_delivered = ${mailErrMsg ? '0' : '1'},`);
      log('sql', `       email_error = ${mailErrMsg ? `'${escSql((mailErrMsg).slice(0, 60))}…'` : 'NULL'}`);
      log('sql', `WHERE id = ${recordId};`);
      try {
        const tU0 = Date.now();
        await items.updateOne(recordId, {
          email_delivered: !mailErrMsg,
          email_error:     mailErrMsg ? mailErrMsg.slice(0, 500) : null,
        });
        log('recv', `Query OK, 1 row affected (${Date.now() - tU0} ms)`);
      } catch (updErr) {
        log('warn', `update failed: ${updErr && updErr.message ? updErr.message : updErr}`);
      }

      if (mailErrMsg) {
        logger.warn(`[contact-form/stream] saved #${recordId} from ${email} but mail failed: ${mailErrMsg}`);
      } else {
        logger.info(`[contact-form/stream] saved #${recordId} from ${email} (${topic}) and notified`);
      }

      emit({ type: 'done', ok: !mailErrMsg, id: recordId, error: mailErrMsg || undefined });
    } catch (err) {
      log('err', `Unexpected error: ${err && err.message ? err.message : err}`);
      emit({ type: 'done', ok: false, error: 'Unexpected error.', id: recordId });
    } finally {
      try { res.end(); } catch (_) {}
    }
  });
}

// Object-form export pins the public mount point to /contact-form/
// regardless of the package name. Public URL via nginx:
//   POST https://dev.gnews.cz/cms/contact-form/submit
export default {
  id: 'contact-form',
  handler: registerRoutes,
};
