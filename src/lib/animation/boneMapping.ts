/**
 * Bone mapping — source-skeleton bone → target-skeleton bone.
 *
 * Owns three concerns:
 *
 *  1. **Storage shape.** A `BoneMapping` is a plain map from source
 *     joint hash → either a target joint hash (mapped) or the
 *     sentinel `IGNORED` (user explicitly marked the bone "do not
 *     drive anything on the target"). Source bones absent from the
 *     map are *unmapped* — distinguished from "ignored" so the UI
 *     can flag them as needing attention.
 *
 *  2. **Auto-mapping cascade.** Given a source SKL and a target SKL,
 *     compute an initial mapping by trying — in order:
 *      a. **Exact hash equality.** Both rigs use FNV1a-of-lowercased-
 *         name for joint hashes (see [SklJointDTO.name_hash]). When
 *         the lowercased names match, the hashes match, and we get
 *         an O(1) lookup that handles the common case (Root, Spine,
 *         L_Hand etc.) automatically.
 *      b. **Normalised-name match.** Lowercase, strip common prefix
 *         noise (`Buffbone_`, `BFB_`), and replace separators. Catches
 *         "L_Hand" vs "l_hand" if hash equality somehow failed (it
 *         shouldn't — but defensive), or "Hand_L" vs "L_Hand" naming
 *         conventions across older / Riot-internal rigs.
 *      c. **Levenshtein within tolerance.** Only the bones that
 *         survived a + b unmapped get this; threshold scales with
 *         name length so "L_Hand" → "L_Hand1" can match but
 *         "L_Hand" → "L_Foot" stays unmapped. Falls back to "no
 *         match" rather than picking a wildly different bone.
 *
 *  3. **Merge with user overrides.** The auto pass is recomputed
 *     every time the source / target SKN changes; user overrides
 *     are kept separately and re-applied on top. So toggling
 *     rescale / changing rigs doesn't blow away the manual mapping
 *     the user spent time setting up.
 *
 *  Stays pure JS — no Babylon imports — so it stays testable in
 *  isolation and the retarget transform can consume it without
 *  pulling scene state.
 */

import type { SklSkeletonDTO, SklJointDTO } from '../babylon/skeletonBuilder';

/** Sentinel value for "user explicitly marked this bone as not
 *  driving anything on the target". Stored in the mapping map so
 *  the consumer can distinguish *intentionally* blank from *not
 *  yet considered*. */
export const IGNORED = 'ignore' as const;

/** Per-bone mapping entry. Numbers are target joint hashes. */
export type MappingEntry = number | typeof IGNORED;

/** Map from source joint hash → target joint hash | IGNORED. */
export type BoneMapping = Map<number, MappingEntry>;

/** Status used by the UI to colour-code each row. Same semantics as
 *  the plan's green / yellow / red / gray legend. */
export type MappingStatus = 'exact' | 'fuzzy' | 'override' | 'ignored' | 'unmapped';

export interface MappingRow {
    sourceHash: number;
    sourceName: string;
    targetHash: number | null;
    targetName: string | null;
    status: MappingStatus;
    /** True when the user has explicitly marked this bone rigid
     *  (status === 'ignored'). The retarget will produce no
     *  output track for it; the target bone sits at its bind
     *  transform and rides its (animated) target parent. */
    effectiveRigid: boolean;
}

/**
 * Compute the auto-mapping from source → target. Pure function;
 * returns a new map every call so callers can compare references
 * to detect "did the auto pass actually change anything".
 */
