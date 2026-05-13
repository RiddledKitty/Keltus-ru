/**
 * directus-extension-rebuild-trigger
 *
 * Endpoint that proxies to the local rebuild listener so the admin UI
 * (panel extension) can show status and trigger a manual rebuild without
 * exposing the REBUILD_SECRET to the browser.
 *
 *   GET  /rebuild-trigger/status   — any authenticated user
 *   POST /rebuild-trigger/trigger  — admin only
 *
 * Env (already in cms/.env):
 *   REBUILD_URL     — e.g. http://127.0.0.1:4337/rebuild
 *   REBUILD_SECRET  — bearer the listener checks
 */

const REBUILD_URL    = process.env.REBUILD_URL    || 'http://127.0.0.1:4337/rebuild';
const REBUILD_SECRET = process.env.REBUILD_SECRET || '';
const HEALTH_URL     = REBUILD_URL.replace(/\/rebuild\/?$/, '/healthz');

function registerRoutes(router, { logger }) {
  if (!REBUILD_SECRET) {
    logger.warn('[rebuild-trigger] REBUILD_SECRET is empty — manual rebuild button will not work');
  } else {
    logger.info(`[rebuild-trigger] mounted; will POST to ${REBUILD_URL}`);
  }

  router.get('/status', async (req, res) => {
    if (!req.accountability?.user) {
      return res.status(403).json({ error: 'auth required' });
    }
    try {
      const r = await fetch(HEALTH_URL);
      const data = await r.json();
      return res.json(data);
    } catch (e) {
      return res.status(502).json({
        error: 'rebuild listener unreachable',
        detail: e && e.message ? e.message : String(e),
      });
    }
  });

  router.post('/trigger', async (req, res) => {
    if (!req.accountability?.admin) {
      return res.status(403).json({ error: 'admin required' });
    }
    try {
      const r = await fetch(REBUILD_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${REBUILD_SECRET}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          source: 'directus-button',
          user: req.accountability.user,
        }),
      });
      const body = await r.json().catch(() => ({}));
      if (r.ok) {
        logger.info(`[rebuild-trigger] manual rebuild requested by user ${req.accountability.user}`);
      }
      return res.status(r.status).json(body);
    } catch (e) {
      return res.status(502).json({
        error: 'rebuild listener unreachable',
        detail: e && e.message ? e.message : String(e),
      });
    }
  });
}

// Object-form export pins the mount point to /rebuild-trigger/* regardless
// of the package name (which is the long directus-extension-rebuild-trigger).
export default {
  id: 'rebuild-trigger',
  handler: registerRoutes,
};
