//! Content-validity checks for the mod checker.
//!
//! Where `manage_commands::mod_scan` verifies *reference integrity* (does
//! every path a bin points at still resolve?), the checks here verify
//! *content validity* — structures that are present inside a bin but
//! wrong in a way that breaks the model in-game. They operate purely on
//! the parsed Jade tree, need no live-game index, and each yields a
//! [`ContentFinding`] the scanner turns into a `ModIssue` with an
//! attached structured fix.
//!
//! The hash constants below are League property/class FNV-1a hashes (of
//! the lowercased names). They let us locate structures with no hashlist.
//! Every value here was verified against the Topaz fixer's source and
//! re-derived from the class name where possible — do not trust a hash
//! that isn't cross-checked, a wrong one silently mangles a good bin.

use super::jade::types::{Bin, BinField, BinValue, FNV1a};
use super::jade::view;

// ── Class hashes (FNV-1a of the class name) ─────────────────────────────────
/// `StaticMaterialDef` — the material objects whose sampler keys ripped
/// bins tend to scramble. (= 4288492553, Topaz `Defi.StaticMaterialDef`.)
pub const CLASS_STATIC_MATERIAL: u32 = 0xff9d3409;
/// `SkinCharacterDataProperties` — the root skin object. Its presence is
/// how we tell a real skin bin from a plain asset/material bin.
pub const CLASS_SKIN_CHARACTER_DATA: u32 = 0x9b67e9f6;
/// The three object classes safe to prune when nothing references them —
/// leftovers from another skin/patch. Values are FNV-1a of the class name
/// (they equal Topaz's `Defi` decimals; the plan doc's hex was wrong).
pub const CLASS_CONTEXTUAL_ACTION: u32 = 0xcf313c24; // ContextualActionData
pub const CLASS_ANIM_GRAPH: u32 = 0xf5fb07c7; // AnimationGraphData
pub const CLASS_GEAR_UPGRADE: u32 = 0x27dd6361; // GearSkinUpgrade

/// Gameplay/data object classes — a bin built around these changes
/// champion balance, items, recommendations or stat-stones rather than
/// the skin's looks. Names match Topaz's `Defi` (all FNV-1a of the name).
/// Deliberately the *unambiguous* set — skin-meta and rune-rec classes
/// are excluded to avoid flagging legit skin metadata.
const GAMEPLAY_CLASSES: &[(u32, &str)] = &[
    (0xdc58b4ae, "AbilityObject"),
    (0x5e7e5a06, "SpellObject"),
    (0x5933da7e, "RecSpellRankUpInfoList"),
    (0x826c6058, "ItemRecommendationContextList"),
    (0x0d7f2774, "JunglePathRecommendation"),
    (0xa422530f, "ItemRecommendationOverrideSet"),
    (0x23ea1915, "CharacterRecord"),
    (0x96766ff4, "StatStoneSet"),
    (0xed237fc4, "StatStoneData"),
];

// ── Field hashes ────────────────────────────────────────────────────────────
/// `samplerValues` list on a material — the two spellings Riot has used
/// across patches (Topaz checks both).
pub const F_SAMPLER_LIST_A: u32 = 0x0a6f0eb5;
pub const F_SAMPLER_LIST_B: u32 = 0xf3d3de85;
/// `texturePath` — the sampler string that names a file (has a `.ext`).
pub const F_TEXTURE_PATH: u32 = 0xf0a363e3;
/// `samplerName`/`textureName` — the sampler string that names the shader
/// sampler slot (no extension).
pub const F_SAMPLER_NAME: u32 = 0xb311d4ef;

/// One re-key a fix would perform, for the diff preview.
struct SamplerMismatch {
    value: String,
    to_texture_path: bool,
}

/// A content-validity problem found in one bin, plus everything the
/// scanner needs to raise a `ModIssue` and reconstruct the fix. Kept free
/// of `manage_commands` types so this module has no dependency back on it.
pub struct ContentFinding {
    /// `ModIssue.kind` (stable snake_case slug), e.g. `"sampler_key"`.
    pub kind: &'static str,
    /// `"error" | "warning" | "info"`.
    pub severity: &'static str,
    /// `"low" | "medium" | "high"` — how safe the fix is to apply blind.
    pub risk: &'static str,
    /// Safe to include in the "apply confident fixes" bulk pass.
    pub auto_fixable: bool,
    /// Display path of the bin this was found in — also the fix target.
    pub bin_path: String,
    /// Path-hash of the specific object the fix targets, when the fix acts
    /// on one object (e.g. removing a stale entry). 0 = whole-bin fix.
    pub object_hash: u32,
    /// Plain-language, in-game-symptom summary.
    pub message: String,
    /// Multi-line human preview of exactly what the fix changes.
    pub detail: String,
    /// Which fix reconstructs this — mapped to a `ModFix` by the scanner.
    pub fix_kind: &'static str,
}

