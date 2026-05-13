#!/usr/bin/env node
/**
 * Idempotent bootstrap for keltus.ru content collections.
 *
 *   DIRECTUS_URL=http://localhost:8055 \
 *   ADMIN_EMAIL=john@local.dev \
 *   ADMIN_PASSWORD=changeme-on-first-login \
 *   node cms/scripts/setup-collections.mjs
 *
 * Or pass DIRECTUS_TOKEN instead of email+password.
 *
 * Creates four collections used by the public Astro site:
 *   - project       — case studies / portfolio items
 *   - team_member   — staff cards
 *   - testimonial   — client quotes (with rotating "featured" subset)
 *   - technology    — capabilities directory (powers /technologies page)
 *
 * Drag-to-reorder is wired via a `sort` field on each collection (Directus
 * uses this for the manual ordering interface — the public site reads
 * items ordered by `sort`).
 *
 * Same conventions as setup-contact-requests.mjs.
 */

const URL_BASE = process.env.DIRECTUS_URL || 'http://localhost:8057';
const EMAIL    = process.env.ADMIN_EMAIL  || 'admin@keltus.ru';
const PASSWORD = process.env.ADMIN_PASSWORD || 'changeme-on-first-login';

let token = process.env.DIRECTUS_TOKEN || '';

async function login() {
  if (token) { console.log('✓ Using DIRECTUS_TOKEN'); return; }
  const r = await fetch(`${URL_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!r.ok) throw new Error(`Login failed: ${r.status} ${await r.text()}`);
  token = (await r.json()).data.access_token;
  console.log(`✓ Logged in as ${EMAIL}`);
}

async function dx(method, path, body) {
  const r = await fetch(`${URL_BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 204) return null;
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = j.errors?.[0]?.message || JSON.stringify(j).slice(0, 300);
    throw Object.assign(new Error(`${method} ${path} → ${r.status}: ${msg}`), { status: r.status });
  }
  return j;
}

async function ensureCollection(name, meta) {
  try {
    await dx('GET', `/collections/${name}`);
    console.log(`· collection "${name}" already exists`);
    return false;
  } catch (e) {
    if (e.status !== 403 && e.status !== 404) throw e;
  }
  await dx('POST', '/collections', {
    collection: name,
    meta: { ...meta, collection: name, hidden: false, singleton: false },
    schema: { name },
    fields: [
      { field: 'id', type: 'integer',
        schema: { is_primary_key: true, has_auto_increment: true },
        meta:   { hidden: true, interface: 'input', readonly: true } },
    ],
  });
  console.log(`+ created collection "${name}"`);
  return true;
}

async function ensureField(collection, field, type, schema = {}, meta = {}) {
  try {
    await dx('GET', `/fields/${collection}/${field}`);
    return false;
  } catch (e) {
    if (e.status !== 403 && e.status !== 404) throw e;
  }
  await dx('POST', `/fields/${collection}`, {
    field, type,
    schema: { name: field, ...schema },
    meta:   { ...meta, field, collection },
  });
  console.log(`  + ${collection}.${field} (${type})`);
  return true;
}

async function ensureDivider(collection, field, title, color) {
  try {
    await dx('GET', `/fields/${collection}/${field}`);
    return false;
  } catch (e) {
    if (e.status !== 403 && e.status !== 404) throw e;
  }
  await dx('POST', `/fields/${collection}`, {
    field,
    type: 'alias',
    meta: {
      interface: 'presentation-divider',
      special: ['alias', 'no-data'],
      options: color ? { title, color } : { title },
      width: 'full',
      hidden: false,
      readonly: false,
      collection,
    },
    schema: null,
  });
  console.log(`  + ${collection}.${field} (divider: ${title})`);
}

async function ensureFileRelation(collection, field) {
  try {
    await dx('POST', '/relations', {
      collection,
      field,
      related_collection: 'directus_files',
      schema: { on_delete: 'SET NULL' },
    });
    console.log(`  + ${collection}.${field} -> directus_files (FK)`);
  } catch (e) {
    if (e.status !== 400) console.log(`  ! ${collection}.${field} file relation: ${e.message.slice(0, 80)}`);
  }
}

