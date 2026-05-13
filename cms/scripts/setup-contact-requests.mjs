#!/usr/bin/env node
/**
 * Idempotent bootstrap for the `contact_requests` collection +
 * default Directus preset (filter / sort / column layout).
 *
 *   DIRECTUS_URL=http://localhost:8055 \
 *   DIRECTUS_TOKEN=... \
 *   node cms/scripts/setup-contact-requests.mjs
 *
 * Or with admin email/password in lieu of a token (matches sibling
 * scripts under cms/scripts/).
 */

const URL_BASE = process.env.DIRECTUS_URL || 'http://localhost:8055';
const EMAIL    = process.env.ADMIN_EMAIL  || 'john@local.dev';
const PASSWORD = process.env.ADMIN_PASSWORD || 'changeme-on-first-login';

let token = process.env.DIRECTUS_TOKEN || '';

async function login() {
  if (token) {
    console.log(`✓ Using DIRECTUS_TOKEN`);
    return;
  }
  const r = await fetch(`${URL_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!r.ok) throw new Error(`Login failed: ${r.status} ${await r.text()}`);
  const j = await r.json();
  token = j.data.access_token;
  console.log(`✓ Logged in as ${EMAIL}`);
}

async function dx(method, path, body) {
  const r = await fetch(`${URL_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 204) return null;
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = j.errors?.[0]?.message || JSON.stringify(j).slice(0, 300);
    throw Object.assign(new Error(`${method} ${path} → ${r.status}: ${msg}`), { status: r.status, body: j });
  }
  return j;
}

const COLLECTION = 'contact_requests';

/* Status workflow shared between (a) the dropdown's choices and
 * (b) the display's labels, so colors line up in the edit form AND
 * in the tabular list view. */
const STATUS_CHOICES = [
  { text: 'Pending',     value: 'pending',     color: '#3B82F6', icon: 'schedule'             }, // blue
  { text: 'In review',   value: 'in_review',   color: '#F59E0B', icon: 'visibility'           }, // amber
  { text: 'Contacted',   value: 'contacted',   color: '#10B981', icon: 'mark_email_read'      }, // green
  { text: 'Replied',     value: 'replied',     color: '#14B8A6', icon: 'forum'                }, // teal
  { text: 'In progress', value: 'in_progress', color: '#F97316', icon: 'autorenew'            }, // orange
  { text: 'Spam',        value: 'spam',        color: '#6B7280', icon: 'report'               }, // grey
  { text: 'Rejected',    value: 'rejected',    color: '#EF4444', icon: 'block'                }, // red
  { text: 'Archived',    value: 'archived',    color: '#94A3B8', icon: 'inventory_2'          }, // slate (soft-delete bucket)
];

const TOPIC_CHOICES = [
  { text: 'General',                     value: 'general'     },
  { text: 'New project / build',         value: 'new-build'   },
  { text: 'Quote request',               value: 'quote'       },
  { text: 'Partnership / collaboration', value: 'partnership' },
  { text: 'Press / media',               value: 'press'       },
  { text: 'Site / technical issue',      value: 'technical'   },
];

async function ensureCollection() {
  try {
    await dx('GET', `/collections/${COLLECTION}`);
    console.log(`· collection "${COLLECTION}" already exists`);
    return false;
  } catch (e) {
    if (e.status !== 403 && e.status !== 404) throw e;
  }

  await dx('POST', '/collections', {
    collection: COLLECTION,
    meta: {
      icon: 'contact_mail',
      note: 'Submissions from the public /contact/ form. Status drives the workflow; "archived" hides rows from default views (soft delete) but they stay queryable.',
      hidden: false,
      singleton: false,
      sort_field: null,
      archive_field: 'status',
      archive_value: 'archived',
      unarchive_value: 'pending',
      collection: COLLECTION,
      display_template: '{{ name }} — {{ subject }}',
    },
    schema: { name: COLLECTION },
    fields: [
      {
        field: 'id',
        type: 'integer',
        schema: { is_primary_key: true, has_auto_increment: true },
        meta: { hidden: true, interface: 'input', readonly: true },
      },
    ],
  });
  console.log(`+ created collection "${COLLECTION}"`);
  return true;
}