/// Run every content check over one parsed bin.
pub fn detect(bin: &Bin, bin_path: &str) -> Vec<ContentFinding> {
    let mut out = Vec::new();
    detect_sampler_key(bin, bin_path, &mut out);
    detect_unreferenced_entries(bin, bin_path, &mut out);
    detect_gameplay_bin(bin, bin_path, &mut out);
    out
}

// ── §3.2 Sampler-key mismatch (white / invisible model) ─────────────────────
//
// A ripped material stores its sampler strings under the wrong keys: the
// texture *path* ends up keyed as the sampler *name* (or vice-versa), so
// the engine can't bind the texture and the surface renders untextured
// white. Healthy bins already have each string under the right key, so
// they never trip this. We only ever consider the two known sampler
// string keys and re-key strictly by content (`.`-in-value ⇒ path), never
// touching any other field.

fn detect_sampler_key(bin: &Bin, bin_path: &str, out: &mut Vec<ContentFinding>) {
    let mut mismatches: Vec<SamplerMismatch> = Vec::new();
    for obj in view::objects(bin) {
        if obj.class_hash != CLASS_STATIC_MATERIAL {
            continue;
        }
        collect_sampler_mismatches(obj.fields, &mut mismatches);
    }
    if mismatches.is_empty() {
        return;
    }

    // Preview: cap the listing so a wildly-broken bin doesn't blow up the
    // card, but keep the true total in the message.
    let total = mismatches.len();
    let mut detail = String::new();
    for m in mismatches.iter().take(8) {
        let (from, to) = if m.to_texture_path {
            ("samplerName", "texturePath")
        } else {
            ("texturePath", "samplerName")
        };
        detail.push_str(&format!("• \"{}\"  {} → {}\n", m.value, from, to));
    }
    if total > 8 {
        detail.push_str(&format!("…and {} more\n", total - 8));
    }

    out.push(ContentFinding {
        kind: "sampler_key",
        severity: "warning",
        risk: "low",
        auto_fixable: true,
        bin_path: bin_path.to_string(),
        object_hash: 0,
        message: format!(
            "Material sampler{} keyed wrong — the model will render untextured white until re-keyed",
            if total == 1 { " is" } else { "s are" }
        ),
        detail: detail.trim_end().to_string(),
        fix_kind: "rekey_samplers",
    });
}

/// Walk a material object's fields, collecting every sampler string whose
/// current key contradicts its content.
fn collect_sampler_mismatches(fields: &[BinField], out: &mut Vec<SamplerMismatch>) {
    for f in fields {
        if f.key.hash != F_SAMPLER_LIST_A && f.key.hash != F_SAMPLER_LIST_B {
            continue;
        }
        let items = match &f.value {
            BinValue::List { items, .. } | BinValue::List2 { items, .. } => items,
            _ => continue,
        };
        for item in items {
            let inner = match item {
                BinValue::Embed { fields, .. } | BinValue::Pointer { fields, .. } => fields,
                _ => continue,
            };
            for sf in inner {
                let BinValue::String(s) = &sf.value else { continue };
                // Only the two known sampler string keys are in scope, so
                // an unexpected field never gets touched.
                if sf.key.hash != F_TEXTURE_PATH && sf.key.hash != F_SAMPLER_NAME {
                    continue;
                }
                let needs_path = s.contains('.');
                let is_path = sf.key.hash == F_TEXTURE_PATH;
                if needs_path != is_path {
                    out.push(SamplerMismatch { value: s.clone(), to_texture_path: needs_path });
                }
            }
        }
    }
}

// ── §3.4 Unreferenced-entry pruning (stale leftovers) ───────────────────────
//
// Ripped/ported bins often carry ContextualActionData / AnimationGraphData
// / GearSkinUpgrade objects left over from another skin or an older patch.
// If nothing references them they're dead weight and can crash or misbehave.
//
// Safety: we only ever consider those three classes, and only in a bin that
// actually contains a `SkinCharacterDataProperties` root (so we don't touch
// plain asset/material bins). We build the "referenced" set from *every*
// live object's `Link` values — including inside Maps, which Hematite's
// version misses — so an entry reachable by any surviving object is kept.
// We under-remove before we ever over-remove. Marked medium-risk and never
// auto-swept: the user approves each removal.