async function enforceFieldOrder(collection, fieldsInOrder) {
  for (let i = 0; i < fieldsInOrder.length; i++) {
    try {
      await dx('PATCH', `/fields/${collection}/${fieldsInOrder[i]}`,
        { meta: { sort: (i + 1) * 10 } });
    } catch (e) {
      if (e.status !== 404) console.log(`    ! reorder ${fieldsInOrder[i]}: ${e.message.slice(0, 80)}`);
    }
  }
}

/* -------- project ------------------------------------------------------ */

const PROJECT_STATUS = [
  { text: 'Опубликовано', value: 'published', color: '#10B981', icon: 'check_circle' },
  { text: 'Черновик',     value: 'draft',     color: '#F59E0B', icon: 'edit' },
  { text: 'В архиве',     value: 'archived',  color: '#94A3B8', icon: 'inventory_2' },
];

async function setupProject() {
  console.log('\n→ project');
  await ensureCollection('project', {
    icon: 'rocket_launch',
    note: 'Кейсы портфолио. featured=true показывает на главной. Порядок задаётся вручную через поле sort.',
    sort_field: 'sort',
    archive_field: 'status',
    archive_value: 'archived',
    unarchive_value: 'draft',
    display_template: '{{ name }}',
  });

  await ensureField('project', 'status', 'string',
    { default_value: 'draft', is_nullable: false },
    {
      interface: 'select-dropdown', display: 'labels',
      options: { choices: PROJECT_STATUS, allowOther: false },
      display_options: { choices: PROJECT_STATUS, showAsDot: false, choiceLabels: false },
      width: 'half',
    });
  await ensureField('project', 'sort', 'integer', { is_nullable: true },
    { interface: 'input', hidden: true });
  await ensureField('project', 'featured', 'boolean',
    { default_value: false, is_nullable: false },
    { interface: 'boolean', special: ['cast-boolean'], width: 'half',
      note: 'Показывать в полосе избранных проектов на главной.' });
  await ensureField('project', 'name', 'string',
    { is_nullable: false, max_length: 120 },
    { interface: 'input', width: 'half', note: 'Отображаемое имя, например «SecureVote»' });
  await ensureField('project', 'slug', 'string',
    { is_nullable: false, max_length: 120, is_unique: true },
    { interface: 'input', width: 'half', note: 'URL-slug. Маленькие буквы, через дефис.',
      special: ['slug'] });
  await ensureField('project', 'tagline', 'string',
    { is_nullable: true, max_length: 240 },
    { interface: 'input', width: 'full',
      note: 'Однострочник под названием (на карточке лучше всего ~80 символов).' });
  await ensureField('project', 'overview', 'text',
    { is_nullable: true },
    { interface: 'input-rich-text-html', width: 'full',
      note: 'Тело страницы проекта.' });

  await ensureDivider('project', 'div_stack', 'Технический стек', '#38BDF8');
  await ensureField('project', 'frontend_stack', 'json',
    { is_nullable: true },
    { interface: 'tags', special: ['cast-json'], width: 'half',
      note: 'Простой список тегов, например ["Astro","TypeScript","Tailwind"]. Свободная форма — без M2M, чтобы редактирование было быстрым.' });
  await ensureField('project', 'backend_stack', 'json',
    { is_nullable: true },
    { interface: 'tags', special: ['cast-json'], width: 'half',
      note: 'Например ["Go","MariaDB","NATS"].' });
  await ensureField('project', 'highlights', 'json',
    { is_nullable: true },
    { interface: 'tags', special: ['cast-json'], width: 'full',
      note: 'Короткие тезисы (постквантовая, ИИ-интеграция и т. д.).' });

  await ensureDivider('project', 'div_apps', 'Сопутствующие приложения', '#94A3B8');
  await ensureField('project', 'apps', 'json',
    { is_nullable: true },
    {
      interface: 'list', special: ['cast-json'], width: 'full',
      options: {
        template: '{{ platform }} — {{ label }}',
        fields: [
          { field: 'platform', name: 'Платформа', type: 'string',
            meta: { interface: 'select-dropdown', width: 'half',
              options: { choices: [
                { text: 'iOS',     value: 'ios' },
                { text: 'Android', value: 'android' },
                { text: 'Веб',     value: 'web' },
                { text: 'Десктоп', value: 'desktop' },
              ] } } },
          { field: 'label',    name: 'Подпись',     type: 'string',
            meta: { interface: 'input', width: 'half' } },
          { field: 'store_url', name: 'URL в магазине', type: 'string',
            meta: { interface: 'input', width: 'full',
              options: { placeholder: 'https://apps.apple.com/...' } } },
        ],
      },
      note: 'Используется для маркеров «iOS + Android собраны» на карточке проекта (паттерн Zavos).',
    });

  await ensureDivider('project', 'div_links', 'Ссылки и медиа', '#94A3B8');
  await ensureField('project', 'cover_image', 'uuid',
    { is_nullable: true },
    { interface: 'file-image', special: ['file'], width: 'half',
      note: 'Обложка карточки (лучше 16:9).' });
  await ensureFileRelation('project', 'cover_image');
  await ensureField('project', 'gallery', 'json',
    { is_nullable: true },
    { interface: 'files', special: ['files'], width: 'full',
      note: 'Скриншоты на странице проекта.' });
  await ensureField('project', 'live_url', 'string',
    { is_nullable: true, max_length: 500 },
    { interface: 'input', width: 'half',
      options: { iconLeft: 'public', placeholder: 'https://…' } });
  await ensureField('project', 'github_url', 'string',
    { is_nullable: true, max_length: 500 },
    { interface: 'input', width: 'half',
      options: { iconLeft: 'code', placeholder: 'https://github.com/…' } });

  await ensureField('project', 'date_created', 'timestamp',
    { is_nullable: true },
    { special: ['date-created'], interface: 'datetime', readonly: true, width: 'half' });
  await ensureField('project', 'date_updated', 'timestamp',
    { is_nullable: true },
    { special: ['date-updated'], interface: 'datetime', readonly: true, width: 'half' });

  await enforceFieldOrder('project', [
    'status', 'featured', 'sort',
    'name', 'slug', 'tagline', 'overview',
    'div_stack', 'frontend_stack', 'backend_stack', 'highlights',
    'div_apps', 'apps',
    'div_links', 'cover_image', 'gallery', 'live_url', 'github_url',
    'date_created', 'date_updated',
  ]);
}

