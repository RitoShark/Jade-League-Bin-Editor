/**
 * Heuristics for guessing the champion + skin number from an SKN
 * path so the "Fetch animations from game" button can skip the
 * picker when the answer is obvious.
 *
 * We look at three signals, strongest first:
 *  1. The SKN filename itself (`akali_skin3.skn`, `ahri_base.skn`).
 *  2. The immediate parent folder (`/skin3/`, `/base/`).
 *  3. An ancestor folder that looks like a WAD name
 *     (`Akali.wad.client/`, `Akali/`).
 *
 * If we get both champion + skin from these we mark the result
 * `confident: true`. Anything less and the UI should open the
 * picker so the user confirms.
 */

export interface DetectedChampSkin {
    /** Lowercased champion name when found, else null. */
    champion: string | null;
    /** 0 = base, 1..N for skin N. Null when undetermined. */
    skinNum: number | null;
    /** True only when *both* fields above came back populated. */
    confident: boolean;
    /** Free-form explanation of where the values came from — shown
     *  in the picker's "auto-detected" line so the user can tell why
     *  Jade guessed what it did. */
    reason: string;
}

const SKIN_PATTERNS: Array<{ re: RegExp; skin: (m: RegExpMatchArray) => number }> = [
    { re: /^(?:.+_)?skin(\d{1,3})(?:\.[^.]+)?$/i, skin: m => parseInt(m[1], 10) },
    { re: /^(?:.+_)?base(?:\.[^.]+)?$/i, skin: () => 0 },
];

const CHAMPION_FILENAME_PATTERNS: Array<RegExp> = [
    /^([a-z][a-z0-9]+)_skin\d{1,3}(?:\.[^.]+)?$/i,
    /^([a-z][a-z0-9]+)_base(?:\.[^.]+)?$/i,
];

const SKIN_FOLDER_RE = /^skin(\d{1,3})$/i;
const BASE_FOLDER_RE = /^base$/i;
const WAD_FOLDER_RE = /^([a-z][a-z0-9]+)\.wad(?:\.client)?$/i;

/** Crack a path into normalised forward-slash segments, lowercased
 *  for matching but with original casing preserved for any captured
 *  champion name (since League WAD filenames are TitleCase and we
 *  want to display that). */
function splitPath(p: string): { lower: string[]; raw: string[] } {
    const norm = p.replace(/\\/g, '/');
    const parts = norm.split('/').filter(Boolean);
    return { lower: parts.map(s => s.toLowerCase()), raw: parts };
}

/** Strip the extension. Works on `.skn` / `.skl` / two-dot suffixes
 *  like `.wad.client` are NOT in scope here (we expect a leaf). */
function withoutExt(name: string): string {
    const idx = name.lastIndexOf('.');
    if (idx <= 0) return name;
    return name.slice(0, idx);
}

/** Champion-name plausibility check: League champion ids are
 *  always-lowercase alphanumeric strings of 3+ chars. Numbers can
 *  appear (`kogmaw`, `chogath` — no, those are letters; but
 *  `aurelionsol` is fine). The check is intentionally loose; we'd
 *  rather offer a false positive in the picker than reject a real
 *  name that happens to look unusual. */
function looksLikeChampion(name: string): boolean {
    return /^[a-z][a-z0-9]{2,}$/i.test(name);
}

export function detectChampionAndSkin(sknDiskPath: string): DetectedChampSkin {
    const { lower, raw } = splitPath(sknDiskPath);
    if (lower.length === 0) {
        return { champion: null, skinNum: null, confident: false, reason: 'Empty path' };
    }

    const leaf = lower[lower.length - 1];
    const leafStem = withoutExt(leaf);
    const reasons: string[] = [];
    let champion: string | null = null;
    let skinNum: number | null = null;

    // 1. SKN filename — strongest signal because mods name their
    //    files after the champion they're skinning.
    for (const pat of CHAMPION_FILENAME_PATTERNS) {
        const m = leafStem.match(pat);
        if (m && looksLikeChampion(m[1])) {
            champion = m[1].toLowerCase();
            reasons.push(`filename "${leaf}"`);
            break;
        }
    }
    for (const { re, skin } of SKIN_PATTERNS) {
        const m = leafStem.match(re);
        if (m) {
            skinNum = skin(m);
            if (!reasons.length) reasons.push(`filename "${leaf}"`);
            break;
        }
    }

    // 2. Parent folder for the skin number — common League layout
    //    nests the SKN inside `skins/skin3/` or `skins/base/`.
    if (skinNum === null && lower.length >= 2) {
        const parent = lower[lower.length - 2];
        const baseM = parent.match(BASE_FOLDER_RE);
        const skinM = parent.match(SKIN_FOLDER_RE);
        if (baseM) {
            skinNum = 0;
            reasons.push(`parent folder "base"`);
        } else if (skinM) {
            skinNum = parseInt(skinM[1], 10);
            reasons.push(`parent folder "skin${skinNum}"`);
        }
    }

    // 3. Champion from an ancestor folder. Walk upward from the
    //    skin folder. Prefer a `.wad.client` ancestor (its filename
    //    is the canonical champion id); fall back to a plain
    //    folder that looks champion-shaped.
    if (champion === null) {
        for (let i = lower.length - 2; i >= 0; i--) {
            const m = lower[i].match(WAD_FOLDER_RE);
            if (m && looksLikeChampion(m[1])) {
                champion = m[1].toLowerCase();
                reasons.push(`WAD folder "${raw[i]}"`);
                break;
            }
        }
    }
    if (champion === null) {
        // The canonical mod layout is
        // `characters/<champ>/skins/<skinFolder>/<file>`. The
        // ancestor two levels above the skin folder is the
        // champion name. We try that specific position before
        // anything more permissive.
        if (lower.length >= 4 && (lower[lower.length - 3] === 'skins')) {
            const candidate = lower[lower.length - 4];
            if (looksLikeChampion(candidate)) {
                champion = candidate;
                reasons.push(`ancestor "characters/${candidate}/skins/…"`);
            }
        }
    }

    return {
        champion,
        skinNum,
        confident: champion !== null && skinNum !== null,
        reason: reasons.length ? reasons.join(' + ') : 'no clear signal',
    };
}