fn detect_unreferenced_entries(bin: &Bin, bin_path: &str, out: &mut Vec<ContentFinding>) {
    let objs = view::objects(bin);
    if !objs.iter().any(|o| o.class_hash == CLASS_SKIN_CHARACTER_DATA) {
        return;
    }

    let mut referenced: std::collections::HashSet<u32> = std::collections::HashSet::new();
    for o in &objs {
        for f in o.fields {
            collect_links(&f.value, &mut referenced);
        }
    }

    for o in &objs {
        let class_name = match o.class_hash {
            CLASS_CONTEXTUAL_ACTION => "ContextualActionData",
            CLASS_ANIM_GRAPH => "AnimationGraphData",
            CLASS_GEAR_UPGRADE => "GearSkinUpgrade",
            _ => continue,
        };
        if referenced.contains(&o.path_hash) {
            continue;
        }
        out.push(ContentFinding {
            kind: "unreferenced_entry",
            severity: "warning",
            risk: "medium",
            auto_fixable: false,
            bin_path: bin_path.to_string(),
            object_hash: o.path_hash,
            message: format!(
                "Leftover {} entry — nothing in this bin references it (stale from another skin or an old patch; can crash or misbehave)",
                class_name
            ),
            detail: format!("remove entry {:08x}  ({})", o.path_hash, class_name),
            fix_kind: "remove_entry",
        });
    }
}

// ── §3.7 Gameplay/data bin (opt-in, non-visual) ─────────────────────────────
//
// Some mods carry a champion's gameplay/data bins (ability, spell, stats,
// recommendations). These change balance, not looks, and can conflict with
// other mods or override champion behaviour. Both reference fixers *drop*
// them outright — but that's a policy call the user should make, so we only
// surface it (info + medium risk, never auto) and let them opt into dropping
// the whole bin. We refuse to offer removal on any bin that also carries
// visual definitions, so a mixed bin's looks can never be lost by accident.

fn detect_gameplay_bin(bin: &Bin, bin_path: &str, out: &mut Vec<ContentFinding>) {
    let objs = view::objects(bin);
    let has_visual = objs
        .iter()
        .any(|o| o.class_hash == CLASS_SKIN_CHARACTER_DATA || o.class_hash == CLASS_STATIC_MATERIAL);
    if has_visual {
        return;
    }
    let mut found: Vec<&str> = Vec::new();
    for o in &objs {
        if let Some((_, name)) = GAMEPLAY_CLASSES.iter().find(|(h, _)| *h == o.class_hash) {
            if !found.contains(name) {
                found.push(name);
            }
        }
    }
    if found.is_empty() {
        return;
    }
    out.push(ContentFinding {
        kind: "gameplay_bin",
        severity: "info",
        risk: "medium",
        auto_fixable: false,
        bin_path: bin_path.to_string(),
        object_hash: 0,
        message: format!(
            "This bin changes gameplay data ({}), not visuals — it can conflict with other mods or override champion balance. Drop it if you only want the skin.",
            found.join(", ")
        ),
        detail: format!("drop bin: {}", bin_path),
        fix_kind: "remove_bin",
    });
}

/// Recursively gather every `Link` (object path-hash) value under a value,
/// descending through structs, containers, options and maps.
fn collect_links(value: &BinValue, out: &mut std::collections::HashSet<u32>) {
    match value {
        BinValue::Link(h) => {
            if h.hash != 0 {
                out.insert(h.hash);
            }
        }
        BinValue::Embed { fields, .. } | BinValue::Pointer { fields, .. } => {
            for f in fields {
                collect_links(&f.value, out);
            }
        }
        BinValue::List { items, .. }
        | BinValue::List2 { items, .. }
        | BinValue::Option { items, .. } => {
            for it in items {
                collect_links(it, out);
            }
        }
        BinValue::Map { items, .. } => {
            for (k, v) in items {
                collect_links(k, out);
                collect_links(v, out);
            }
        }
        _ => {}
    }
}

/// Remove one top-level object (by path-hash) from the bin's `entries`
/// map. Returns true if an entry was removed.
pub fn remove_entry(bin: &mut Bin, object_hash: u32) -> bool {
    let Some(items) = view::entries_mut(bin) else { return false };
    let before = items.len();
    items.retain(|(k, _)| !matches!(k, BinValue::Hash(h) if h.hash == object_hash));
    items.len() != before
}

