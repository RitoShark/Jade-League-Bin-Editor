/**
 * CommunityDragon helpers — fetch champion / skin metadata + image
 * blobs, cache in memory. Modelled on Flint's approach: PNG GETs are
 * cheap and the browser layer already caches them, but we wrap in
 * blob URLs so the renderer keeps working offline once the user has
 * touched a champion (no re-decode, no re-fetch).
 *
 * The Viewer is the first customer. MaterialLibraryBrowser still has
 * its own inline CDragon URLs — those can migrate here later if the
 * shapes line up.
 */

export type CDragonBranch = 'latest' | 'pbe';

export interface CDragonChampion {
  id: number;
  name: string;
  /** e.g. "Aatrox", "Chogath" — matches our WAD filename stems. */
  alias: string;
}

export interface CDragonSkin {
  id: number;
  /** 0 = base, 1+ for skins, also used as the in-game "skin id". */
  num: number;
  name: string;
  isBase: boolean;
  splashPath?: string;
  uncenteredSplashPath?: string;
  tilePath?: string;
  /** Chromas attached to the skin (color variants). */
  chromas?: CDragonChroma[];
}

export interface CDragonChroma {
  id: number;
  name: string;
  chromaPath?: string;
  colors?: string[];
}

const base = (branch: CDragonBranch) =>
  `https://raw.communitydragon.org/${branch}/plugins/rcp-be-lol-game-data/global/default/v1`;

// ----- caches ----------------------------------------------------------

const championsByBranch = new Map<CDragonBranch, CDragonChampion[]>();
const championDetailsByKey = new Map<string, CDragonChampionDetails>(); // `${branch}:${championId}`
const imageBlobs = new Map<string, string>();
const inflight = new Map<string, Promise<string>>();
/** alias-lowercase + branch → resolved circle URL (whichever variant
 *  CDragon actually serves for this champ). Populated by the preloader. */
const resolvedCircleUrls = new Map<string, string>();

// ----- listings --------------------------------------------------------

interface RawChampionSummary {
  id: number;
  name: string;
  alias: string;
}

/** Fetch the alias/id/name list once per branch; cached for the session. */
export async function fetchChampions(
  branch: CDragonBranch = 'latest',
): Promise<CDragonChampion[]> {
  const cached = championsByBranch.get(branch);
  if (cached) return cached;
  const url = `${base(branch)}/champion-summary.json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`champion-summary HTTP ${res.status}`);
  const raw: RawChampionSummary[] = await res.json();
  const mapped: CDragonChampion[] = raw
    // CDragon includes -1 (None) and 0 (placeholder) — drop them.
    .filter((c) => c.id > 0 && c.id < 10000 && c.alias)
    .map((c) => ({ id: c.id, name: c.name, alias: c.alias }))
    .sort((a, b) => a.name.localeCompare(b.name));
  championsByBranch.set(branch, mapped);
  return mapped;
}

export interface CDragonChampionDetails {
  id: number;
  name: string;
  alias: string;
  title: string;
  shortBio: string;
  skins: CDragonSkin[];
}

interface RawCDragonSkin {
  id: number;
  name?: string;
  isBase?: boolean;
  splashPath?: string;
  uncenteredSplashPath?: string;
  tilePath?: string;
  chromas?: Array<{
    id: number;
    name?: string;
    chromaPath?: string;
    colors?: string[];
  }>;
}

/**
 * Fetch the full per-champion CDragon payload (bio + skin list + chromas).
 * Cached per branch+id. The skin list inside is what stage 2's gallery
 * renders; the bio shows in stage 3's Information accordion section.
 */
export async function fetchChampionDetails(
  championId: number,
  branch: CDragonBranch = 'latest',
): Promise<CDragonChampionDetails> {
  const key = `${branch}:${championId}`;
  const cached = championDetailsByKey.get(key);
  if (cached) return cached;
  const url = `${base(branch)}/champions/${championId}.json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`champion ${championId} HTTP ${res.status}`);
  const data: {
    id: number;
    name?: string;
    alias?: string;
    title?: string;
    shortBio?: string;
    skins?: RawCDragonSkin[];
  } = await res.json();
  const out: CDragonChampionDetails = {
    id: data.id,
    name: data.name ?? '',
    alias: data.alias ?? '',
    title: data.title ?? '',
    shortBio: data.shortBio ?? '',
    skins: (data.skins ?? []).map((s) => ({
      id: s.id,
      num: s.id % 1000,
      name: s.name ?? `Skin ${s.id}`,
      isBase: s.isBase ?? s.id % 1000 === 0,
      splashPath: s.splashPath,
      uncenteredSplashPath: s.uncenteredSplashPath,
      tilePath: s.tilePath,
      chromas: s.chromas?.map((c) => ({
        id: c.id,
        name: c.name ?? `Chroma ${c.id}`,
        chromaPath: c.chromaPath,
        colors: c.colors,
      })),
    })),
  };
  championDetailsByKey.set(key, out);
  return out;
}

