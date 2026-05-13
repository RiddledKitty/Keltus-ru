import { defineModule } from '@directus/extensions-sdk';
import ModuleComponent from './module.vue';

/**
 * Adds an "Analytics" entry to the Directus admin sidebar. The dashboard
 * fetches its data from the sarahanalytics Go service via the same
 * /api/analytics/* endpoints the public beacon uses.
 *
 * Auth: the request includes the Directus session cookie automatically
 * (same origin), and we attach a Bearer token (the static admin token from
 * .deploy-secrets) so the Go service can verify the caller. The token is
 * exposed to the extension at build time via the directus_settings.
 */
export default defineModule({
  id: 'analytics',
  name: 'Analytics',
  icon: 'analytics',
  routes: [
    {
      path: '',
      component: ModuleComponent,
    },
  ],
});