/* -------- team_member -------------------------------------------------- */

async function setupTeamMember() {
  console.log('\n→ team_member');
  await ensureCollection('team_member', {
    icon: 'person',
    note: 'Карточки команды на /team и в полосе на главной. Порядок — перетаскиванием.',
    sort_field: 'sort',
    archive_field: 'status',
    archive_value: 'archived',
    unarchive_value: 'draft',
    display_template: '{{ name }}',
  });

  await ensureField('team_member', 'status', 'string',
    { default_value: 'published', is_nullable: false },
    {
      interface: 'select-dropdown', display: 'labels',
      options: { choices: PROJECT_STATUS, allowOther: false },
      display_options: { choices: PROJECT_STATUS, showAsDot: false },
      width: 'half',
    });
  await ensureField('team_member', 'sort', 'integer', { is_nullable: true },
    { interface: 'input', hidden: true });
  await ensureField('team_member', 'featured', 'boolean',
    { default_value: false, is_nullable: false },
    { interface: 'boolean', special: ['cast-boolean'], width: 'half',
      note: 'Показывать в полосе команды на главной.' });
  await ensureField('team_member', 'name', 'string',
    { is_nullable: false, max_length: 120 },
    { interface: 'input', width: 'half' });
  await ensureField('team_member', 'slug', 'string',
    { is_nullable: false, max_length: 120, is_unique: true },
    { interface: 'input', width: 'half',
      note: 'URL-slug для /team/<slug>/. Маленькие буквы, через дефис.',
      special: ['slug'] });
  await ensureField('team_member', 'role', 'string',
    { is_nullable: true, max_length: 120 },
    { interface: 'input', width: 'half',
      note: 'Должность, показывается под именем.' });
  await ensureField('team_member', 'location', 'string',
    { is_nullable: true, max_length: 120 },
    { interface: 'input', width: 'half',
      note: 'Город + страна, например «Прага, Чехия»',
      options: { iconLeft: 'place' } });
  await ensureField('team_member', 'bio', 'text',
    { is_nullable: true },
    { interface: 'input-multiline', width: 'full',
      note: 'Короткое резюме (1–2 предложения), показывается на карточках.' });
  await ensureField('team_member', 'story', 'text',
    { is_nullable: true },
    { interface: 'input-rich-text-html', width: 'full',
      note: 'Развёрнутая биография на странице /team/<slug>/.' });
  await ensureField('team_member', 'photo', 'uuid',
    { is_nullable: true },
    { interface: 'file-image', special: ['file'], width: 'half' });
  await ensureFileRelation('team_member', 'photo');
  await ensureField('team_member', 'socials', 'json',
    { is_nullable: true },
    {
      interface: 'list', special: ['cast-json'], width: 'full',
      options: {
        template: '{{ label }} — {{ url }}',
        fields: [
          { field: 'label', name: 'Подпись', type: 'string',
            meta: { interface: 'input', width: 'half',
              options: { placeholder: 'GitHub' } } },
          { field: 'url',   name: 'URL',     type: 'string',
            meta: { interface: 'input', width: 'half',
              options: { placeholder: 'https://github.com/…' } } },
        ],
      },
    });

  await enforceFieldOrder('team_member', [
    'status', 'featured', 'sort',
    'name', 'slug', 'role', 'location',
    'bio', 'story',
    'photo', 'socials',
  ]);
}