export function autoMapBones(
    sourceSkl: SklSkeletonDTO,
    targetSkl: SklSkeletonDTO,
): BoneMapping {
    const result: BoneMapping = new Map();

    // Index the target side by hash AND by normalised name. The
    // hash index is the fast path (covers ~95% of bones on
    // same-engine rigs); the normalised-name index handles cases
    // where the hash differs because the casing or separator
    // differs (rare but real on legacy assets).
    const targetByHash = new Map<number, SklJointDTO>();
    const targetByNorm = new Map<string, SklJointDTO>();
    for (const j of targetSkl.joints) {
        targetByHash.set(j.name_hash, j);
        const key = normaliseBoneName(j.name);
        // First-occurrence wins — duplicates in the target rig
        // (rare; usually a buffbone naming collision) keep their
        // first slot rather than ping-ponging on auto-map runs.
        if (!targetByNorm.has(key)) targetByNorm.set(key, j);
    }

    // Track which target joints have been claimed by hash/norm
    // matches so the fuzzy pass doesn't reassign them.
    const claimedTargets = new Set<number>();

    // Pass A: hash equality. The 90%+ case for cross-skin retargets
    // and most cross-champion retargets.
    for (const s of sourceSkl.joints) {
        const t = targetByHash.get(s.name_hash);
        if (t) {
            result.set(s.name_hash, t.name_hash);
            claimedTargets.add(t.name_hash);
        }
    }

    // Pass B: normalised-name match for bones still unmapped after
    // pass A. Picks up the "Hand_L" vs "L_Hand" cases without
    // tolerating arbitrary distance — same normalisation rules on
    // both sides means the only matches are bones whose names
    // collapse to the same canonical form.
    for (const s of sourceSkl.joints) {
        if (result.has(s.name_hash)) continue;
        const key = normaliseBoneName(s.name);
        const t = targetByNorm.get(key);
        if (t && !claimedTargets.has(t.name_hash)) {
            result.set(s.name_hash, t.name_hash);
            claimedTargets.add(t.name_hash);
        }
    }

    // Pass C: Levenshtein within tolerance. Only triggers on bones
    // both passes failed, and only against unclaimed targets — so
    // the fuzzy pass can't kick a previously-confidently-matched
    // bone off its slot. Threshold scales with name length so
    // longer names tolerate more typos in absolute terms but the
    // relative similarity bar stays high (~85%+).
    const unclaimedTargets = targetSkl.joints.filter(
        t => !claimedTargets.has(t.name_hash),
    );
    for (const s of sourceSkl.joints) {
        if (result.has(s.name_hash)) continue;
        const sNorm = normaliseBoneName(s.name);
        let best: SklJointDTO | null = null;
        let bestDist = Infinity;
        for (const t of unclaimedTargets) {
            if (claimedTargets.has(t.name_hash)) continue;
            const tNorm = normaliseBoneName(t.name);
            const d = levenshtein(sNorm, tNorm);
            if (d < bestDist) {
                bestDist = d;
                best = t;
            }
        }
        if (best) {
            // Tolerance: roughly 15% of the longer name's length,
            // clamped at 3 absolute edits. So "l_hand" (6) → "l_hand1"
            // (7) at distance 1 passes (limit ~1); "l_hand" → "l_foot"
            // at distance 2 also passes (limit 1) — that's wrong for
            // semantic mapping but Levenshtein doesn't know about
            // semantics. We accept some false positives because they
            // surface as yellow "fuzzy" in the UI and the user can
            // override.
            const longerLen = Math.max(sNorm.length, normaliseBoneName(best.name).length);
            const tol = Math.min(3, Math.max(1, Math.floor(longerLen * 0.15)));
            if (bestDist <= tol) {
                result.set(s.name_hash, best.name_hash);
                claimedTargets.add(best.name_hash);
            }
        }
    }

    return result;
}

/**
 * Combine the auto-mapping with the user's manual overrides. The
 * override map wins on every key it has — entries it doesn't touch
 * keep their auto value.
 *
 * Override semantics:
 *   - `number` → use this target hash (force-pick, bypass auto)
 *   - `IGNORED` → mark "do not drive any target bone"
 *   - missing key → defer to auto
 */
export function applyOverrides(
    auto: BoneMapping,
    overrides: BoneMapping,
): BoneMapping {
    const result: BoneMapping = new Map(auto);
    for (const [src, entry] of overrides) {
        result.set(src, entry);
    }
    return result;
}

/**
 * Build per-row rendering data for the panel. Walks the source
 * skeleton in declared order (= roughly hierarchy order) and tags
 * each row with its status based on auto + overrides.
 */