// ── §3.9 TEX non-block-aligned dimensions (noise / crash) ───────────────────
//
// BCn textures store 4×4 pixel blocks. A TEX whose width or height isn't a
// multiple of 4 makes the engine read past the buffer for the bottom/right
// edge — it renders as noise or crashes on some patches. The fix rounds each
// bad dimension *down* to the nearest ×4 and crops the base mip's blocks to
// match, then re-stamps the header and clears the mip flag (sub-mips were
// sized for the old dims). Ported from Hematite's well-tested byte fixer,
// extended with Jade's BC7/BC5 formats. Pure byte-in/byte-out, no re-encode.

const TEX_FLAG_HAS_MIPMAPS: u8 = 1;

/// (bytes-per-block, block dimension) for a TEX `format` byte, or `None`
/// for formats we won't touch. Block dim 1 ⇒ no alignment constraint.
fn tex_format_block_info(format_byte: u8) -> Option<(usize, usize)> {
    match format_byte {
        10 => Some((8, 4)),  // DXT1 / BC1
        12 => Some((16, 4)), // DXT5 / BC3
        13 => Some((16, 4)), // BC7 (Jade format 13)
        14 => Some((16, 4)), // BC5 (Jade format 14)
        20 => Some((4, 1)),  // BGRA8 — no block constraint
        _ => None,
    }
}

fn align_down(value: u32, block: u32) -> u32 {
    if block <= 1 {
        return value;
    }
    (value / block) * block
}

fn mip_byte_size(width: u32, height: u32, bytes_per_block: usize, block_dim: usize) -> usize {
    let blocks_w = (width as usize).div_ceil(block_dim);
    let blocks_h = (height as usize).div_ceil(block_dim);
    blocks_w * blocks_h * bytes_per_block
}

/// Header-only check (needs just the 12-byte TEX header): does this TEX
/// need a dimension fix? Returns `(width, height, new_w, new_h)` if so.
/// Cheap enough to run over every texture in a scan.
pub fn tex_dim_check(head: &[u8]) -> Option<(u32, u32, u32, u32)> {
    if head.len() < 12 || &head[..4] != b"TEX\0" {
        return None;
    }
    // resource_type: only plain-2D (0). Cubemaps / volume pack differently.
    if head[10] != 0 {
        return None;
    }
    let width = u16::from_le_bytes([head[4], head[5]]) as u32;
    let height = u16::from_le_bytes([head[6], head[7]]) as u32;
    if width == 0 || height == 0 {
        return None;
    }
    let (_, block_dim) = tex_format_block_info(head[9])?;
    let block = block_dim as u32;
    if block <= 1 {
        return None;
    }
    let new_w = align_down(width, block);
    let new_h = align_down(height, block);
    if (new_w == width && new_h == height) || new_w == 0 || new_h == 0 {
        return None;
    }
    Some((width, height, new_w, new_h))
}

/// Apply the TEX dimension fix. Returns the rewritten bytes, or `None`
/// when nothing needed changing (or the crop couldn't be done safely).
pub fn fix_tex_dimensions(data: &[u8]) -> Option<Vec<u8>> {
    let (width, height, new_w, new_h) = tex_dim_check(data)?;
    let tex_format = data[9];
    let (bytes_per_block, block_dim) = tex_format_block_info(tex_format)?;

    let flags = data[11];
    let has_mips = flags & TEX_FLAG_HAS_MIPMAPS != 0;
    let max_dim = width.max(height);
    let mip_count = if has_mips {
        (max_dim as f64).log2().floor() as u32 + 1
    } else {
        1
    };

    // TEX stores mips smallest→largest; the base level is the last chunk.
    let mut pre_base = 0usize;
    if has_mips {
        for level in 1..mip_count {
            let mw = (width >> level).max(1);
            let mh = (height >> level).max(1);
            pre_base += mip_byte_size(mw, mh, bytes_per_block, block_dim);
        }
    }

    let base_size_old = mip_byte_size(width, height, bytes_per_block, block_dim);
    let base_size_new = mip_byte_size(new_w, new_h, bytes_per_block, block_dim);
    let pixel_start = 12usize.checked_add(pre_base)?;
    let pixel_end_old = pixel_start.checked_add(base_size_old)?;
    if pixel_end_old > data.len() {
        return None;
    }

    // Keep the first `blocks_per_row_new` blocks of the first
    // `block_rows_new` block-rows of the base level.
    let blocks_per_row_old = (width as usize).div_ceil(block_dim);
    let blocks_per_row_new = (new_w as usize).div_ceil(block_dim);
    let block_rows_new = (new_h as usize).div_ceil(block_dim);

    let base = &data[pixel_start..pixel_end_old];
    let row_bytes_old = blocks_per_row_old * bytes_per_block;
    let row_bytes_new = blocks_per_row_new * bytes_per_block;
    let mut cropped_base = Vec::with_capacity(base_size_new);
    for row_idx in 0..block_rows_new {
        let row_start = row_idx * row_bytes_old;
        let row_end = row_start.checked_add(row_bytes_new)?;
        if row_end > base.len() {
            return None;
        }
        cropped_base.extend_from_slice(&base[row_start..row_end]);
    }

    // Re-stamp the header with the new dimensions; drop the (now
    // mis-sized) sub-mip chain and clear the mip flag.
    let mut out = Vec::with_capacity(12 + base_size_new);
    out.extend_from_slice(&data[..12]);
    out[4..6].copy_from_slice(&(new_w as u16).to_le_bytes());
    out[6..8].copy_from_slice(&(new_h as u16).to_le_bytes());
    if has_mips {
        out[11] &= !TEX_FLAG_HAS_MIPMAPS;
    }
    out.extend_from_slice(&cropped_base);
    Some(out)
}

