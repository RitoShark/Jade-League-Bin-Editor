//! Extract per-submesh diffuse-texture paths from a parsed skin BIN.
//!
//! Originally went through ritobin TEXT (BIN → text → regex), which
//! made the BIN-parse step the dominant cost on champion previews
//! (~2.6 s out of ~3.3 s end-to-end on Samira skin30). Now we walk
//! the parsed `BinTree` directly with FNV1a-32 hash field lookups —
//! same algorithm Aventurine's C++ DLL uses, but in pure Rust without
//! the FFI baggage. The text-based regex pipeline + its dictionary
//! bookkeeping is gone entirely.
//!
//! BIN structure (cross-checked with Aventurine `bin_parser.cpp`):
//!
//! ```text
//! "champion_skin0" SkinCharacterDataProperties {
//!     skinMeshProperties: embed = SkinMeshDataProperties {
//!         texture: string                                    // BASE
//!         materialOverride: list[embed] = {
//!             SkinMeshDataProperties_MaterialOverride {
//!                 submesh: string                            // material name
//!                 texture: string                            // direct override
//!                 // OR
//!                 material: link = ObjectLink → StaticMaterialDef
//!             }
//!         }
//!     }
//! }
//!
//! "Characters/Aatrox/Skin0_Body" StaticMaterialDef {
//!     samplerValues: list[embed] = {
//!         StaticMaterialShaderSamplerDef {
//!             textureName: string = "Diffuse_Texture"
//!             texturePath: string = "ASSETS/.../body_diffuse.tex"
//!         }
//!     }
//! }
//! ```

// Canonical engine-agnostic tree: the Jade-native `Bin`/`BinValue`.
// Whichever converter engine is selected, bytes are parsed into this
// shape (`read_bin_engine`), so this walker never references `ltk_meta`.
use crate::core::bin::{BinField, BinValue, JadeBin as BinTree};
use crate::core::bin::jade::view;
use serde::Serialize;

use crate::core::bin::read_bin_engine;
use crate::core::wad::{read_chunk_decompressed_bytes, with_mount};

use super::skin_bin::find_skin_bin;

// ── FNV1a-32 hash constants ────────────────────────────────────────
//
// Computed at compile-time from the lowercased field name. Identical
// to what Aventurine's C++ DLL hardcodes — kept as `const fn` so a
// reader can verify any of them by changing the string and recompiling
// without having to rerun a hash tool.

const fn fnv1a_lower(s: &str) -> u32 {
    let bytes = s.as_bytes();
    let mut hash: u32 = 0x811c_9dc5;
    let mut i = 0;
    while i < bytes.len() {
        let mut b = bytes[i];
        if b >= b'A' && b <= b'Z' {
            b += 32; // ASCII lowercase
        }
        hash ^= b as u32;
        hash = hash.wrapping_mul(0x0100_0193);
        i += 1;
    }
    hash
}

const H_SKIN_MESH_PROPERTIES: u32 = fnv1a_lower("skinMeshProperties");
const H_TEXTURE: u32 = fnv1a_lower("texture");
const H_MATERIAL_OVERRIDE: u32 = fnv1a_lower("materialOverride");
const H_SUBMESH: u32 = fnv1a_lower("submesh");
const H_MATERIAL: u32 = fnv1a_lower("material");
const H_SAMPLER_VALUES: u32 = fnv1a_lower("samplerValues");
const H_TEXTURE_NAME: u32 = fnv1a_lower("textureName");
const H_TEXTURE_PATH: u32 = fnv1a_lower("texturePath");
// Chroma resolution
const H_CHROMAS: u32 = fnv1a_lower("chromas");
const H_CHROMA_LIST: u32 = fnv1a_lower("chromaList");
const H_ID: u32 = fnv1a_lower("id");
const H_CHILD_SKIN: u32 = fnv1a_lower("childSkin");
// SKN path resolution — `simpleSkin` is the canonical pointer on
// `skinMeshProperties` to the .skn the engine actually renders.
pub const H_SIMPLE_SKIN: u32 = fnv1a_lower("simpleSkin");

// ── Public types (unchanged shape — frontend consumers stay valid) ─