// ----- URL helpers -----------------------------------------------------

export function getChampionIconUrl(
  championId: number,
  branch: CDragonBranch = 'latest',
): string {
  return `${base(branch)}/champion-icons/${championId}.png`;
}

/**
 * Circular portrait (transparent corners), pulled from the game asset
 * tree on CDragon. Distinct from `getChampionIconUrl` which serves the
 * square mastery-style tile — Flint uses the square one and it ends up
 * looking weird when clipped to a circle on our tiles.
 *
 * LoL's HUD asset naming is inconsistent: older champions have a
 * legacy unkeyed `<alias>_circle.png` while newer ones only ship the
 * skin-keyed `<alias>_circle_0.png` (skin 0 = base). We try the modern
 * path first since it's universal, falling back to the legacy name.
 *
 * Returns *both* URLs so the caller (or `preloadChampionCircle`) can
 * race them. Single-URL accessors below are kept for convenience but
 * always prefer the modern path.
 */
export function getChampionCircleUrls(
  alias: string,
  branch: CDragonBranch = 'latest',
): { primary: string; fallback: string } {
  const a = alias.toLowerCase();
  const root = `https://raw.communitydragon.org/${branch}/game/assets/characters/${a}/hud`;
  return {
    primary: `${root}/${a}_circle_0.png`,
    fallback: `${root}/${a}_circle.png`,
  };
}

/** Convenience accessor — returns whichever circle URL the preloader
 *  resolved for this alias, or the modern guess when nothing's cached
 *  yet (so `<img>` falls back gracefully without a separate probe). */
export function getChampionCircleUrl(
  alias: string,
  branch: CDragonBranch = 'latest',
): string {
  const k = `${branch}:${alias.toLowerCase()}`;
  const resolved = resolvedCircleUrls.get(k);
  if (resolved) return resolved;
  return getChampionCircleUrls(alias, branch).primary;
}

/**
 * Preload a champion's circle portrait. LoL's HUD asset names are messy:
 *
 *   - Aatrox: `aatrox_circle.png`               (legacy unkeyed)
 *   - Akali:  `akali_circle_0.png`              (skin-keyed, modern)
 *   - Xin Zhao: `xinzhaorework_circle_0.png`    (reworked champs add "rework")
 *   - Zilean: `chronokeeper_circle.png`         (some champs use the
 *                                                in-universe codename)
 *
 * We try a small set of predictable patterns first; if all fail we fall
 * back to listing the directory and picking the first `*_circle*.png`
 * we find. Returns the resolved URL so callers can record it. Rejects
 * when even the directory listing turns up nothing.
 */