async function ensureField(field, type, schema = {}, meta = {}) {
  try {
    await dx('GET', `/fields/${COLLECTION}/${field}`);
    return false;
  } catch (e) {
    if (e.status !== 403 && e.status !== 404) throw e;
  }
  await dx('POST', `/fields/${COLLECTION}`, {
    field,
    type,
    schema: { name: field, ...schema },
    meta: { ...meta, field, collection: COLLECTION },
  });
  console.log(`  + ${field} (${type})`);
  return true;
}

/* Update the field's meta (interface, options, width, etc.) even when
 * the field already exists. ensureField only writes meta on create. */
async function patchFieldMeta(field, meta) {
  try {
    await dx('PATCH', `/fields/${COLLECTION}/${field}`, { meta });
  } catch (e) {
    if (e.status !== 404) {
      console.log(`  ! couldn't update meta on ${field}: ${e.message.slice(0, 120)}`);
    }
  }
}

/* Drop a field if it exists (for retiring fields between schema
 * iterations). Silent if already gone. */
async function dropFieldIfExists(field) {
  try {
    await dx('GET', `/fields/${COLLECTION}/${field}`);
  } catch (e) {
    if (e.status === 403 || e.status === 404) return;
    throw e;
  }
  try {
    await dx('DELETE', `/fields/${COLLECTION}/${field}`);
    console.log(`  - dropped ${field}`);
  } catch (e) {
    console.log(`  ! couldn't drop ${field}: ${e.message.slice(0, 120)}`);
  }
}

async function enforceFieldOrder(fieldsInOrder) {
  for (let i = 0; i < fieldsInOrder.length; i++) {
    const field = fieldsInOrder[i];
    try {
      await dx('PATCH', `/fields/${COLLECTION}/${field}`, {
        meta: { sort: (i + 1) * 10 },
      });
    } catch (e) {
      if (e.status !== 404) {
        console.log(`    ! couldn't reorder ${field}: ${e.message.slice(0, 80)}`);
      }
    }
  }
}

