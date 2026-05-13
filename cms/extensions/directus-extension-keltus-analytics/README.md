# directus-extension-keltus-analytics

Directus 11 module that adds an "Analytics" sidebar item showing
self-hosted page-view stats for keltus.io.

## Build

```sh
cd cms/extensions/directus-extension-keltus-analytics
npm install
npm run build
```

Output goes to `dist/index.js`. Directus auto-loads it on start.

## Develop

```sh
npm run dev
```

Watch-mode rebuild. Restart Directus to pick up changes.

## Where the data comes from

The component fetches from `/api/analytics/*` (proxied by nginx to the
keltusanalytics Go service on `127.0.0.1:4328`). Same origin as Directus
admin, so the request rides on the existing session cookie. The Go
service may require a Bearer token (`KELTUS_ANALYTICS_ADMIN_TOKEN`); when
set, the extension needs to send it via the `Authorization` header.
For dev we leave the token off in the service and rely on the nginx
proxy + Directus session for access control.
