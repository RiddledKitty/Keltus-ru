# directus-extension-rebuild-hook

Fires the static-site rebuild listener when content collections change in
Directus. Replaces the equivalent Directus Flow because Flow event-hook
registration is unreliable on some Directus 11 versions — hook extensions
are loaded as code at boot and register deterministically.

## Watched collections

`article`, `show`, `affiliate_product`, `sponsor`, `site_config`,
`homepage_block`, `guest`.

## Required env (set in `cms/.env`)

- `REBUILD_SECRET` — Bearer token the listener checks (same value as the
  listener's own `REBUILD_SECRET`). Without this set the hook logs a
  warning at boot and does nothing.
- `REBUILD_URL` — optional, defaults to `http://127.0.0.1:4327/rebuild`.

## Build

```bash
npm install
npm run build
```

Then restart Directus. Hook fires within ~2s of any save (debounced —
multiple saves in a row coalesce into one rebuild request).