#[derive(Debug, Clone, Serialize)]
pub struct MaterialTexture {
    pub material: String,
    pub texture_path: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct SkinTextureMap {
    pub bin_path: String,
    pub bin_path_hash_hex: String,
    pub default_texture: Option<String>,
    pub materials: Vec<MaterialTexture>,
    /// Alternate diffuse for shadow / demon / transformed forms — e.g.
    /// Evelynn's `ShadowTexture` sampler. `None` when the resolved
    /// material has no such sampler. Frontend can offer a toggle to
    /// swap the default with this.
    pub shadow_texture: Option<String>,
}

// ── End-to-end command path ─────────────────────────────────────────

/// Disk-source variant — given an SKN file path, find its sibling
/// skin BIN, parse it, and return the same texture map shape the WAD
/// path produces. Returns `Ok(None)` for any structural miss (no
/// skin BIN found, parse error). The texture paths in the result
/// are still BIN-string format (`ASSETS/...`); a separate per-clip
/// resolver maps them to disk paths.
pub fn read_skin_textures_for_skn_disk(
    skn_disk_path: &str,
) -> Result<Option<SkinTextureMap>, String> {
    use super::skin_bin::{data_path_variants, disk_layout_for_skn, find_skin_bin_disk};

    let skin_bin_path = match find_skin_bin_disk(skn_disk_path) {
        Some(p) => p,
        // Folder-scan fallback for BIN-less mods is implemented in
        // the Tauri command wrapper (`read_skn_textures_disk`) so
        // the returned disk paths can be absolute. Here we just
        // signal "no map" and let the caller take over.
        None => return Ok(None),
    };
    let bytes = std::fs::read(&skin_bin_path)
        .map_err(|e| format!("read skin bin '{}': {}", skin_bin_path, e))?;
    let primary_tree = read_bin_engine(&bytes).map_err(|e| format!("parse skin bin: {e}"))?;

    // Parse every BIN listed in the primary's `linked:` dependency list,
    // so champions like Evelynn — whose `Material: link` points at a
    // `StaticMaterialDef` defined in a sibling multi-skin BIN — resolve
    // their diffuse correctly. Without this the disk-side binder only
    // sees the placeholder texture path from `texture: string` (or
    // nothing at all if the BIN omits that field).
    //
    // Failures (file missing, parse error) are non-fatal: skip the dep
    // and continue — the same forgiving behavior the WAD-side walker
    // uses.
    let mut linked_trees: Vec<BinTree> = Vec::new();
    let mut loaded_paths: std::collections::HashSet<String> = std::collections::HashSet::new();
    loaded_paths.insert(skin_bin_path.replace('\\', "/").to_lowercase());

    if let Some(layout) = disk_layout_for_skn(skn_disk_path) {
        // (1) Walk the primary's `linked:` dependencies. These are
        //     the BIN files Riot explicitly tags as required. Most
        //     champion-level material defs come through here.
        for dep in view::dependencies(&primary_tree) {
            let lower = dep.to_lowercase();
            // Dependencies are `DATA/Characters/...` strings; only the
            // `data/`-rooted ones matter for material resolution.
            let Some(_rel) = lower.strip_prefix("data/") else { continue };
            for candidate in data_path_variants(&lower, &layout) {
                if !std::path::Path::new(&candidate).is_file() {
                    continue;
                }
                let key = candidate.replace('\\', "/").to_lowercase();
                if loaded_paths.contains(&key) {
                    break;
                }
                let dep_bytes = match std::fs::read(&candidate) {
                    Ok(b) => b,
                    Err(e) => {
                        eprintln!("[textures] linked BIN '{}' read failed: {}", candidate, e);
                        break;
                    }
                };
                match read_bin_engine(&dep_bytes) {
                    Ok(t) => {
                        loaded_paths.insert(key);
                        linked_trees.push(t);
                    }
                    Err(e) => eprintln!("[textures] linked BIN '{}' parse failed: {}", candidate, e),
                }
                break;
            }
        }

        // (2) Sibling-BIN sweep. The WAD walker effectively has every
        //     BIN in the mounted archive available; the disk walker
        //     only sees what's actually on the user's drive. Mods
        //     commonly ship just `skin{N}.bin` and lean on Riot's
        //     base material defs for the per-submesh `material: link`s.
        //     When those base BINs are NOT in the dependencies list
        //     but happen to sit next to the skin BIN, load them anyway.
        //     We sweep:
        //       a) every other `skin*.bin` in the same `skins/` folder
        //          (skin0.bin frequently owns the base StaticMaterialDef
        //          objects that `materialOverride` entries link to).
        //       b) the champion-root BIN one level up
        //          (`data/characters/<champ>/<champ>.bin`).
        //       c) any other `.bin` at the champion root
        //          (e.g. `evelynn_multi_skins_*.bin`).
        let skn_norm = skn_disk_path.replace('\\', "/").to_lowercase();
        let mut champion: Option<&str> = None;
        if let Some(after_chars) = skn_norm.split("characters/").nth(1) {
            if let Some(name) = after_chars.split('/').next() {
                if !name.is_empty() {
                    champion = Some(name);
                }
            }
        }

        if let Some(champ) = champion {
            let try_load = |path_str: &str, linked: &mut Vec<BinTree>, loaded: &mut std::collections::HashSet<String>| {
                let key = path_str.replace('\\', "/").to_lowercase();
                if loaded.contains(&key) {
                    return;
                }
                if !std::path::Path::new(path_str).is_file() {
                    return;
                }
                let bytes = match std::fs::read(path_str) {
                    Ok(b) => b,
                    Err(_) => return,
                };
                match read_bin_engine(&bytes) {
                    Ok(t) => {
                        loaded.insert(key);
                        linked.push(t);
                    }
                    Err(e) => eprintln!("[textures] sibling BIN '{}' parse failed: {}", path_str, e),
                }
            };

            // (a) every sibling skin BIN
            let skins_dir_rel = format!("data/characters/{champ}/skins/");
            for variant in data_path_variants(&skins_dir_rel, &layout) {
                let path = std::path::Path::new(&variant);
                let Ok(entries) = std::fs::read_dir(path) else { continue };
                for entry in entries.flatten() {
                    let p = entry.path();
                    if !p.is_file() { continue; }
                    let Some(name) = p.file_name().and_then(|n| n.to_str()) else { continue };
                    let lower = name.to_lowercase();
                    if !lower.ends_with(".bin") { continue; }
                    if !lower.starts_with("skin") { continue; }
                    let abs = p.to_string_lossy().into_owned();
                    try_load(&abs, &mut linked_trees, &mut loaded_paths);
                }
                break; // first variant that exists wins
            }

            // (b) champion-root BIN
            let champ_root_rel = format!("data/characters/{champ}/{champ}.bin");
            for variant in data_path_variants(&champ_root_rel, &layout) {
                try_load(&variant, &mut linked_trees, &mut loaded_paths);
            }

            // (c) all other BINs at the champion root (multi-skin
            //     material defs etc.)
            let champ_dir_rel = format!("data/characters/{champ}/");
            for variant in data_path_variants(&champ_dir_rel, &layout) {
                let path = std::path::Path::new(&variant);
                let Ok(entries) = std::fs::read_dir(path) else { continue };
                for entry in entries.flatten() {
                    let p = entry.path();
                    if !p.is_file() { continue; }
                    let Some(name) = p.file_name().and_then(|n| n.to_str()) else { continue };
                    if !name.to_lowercase().ends_with(".bin") { continue; }
                    let abs = p.to_string_lossy().into_owned();
                    try_load(&abs, &mut linked_trees, &mut loaded_paths);
                }
                break;
            }
        }
    }

    eprintln!(
        "[textures] disk walker loaded {} BIN trees (primary + {} linked) for {}",
        1 + linked_trees.len(),
        linked_trees.len(),
        skn_disk_path
    );

    let mut trees: Vec<BinTree> = Vec::with_capacity(1 + linked_trees.len());
    trees.push(primary_tree);
    trees.extend(linked_trees);
    let (default_texture, materials, shadow_texture) = extract_textures_from_trees(&trees);

    Ok(Some(SkinTextureMap {
        bin_path: skin_bin_path.replace('\\', "/").to_lowercase(),
        bin_path_hash_hex: format!("{:016x}", 0u64),
        default_texture,
        materials,
        shadow_texture,
    }))
}

pub fn read_skin_textures_for_skn(
    mount_id: u64,
    skn_path_hash: u64,
) -> Result<Option<SkinTextureMap>, String> {
    let bin_match = match find_skin_bin(mount_id, skn_path_hash) {
        Some(m) => m,
        None => return Ok(None),
    };
    let bin_hash = u64::from_str_radix(&bin_match.path_hash_hex, 16)
        .map_err(|e| format!("bad bin hash hex: {e}"))?;

    let info = with_mount(mount_id, |m| {
        m.chunks
            .iter()
            .find(|c| c.path_hash == bin_hash)
            .map(|c| (m.path.clone(), *c))
    })
    .flatten()
    .ok_or_else(|| format!("bin chunk {} not in mount {}", bin_match.path_hash_hex, mount_id))?;
    let bytes = read_chunk_decompressed_bytes(&info.0, &info.1)
        .map_err(|e| format!("read bin chunk: {e}"))?;
    let primary_tree = read_bin_engine(&bytes).map_err(|e| format!("parse bin tree: {e}"))?;

    // Parse every BIN in the primary's `linked:` dependency list.
    // Evelynn's MaterialDef lives in a sibling multi-skin BIN, so the
    // `Material: link` in skin0.bin points at an object that simply
    // isn't in skin0's own tree — we need the linked BINs to resolve.
    // We collect them once here so the extractor can search across the
    // whole bundle. Failures (chunk missing, parse error) are non-fatal:
    // skip the BIN and continue.
    let deps_paths: Vec<String> =
        view::dependencies(&primary_tree).iter().map(|s| s.to_string()).collect();
    let mut linked_trees: Vec<BinTree> = Vec::with_capacity(deps_paths.len());
    for dep_path in &deps_paths {
        let lower = dep_path.to_lowercase();
        let dep_hash = xxh64_path(&lower);
        let dep_info = with_mount(mount_id, |m| {
            m.chunks
                .iter()
                .find(|c| c.path_hash == dep_hash)
                .map(|c| (m.path.clone(), *c))
        })
        .flatten();
        let Some(dep_info) = dep_info else { continue };
        let dep_bytes = match read_chunk_decompressed_bytes(&dep_info.0, &dep_info.1) {
            Ok(b) => b,
            Err(e) => {
                eprintln!("[textures] linked BIN '{}' read failed: {}", lower, e);
                continue;
            }
        };
        match read_bin_engine(&dep_bytes) {
            Ok(t) => linked_trees.push(t),
            Err(e) => eprintln!("[textures] linked BIN '{}' parse failed: {}", lower, e),
        }
    }

    let mut trees: Vec<BinTree> = Vec::with_capacity(1 + linked_trees.len());
    trees.push(primary_tree);
    trees.extend(linked_trees);

    let (default_texture, materials, shadow_texture) = extract_textures_from_trees(&trees);

    Ok(Some(SkinTextureMap {
        bin_path: bin_match.path,
        bin_path_hash_hex: bin_match.path_hash_hex,
        default_texture,
        materials,
        shadow_texture,
    }))
}

/// xxh64 of a lowercased path string — same hashing the WAD's chunk
/// index uses. Local helper since `xxh64_lower` lives in mesh_commands
/// and we'd rather not introduce a cycle.
fn xxh64_path(s: &str) -> u64 {
    use std::hash::Hasher;
    let mut h = twox_hash::XxHash64::with_seed(0);
    h.write(s.as_bytes());
    h.finish()
}

// ── Tree walker ─────────────────────────────────────────────────────

/// Walk the parsed BinTree and pull out (default_texture, per-material).
/// Public so tests can hit it without IPC plumbing.
///
/// **Form-switching note**: champion BINs for transforming champs
/// (Evelynn, Jayce, Elise, Nidalee, Karma, Shyvana, Rumble in some
/// versions, …) carry **multiple** `SkinCharacterDataProperties` —
/// one per form. Their `materialOverride` blocks frequently re-use
/// submesh names ("Body", "Weapon", …) with different textures
/// per form. Pooling them in one flat list collapses to whichever
/// form happens to be iterated last, which is how you get the
/// "wrong texture on the right submesh" symptom.
///
/// For now we just take the **first** `SkinCharacterDataProperties`
/// object we encounter. That maps to the canonical form
/// (`Evelynn_Skin0` before `Evelynn_Skin0_Form1`, etc.) because
/// `ltk_meta`'s `IndexMap` preserves the BIN's on-disk insertion
/// order. Alt forms lose their bindings and fall back to the default
/// texture (which is usually right enough for a viewer); a real
/// form-picker is a follow-up.
#[allow(dead_code)]
pub fn extract_textures_from_tree(tree: &BinTree) -> (Option<String>, Vec<MaterialTexture>) {
    let (default_texture, materials, _) = extract_textures_from_trees(std::slice::from_ref(tree));
    (default_texture, materials)
}

/// Cross-tree variant — `trees[0]` is the primary skin BIN; the rest
/// are its `linked:` dependencies, parsed by the caller. Material
/// links can resolve to objects defined in any of these BINs (Evelynn
/// is the canonical case: her `Material: link` points at a
/// `StaticMaterialDef` that lives in a sibling multi-skin BIN, not in
/// her own `skin0.bin`). Returns `(default, materials, shadow_alt)`.
pub fn extract_textures_from_trees(
    trees: &[BinTree],
) -> (Option<String>, Vec<MaterialTexture>, Option<String>) {
    if trees.is_empty() {
        eprintln!("[textures] extract_textures_from_trees: empty trees");
        return (None, Vec::new(), None);
    }
    let primary = &trees[0];
    eprintln!(
        "[textures] extract_textures_from_trees: {} trees, primary has {} objects",
        trees.len(),
        view::objects(primary).len()
    );
    for object in view::objects(primary) {
        if let Some(smp_props) = skin_mesh_props_of(object.fields) {
            let result = extract_textures_from_smp(trees, smp_props);
            eprintln!(
                "[textures] result: default={:?} bindings_count={} shadow={:?}",
                result.0,
                result.1.len(),
                result.2
            );
            for b in &result.1 {
                eprintln!("[textures]   binding submesh='{}' texture='{}'", b.material, b.texture_path);
            }
            return result;
        }
    }
    eprintln!("[textures] no SkinMeshProperties found in primary tree");
    (None, Vec::new(), None)
}

/// Read the `simpleSkin: string` field from the first SCDP's
/// `skinMeshProperties` block. This is the canonical pointer to the
/// .skn the engine actually renders — **the only reliable way** to
/// pick the right SKN when the WAD contains several (Rell's rider vs
/// horse, Mel's main vs alt rigs, etc.). Returns the BIN-form path
/// (`ASSETS/...`) lowercased, or `None` if no SCDP / no field.
pub fn extract_simple_skin(tree: &BinTree) -> Option<String> {
    for object in view::objects(tree) {
        let smp_props = match skin_mesh_props_of(object.fields) {
            Some(p) => p,
            None => continue,
        };
        if let Some(s) = string_field(smp_props, H_SIMPLE_SKIN) {
            if !s.is_empty() {
                return Some(s.to_lowercase());
            }
        }
        // Only inspect the first SCDP — same first-match rule as the
        // base texture walker.
        return None;
    }
    None
}

/// Walk the parsed BinTree looking for a chroma whose `id` field
/// matches `chroma_id`, returning that chroma's texture overrides.
///
/// Chromas in League's BIN ecosystem are typically additional
/// `SkinCharacterDataProperties` objects in the same skin BIN, listed
/// either as `chromas` or `chromaList` on the parent. Each carries its
/// own `skinMeshProperties.materialOverride` block (usually small —
/// just the body/weapon swaps). We return the **chroma's bindings
/// only**; the caller is expected to merge them onto the base
/// material list (chroma overrides win).
///
/// `default_texture` is the chroma's own default if it set one,
/// otherwise `None` (caller falls back to the base default).
pub fn extract_chroma_textures(
    trees: &[BinTree],
    chroma_id: u32,
) -> Option<(Option<String>, Vec<MaterialTexture>)> {
    if trees.is_empty() {
        return None;
    }
    let primary = &trees[0];

    let mut chroma_links: Vec<u32> = Vec::new();
    for object in view::objects(primary) {
        let Some(smp_props) = skin_mesh_props_of(object.fields) else { continue };

        let scan_sources: [&[BinField]; 2] = [object.fields, smp_props];
        for src in scan_sources.iter() {
            for key in &[H_CHROMAS, H_CHROMA_LIST] {
                if let Some(list_prop) = view::field(src, *key) {
                    if let Some(items) = container_items(list_prop) {
                        for item in items {
                            if let BinValue::Link(link) = item {
                                chroma_links.push(link.hash);
                            }
                        }
                    }
                }
            }
        }
        if !chroma_links.is_empty() {
            break;
        }
        break;
    }

    if chroma_links.is_empty() {
        return None;
    }

    for link_hash in chroma_links {
        // Chroma object can live in any of the linked BINs too.
        let obj = trees.iter().find_map(|t| view::object(t, link_hash));
        let Some(obj) = obj else { continue };
        let id_value = u32_field(obj.fields, H_ID).or_else(|| {
            object_link_field(obj.fields, H_CHILD_SKIN)
                .and_then(|h| trees.iter().find_map(|t| view::object(t, h)))
                .and_then(|target| u32_field(target.fields, H_ID))
        });
        if id_value != Some(chroma_id) {
            continue;
        }

        let chroma_obj = obj;
        let smp_props = skin_mesh_props_of(chroma_obj.fields)
            .unwrap_or(chroma_obj.fields);
        let (default_texture, materials, _shadow) = extract_textures_from_smp(trees, smp_props);
        return Some((default_texture, materials));
    }

    None
}

/// Shared per-SCDP walker — extracts the default texture + material
/// overrides from a single `skinMeshProperties` props map. Used by
/// both the base-skin extractor and the chroma extractor so the two
/// paths stay in lock-step on which fields they understand.
fn extract_textures_from_smp(
    trees: &[BinTree],
    smp_props: &[BinField],
) -> (Option<String>, Vec<MaterialTexture>, Option<String>) {
    let mut default_texture: Option<String> = None;
    let mut materials: Vec<MaterialTexture> = Vec::new();
    let mut shadow_texture: Option<String> = None;

    // Priority 1 — top-level `Material: link` on skinMeshProperties.
    // This is the actually-shipped diffuse for the skin; the plain
    // `texture: string` field is often a leftover sketch / placeholder
    // Riot forgot to remove (Aatrox Skin07 references a stale TX_CM
    // that doesn't match what the game actually renders). The linked
    // StaticMaterialDef's `Diffuse_Texture` sampler is canonical.
    //
    // Looks across `trees` because the linked StaticMaterialDef
    // frequently lives in a sibling BIN (Evelynn's multi-skin
    // material BIN, etc.), not in the same skin BIN.
    if let Some(link_hash) = object_link_field(smp_props, H_MATERIAL) {
        if let Some((diffuse, shadow)) = resolve_material_diffuse_with_shadow(trees, link_hash) {
            default_texture = Some(diffuse.to_lowercase());
            shadow_texture = shadow.map(|s| s.to_lowercase());
        }
    }

    if default_texture.is_none() {
        if let Some(s) = string_field(smp_props, H_TEXTURE) {
            if !s.is_empty() {
                default_texture = Some(s.to_lowercase());
            }
        }
    }

    if let Some(overrides) = view::field(smp_props, H_MATERIAL_OVERRIDE) {
        if let Some(list) = container_items(overrides) {
            eprintln!("[textures] materialOverride has {} entries", list.len());
            for (i, item) in list.iter().enumerate() {
                let Some(item_props) = embedded_props(item) else {
                    eprintln!("[textures]   override[{}] not an embedded/struct", i);
                    continue;
                };
                // Diagnose what fields the entry actually carries so
                // we can tell whether the lookup-by-hash is matching.
                let submesh_opt = string_field(item_props, H_SUBMESH);
                let texture_opt = string_field(item_props, H_TEXTURE);
                let material_opt = object_link_field(item_props, H_MATERIAL);
                eprintln!(
                    "[textures]   override[{}] props={} submesh={:?} texture={:?} material_link={:?}",
                    i,
                    item_props.len(),
                    submesh_opt,
                    texture_opt,
                    material_opt
                );
                let Some(submesh) = submesh_opt else {
                    eprintln!("[textures]   override[{}] skipped — no submesh field", i);
                    continue;
                };
                let material_name = submesh.to_string();

                if let Some(t) = texture_opt {
                    if !t.is_empty() {
                        materials.push(MaterialTexture {
                            material: material_name,
                            texture_path: t.to_lowercase(),
                        });
                        continue;
                    }
                }

                if let Some(link_hash) = material_opt {
                    if let Some(t) = resolve_material_diffuse(trees, link_hash) {
                        materials.push(MaterialTexture {
                            material: material_name,
                            texture_path: t.to_lowercase(),
                        });
                    } else {
                        eprintln!(
                            "[textures]   override[{}] material link 0x{:08x} did not resolve in any tree",
                            i, link_hash
                        );
                    }
                }
            }
        } else {
            eprintln!("[textures] materialOverride present but not a container");
        }
    } else {
        eprintln!("[textures] no materialOverride field on skinMeshProperties");
    }

    (default_texture, materials, shadow_texture)
}

/// Pull the `skinMeshProperties` embedded/struct props out of an
/// object's properties map, if any. Centralises the field-name +
/// embedded-vs-struct unwrap so callers don't duplicate the logic.
fn skin_mesh_props_of(fields: &[BinField]) -> Option<&[BinField]> {
    embedded_props(view::field(fields, H_SKIN_MESH_PROPERTIES)?)
}

/// Look up a StaticMaterialDef object by its FNV1a path hash across
/// the primary BIN + every linked dependency BIN, and pull the
/// diffuse-style texture path out of its `samplerValues` list.
///
/// Priority cascade (`base/` treated as project-specific too —
/// it's the canonical skin0 folder for many champs like Evelynn):
///   1. `*main_texture` sampler with a `/skin{N}/` or `/base/` path
///   2. `*diffuse*` sampler with a `/skin{N}/` or `/base/` path
///   3. Any sampler with a `/skin{N}/` or `/base/` path
///   4. First `*main_texture` sampler regardless of path
///   5. First `*diffuse*` sampler regardless of path
fn resolve_material_diffuse(trees: &[BinTree], mat_path_hash: u32) -> Option<String> {
    resolve_material_diffuse_with_shadow(trees, mat_path_hash).map(|(d, _)| d)
}

/// Same as [`resolve_material_diffuse`] but also returns the shadow /
/// alt-form texture if the material declares one. Used by Evelynn-style
/// champs where the same StaticMaterialDef ships two diffuse samplers
/// (`DiffuseTexture` + `ShadowTexture`) and the engine swaps between
/// them based on a runtime form switch.
fn resolve_material_diffuse_with_shadow(
    trees: &[BinTree],
    mat_path_hash: u32,
) -> Option<(String, Option<String>)> {
    // Search every tree (primary first) for the StaticMaterialDef.
    let mat_obj = trees.iter().find_map(|t| view::object(t, mat_path_hash))?;
    let samplers = container_items(view::field(mat_obj.fields, H_SAMPLER_VALUES)?)?;

    let mut samples: Vec<(String, String)> = Vec::with_capacity(samplers.len());
    for item in samplers {
        let Some(item_props) = embedded_props(item) else { continue };
        let name = string_field(item_props, H_TEXTURE_NAME).unwrap_or("");
        let path = string_field(item_props, H_TEXTURE_PATH).unwrap_or("");
        if path.is_empty() {
            continue;
        }
        samples.push((name.to_lowercase(), path.to_string()));
    }

    let is_project_specific = |p: &str| {
        let lower = p.to_lowercase();
        // Either `/skin{digit+}/` or `/base/` counts — `base/` is the
        // canonical skin0 folder so excluding it makes the priority
        // cascade fall all the way to the unfiltered pass for champs
        // like Evelynn whose materials only ever reference `/base/…`.
        if lower.contains("/base/") {
            return true;
        }
        let bytes = lower.as_bytes();
        let mut i = 0;
        while i + 5 < bytes.len() {
            if &bytes[i..i + 5] == b"/skin" {
                let mut j = i + 5;
                let mut saw_digit = false;
                while j < bytes.len() && bytes[j].is_ascii_digit() {
                    saw_digit = true;
                    j += 1;
                }
                if saw_digit && j < bytes.len() && bytes[j] == b'/' {
                    return true;
                }
            }
            i += 1;
        }
        false
    };

    let pick_diffuse = || -> Option<String> {
        for (name, path) in &samples {
            if name.contains("main_texture") && is_project_specific(path) {
                return Some(path.clone());
            }
        }
        for (name, path) in &samples {
            if name.contains("diffuse") && is_project_specific(path) {
                return Some(path.clone());
            }
        }
        for (_name, path) in &samples {
            if is_project_specific(path) {
                return Some(path.clone());
            }
        }
        for (name, path) in &samples {
            if name.contains("main_texture") {
                return Some(path.clone());
            }
        }
        for (name, path) in &samples {
            if name.contains("diffuse") {
                return Some(path.clone());
            }
        }
        None
    };

    let diffuse = pick_diffuse()?;

    // Shadow alt — anything with `shadow` in the texture name. Skip
    // the picked diffuse so we don't return the same path twice.
    let shadow = samples
        .iter()
        .find(|(name, path)| name.contains("shadow") && path != &diffuse)
        .map(|(_, p)| p.clone());

    Some((diffuse, shadow))
}

// ── Static-mesh (SCB / SCO) texture lookup ─────────────────────────
//
// Static meshes aren't wired through `skinMeshProperties` — they're
// referenced from VFX emitters, item materials, weapon mounts, etc.,
// usually as a string path on a nested struct like
// `VfxPrimitiveMesh.mMesh.mSimpleMeshName`. The texture(s) for that
// mesh live as *sibling* string properties in the same top-level
// BinTreeObject — same `VfxEmitterDefinitionData`, just different
// nested struct.
//
// We can't follow the same FNV1a-hash-keyed approach as the SKN
// walker because the field names involved are inconsistent across
// the BIN ecosystem (mSimpleMeshName, mainTexture, baseColor,
// erosionMapName, …). Instead we do a dumb-but-effective generic
// pass:
//
//   1. Walk every top-level object's value tree once.
//   2. Find any object whose subtree contains the SCB/SCO path as a
//      string value (case-insensitive).
//   3. Collect every `.tex` / `.dds` string in that same object's
//      subtree.
//   4. Score the collected paths and pick the most likely "main"
//      diffuse — skipping obvious non-diffuse maps (alpha erosion,
//      noise, normal, mask).
//
// Returns one path string for the frontend to resolve into a chunk
// hash.

pub fn find_static_mesh_texture(tree: &BinTree, mesh_path: &str) -> Option<String> {
    let needle = mesh_path.to_lowercase();
    let mut all_textures: Vec<String> = Vec::new();
    for obj in view::objects(tree) {
        let mut found_mesh_ref = false;
        let mut texture_paths: Vec<String> = Vec::new();
        visit_strings_in_props(obj.fields, &mut |s| {
            let lower = s.to_lowercase();
            if !found_mesh_ref && lower == needle {
                found_mesh_ref = true;
            }
            if lower.ends_with(".tex") || lower.ends_with(".dds") {
                texture_paths.push(s.to_string());
            }
        });
        if found_mesh_ref {
            for p in texture_paths {
                if !all_textures.contains(&p) {
                    all_textures.push(p);
                }
            }
        }
    }
    pick_main_static_texture(&all_textures)
}

/// Score-and-pick the most likely diffuse from a flat list of
/// candidate texture paths. Skips obvious effect maps; falls back to
/// the first candidate when nothing scores high enough.
fn pick_main_static_texture(paths: &[String]) -> Option<String> {
    // Likely-not-diffuse keywords. Substring match on lowercased
    // path. These cover Riot's common naming conventions for non-
    // colour textures so we don't apply an alpha mask as the main
    // diffuse on a mesh.
    const EFFECT_HINTS: &[&str] = &[
        "erosion", "_n.", "_dn.", "normal", "noise", "_mask", "alphaerosion",
    ];
    // Positive hints — preferred when present.
    const MAIN_HINTS: &[&str] = &["_tx_cm", "tx_cm", "diffuse", "main_texture", "_color", "base"];

    // First pass: project-specific (`/skin{N}/`) + main hint match.
    for p in paths {
        let lower = p.to_lowercase();
        if EFFECT_HINTS.iter().any(|kw| lower.contains(kw)) {
            continue;
        }
        if MAIN_HINTS.iter().any(|kw| lower.contains(kw)) {
            return Some(p.clone());
        }
    }
    // Second pass: any non-effect texture.
    for p in paths {
        let lower = p.to_lowercase();
        if !EFFECT_HINTS.iter().any(|kw| lower.contains(kw)) {
            return Some(p.clone());
        }
    }
    // Last resort: first path of any kind.
    paths.first().cloned()
}

fn visit_strings_in_props<F: FnMut(&str)>(fields: &[BinField], f: &mut F) {
    for field in fields {
        visit_strings_in_value(&field.value, f);
    }
}

fn visit_strings_in_value<F: FnMut(&str)>(v: &BinValue, f: &mut F) {
    match v {
        BinValue::String(s) => f(s),
        BinValue::Embed { fields, .. } | BinValue::Pointer { fields, .. } => {
            visit_strings_in_props(fields, f)
        }
        BinValue::List { items, .. } | BinValue::List2 { items, .. } => {
            for item in items {
                visit_strings_in_value(item, f);
            }
        }
        // Other variants either don't carry strings (numerics,
        // hashes, booleans) or are exotic enough that BIN texture
        // references basically never live in them. If we miss
        // something, the field-name search will still cover it on
        // the next call.
        _ => {}
    }
}

// ── Property unwrappers ────────────────────────────────────────────
//
// All operate on the Jade-native tree: object fields are a flat
// `&[BinField]`, looked up by FNV1a hash via `view::field`, and
// containers are plain `Vec<BinValue>` (no clone needed).

fn embedded_props(v: &BinValue) -> Option<&[BinField]> {
    match v {
        BinValue::Embed { fields, .. } | BinValue::Pointer { fields, .. } => Some(fields),
        _ => None,
    }
}

/// Borrow a container's items. Jade's `List`/`List2` already store a
/// `Vec<BinValue>`, so this is a cheap reslice (no clone).
fn container_items(v: &BinValue) -> Option<&[BinValue]> {
    match v {
        BinValue::List { items, .. } | BinValue::List2 { items, .. } => Some(items),
        _ => None,
    }
}

fn string_field(fields: &[BinField], name_hash: u32) -> Option<&str> {
    match view::field(fields, name_hash)? {
        BinValue::String(s) => Some(s),
        _ => None,
    }
}

fn object_link_field(fields: &[BinField], name_hash: u32) -> Option<u32> {
    match view::field(fields, name_hash)? {
        BinValue::Link(link) => Some(link.hash),
        _ => None,
    }
}

/// Pull an unsigned-int field as `u32`. Tolerates the common widths
/// (`u8`/`u16`/`u32`) since chroma `id` shows up as different types
/// across versions. Wider types (`u64`) truncate; if anyone exceeds
/// `u32::MAX` we have bigger problems.
fn u32_field(fields: &[BinField], name_hash: u32) -> Option<u32> {
    match view::field(fields, name_hash)? {
        BinValue::U8(v) => Some(*v as u32),
        BinValue::U16(v) => Some(*v as u32),
        BinValue::U32(v) => Some(*v),
        BinValue::I8(v) => Some(*v as u32),
        BinValue::I16(v) => Some(*v as u32),
        BinValue::I32(v) => Some(*v as u32),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Sanity-check the precomputed FNV1a-32 hashes against Aventurine's
    /// hardcoded values. If `fnv1a_lower` ever drifts (e.g. a
    /// case-handling tweak), this catches it before the parser starts
    /// silently missing fields.
    #[test]
    fn hash_constants_match_aventurine() {
        assert_eq!(H_SKIN_MESH_PROPERTIES, 0x45ff_5904);
        assert_eq!(H_TEXTURE, 0x3c64_68f4);
        assert_eq!(H_MATERIAL_OVERRIDE, 0x2472_5910);
        assert_eq!(H_SUBMESH, 0xaad7_612c);
        assert_eq!(H_MATERIAL, 0xd2e4_d060);
        assert_eq!(H_SAMPLER_VALUES, 0x0a6f_0eb5);
        assert_eq!(H_TEXTURE_NAME, 0xb311_d4ef);
        assert_eq!(H_TEXTURE_PATH, 0xf0a3_63e3);
    }
}