/* -------- testimonial -------------------------------------------------- */

async function setupTestimonial() {
  console.log('\n→ testimonial');
  await ensureCollection('testimonial', {
    icon: 'format_quote',
    note: 'Цитаты клиентов. featured=true добавляет в ротацию на главной.',
    sort_field: 'sort',
    archive_field: 'status',
    archive_value: 'archived',
    unarchive_value: 'draft',
    display_template: '{{ author }} — {{ company }}',
  });

  await ensureField('testimonial', 'status', 'string',
    { default_value: 'published', is_nullable: false },
    {
      interface: 'select-dropdown', display: 'labels',
      options: { choices: PROJECT_STATUS, allowOther: false },
      display_options: { choices: PROJECT_STATUS, showAsDot: false },
      width: 'half',
    });
  await ensureField('testimonial', 'sort', 'integer', { is_nullable: true },
    { interface: 'input', hidden: true });
  await ensureField('testimonial', 'featured', 'boolean',
    { default_value: false, is_nullable: false },
    { interface: 'boolean', special: ['cast-boolean'], width: 'half',
      note: 'Включить в ротацию на главной.' });
  await ensureField('testimonial', 'quote', 'text',
    { is_nullable: false },
    { interface: 'input-multiline', width: 'full',
      note: 'Лучше до ~280 символов, чтобы карточки оставались читаемыми.' });
  await ensureField('testimonial', 'author', 'string',
    { is_nullable: false, max_length: 120 },
    { interface: 'input', width: 'half' });
  await ensureField('testimonial', 'author_role', 'string',
    { is_nullable: true, max_length: 120 },
    { interface: 'input', width: 'half', note: 'Должность' });
  await ensureField('testimonial', 'company', 'string',
    { is_nullable: true, max_length: 120 },
    { interface: 'input', width: 'half' });
  await ensureField('testimonial', 'photo', 'uuid',
    { is_nullable: true },
    { interface: 'file-image', special: ['file'], width: 'half' });
  await ensureFileRelation('testimonial', 'photo');
  await ensureField('testimonial', 'project', 'integer',
    { is_nullable: true },
    { interface: 'select-dropdown-m2o', special: ['m2o'], width: 'half',
      options: { template: '{{ name }}' },
      note: 'Необязательно — ссылка на проект, под который клиент нас нанимал.' });
  // Foreign key
  try {
    await dx('POST', '/relations', {
      collection: 'testimonial',
      field: 'project',
      related_collection: 'project',
      schema: { on_delete: 'SET NULL' },
    });
  } catch (e) {
    if (e.status !== 400) console.log(`  ! testimonial.project relation: ${e.message.slice(0,80)}`);
  }

  await enforceFieldOrder('testimonial', [
    'status', 'featured', 'sort', 'quote', 'author', 'author_role',
    'company', 'photo', 'project',
  ]);
}

