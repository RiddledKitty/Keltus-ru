/**
 * Rebuild Site — panel that lets an admin trigger the static-site rebuild
 * listener with one click and shows the last-build status.
 *
 * Backend is /rebuild-trigger/* (the directus-extension-rebuild-trigger
 * endpoint extension); browser auth is the user's existing Directus session
 * (sent via fetch credentials:'include').
 */

import { defineComponent, h, ref, onMounted, onUnmounted, computed } from 'vue';

const Panel = defineComponent({
  setup() {
    const status     = ref(null);   // { ok, running, queued, lastFinishedAt, lastDurationMs, lastExitCode, lastPurge }
    const error      = ref(null);
    const triggering = ref(false);
    let pollTimer = null;

    async function fetchStatus() {
      try {
        const r = await fetch('/rebuild-trigger/status', { credentials: 'include' });
        if (!r.ok) {
          error.value = `status ${r.status}`;
          return;
        }
        status.value = await r.json();
        error.value = null;
      } catch (e) {
        error.value = e.message || String(e);
      }
    }

    async function trigger() {
      triggering.value = true;
      error.value = null;
      try {
        const r = await fetch('/rebuild-trigger/trigger', {
          method: 'POST',
          credentials: 'include',
        });
        const body = await r.json().catch(() => ({}));
        if (!r.ok) {
          error.value = body.error || `error ${r.status}`;
        }
      } catch (e) {
        error.value = e.message || String(e);
      }
      triggering.value = false;
      // Fast-poll a few times so the UI catches the "running" state immediately
      for (let i = 0; i < 4; i++) {
        await new Promise(res => setTimeout(res, 600));
        await fetchStatus();
        if (status.value?.running) break;
      }
    }

    onMounted(() => {
      fetchStatus();
      pollTimer = setInterval(fetchStatus, 4000);
    });
    onUnmounted(() => {
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = null;
    });

    const running       = computed(() => Boolean(status.value?.running));
    const queued        = computed(() => Boolean(status.value?.queued));
    const lastOk        = computed(() => status.value?.lastExitCode === 0);
    const lastFinished  = computed(() => {
      if (!status.value?.lastFinishedAt) return null;
      const d = new Date(status.value.lastFinishedAt);
      return d.toLocaleString();
    });
    const lastDuration  = computed(() => {
      const ms = status.value?.lastDurationMs;
      if (!ms && ms !== 0) return null;
      return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
    });
    const cfStatus      = computed(() => {
      const cf = status.value?.lastPurge?.cloudflare;
      if (!cf) return null;
      if (cf.skipped) return `CDN purge skipped (${cf.reason || 'n/a'})`;
      if (cf.ok) return 'CDN cache purged';
      return 'CDN purge failed';
    });

    return () => h('div', {
      style: {
        boxSizing: 'border-box',
        height: '100%',
        padding: '20px 24px',
        display: 'flex',
        flexDirection: 'column',
        gap: '14px',
        justifyContent: 'center',
        fontFamily: 'inherit',
      },
    }, [
      // Header row — title + status pill
      h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' } }, [
        h('strong', { style: { fontSize: '15px' } }, 'Rebuild the static site'),
        running.value
          ? h('span', { style: pillStyle('#fbbf24') }, queued.value ? 'Queued · building' : 'Building…')
          : status.value === null
            ? h('span', { style: pillStyle('#94a3b8') }, error.value ? 'Listener offline' : '…')
            : lastOk.value
              ? h('span', { style: pillStyle('#10b981') }, '✓ Last build OK')
              : h('span', { style: pillStyle('#f43f5e') }, `Exit ${status.value?.lastExitCode ?? '?'}`),
      ]),

      // Description
      h('p', {
        style: { margin: '0', color: 'var(--foreground-subdued, #94a3b8)', fontSize: '13px', lineHeight: '1.55' },
      }, 'Force the front-end to rebuild now. Normally this happens automatically a couple of seconds after you save content — use this if you bypassed the watched collections or just want to redeploy.'),

      // Button
      h('button', {
        type: 'button',
        onClick: trigger,
        disabled: triggering.value || running.value || error.value === 'admin required',
        style: {
          padding: '11px 18px',
          background: (triggering.value || running.value)
            ? 'var(--background-subdued, #1a212e)'
            : 'var(--primary, #38bdf8)',
          color: (triggering.value || running.value)
            ? 'var(--foreground-subdued, #94a3b8)'
            : '#04111c',
          border: '0',
          borderRadius: '6px',
          fontFamily: 'inherit',
          fontWeight: '700',
          fontSize: '13.5px',
          cursor: (triggering.value || running.value) ? 'wait' : 'pointer',
          transition: 'opacity .2s ease, background .2s ease',
          alignSelf: 'flex-start',
        },
      }, triggering.value
          ? 'Triggering…'
          : running.value
            ? 'Rebuild in progress'
            : 'Rebuild now'),

      // Last-build line
      lastFinished.value && h('p', {
        style: { margin: '0', color: 'var(--foreground-subdued, #94a3b8)', fontSize: '11.5px', fontFamily: 'var(--family-monospace, monospace)' },
      }, [
        `Last build: ${lastFinished.value}`,
        lastDuration.value ? ` · ${lastDuration.value}` : '',
        cfStatus.value ? ` · ${cfStatus.value}` : '',
      ].join('')),

      // Error
      error.value && h('p', {
        style: { margin: '0', color: 'var(--danger, #f43f5e)', fontSize: '12px' },
      }, error.value),
    ]);
  },
});

function pillStyle(color) {
  return {
    fontSize: '11px',
    fontFamily: 'var(--family-monospace, monospace)',
    fontWeight: '700',
    letterSpacing: '0.04em',
    textTransform: 'uppercase',
    color,
    border: `1px solid ${color}`,
    padding: '3px 8px',
    borderRadius: '999px',
    whiteSpace: 'nowrap',
  };
}

export default {
  id: 'rebuild-button',
  name: 'Rebuild Site',
  icon: 'refresh',
  description: 'One-click manual trigger for the static-site rebuild listener.',
  component: Panel,
  options: [],
  minWidth: 16,
  minHeight: 8,
};