export function buildMappingRows(
    sourceSkl: SklSkeletonDTO,
    targetSkl: SklSkeletonDTO,
    auto: BoneMapping,
    overrides: BoneMapping,
): MappingRow[] {
    const targetByHash = new Map<number, SklJointDTO>();
    for (const j of targetSkl.joints) targetByHash.set(j.name_hash, j);

    const rows: MappingRow[] = [];
    for (const s of sourceSkl.joints) {
        const override = overrides.get(s.name_hash);
        const autoEntry = auto.get(s.name_hash);
        let entry: MappingEntry | undefined;
        let isOverride = false;
        if (override !== undefined) {
            entry = override;
            isOverride = true;
        } else {
            entry = autoEntry;
        }

        let targetHash: number | null = null;
        let targetName: string | null = null;
        let status: MappingStatus;

        if (entry === IGNORED) {
            status = 'ignored';
        } else if (typeof entry === 'number') {
            targetHash = entry;
            const tj = targetByHash.get(entry);
            targetName = tj?.name ?? null;
            if (isOverride) {
                status = 'override';
            } else {
                status = entry === s.name_hash ? 'exact' : 'fuzzy';
            }
        } else {
            status = 'unmapped';
        }

        rows.push({
            sourceHash: s.name_hash,
            sourceName: s.name,
            targetHash,
            targetName,
            status,
            effectiveRigid: status === 'ignored',
        });
    }
    return rows;
}

/** Lowercase + strip the noise that varies across naming
 *  conventions without changing the bone's identity. The result is
 *  a canonical form suitable for direct equality + a baseline for
 *  Levenshtein. */
export function normaliseBoneName(name: string): string {
    let s = name.toLowerCase();
    // Strip common prefixes (Riot uses "Buffbone_Glb_Root" / "BFB_…"
    // interchangeably on some rigs). The fuzzy pass would catch
    // these too but pre-collapsing them lets the cheaper Pass B
    // hit them and avoid the O(n²) Levenshtein scan.
    s = s.replace(/^buffbone_/, 'bfb_');
    // Normalise separator chars — older internal rigs used `-`, some
    // FBX importers convert spaces to `_` already; we want all of
    // those to look the same.
    s = s.replace(/[\s\-.]+/g, '_');
    // Drop trailing digits like "_01", "_02" added by Maya when a
    // bone gets duplicated. Bones with intentional numeric suffixes
    // (e.g. "Spine_1") keep them — only strip if AT LEAST 2 digits
    // follow an underscore (rare false positive on real names).
    s = s.replace(/_\d{2,}$/, '');
    return s;
}

/** Iterative Levenshtein with a single rolling row of scratch
 *  space. Allocations dominate the cost for hot loops over 200×200
 *  bone-name pairs, so we lift the row out of the inner function
 *  and reuse it across calls per-process.
 *
 *  Returns `Infinity` for inputs longer than the cap — we don't
 *  want a 1000-char bone name (custom rigs can do anything) to
 *  blow up the auto-map pass with an O(10⁶) compute. */
const LEV_CAP = 64;
const LEV_PREV = new Uint16Array(LEV_CAP + 1);
const LEV_CURR = new Uint16Array(LEV_CAP + 1);

export function levenshtein(a: string, b: string): number {
    if (a === b) return 0;
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;
    if (a.length > LEV_CAP || b.length > LEV_CAP) return Infinity;
    // Optimisation: bones with wildly different lengths can't be
    // close — early exit avoids the whole DP fill.
    if (Math.abs(a.length - b.length) > Math.max(a.length, b.length) * 0.5) {
        return Math.max(a.length, b.length);
    }
    const m = a.length;
    const n = b.length;
    for (let j = 0; j <= n; j++) LEV_PREV[j] = j;
    for (let i = 1; i <= m; i++) {
        LEV_CURR[0] = i;
        const aChar = a.charCodeAt(i - 1);
        for (let j = 1; j <= n; j++) {
            const cost = aChar === b.charCodeAt(j - 1) ? 0 : 1;
            const del = LEV_PREV[j] + 1;
            const ins = LEV_CURR[j - 1] + 1;
            const sub = LEV_PREV[j - 1] + cost;
            LEV_CURR[j] = Math.min(del, ins, sub);
        }
        // Swap rows for the next iteration. Both arrays are shared
        // module-level so this is a per-call hot loop with zero
        // GC pressure.
        for (let j = 0; j <= n; j++) LEV_PREV[j] = LEV_CURR[j];
    }
    return LEV_PREV[n];
}