/* -------- technology --------------------------------------------------- */

const TECH_CATEGORIES = [
  { text: 'Фронтенд',                    value: 'frontend', color: '#38BDF8' },
  { text: 'Бэкенд',                      value: 'backend',  color: '#10B981' },
  { text: 'Мобильное',                   value: 'mobile',   color: '#A78BFA' },
  { text: 'Безопасность',                value: 'security', color: '#F43F5E' },
  { text: 'ИИ / ML',                     value: 'ai',       color: '#F59E0B' },
  { text: 'Инфраструктура',              value: 'infra',    color: '#94A3B8' },
];

async function setupTechnology() {
  console.log('\n→ technology');
  await ensureCollection('technology', {
    icon: 'memory',
    note: 'Каталог возможностей — обеспечивает страницу /technologies.',
    sort_field: 'sort',
    archive_field: 'status',
    archive_value: 'archived',
    unarchive_value: 'draft',
    display_template: '{{ name }} ({{ category }})',
  });

  await ensureField('technology', 'status', 'string',
    { default_value: 'published', is_nullable: false },
    {
      interface: 'select-dropdown', display: 'labels',
      options: { choices: PROJECT_STATUS, allowOther: false },
      display_options: { choices: PROJECT_STATUS, showAsDot: false },
      width: 'half',
    });
  await ensureField('technology', 'sort', 'integer', { is_nullable: true },
    { interface: 'input', hidden: true });
  await ensureField('technology', 'category', 'string',
    { is_nullable: false, max_length: 32 },
    {
      interface: 'select-dropdown', display: 'labels',
      options: { choices: TECH_CATEGORIES, allowOther: false },
      display_options: { choices: TECH_CATEGORIES, showAsDot: false },
      width: 'half',
    });
  await ensureField('technology', 'name', 'string',
    { is_nullable: false, max_length: 80 },
    { interface: 'input', width: 'half' });
  await ensureField('technology', 'slug', 'string',
    { is_nullable: false, max_length: 80, is_unique: true },
    { interface: 'input', width: 'half', special: ['slug'] });
  await ensureField('technology', 'blurb', 'text',
    { is_nullable: true },
    { interface: 'input-multiline', width: 'full',
      note: 'Одно-два предложения «что это и зачем мы это используем».' });
  await ensureField('technology', 'icon', 'uuid',
    { is_nullable: true },
    { interface: 'file-image', special: ['file'], width: 'half',
      note: 'Необязательный SVG/PNG. Если пусто — используется цветной блок категории.' });
  await ensureFileRelation('technology', 'icon');

  await enforceFieldOrder('technology', [
    'status', 'sort', 'category', 'name', 'slug', 'blurb', 'icon',
  ]);
}

/* -------- site_config (theme singleton) ------------------------------- */

/* Each entry pairs a key with the baked-in default hex from tokens.css.
 * The field uses Directus's select-color interface (hex output). On the
 * Astro side, BaseLayout emits an override ONLY for fields whose value
 * differs from this default — so the user can "revert" any field simply
 * by typing the default back in, or by clearing the field. */