async function setupFields() {
  console.log(`\n→ ${COLLECTION} fields`);

  // Workflow status — drives archive (soft-delete) too
  await ensureField('status', 'string',
    { default_value: 'pending', is_nullable: false },
    {
      interface: 'select-dropdown',
      display: 'labels',
      options: { choices: STATUS_CHOICES, allowOther: false },
      display_options: { choices: STATUS_CHOICES, showAsDot: false, choiceLabels: false },
      special: null,
      width: 'half',
      note: 'Workflow state. "Archived" hides the row from default views.',
    });
  // Re-apply meta on existing fields too, so colour/options updates propagate.
  await patchFieldMeta('status', {
    interface: 'select-dropdown',
    display: 'labels',
    options: { choices: STATUS_CHOICES, allowOther: false },
    display_options: { choices: STATUS_CHOICES, showAsDot: false, choiceLabels: false },
    width: 'half',
    note: 'Workflow state. "Archived" hides the row from default views.',
  });

  // Submitter identity
  await ensureField('name', 'string',
    { is_nullable: false, max_length: 120 },
    { interface: 'input', width: 'half', note: 'Submitter name' });

  await ensureField('email', 'string',
    { is_nullable: false, max_length: 200 },
    { interface: 'input', display: 'formatted-value', width: 'half',
      options: { iconLeft: 'mail' } });

  await ensureField('phone', 'string',
    { is_nullable: true, max_length: 20 },
    { interface: 'input', width: 'half', display: 'phone-formatted',
      options: { iconLeft: 'phone', placeholder: '+15551234567' },
      note: 'Normalized E.164 (leading + and digits only).' });
  await patchFieldMeta('phone', {
    interface: 'input',
    display: 'phone-formatted',
    options: { iconLeft: 'phone', placeholder: '+15551234567' },
    width: 'half',
    note: 'Normalized E.164 (leading + and digits only). Displayed with readable spacing.',
  });

  await ensureField('topic', 'string',
    { is_nullable: false, default_value: 'general', max_length: 60 },
    {
      interface: 'select-dropdown',
      display: 'labels',
      options: { choices: TOPIC_CHOICES, allowOther: false },
      display_options: { choices: TOPIC_CHOICES, showAsDot: false, choiceLabels: true },
      width: 'half',
    });
  await patchFieldMeta('topic', {
    interface: 'select-dropdown',
    display: 'labels',
    options: { choices: TOPIC_CHOICES, allowOther: false },
    display_options: { choices: TOPIC_CHOICES, showAsDot: false, choiceLabels: true },
    width: 'half',
  });

  await ensureField('subject', 'string',
    { is_nullable: false, max_length: 200 },
    { interface: 'input', width: 'full' });

  await ensureField('message', 'text',
    { is_nullable: false },
    { interface: 'input-multiline', width: 'full' });

  // Internal admin notes (not from public form)
  await ensureField('admin_notes', 'text',
    { is_nullable: true },
    { interface: 'input-multiline', width: 'full',
      note: 'Private notes — never shown to the submitter.' });

  // Audit metadata
  await ensureField('ip', 'string',
    { is_nullable: true, max_length: 64 },
    { interface: 'input', width: 'half', readonly: true,
      note: 'Submitter IP at time of submission' });

  await ensureField('user_agent', 'text',
    { is_nullable: true },
    { interface: 'input-multiline', width: 'full', readonly: true });

  // Did the email actually deliver?
  await ensureField('email_delivered', 'boolean',
    { default_value: false, is_nullable: false },
    { interface: 'boolean', special: ['cast-boolean'], width: 'half',
      note: 'true if Brevo / SMTP accepted the message' });

  await ensureField('email_error', 'text',
    { is_nullable: true },
    { interface: 'input-multiline', width: 'full', readonly: true,
      note: 'Last delivery error, if any' });

  // Geo enrichment — derived from IP via GeoLite2-City at submission time.
  // Column names keep the geo_ prefix (internal), but the form labels are
  // overridden via translations so the UI shows the friendly names.
  const enLabel = (label) => ({ translations: [{ language: 'en-US', translation: label }] });

  // Drop the legacy ISO-code field if a previous setup created it.
  await dropFieldIfExists('geo_country');

  await ensureField('geo_country_name', 'string',
    { is_nullable: true, max_length: 120 },
    { interface: 'input', width: 'half', readonly: true });
  await patchFieldMeta('geo_country_name', { ...enLabel('Country'), width: 'half', readonly: true, note: null });

  await ensureField('geo_region', 'string',
    { is_nullable: true, max_length: 120 },
    { interface: 'input', width: 'half', readonly: true });
  await patchFieldMeta('geo_region', { ...enLabel('Region'), width: 'half', readonly: true, note: 'State / region / subdivision' });

  await ensureField('geo_city', 'string',
    { is_nullable: true, max_length: 120 },
    { interface: 'input', width: 'half', readonly: true });
  await patchFieldMeta('geo_city', { ...enLabel('City'), width: 'half', readonly: true });

  await ensureField('geo_postal', 'string',
    { is_nullable: true, max_length: 32 },
    { interface: 'input', width: 'half', readonly: true });
  await patchFieldMeta('geo_postal', { ...enLabel('Postal'), width: 'half', readonly: true });

  await ensureField('geo_timezone', 'string',
    { is_nullable: true, max_length: 64 },
    { interface: 'input', width: 'half', readonly: true });
  await patchFieldMeta('geo_timezone', { ...enLabel('Timezone'), width: 'half', readonly: true, note: 'IANA timezone, e.g. "Europe/Prague"' });

  await ensureField('geo_lat', 'float',
    { is_nullable: true },
    { interface: 'input', width: 'half', readonly: true });
  await patchFieldMeta('geo_lat', { ...enLabel('Lat'), width: 'half', readonly: true, note: 'GeoLite2 city centroid (~50 km accuracy)' });

  await ensureField('geo_lon', 'float',
    { is_nullable: true },
    { interface: 'input', width: 'half', readonly: true });
  await patchFieldMeta('geo_lon', { ...enLabel('Lon'), width: 'half', readonly: true });

  // Built-in audit fields
  await ensureField('date_created', 'timestamp',
    { is_nullable: true },
    { special: ['date-created'], interface: 'datetime', readonly: true, hidden: false, width: 'half' });

  await ensureField('date_updated', 'timestamp',
    { is_nullable: true },
    { special: ['date-updated'], interface: 'datetime', readonly: true, hidden: false, width: 'half' });

  // Visual sectioning of the edit form
  await ensureDivider('div_message',  'Message');
  await ensureDivider('div_internal', 'Internal');
  await ensureDivider('div_audit',    'Audit metadata', '#94A3B8');
  await ensureDivider('div_geo',      'Location (from IP)',  '#94A3B8');
  // Re-title the divider on existing collections too.
  await patchFieldMeta('div_geo', { options: { title: 'Location (from IP)', color: '#94A3B8' } });

  await enforceFieldOrder([
    'status',
    'date_created',
    'name',
    'email',
    'phone',
    'topic',
    'div_message',
    'subject',
    'message',
    'div_internal',
    'admin_notes',
    'email_delivered',
    'email_error',
    'div_audit',
    'ip',
    'user_agent',
    'date_updated',
    'div_geo',
    'geo_country_name',
    'geo_region',
    'geo_city',
    'geo_postal',
    'geo_timezone',
    'geo_lat',
    'geo_lon',
  ]);
}

