/**
 * directus-extension-rebuild-hook
 *
 * Replaces the "Auto rebuild site" Directus Flow. Flows don't reliably
 * register event hooks on some Directus 11 versions (silent failure:
 * saves succeed, webhook never fires). Hook extensions are loaded as
 * code at boot, so registration is guaranteed.
 *
 * Watches WATCHED_COLLECTIONS for create/update/delete and POSTs the
 * rebuild listener, debounced ~2s so a flurry of edits = one rebuild.
 *
 * Required env (cms/.env):
 *   REBUILD_SECRET  — Bearer token the listener checks
 *   REBUILD_URL     — optional, default http://127.0.0.1:4327/rebuild
 *
 * Source-of-truth is dist/index.js (shipped as plain JS rather than a
 * TS build because the Directus SDK build pipeline has chicken-and-egg
 * validation that gets in the way of a one-file hook).
 */

const WATCHED_COLLECTIONS = [
  'project',
  'team_member',
  'testimonial',
  'technology',
  'site_config',
];

const REBUILD_URL = process.env.REBUILD_URL || 'http://127.0.0.1:4327/rebuild';
const REBUILD_SECRET = process.env.REBUILD_SECRET || '';
const DEBOUNCE_MS = 2000;

export default ({ action }, { logger }) => {
  if (!REBUILD_SECRET) {
    logger.warn('[rebuild-hook] REBUILD_SECRET not set — hook installed but will not fire. Add it to cms/.env.');
    return;
  }
  logger.info(`[rebuild-hook] watching ${WATCHED_COLLECTIONS.length} collections → ${REBUILD_URL}`);

  let debounceTimer = null;
  let pendingReasons = new Set();

  const trigger = (reason) => {
    pendingReasons.add(reason);
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
      const summary = [...pendingReasons].join(', ');
      pendingReasons = new Set();
      debounceTimer = null;
      try {
        const r = await fetch(REBUILD_URL, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${REBUILD_SECRET}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ source: 'directus-hook', reasons: summary }),
        });
        if (r.ok) {
          logger.info(`[rebuild-hook] triggered rebuild (${summary})`);
        } else {
          const body = await r.text().catch(() => '');
          logger.warn(`[rebuild-hook] listener returned ${r.status} (${summary}): ${body.slice(0, 200)}`);
        }
      } catch (e) {
        logger.warn(`[rebuild-hook] POST failed (${summary}): ${e && e.message ? e.message : e}`);
      }
    }, DEBOUNCE_MS);
  };

  for (const coll of WATCHED_COLLECTIONS) {
    action(`${coll}.items.create`, () => trigger(`${coll}:create`));
    action(`${coll}.items.update`, () => trigger(`${coll}:update`));
    action(`${coll}.items.delete`, () => trigger(`${coll}:delete`));
  }
};