const THEME_FIELDS = [
  // Brand
  { key: 'accent',       label: 'Акцент — основной цвет бренда (ссылки, фон кнопок, метка K, шкалы)',         default: '#38bdf8', section: 'brand' },
  { key: 'accent_hover', label: 'Акцент при наведении — более тёмный вариант для hover/active',                default: '#0ea5e9', section: 'brand' },

  // Surfaces
  { key: 'bg',           label: 'Фон страницы',                                                                default: '#0a0e14', section: 'surfaces' },
  { key: 'bg_alt',       label: 'Фон карточек / панелей (приподнятые поверхности)',                            default: '#11161f', section: 'surfaces' },
  { key: 'bg_3',         label: 'Дополнительный фон — hover строк таблиц, чипов, дорожки шкал',                default: '#1a212e', section: 'surfaces' },
  { key: 'border',       label: 'Тонкая граница (разделители, границы карточек)',                              default: '#1f2937', section: 'surfaces' },
  { key: 'border_2',     label: 'Усиленная граница (карточки в hover)',                                        default: '#2c3848', section: 'surfaces' },

  // Text
  { key: 'text',         label: 'Основной текст (абзацы, заголовки)',                                          default: '#e6edf5', section: 'text' },
  { key: 'text_2',       label: 'Второстепенный текст (подписи, таглайны, биографии)',                         default: '#9aa6b8', section: 'text' },
  { key: 'text_3',       label: 'Третичный текст (мелкий шрифт, строки локации, моноподписи)',                 default: '#5b6679', section: 'text' },

  // Status
  { key: 'success',      label: 'Успех — шкалы Lighthouse 90+, бейджи OK',                                     default: '#10b981', section: 'status' },
  { key: 'warn',         label: 'Предупреждение — шкалы Lighthouse 50–89, статус «черновик»',                  default: '#f59e0b', section: 'status' },
  { key: 'danger',       label: 'Опасность — шкалы Lighthouse <50, состояния ошибок',                          default: '#f43f5e', section: 'status' },
];

async function setupSiteConfig() {
  console.log('\n→ site_config (theme singleton)');
  // Note: archive_field intentionally omitted — singleton, never archived.
  await ensureCollection('site_config', {
    icon: 'palette',
    note: 'Цвета темы по всему сайту. Выберите любой hex; очистите поле, чтобы вернуть встроенное значение. После сохранения запускается пересборка — сайт обновляется за 5–10 секунд.',
    singleton: true,
    display_template: 'Тема сайта',
  });

  const sections = {
    brand:      'Цвета бренда — метка K, акценты, кнопки, ссылки',
    surfaces:   'Поверхности — страница, карточки, hover, границы',
    text:       'Текст — основной, второстепенный, подписи',
    status:     'Цвета состояний — шкалы Lighthouse, бейджи успех/предупр./ошибка',
    easter_egg: 'Пасхалка — текст, мелькающий после кода Konami',
  };
  const sectionOrder = ['brand', 'surfaces', 'text', 'status', 'easter_egg'];

  // Dividers per section
  for (const s of sectionOrder) {
    await ensureDivider('site_config', `div_${s}`, sections[s], '#38bdf8');
  }

  // The 13 color fields
  for (const f of THEME_FIELDS) {
    await ensureField('site_config', f.key, 'string',
      { default_value: f.default, max_length: 32 },
      { interface: 'select-color',
        display: 'color',
        width: 'half',
        options: { format: 'hex' },
        note: `${f.label}. По умолчанию: ${f.default}. Очистите, чтобы вернуть.` });
    // Patch meta on existing fields too, so note/options updates land
    // even when the field was created in an earlier setup run.
    await patchSiteConfigMeta(f);
  }

  // Easter-egg toast text — editable copy that flashes after the Konami
  // code (↑↑↓↓←→←→BA). Stored on site_config so the operator can change
  // it without touching code. Multi-line is allowed — paste ASCII art and
  // it renders monospace and centered on screen.
  const KONAMI_DEFAULT = 'да, мы знаем — но синапсы всё равно лучше.';
  await ensureField('site_config', 'konami_toast', 'text',
    { is_nullable: true },
    { interface: 'input-multiline',
      display: 'raw',
      width: 'full',
      options: { font: 'monospace' },
      note: `Текст, мелькающий после ввода кода Konami (↑ ↑ ↓ ↓ ← → ← → B A). Многострочный текст допустим — вставьте ASCII-арт, и он отрисуется моноширинным и по центру. По умолчанию, если пусто: «${KONAMI_DEFAULT}»` });

  // Build a single ordered list: each divider followed by its fields
  const order = [];
  for (const s of sectionOrder) {
    order.push(`div_${s}`);
    if (s === 'easter_egg') {
      order.push('konami_toast');
    } else {
      order.push(...THEME_FIELDS.filter(f => f.section === s).map(f => f.key));
    }
  }
  await enforceFieldOrder('site_config', order);

  // Backfill the singleton row with defaults so the operator sees the
  // real starting palette in the editor, not blanks. Only fills fields
  // that are currently null/undefined/'' — never overwrites a value
  // the operator has explicitly set.
  try {
    const current = (await dx('GET', '/items/site_config'))?.data || {};
    const patch = {};
    for (const f of THEME_FIELDS) {
      if (!current[f.key]) patch[f.key] = f.default;
    }
    if (!current.konami_toast) patch.konami_toast = KONAMI_DEFAULT;
    if (Object.keys(patch).length > 0) {
      // Singleton endpoint expects { data: {...} } wrapper in Directus 11.
      await dx('PATCH', '/items/site_config', { data: patch });
      console.log(`  · заполнено значениями по умолчанию: ${Object.keys(patch).length} полей site_config`);
    } else {
      console.log('  · site_config: все цвета уже заданы — backfill не требуется');
    }
  } catch (e) {
    console.log(`  ! backfill пропущен: ${e.message.slice(0, 120)}`);
  }
}