async function ensureDivider(field, title, color) {
  try {
    await dx('GET', `/fields/${COLLECTION}/${field}`);
    return false;
  } catch (e) {
    if (e.status !== 403 && e.status !== 404) throw e;
  }
  await dx('POST', `/fields/${COLLECTION}`, {
    field,
    type: 'alias',
    meta: {
      interface: 'presentation-divider',
      special: ['alias', 'no-data'],
      options: color ? { title, color } : { title },
      width: 'full',
      hidden: false,
      readonly: false,
      collection: COLLECTION,
    },
    schema: null,
  });
  console.log(`  + ${field} (divider: ${title})`);
}

/* Default preset for everyone (role: null, user: null, bookmark: null
 * — a "global default"). Tabular layout, sortable columns, with the
 * Status / Topic / Name columns visible. Default sort is name asc.
 *
 * Idempotent: if a global default already exists for this collection,
 * we PATCH it instead of POSTing a duplicate. */
async function ensureDefaultPreset() {
  console.log(`\n→ default preset for ${COLLECTION}`);
  const existing = await dx(
    'GET',
    `/presets?filter[collection][_eq]=${COLLECTION}` +
      `&filter[user][_null]=true&filter[role][_null]=true&filter[bookmark][_null]=true&fields=id&limit=1`,
  );
  const layout = 'tabular';
  const layoutOptions = {
    tabular: {
      widths: {
        name: 180,
        email: 220,
        phone: 140,
        topic: 160,
        subject: 320,
        status: 140,
        date_created: 160,
      },
      fields: ['status', 'name', 'email', 'phone', 'topic', 'subject', 'date_created'],
    },
  };
  const layoutQuery = {
    tabular: {
      sort: ['-date_created'],
      page: 1,
      limit: 50,
      fields: ['status', 'name', 'email', 'phone', 'topic', 'subject', 'date_created'],
    },
  };
  const payload = {
    collection: COLLECTION,
    layout,
    layout_options: layoutOptions,
    layout_query: layoutQuery,
    /* Pre-pin Status + Topic as filter chips so they're one-click
     * accessible from the toolbar. Empty filter list = show everything
     * by default (apart from archived, which the archive_field hides). */
    filter: null,
    search: null,
  };
  if (existing?.data?.[0]) {
    await dx('PATCH', `/presets/${existing.data[0].id}`, payload);
    console.log(`· updated existing default preset`);
  } else {
    await dx('POST', '/presets', payload);
    console.log(`+ created default preset (tabular, newest first)`);
  }
}

