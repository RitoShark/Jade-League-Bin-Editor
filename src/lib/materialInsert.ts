/**
 * Helpers for inserting library ("jadelib") materials into a bin.
 *
 * Materials are StaticMaterialDefs keyed by name. The game MERGES these by
 * name across every enabled mod — so if two different mods both insert, say,
 * `jadelib_toon_shading`, the game keeps only one definition and the other
 * mod's material silently doesn't apply. To avoid that, every insert gets a
 * globally-unique name by suffixing the library material's base name with a
 * unix timestamp: `jadelib_toon_shading_1719000000`.
 */

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Build a globally-unique material name from the library material's base
 * name. Appends a per-second unix timestamp so the same material inserted
 * into different mods never collides. As a belt-and-braces guard against two
 * inserts within the same second into the SAME bin, we still bump a numeric
 * suffix if the timestamped name already exists in `content`.
 */
export function uniqueMaterialName(originalName: string, content: string): string {
    const ts = Math.floor(Date.now() / 1000);
    const baseName = `${originalName}_${ts}`;
    const escapedBase = escapeRegExp(baseName);
    const existingRe = new RegExp(`"${escapedBase}(?:_\\d+)?"\\s*=`, 'g');
    const existingNames = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = existingRe.exec(content)) !== null) {
        const nameMatch = m[0].match(/"([^"]+)"/);
        if (nameMatch) existingNames.add(nameMatch[1]);
    }
    if (!existingNames.has(baseName)) return baseName;
    let suffix = 2;
    while (existingNames.has(`${baseName}_${suffix}`)) suffix++;
    return `${baseName}_${suffix}`;
}

/**
 * Rewrite every quoted occurrence of the snippet's original material name to
 * the unique final name (the cached snippet always carries the un-suffixed
 * base name). Matches the exact quoted name, so texture paths like
 * `"assets/jadelib/toon-shading/…"` are never touched.
 */
export function renameMaterialInSnippet(
    snippetText: string,
    originalName: string,
    finalName: string,
): string {
    if (finalName === originalName) return snippetText;
    const escOrig = escapeRegExp(originalName);
    return snippetText.replace(new RegExp(`"${escOrig}"`, 'g'), `"${finalName}"`);
}