export async function preloadChampionCircle(
  alias: string,
  branch: CDragonBranch = 'latest',
): Promise<string> {
  const a = alias.toLowerCase();
  const root = `https://raw.communitydragon.org/${branch}/game/assets/characters/${a}/hud`;

  const candidates = [
    `${root}/${a}_circle_0.png`,
    `${root}/${a}_circle.png`,
    `${root}/${a}rework_circle_0.png`,
    `${root}/${a}rework_circle.png`,
  ];

  const k = `${branch}:${a}`;
  const memo = resolvedCircleUrls.get(k);
  if (memo) {
    // Re-touch the blob cache so callers can rely on `getCachedImageUrl`.
    try {
      await preloadImage(memo);
    } catch {
      resolvedCircleUrls.delete(k);
    }
    if (resolvedCircleUrls.has(k)) return memo;
  }

  for (const url of candidates) {
    try {
      await preloadImage(url);
      resolvedCircleUrls.set(k, url);
      return url;
    } catch {
      /* try next candidate */
    }
  }

  // Last resort — directory listing. Pick the file with the simplest
  // suffix (`_0.png` > `.png` > anything else) so we land on the base
  // skin and not a chroma/skin variant.
  const res = await fetch(`${root}/`);
  if (!res.ok) throw new Error(`No circle for ${alias}: HUD folder ${res.status}`);
  const html = await res.text();
  const matches = Array.from(html.matchAll(/href="([^"]*circle[^"]*\.png)"/gi)).map(
    (m) => m[1],
  );
  // Prefer plain `_circle_0` / `_circle` over chromas (`_circle_42`,
  // `_circle_skin12` etc). Score by how "base"-looking the suffix is.
  const score = (filename: string): number => {
    const tail = filename.toLowerCase().replace(/^.*_circle/, '_circle');
    if (tail === '_circle_0.png') return 0;
    if (tail === '_circle.png') return 1;
    return 2 + filename.length; // longer / weirder = less preferred
  };
  matches.sort((a, b) => score(a) - score(b));
  for (const filename of matches) {
    const url = `${root}/${filename}`;
    try {
      await preloadImage(url);
      resolvedCircleUrls.set(k, url);
      return url;
    } catch {
      /* try next */
    }
  }
  throw new Error(`No circle portrait found for ${alias}`);
}

export function getChromaIconUrl(
  championId: number,
  chromaId: number,
  branch: CDragonBranch = 'latest',
): string {
  return `${base(branch)}/champion-chroma-images/${championId}/${chromaId}.png`;
}

/** Resolve a CDragon-relative path (e.g. `splashPath`) to an HTTPS URL. */
export function resolveAsset(
  path: string,
  branch: CDragonBranch = 'latest',
): string {
  const root = `https://raw.communitydragon.org/${branch}/plugins/rcp-be-lol-game-data/global/default`;
  return path.replace('/lol-game-data/assets', root).toLowerCase();
}

// ----- image blob cache ------------------------------------------------

/** Synchronously read a cached blob URL, if any. */
export function getCachedImageUrl(url: string): string | null {
  return imageBlobs.get(url) ?? null;
}

/**
 * Fetch an image and return a session-cached blob URL. Concurrent
 * callers for the same URL share one request.
 */
export function preloadImage(url: string): Promise<string> {
  const hit = imageBlobs.get(url);
  if (hit) return Promise.resolve(hit);
  const pending = inflight.get(url);
  if (pending) return pending;

  const promise = fetch(url)
    .then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.blob();
    })
    .then((blob) => {
      const blobUrl = URL.createObjectURL(blob);
      imageBlobs.set(url, blobUrl);
      inflight.delete(url);
      return blobUrl;
    })
    .catch((err) => {
      inflight.delete(url);
      throw err;
    });
  inflight.set(url, promise);
  return promise;
}

/** Drop every cached image / API response. Useful for a "refresh" button. */
export function clearCache(): void {
  championsByBranch.clear();
  championDetailsByKey.clear();
  resolvedCircleUrls.clear();
  for (const url of imageBlobs.values()) URL.revokeObjectURL(url);
  imageBlobs.clear();
  inflight.clear();
}
