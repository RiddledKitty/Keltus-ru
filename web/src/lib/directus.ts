/**
 * Build-time fetcher for Directus content. Run only during `astro build` /
 * `astro dev` — the public site is fully static, so these requests don't
 * happen on user page loads.
 *
 * Reads DIRECTUS_URL and DIRECTUS_TOKEN from env. In production the token
 * is read-only on published items via the Public role (see
 * setup-collections.mjs); locally you can use an admin token.
 */

const URL_BASE = import.meta.env.DIRECTUS_URL || process.env.DIRECTUS_URL || 'http://localhost:8055';
const PUBLIC_BASE = import.meta.env.PUBLIC_CMS_URL || process.env.PUBLIC_CMS_URL || URL_BASE;
const TOKEN    = import.meta.env.DIRECTUS_TOKEN || process.env.DIRECTUS_TOKEN || '';

type Query = Record<string, string | number | boolean>;

async function dx<T>(path: string, query: Query = {}): Promise<T> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) qs.set(k, String(v));
  const url = `${URL_BASE}${path}${qs.toString() ? '?' + qs.toString() : ''}`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
  // Fail-soft: a Directus outage / connection refused must not 500 the page.
  // Empty arrays render as empty sections — better than a crashed build/dev.
  try {
    const r = await fetch(url, { headers });
    if (!r.ok) {
      console.warn(`[directus] ${path} → ${r.status}: ${(await r.text()).slice(0, 200)}`);
      return { data: [] } as unknown as T;
    }
    return r.json() as Promise<T>;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[directus] ${path} → unreachable: ${msg.slice(0, 200)}`);
    return { data: [] } as unknown as T;
  }
}

export interface DxItem<T> { data: T; }
export interface DxList<T> { data: T[]; }

export interface Project {
  id: number;
  status: 'published' | 'draft' | 'archived';
  featured: boolean;
  sort: number | null;
  name: string;
  slug: string;
  tagline: string | null;
  overview: string | null;
  frontend_stack: string[] | null;
  backend_stack: string[] | null;
  highlights: string[] | null;
  apps: Array<{ platform: 'ios' | 'android' | 'web' | 'desktop'; label?: string; store_url?: string }> | null;
  cover_image: string | null;
  gallery: string[] | null;
  live_url: string | null;
  github_url: string | null;
}

export interface TeamMember {
  id: number;
  status: string;
  featured: boolean;
  sort: number | null;
  name: string;
  slug: string;
  role: string | null;
  location: string | null;
  bio: string | null;
  story: string | null;
  photo: string | null;
  socials: Array<{ label: string; url: string }> | null;
}

export interface Testimonial {
  id: number;
  status: string;
  featured: boolean;
  sort: number | null;
  quote: string;
  author: string;
  author_role: string | null;
  company: string | null;
  photo: string | null;
  project: number | null;
}

export interface SiteConfig {
  // Brand
  accent:       string | null;
  accent_hover: string | null;
  // Surfaces
  bg:           string | null;
  bg_alt:       string | null;
  bg_3:         string | null;
  border:       string | null;
  border_2:     string | null;
  // Text
  text:         string | null;
  text_2:       string | null;
  text_3:       string | null;
  // Status
  success:      string | null;
  warn:         string | null;
  danger:       string | null;
  // Easter egg
  konami_image: string | null; // directus_files UUID
}

export type ThemeColorKey = Exclude<keyof SiteConfig, 'konami_image'>;

/** Baked-in defaults — these MUST stay in lockstep with web/src/styles/tokens.css
 *  and with cms/scripts/setup-collections.mjs THEME_FIELDS. When a site_config
 *  field matches its default, BaseLayout skips emitting an override (smaller HTML). */
export const THEME_DEFAULTS: Record<ThemeColorKey, string> = {
  accent:       '#38bdf8',
  accent_hover: '#0ea5e9',
  bg:           '#0a0e14',
  bg_alt:       '#11161f',
  bg_3:         '#1a212e',
  border:       '#1f2937',
  border_2:     '#2c3848',
  text:         '#e6edf5',
  text_2:       '#9aa6b8',
  text_3:       '#5b6679',
  success:      '#10b981',
  warn:         '#f59e0b',
  danger:       '#f43f5e',
};

export interface Technology {
  id: number;
  status: string;
  sort: number | null;
  category: 'frontend' | 'backend' | 'mobile' | 'security' | 'ai' | 'infra';
  name: string;
  slug: string;
  blurb: string | null;
  icon: string | null;
}

export async function listProjects(opts: { featured?: boolean } = {}): Promise<Project[]> {
  const filter: Record<string, unknown> = { status: { _eq: 'published' } };
  if (opts.featured) filter.featured = { _eq: true };
  const r = await dx<DxList<Project>>('/items/project', {
    filter: JSON.stringify(filter),
    sort: 'sort,-id',
    limit: 100,
    fields: '*',
  });
  return r.data;
}

export async function getProject(slug: string): Promise<Project | null> {
  const r = await dx<DxList<Project>>('/items/project', {
    filter: JSON.stringify({ slug: { _eq: slug }, status: { _eq: 'published' } }),
    limit: 1,
    fields: '*',
  });
  return r.data[0] ?? null;
}

export async function listTeam(opts: { featured?: boolean } = {}): Promise<TeamMember[]> {
  const filter: Record<string, unknown> = { status: { _eq: 'published' } };
  if (opts.featured) filter.featured = { _eq: true };
  const r = await dx<DxList<TeamMember>>('/items/team_member', {
    filter: JSON.stringify(filter),
    sort: 'sort,-id',
    limit: 50,
    fields: '*',
  });
  return r.data;
}

export async function getTeamMember(slug: string): Promise<TeamMember | null> {
  const r = await dx<DxList<TeamMember>>('/items/team_member', {
    filter: JSON.stringify({ slug: { _eq: slug }, status: { _eq: 'published' } }),
    limit: 1,
    fields: '*',
  });
  return r.data[0] ?? null;
}

export async function listTestimonials(opts: { featured?: boolean } = {}): Promise<Testimonial[]> {
  const filter: Record<string, unknown> = { status: { _eq: 'published' } };
  if (opts.featured) filter.featured = { _eq: true };
  const r = await dx<DxList<Testimonial>>('/items/testimonial', {
    filter: JSON.stringify(filter),
    sort: 'sort,-id',
    limit: 30,
    fields: '*',
  });
  return r.data;
}

export async function listTechnologies(): Promise<Technology[]> {
  const r = await dx<DxList<Technology>>('/items/technology', {
    filter: JSON.stringify({ status: { _eq: 'published' } }),
    sort: 'category,sort,name',
    limit: 200,
    fields: '*',
  });
  return r.data;
}

export async function getSiteConfig(): Promise<SiteConfig | null> {
  // Directus 11's singleton API can return either `{data: {...}}` (true
  // singleton response) or `{data: [{...}]}` (collection-style). Tolerate
  // both shapes — and dx() also falls back to `{data: []}` on a network
  // error, so the empty-array case must yield null (no override applied).
  try {
    const r = await dx<{ data: SiteConfig | SiteConfig[] }>(
      '/items/site_config', { fields: '*', limit: 1 });
    const d: any = (r as any).data;
    if (Array.isArray(d)) return d[0] ?? null;
    return d ?? null;
  } catch {
    return null;
  }
}

/** Build a CSS override string with one CSS variable per non-default site_config
 *  color. Returns an empty string when the user has accepted every default —
 *  no override CSS emitted, no unnecessary bytes shipped. */
export function themeOverrideCss(cfg: SiteConfig | null): string {
  if (!cfg) return '';
  const VAR_PREFIX: Record<ThemeColorKey, string> = {
    accent:       '--kel-accent',
    accent_hover: '--kel-accent-2',
    bg:           '--kel-bg',
    bg_alt:       '--kel-bg-alt',
    bg_3:         '--kel-bg-3',
    border:       '--kel-border',
    border_2:     '--kel-border-2',
    text:         '--kel-text',
    text_2:       '--kel-text-2',
    text_3:       '--kel-text-3',
    success:      '--kel-success',
    warn:         '--kel-warn',
    danger:       '--kel-danger',
  };
  const lines: string[] = [];
  for (const key of Object.keys(VAR_PREFIX) as Array<ThemeColorKey>) {
    const value = (cfg as any)[key];
    if (!value) continue;
    const lower = String(value).trim().toLowerCase();
    // Don't emit overrides for the default value — saves bytes and keeps the
    // tokens.css cascade authoritative.
    if (lower === THEME_DEFAULTS[key].toLowerCase()) continue;
    lines.push(`  ${VAR_PREFIX[key]}: ${value};`);
  }
  if (lines.length === 0) return '';
  // Also derive the soft-accent (rgba 14%) automatically — never user-editable
  // but reflects whatever they picked for the main accent.
  const accent = cfg.accent || THEME_DEFAULTS.accent;
  const soft = hexToRgba(accent, 0.14);
  if (soft) lines.push(`  --kel-accent-soft: ${soft};`);
  return `:root {\n${lines.join('\n')}\n}\n`;
}

function hexToRgba(hex: string, alpha: number): string | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 0xff, g = (n >> 8) & 0xff, b = n & 0xff;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function assetUrl(uuid: string | null | undefined, params: Record<string, string | number> = {}) {
  if (!uuid) return '';
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) qs.set(k, String(v));
  const suffix = qs.toString() ? '?' + qs.toString() : '';
  return `${PUBLIC_BASE}/assets/${uuid}${suffix}`;
}

const RICH_HOST_RE = /(["'])https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?(\/assets\/[^"'\s>]+)/gi;
const RICH_REL_RE  = /(\s(?:src|href)=)(["'])(\/assets\/[^"'\s>]+)\2/gi;
export function sanitizeRichHtml(html: string | null | undefined): string {
  if (!html) return '';
  return html
    .replace(RICH_HOST_RE, `$1${PUBLIC_BASE}$2`)
    .replace(RICH_REL_RE, `$1$2${PUBLIC_BASE}$3$2`);
}