/* Quick-filter bookmarks. Each one shows in the navigation sidebar
 * directly under "Contact Requests" with its own icon + colour and is
 * a single click away. Multi-status / multi-topic combos use the _in
 * operator so e.g. "Active" covers pending + in_review + in_progress
 * in one shortcut.
 *
 * Idempotent: keyed by bookmark name; existing bookmarks are PATCHed,
 * new ones are POSTed. */
const BOOKMARKS = [
  // Status shortcuts
  { name: 'Pending',          icon: 'schedule',         color: '#3B82F6',
    filter: { _and: [{ status: { _eq:  'pending' } }] } },
  { name: 'Active',           icon: 'pending_actions',  color: '#F59E0B',
    filter: { _and: [{ status: { _in: ['pending', 'in_review', 'in_progress'] } }] } },
  { name: 'Done',             icon: 'mark_email_read',  color: '#10B981',
    filter: { _and: [{ status: { _in: ['contacted', 'replied'] } }] } },
  { name: 'Trash',            icon: 'delete',           color: '#6B7280',
    filter: { _and: [{ status: { _in: ['spam', 'rejected'] } }] } },

  // Topic shortcuts
  { name: 'New builds',       icon: 'rocket_launch',    color: '#38BDF8',
    filter: { _and: [{ topic:  { _eq:  'new-build' } }] } },
  { name: 'Quote requests',   icon: 'request_quote',    color: '#F97316',
    filter: { _and: [{ topic:  { _eq:  'quote' } }] } },
  { name: 'Partnerships',     icon: 'handshake',        color: '#10B981',
    filter: { _and: [{ topic:  { _eq:  'partnership' } }] } },
  { name: 'Press inquiries',  icon: 'campaign',         color: '#3B82F6',
    filter: { _and: [{ topic:  { _eq:  'press' } }] } },
  { name: 'Technical',        icon: 'bug_report',       color: '#EF4444',
    filter: { _and: [{ topic:  { _eq:  'technical' } }] } },
];

async function ensureBookmarks() {
  console.log(`\n→ bookmarks for ${COLLECTION}`);
  const layoutQuery = {
    tabular: {
      sort: ['-date_created'],
      page: 1,
      limit: 50,
      fields: ['status', 'name', 'email', 'phone', 'topic', 'subject', 'date_created'],
    },
  };
  const layoutOptions = {
    tabular: {
      widths: { name: 180, email: 220, phone: 140, topic: 160, subject: 320, status: 140, date_created: 160 },
      fields: ['status', 'name', 'email', 'phone', 'topic', 'subject', 'date_created'],
    },
  };

  // Pull existing bookmarks for this collection so we can update by name.
  const existing = await dx(
    'GET',
    `/presets?filter[collection][_eq]=${COLLECTION}` +
      `&filter[bookmark][_nnull]=true&fields=id,bookmark&limit=200`,
  );
  const byName = new Map();
  for (const p of existing?.data || []) byName.set(p.bookmark, p.id);

  for (const b of BOOKMARKS) {
    const payload = {
      collection: COLLECTION,
      bookmark:   b.name,
      icon:       b.icon,
      color:      b.color,
      layout:     'tabular',
      layout_query:   layoutQuery,
      layout_options: layoutOptions,
      filter:     b.filter,
      // role/user null = visible to everyone in the org
      user: null,
      role: null,
    };
    if (byName.has(b.name)) {
      await dx('PATCH', `/presets/${byName.get(b.name)}`, payload);
      console.log(`  · updated bookmark "${b.name}"`);
    } else {
      await dx('POST', '/presets', payload);
      console.log(`  + created bookmark "${b.name}"`);
    }
  }
}

(async () => {
  console.log(`Setting up ${COLLECTION} at ${URL_BASE}`);
  await login();
  await ensureCollection();
  await setupFields();
  await ensureDefaultPreset();
  await ensureBookmarks();
  console.log('\n✔ Done.');
})().catch((e) => {
  console.error('FAILED:', e.stack || e.message);
  process.exit(1);
});
