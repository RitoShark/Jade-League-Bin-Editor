/**
 * Batch-retarget match resolver.
 *
 * Given a source champion's animation clips and a target champion's
 * clips, decide which target file each source clip should overwrite.
 * Three tiers, mirroring the Export panel's status chips:
 *
 *   1. `bin`  — exact clip-name match, with BOTH lists coming from real
 *               animation-graph BINs. The most reliable: "Run" → "Run"
 *               regardless of the physical filenames.
 *   2. `name` — exact name match where a BIN wasn't available on one
 *               side, OR a distinctive-token filename match
 *               (`ahri_run` ↔ `leblanc_run` via the `run` token).
 *   3. `unmatched` — nothing plausible; the user picks manually.
 *
 * The resolver only proposes the auto-pick + status. The panel owns the
 * editable state (enable, physics, manual target overrides).
 */

export interface BatchClip {
    /** Resolved clip name ("Run") or the ANM file stem fallback. */
    name: string;
    /** Absolute disk path of the ANM (the overwrite destination for a
     *  target clip; the source to load for a source clip). */
    anm_disk_path?: string | null;
}

export type MatchStatus = 'bin' | 'name' | 'unmatched';

export interface ResolvedMatch {
    source: BatchClip;
    target: BatchClip | null;
    status: MatchStatus;
}

/** Split an identifier into lowercase tokens, also breaking camelCase
 *  (`BlueFish` → `blue`, `fish`) and `_`/`-`/`.` separators. */
function tokenize(s: string): string[] {
    const out: string[] = [];
    let cur = '';
    let prevLower = false;
    for (const ch of s) {
        if (/[a-zA-Z0-9]/.test(ch)) {
            if (/[A-Z]/.test(ch) && prevLower && cur) { out.push(cur); cur = ''; }
            cur += ch.toLowerCase();
            prevLower = /[a-z0-9]/.test(ch);
        } else if (cur) {
            out.push(cur); cur = ''; prevLower = false;
        }
    }
    if (cur) out.push(cur);
    return out;
}

/** Longest meaningful token shared between two names (substring either
 *  direction), ignoring short/noise tokens. 0 = nothing distinctive. */
function tokenScore(a: string, b: string, noise: Set<string>): number {
    const aLower = a.toLowerCase();
    const bLower = b.toLowerCase();
    const aTok = tokenize(a);
    const bTok = tokenize(b);
    const ok = (t: string) => t.length >= 3 && !noise.has(t);
    let score = 0;
    for (const t of aTok) {
        if (!ok(t)) continue;
        if (bLower.includes(t)) score = Math.max(score, t.length);
    }
    for (const t of bTok) {
        if (!ok(t)) continue;
        if (aLower.includes(t)) score = Math.max(score, t.length);
    }
    return score;
}

/** Tokens carried by EVERY clip in a set carry no identity (e.g. the
 *  champion-name prefix `ahri` on every `ahri_*.anm`). Strip them so
 *  matches key on the distinctive part (`run`, `spell1`). */
function commonTokens(clips: BatchClip[]): Set<string> {
    if (clips.length < 2) return new Set();
    let shared: Set<string> | null = null;
    for (const c of clips) {
        const toks = new Set(tokenize(c.name));
        if (shared === null) { shared = toks; continue; }
        for (const t of Array.from(shared)) if (!toks.has(t)) shared.delete(t);
    }
    return shared ?? new Set();
}

export function resolveBatchMatches(
    sources: BatchClip[],
    targets: BatchClip[],
    opts: { sourceFromBin: boolean; targetFromBin: boolean },
): ResolvedMatch[] {
    const targetByName = new Map<string, BatchClip>();
    for (const t of targets) {
        const k = t.name.toLowerCase();
        if (!targetByName.has(k)) targetByName.set(k, t);
    }
    // Noise = tokens common to both whole sets (champ prefixes etc.).
    const noise = new Set<string>([
        ...Array.from(commonTokens(sources)),
        ...Array.from(commonTokens(targets)),
    ]);

    const bothBin = opts.sourceFromBin && opts.targetFromBin;
    return sources.map((source): ResolvedMatch => {
        // Tier 1: exact name match.
        const exact = targetByName.get(source.name.toLowerCase());
        if (exact) {
            return { source, target: exact, status: bothBin ? 'bin' : 'name' };
        }
        // Tier 2: distinctive-token match.
        let best: BatchClip | null = null;
        let bestScore = 0;
        for (const t of targets) {
            const sc = tokenScore(source.name, t.name, noise);
            if (sc > bestScore) { bestScore = sc; best = t; }
        }
        if (best && bestScore > 0) {
            return { source, target: best, status: 'name' };
        }
        return { source, target: null, status: 'unmatched' };
    });
}
