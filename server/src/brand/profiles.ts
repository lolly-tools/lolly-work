/**
 * Brand profiles (plans/29) — the deploy's mounted pack can carry multiple brand
 * profiles under `<pack>/brands/<name>/`, one of which is active. The active
 * profile is named in `<pack>/.lolly-profile` and served through the
 * `<pack>/catalog` SYMLINK → `brands/<name>/catalog`; switching re-points that
 * symlink and rewrites the marker (the same convention the OSS lolly tree uses).
 *
 * Pure fs helpers here; the HTTP routes (app.ts) own auth, audit, and the cache
 * invalidation a switch requires. A pack with no `brands/` dir simply reports
 * `available: false` — the single-brand deploy is unchanged.
 */
import { readdir, readFile, writeFile, lstat, stat, unlink, symlink, readlink } from 'node:fs/promises';
import { join } from 'node:path';

const PROFILE_MARKER = '.lolly-profile';
/** A profile name is a single path segment — no traversal, matches the brands/ dirs. */
const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

export interface BrandProfile {
  name: string;
  active: boolean;
}
export interface ProfilesResult {
  /** True only when the pack is profile-aware (has a brands/ dir with ≥1 profile). */
  available: boolean;
  active: string | null;
  profiles: BrandProfile[];
}

async function inferActiveFromSymlink(packRoot: string, names: string[]): Promise<string | null> {
  try {
    const target = await readlink(join(packRoot, 'catalog')); // e.g. 'brands/suse/catalog'
    const m = /(?:^|\/)brands\/([^/]+)\/catalog\/?$/.exec(target.split('\\').join('/'));
    if (m && names.includes(m[1] as string)) return m[1] as string;
  } catch {
    /* not a symlink / missing — fall through */
  }
  return null;
}

/** Enumerate the pack's brand profiles + which is active. */
export async function listBrandProfiles(packRoot: string): Promise<ProfilesResult> {
  let entries;
  try {
    entries = await readdir(join(packRoot, 'brands'), { withFileTypes: true });
  } catch {
    return { available: false, active: null, profiles: [] };
  }
  const names = entries.filter((e) => e.isDirectory() && NAME_RE.test(e.name)).map((e) => e.name).sort();
  if (!names.length) return { available: false, active: null, profiles: [] };
  let active: string | null = null;
  try {
    active = (await readFile(join(packRoot, PROFILE_MARKER), 'utf8')).trim() || null;
  } catch {
    /* no marker */
  }
  // Marker missing or stale (names it a profile that no longer exists) → trust
  // the catalog symlink, which is what's actually served.
  if (!active || !names.includes(active)) active = (await inferActiveFromSymlink(packRoot, names)) ?? active;
  return { available: true, active, profiles: names.map((name) => ({ name, active: name === active })) };
}

/** Make `name` the active profile: re-point the catalog symlink and rewrite the
 *  marker. Refuses to touch a real (non-symlink) catalog dir, and validates the
 *  target profile exists. Throws on a read-only fs (e.g. Vercel). */
export async function switchBrandProfile(packRoot: string, name: string): Promise<void> {
  if (!NAME_RE.test(name)) throw new Error('invalid profile name');
  const brandCatalog = join(packRoot, 'brands', name, 'catalog');
  const target = await stat(brandCatalog).catch(() => null);
  if (!target?.isDirectory()) throw new Error(`no such brand profile: ${name}`);

  const catalogLink = join(packRoot, 'catalog');
  const link = await lstat(catalogLink).catch(() => null);
  if (link && !link.isSymbolicLink()) throw new Error('catalog is a real directory, not a profile symlink — cannot switch');
  if (link) await unlink(catalogLink);
  // Relative symlink so the pack stays relocatable.
  await symlink(join('brands', name, 'catalog'), catalogLink);
  await writeFile(join(packRoot, PROFILE_MARKER), `${name}\n`, 'utf8');
}