/// Apply the sampler-key fix over a whole bin: re-key every material
/// sampler string by content. Idempotent — re-running changes nothing.
/// Returns the number of fields re-keyed.
pub fn rekey_samplers(bin: &mut Bin) -> u32 {
    let mut changed = 0u32;
    let Some(items) = view::entries_mut(bin) else { return 0 };
    for (_key, val) in items.iter_mut() {
        let (name_hash, fields) = match val {
            BinValue::Embed { name, fields } | BinValue::Pointer { name, fields } => (name.hash, fields),
            _ => continue,
        };
        if name_hash != CLASS_STATIC_MATERIAL {
            continue;
        }
        changed += rekey_material_fields(fields);
    }
    changed
}

#[cfg(test)]
mod tex_tests {
    use super::*;

    fn synth_bc1_tex(width: u16, height: u16) -> Vec<u8> {
        let (bpb, bd) = (8usize, 4usize);
        let size = (width as usize).div_ceil(bd) * (height as usize).div_ceil(bd) * bpb;
        let mut buf = Vec::with_capacity(12 + size);
        buf.extend_from_slice(b"TEX\0");
        buf.extend_from_slice(&width.to_le_bytes());
        buf.extend_from_slice(&height.to_le_bytes());
        buf.push(0); // _unknown1
        buf.push(10); // format = BC1
        buf.push(0); // resource_type = 0 (plain 2D)
        buf.push(0); // flags = no mips
        for i in 0..size {
            buf.push((i % 0xFF) as u8);
        }
        buf
    }

    #[test]
    fn aligned_is_passthrough() {
        let buf = synth_bc1_tex(8, 8);
        assert!(fix_tex_dimensions(&buf).is_none());
    }

    #[test]
    fn misaligned_width_crops_down() {
        let buf = synth_bc1_tex(6, 4); // 6→4
        let out = fix_tex_dimensions(&buf).unwrap();
        assert_eq!(out.len(), 12 + 8);
        assert_eq!(u16::from_le_bytes([out[4], out[5]]), 4);
        assert_eq!(u16::from_le_bytes([out[6], out[7]]), 4);
    }

    #[test]
    fn would_crop_to_zero_keeps_original() {
        let buf = synth_bc1_tex(2, 2); // 2→0 refused
        assert!(fix_tex_dimensions(&buf).is_none());
    }

    #[test]
    fn cubemap_resource_type_skipped() {
        let mut buf = synth_bc1_tex(6, 4);
        buf[10] = 1; // not plain 2D
        assert!(tex_dim_check(&buf).is_none());
    }
}

fn rekey_material_fields(fields: &mut [BinField]) -> u32 {
    let mut changed = 0u32;
    for f in fields.iter_mut() {
        if f.key.hash != F_SAMPLER_LIST_A && f.key.hash != F_SAMPLER_LIST_B {
            continue;
        }
        let items = match &mut f.value {
            BinValue::List { items, .. } | BinValue::List2 { items, .. } => items,
            _ => continue,
        };
        for item in items.iter_mut() {
            let inner = match item {
                BinValue::Embed { fields, .. } | BinValue::Pointer { fields, .. } => fields,
                _ => continue,
            };
            for sf in inner.iter_mut() {
                let BinValue::String(s) = &sf.value else { continue };
                if sf.key.hash != F_TEXTURE_PATH && sf.key.hash != F_SAMPLER_NAME {
                    continue;
                }
                let needed = if s.contains('.') { F_TEXTURE_PATH } else { F_SAMPLER_NAME };
                if sf.key.hash != needed {
                    sf.key = FNV1a::new(needed);
                    changed += 1;
                }
            }
        }
    }
    changed
}