async function patchSiteConfigMeta(f) {
  try {
    await dx('PATCH', `/fields/site_config/${f.key}`, {
      meta: {
        interface: 'select-color',
        display: 'color',
        width: 'half',
        options: { format: 'hex' },
        note: `${f.label}. По умолчанию: ${f.default}. Очистите, чтобы вернуть.`,
      },
    });
  } catch (_) { /* silent — non-fatal */ }
}

/* -------- public read permissions ------------------------------------- */

async function setPublicReadPermissions() {
  console.log('\n→ public READ permissions');
  // Find the Public role
  const roles = await dx('GET', `/roles?filter[name][_eq]=Public&fields=id,name&limit=1`);
  const publicRoleId = roles?.data?.[0]?.id;
  if (!publicRoleId) {
    console.log('  ! Public role not found — skipping. (Directus creates this on first start.)');
    return;
  }

  // Content collections — only published rows readable
  const STATUS_FILTERED = ['project', 'team_member', 'testimonial', 'technology'];
  // Singletons / settings — read unconditionally
  const UNFILTERED       = ['site_config'];

  for (const coll of [...STATUS_FILTERED, ...UNFILTERED]) {
    try {
      const existing = await dx('GET',
        `/permissions?filter[role][_eq]=${publicRoleId}` +
        `&filter[collection][_eq]=${coll}` +
        `&filter[action][_eq]=read&fields=id&limit=1`);
      if (existing?.data?.[0]) {
        console.log(`  · ${coll}: public read already set`);
        continue;
      }
      const payload = {
        role: publicRoleId,
        collection: coll,
        action: 'read',
        fields: ['*'],
      };
      if (STATUS_FILTERED.includes(coll)) {
        payload.permissions = { _and: [{ status: { _eq: 'published' } }] };
      }
      await dx('POST', '/permissions', payload);
      console.log(`  + ${coll}: public read${STATUS_FILTERED.includes(coll) ? ' (status=published)' : ''}`);
    } catch (e) {
      console.log(`  ! ${coll}: ${e.message.slice(0, 120)}`);
    }
  }

  // directus_files needs READ too so cover/photo URLs resolve publicly.
  try {
    const existing = await dx('GET',
      `/permissions?filter[role][_eq]=${publicRoleId}` +
      `&filter[collection][_eq]=directus_files` +
      `&filter[action][_eq]=read&fields=id&limit=1`);
    if (!existing?.data?.[0]) {
      await dx('POST', '/permissions', {
        role: publicRoleId,
        collection: 'directus_files',
        action: 'read',
        fields: ['id', 'storage', 'filename_disk', 'filename_download', 'title',
                 'type', 'width', 'height', 'description', 'modified_on'],
      });
      console.log('  + directus_files: public read');
    } else {
      console.log('  · directus_files: public read already set');
    }
  } catch (e) {
    console.log(`  ! directus_files: ${e.message.slice(0, 120)}`);
  }
}

(async () => {
  console.log(`Настройка коллекций keltus на ${URL_BASE}`);
  await login();
  await setupProject();
  await setupTeamMember();
  await setupTestimonial();
  await setupTechnology();
  await setupSiteConfig();
  await setPublicReadPermissions();
  console.log('\n✔ Готово.');
})().catch((e) => {
  console.error('СБОЙ:', e.stack || e.message);
  process.exit(1);
});
