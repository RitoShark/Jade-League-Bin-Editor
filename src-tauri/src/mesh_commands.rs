//! Tauri commands for 3D mesh previews. Mirrors `wad_commands.rs` style:
//! the parser lives in `core/mesh/` and these commands are thin
//! request-shaping layers that hand bytes to it.

use crate::core::bin::read_bin_engine;
use crate::core::mesh::skin_textures::find_static_mesh_texture;
use crate::core::mesh::texture_decode::decode_auto;
use crate::core::mesh::{
    find_skin_bin, parse_anm, parse_scb, parse_skl, parse_skn, parse_sco,
    read_skin_textures_for_skn, read_skin_textures_for_skn_disk, read_skn_animations,
    read_skn_animations_disk, write_anm_v4, AnimationListing, BakedAnimation, SkinBinMatch,
    SklSkeleton, SknMesh, StaticMesh,
};
use crate::core::mesh::fbx::{parse_static_fbx, FbxSceneDTO};
use crate::core::wad::{read_chunk_decompressed_bytes, with_mount};
use serde::Serialize;
use std::collections::HashSet;
use std::hash::Hasher;
use std::path::PathBuf;
use twox_hash::XxHash64;

/// Parse an SKN file off disk. Path is whatever the frontend hands us —
/// usually a previously-extracted file from the WAD extract folder.
#[tauri::command]
pub async fn read_skn_mesh(path: String) -> Result<SknMesh, String> {
    let pb = PathBuf::from(&path);
    let bytes = tokio::task::spawn_blocking(move || std::fs::read(&pb))
        .await
        .map_err(|e| format!("Read task join failed: {}", e))?
        .map_err(|e| format!("Read SKN '{}': {}", path, e))?;
    parse_skn(&bytes).map_err(|e| e.to_string())
}

/// Parse a static FBX (mesh + materials + diffuse texture references)
/// for the Photo Studio. Skinning / animation / blend shapes are
/// intentionally not surfaced — those make the parser an order of
/// magnitude larger and aren't needed for "drop in a prop / background
/// model" use cases. Heavy parse runs on the blocking pool because
/// ufbx is sync C code that can take a few hundred ms on large files.
#[tauri::command]
pub async fn read_fbx_static_meshes(path: String) -> Result<FbxSceneDTO, String> {
    let p = path.clone();
    tokio::task::spawn_blocking(move || parse_static_fbx(&p))
        .await
        .map_err(|e| format!("FBX task join: {}", e))?
}

/// Parse an SKN that lives inside a mounted WAD. Pulls the chunk bytes by
/// path hash, decompresses them on the blocking pool, then parses on the
/// async thread (parsing is in-memory and fast — KB to low-MB at most).
#[tauri::command]
pub async fn wad_read_skn_mesh(id: u64, path_hash_hex: String) -> Result<SknMesh, String> {
    let trimmed = path_hash_hex
        .trim()
        .trim_start_matches("0x")
        .trim_start_matches("0X");
    let hash = u64::from_str_radix(trimmed, 16)
        .map_err(|e| format!("Invalid hex hash '{}': {}", path_hash_hex, e))?;

    let info = with_mount(id, |m| {
        m.chunks
            .iter()
            .find(|c| c.path_hash == hash)
            .map(|c| (m.path.clone(), *c))
    })
    .flatten()
    .ok_or_else(|| format!("Chunk {} not in mount {}", path_hash_hex, id))?;

    let (wad_path, chunk) = info;
    let bytes = tokio::task::spawn_blocking(move || read_chunk_decompressed_bytes(&wad_path, &chunk))
        .await
        .map_err(|e| format!("Read task join failed: {}", e))?
        .map_err(|e| e.to_string())?;

    parse_skn(&bytes).map_err(|e| e.to_string())
}

// ── SCB / SCO (static meshes) ───────────────────────────────────────
//
// Same shape as the SKN commands above, just with the StaticMesh DTO.
// Frontend dispatches by the file extension on the previewed source.
// The texture pipeline reuses the existing `wad_guess_textures` flow:
// for a static mesh we pass its single material name as a one-element
// submesh list, the guess searches the same folder, and the matched
// texture (if any) gets applied. No skin-BIN lookup — SCB/SCO
// materials are referenced by direct name and don't show up under
// `skinMeshProperties.materialOverride`.

#[tauri::command]
pub async fn read_scb_mesh(path: String) -> Result<StaticMesh, String> {
    let pb = PathBuf::from(&path);
    let bytes = tokio::task::spawn_blocking(move || std::fs::read(&pb))
        .await
        .map_err(|e| format!("Read task join failed: {}", e))?
        .map_err(|e| format!("Read SCB '{}': {}", path, e))?;
    parse_scb(&bytes).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn wad_read_scb_mesh(id: u64, path_hash_hex: String) -> Result<StaticMesh, String> {
    let trimmed = path_hash_hex
        .trim()
        .trim_start_matches("0x")
        .trim_start_matches("0X");
    let hash = u64::from_str_radix(trimmed, 16)
        .map_err(|e| format!("Invalid hex hash '{}': {}", path_hash_hex, e))?;
    let info = with_mount(id, |m| {
        m.chunks
            .iter()
            .find(|c| c.path_hash == hash)
            .map(|c| (m.path.clone(), *c))
    })
    .flatten()
    .ok_or_else(|| format!("Chunk {} not in mount {}", path_hash_hex, id))?;
    let (wad_path, chunk) = info;
    let bytes = tokio::task::spawn_blocking(move || read_chunk_decompressed_bytes(&wad_path, &chunk))
        .await
        .map_err(|e| format!("Read task join failed: {}", e))?
        .map_err(|e| e.to_string())?;
    parse_scb(&bytes).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn read_sco_mesh(path: String) -> Result<StaticMesh, String> {
    let pb = PathBuf::from(&path);
    let bytes = tokio::task::spawn_blocking(move || std::fs::read(&pb))
        .await
        .map_err(|e| format!("Read task join failed: {}", e))?
        .map_err(|e| format!("Read SCO '{}': {}", path, e))?;
    parse_sco(&bytes).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn wad_read_sco_mesh(id: u64, path_hash_hex: String) -> Result<StaticMesh, String> {
    let trimmed = path_hash_hex
        .trim()
        .trim_start_matches("0x")
        .trim_start_matches("0X");
    let hash = u64::from_str_radix(trimmed, 16)
        .map_err(|e| format!("Invalid hex hash '{}': {}", path_hash_hex, e))?;
    let info = with_mount(id, |m| {
        m.chunks
            .iter()
            .find(|c| c.path_hash == hash)
            .map(|c| (m.path.clone(), *c))
    })
    .flatten()
    .ok_or_else(|| format!("Chunk {} not in mount {}", path_hash_hex, id))?;
    let (wad_path, chunk) = info;
    let bytes = tokio::task::spawn_blocking(move || read_chunk_decompressed_bytes(&wad_path, &chunk))
        .await
        .map_err(|e| format!("Read task join failed: {}", e))?
        .map_err(|e| e.to_string())?;
    parse_sco(&bytes).map_err(|e| e.to_string())
}

// ── SKL (skeleton) ───────────────────────────────────────────────────
//
// Two consumers:
//  1. Standalone `.skl` preview — same shape as SKN, just renders the
//     bone hierarchy without any geometry.
//  2. SKN overlay — when the SKN preview is loaded with the "show
//     skeleton" toggle on, we look up the sibling .skl (same path,
//     different extension) and add its bones to the scene.
//
// `wad_find_sibling_skl` exists for case 2: from an SKN's path hash
// it derives the matching .skl path, hashes that, and returns the
// .skl's path hash if a chunk with that hash lives in the same mount.

#[tauri::command]
pub async fn read_skl_skeleton(path: String) -> Result<SklSkeleton, String> {
    let pb = PathBuf::from(&path);
    let bytes = tokio::task::spawn_blocking(move || std::fs::read(&pb))
        .await
        .map_err(|e| format!("Read task join failed: {}", e))?
        .map_err(|e| format!("Read SKL '{}': {}", path, e))?;
    parse_skl(&bytes).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn wad_read_skl_skeleton(id: u64, path_hash_hex: String) -> Result<SklSkeleton, String> {
    let trimmed = path_hash_hex
        .trim()
        .trim_start_matches("0x")
        .trim_start_matches("0X");
    let hash = u64::from_str_radix(trimmed, 16)
        .map_err(|e| format!("Invalid hex hash '{}': {}", path_hash_hex, e))?;

    let info = with_mount(id, |m| {
        m.chunks
            .iter()
            .find(|c| c.path_hash == hash)
            .map(|c| (m.path.clone(), *c))
    })
    .flatten()
    .ok_or_else(|| format!("Chunk {} not in mount {}", path_hash_hex, id))?;

    let (wad_path, chunk) = info;
    let bytes = tokio::task::spawn_blocking(move || read_chunk_decompressed_bytes(&wad_path, &chunk))
        .await
        .map_err(|e| format!("Read task join failed: {}", e))?
        .map_err(|e| e.to_string())?;

    parse_skl(&bytes).map_err(|e| e.to_string())
}

/// Find the SKL chunk that lives next to the given SKN inside the same
/// mount. Returns `null` when the SKN's path isn't resolved (we can't
/// derive the .skl name from a hash-only path) or when the .skl isn't
/// in this WAD. Frontend uses this to layer a skeleton overlay over
/// the SKN preview.
#[tauri::command]
pub async fn wad_find_sibling_skl(
    id: u64,
    skn_path_hash_hex: String,
) -> Result<Option<String>, String> {
    let trimmed = skn_path_hash_hex
        .trim()
        .trim_start_matches("0x")
        .trim_start_matches("0X");
    let skn_hash = u64::from_str_radix(trimmed, 16)
        .map_err(|e| format!("Invalid hex hash '{}': {}", skn_path_hash_hex, e))?;

    // Need the SKN's resolved path to construct the sibling .skl path.
    // If we only have the hex fallback, there's no way to derive it.
    let skn_path: Option<String> = with_mount(id, |m| m.resolved.get(&skn_hash).cloned()).flatten();
    let Some(skn_path) = skn_path else {
        return Ok(None);
    };

    // Build candidate .skl paths by extension swap. Riot's tooling
    // outputs both lowercase and (rarely) capitalised paths; the
    // candidates list mirrors the same fallbacks `wad_guess_textures`
    // uses so we don't miss a sibling that happens to be cased
    // differently.
    let lower = skn_path.to_lowercase();
    let stem_end = lower.rfind('.').unwrap_or(lower.len());
    let skl_lower = format!("{}.skl", &lower[..stem_end]);

    let chunk_hashes: HashSet<u64> = with_mount(id, |m| {
        m.chunks.iter().map(|c| c.path_hash).collect()
    })
    .unwrap_or_default();

    for candidate in path_candidates(&skl_lower) {
        let h = xxh64_lower(&candidate);
        if chunk_hashes.contains(&h) {
            return Ok(Some(format!("{:016x}", h)));
        }
    }
    Ok(None)
}

/// Locate the skin BIN (`data/characters/{champion}/skins/{skin}.bin`)
/// for a given SKN path inside a mounted WAD. Returns `null` if the SKN
/// isn't in the mount, isn't resolved, or no candidate BIN exists in
/// the WAD.
#[tauri::command]
pub async fn find_skin_bin_for_skn(
    id: u64,
    path_hash_hex: String,
) -> Result<Option<SkinBinMatch>, String> {
    let trimmed = path_hash_hex
        .trim()
        .trim_start_matches("0x")
        .trim_start_matches("0X");
    let hash = u64::from_str_radix(trimmed, 16)
        .map_err(|e| format!("Invalid hex hash '{}': {}", path_hash_hex, e))?;
    Ok(find_skin_bin(id, hash))
}

/// One material/texture entry returned to the frontend, enriched with
/// the texture's chunk hash (if it lives in this same mount). The
/// frontend then uses `wad_read_chunk_b64` to actually fetch + decode
/// the texture bytes — no new bytes-IPC plumbing needed.
#[derive(Debug, Clone, Serialize)]
pub struct TextureBinding {
    pub material: String,
    pub texture_path: String,
    /// `null` when the texture's path can't be hashed to a chunk
    /// present in this mount (e.g. it lives in a different WAD,
    /// or the path uses an `assets/...` prefix that doesn't match
    /// any chunk's resolved name).
    pub chunk_hash_hex: Option<String>,
    /// Disk path to the texture file when the SKN was loaded from
    /// disk and the file exists. `None` for WAD-source previews;
    /// the frontend uses `chunk_hash_hex` in that case.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub texture_disk_path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SknTextureBindings {
    pub bin_path: String,
    pub bin_path_hash_hex: String,
    pub default_texture: Option<String>,
    pub default_chunk_hash_hex: Option<String>,
    /// Disk path to the BASE texture when the SKN was loaded from
    /// disk and the file exists. `None` for WAD-source previews.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_texture_disk_path: Option<String>,
    pub bindings: Vec<TextureBinding>,
    /// Alternate diffuse for shadow / demon / transformed forms —
    /// populated when the resolved StaticMaterialDef has a
    /// `ShadowTexture` (or similar) sampler. `None` when there's no
    /// alternate. Frontend can offer a toggle to swap with
    /// `default_chunk_hash_hex`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shadow_texture: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shadow_chunk_hash_hex: Option<String>,
}

/// Read + parse an ANM chunk from a mounted WAD into a baked
/// per-joint frame table. Heavy enough on big animations (200 joints
/// × 100 frames) that we run on the blocking pool. Compressed ANMs
/// produce a clean error surfaced to the frontend; only uncompressed
/// (v3/v4/v5) plays in v1.
#[tauri::command]
pub async fn wad_load_animation(
    id: u64,
    path_hash_hex: String,
) -> Result<BakedAnimation, String> {
    let trimmed = path_hash_hex
        .trim()
        .trim_start_matches("0x")
        .trim_start_matches("0X");
    let hash = u64::from_str_radix(trimmed, 16)
        .map_err(|e| format!("Invalid hex hash '{}': {}", path_hash_hex, e))?;

    let info = with_mount(id, |m| {
        m.chunks
            .iter()
            .find(|c| c.path_hash == hash)
            .map(|c| (m.path.clone(), *c))
    })
    .flatten()
    .ok_or_else(|| format!("ANM chunk {} not in mount {}", path_hash_hex, id))?;
    let (wad_path, chunk) = info;

    let baked = tokio::task::spawn_blocking(move || -> Result<BakedAnimation, String> {
        let bytes = read_chunk_decompressed_bytes(&wad_path, &chunk)
            .map_err(|e| format!("read ANM chunk: {e}"))?;
        parse_anm(&bytes).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("ANM task join failed: {e}"))??;

    Ok(baked)
}

/// Disk-source counterpart of [`wad_load_animation`]. Reads the ANM
/// straight from the given path (no WAD lookup) and parses it into
/// the same `BakedAnimation` shape, so the frontend's player works
/// identically across sources.
#[tauri::command]
pub async fn read_animation(path: String) -> Result<BakedAnimation, String> {
    let pb = PathBuf::from(&path);
    let baked = tokio::task::spawn_blocking(move || -> Result<BakedAnimation, String> {
        let bytes = std::fs::read(&pb).map_err(|e| format!("read ANM '{}': {}", pb.display(), e))?;
        parse_anm(&bytes).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("ANM task join failed: {e}"))??;
    Ok(baked)
}

/// Bake a `BakedAnimation` to disk as a v4 uncompressed ANM file.
///
/// Used by the Animation Studio's bake-and-write pipeline — the
/// frontend retargets the source clip in JS (per-frame TRS rewrite
/// against the target rig), then ships the resulting DTO here for
/// the Rust v4 writer to serialise. Round-trips losslessly back
/// through `read_animation`.
///
/// - `path`: where to write. Caller is responsible for ensuring the
///   parent directory exists.
/// - `baked`: the already-retargeted animation (target hashes, target
///   bone count, target-rig translations + rotations).
/// - `backup_existing`: when true, an existing file at `path` is
///   renamed to `<path>.bak` (overwriting any prior `.bak`) before
///   the write. Off = silently overwrite.
#[tauri::command]
pub async fn write_animation_v4(
    path: String,
    baked: BakedAnimation,
    backup_existing: bool,
) -> Result<u64, String> {
    let pb = PathBuf::from(&path);
    let bytes = tokio::task::spawn_blocking(move || -> Result<Vec<u8>, String> {
        write_anm_v4(&baked).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("ANM write task join failed: {e}"))??;

    // Backup-existing happens AFTER serialisation succeeds — we
    // don't want to rename the old file out of the way and then
    // fail to write the new one, leaving the user with nothing at
    // the canonical path.
    if backup_existing && pb.exists() {
        let mut backup = pb.clone();
        let new_name = format!(
            "{}.bak",
            pb.file_name().and_then(|s| s.to_str()).unwrap_or("anm"),
        );
        backup.set_file_name(new_name);
        // Remove an existing `.bak` first — `rename` will fail on
        // Windows if the destination already exists.
        if backup.exists() {
            let _ = std::fs::remove_file(&backup);
        }
        std::fs::rename(&pb, &backup)
            .map_err(|e| format!("backup '{}' → '{}': {}", pb.display(), backup.display(), e))?;
    }

    // Ensure the parent folder exists — the default suggested path
    // is `<target>/animations/<clip>`, and a fresh mod won't have
    // an animations/ folder yet. mkdir -p semantics.
    if let Some(parent) = pb.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("create dir '{}': {}", parent.display(), e))?;
        }
    }

    let len = bytes.len() as u64;
    std::fs::write(&pb, &bytes)
        .map_err(|e| format!("write ANM '{}': {}", pb.display(), e))?;
    Ok(len)
}

/// Disk-source counterpart of [`wad_read_skn_animations`]. Walks up
/// from the SKN path to find the skin BIN and animation BIN on disk,
/// returning the same listing shape — except clips carry
/// `anm_disk_path` instead of `anm_chunk_hash_hex`.
/// Disk-source counterpart of [`read_skn_animations_cmd`]. Reads
/// every `.anm` file siblings to the SKN's path and returns the
/// same listing shape — except clips carry `anm_disk_path` instead
/// of `anm_chunk_hash_hex`.
///
/// `extra_anim_dir` is an optional second directory to scan for
/// `.anm` files. The frontend passes the studio scene's "borrowed
/// animations" folder here (returned by `fetch_vanilla_animations`).
/// Anything found is merged into the main listing; duplicates by
/// clip name are skipped so the SKN-folder side wins.
#[tauri::command]
pub async fn read_skn_animations_disk_cmd(
    skn_path: String,
    extra_anim_dir: Option<String>,
) -> Result<Option<AnimationListing>, String> {
    use crate::core::mesh::skin_animations::scan_anm_dir;
    tokio::task::spawn_blocking(move || {
        let mut listing = read_skn_animations_disk(&skn_path)?;
        if let Some(dir) = extra_anim_dir {
            let extra = scan_anm_dir(&dir);
            if !extra.is_empty() {
                match listing.as_mut() {
                    Some(l) => {
                        let existing: std::collections::HashSet<String> =
                            l.clips.iter().map(|c| c.name.to_lowercase()).collect();
                        for clip in extra {
                            if !existing.contains(&clip.name.to_lowercase()) {
                                l.clips.push(clip);
                            }
                        }
                        l.clips.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
                    }
                    None => {
                        listing = Some(crate::core::mesh::AnimationListing {
                            bin_path: String::new(),
                            bin_path_hash_hex: format!("{:016x}", 0u64),
                            clips: extra,
                        });
                    }
                }
            }
        }
        Ok(listing)
    })
    .await
    .map_err(|e| format!("animations disk task join failed: {e}"))?
}

/// Disk-source counterpart of [`wad_read_skin_textures`]. Walks the
/// SKN's sibling skin BIN and resolves each material's texture path
/// to a file on disk under the same root.
#[tauri::command]
pub async fn read_skn_textures_disk(
    skn_path: String,
    submesh_names: Option<Vec<String>>,
) -> Result<Option<SknTextureBindings>, String> {
    let map = tokio::task::spawn_blocking({
        let p = skn_path.clone();
        move || read_skin_textures_for_skn_disk(&p)
    })
    .await
    .map_err(|e| format!("textures disk task join: {e}"))??;

    eprintln!(
        "[textures] read_skn_textures_disk skn={} map={}",
        skn_path,
        if map.is_some() { "Some" } else { "None" }
    );

    use crate::core::mesh::skin_bin::{assets_path_variants, disk_layout_for_skn};
    let layout_opt = disk_layout_for_skn(&skn_path);

    let resolve = |bin_path: &str| -> Option<String> {
        let layout = layout_opt.as_ref()?;
        let lower = bin_path.to_lowercase();
        let rel = lower.strip_prefix("assets/").unwrap_or(&lower);
        assets_path_variants(rel, layout)
            .into_iter()
            .find(|p| std::path::Path::new(p).is_file())
    };

    // Always pre-compute the folder-scan default — used as a safety
    // net whenever the BIN's texture_path strings don't resolve to
    // actual files on disk. Mods commonly rename textures without
    // updating the BIN, which trips the canonical resolver but leaves
    // a perfectly usable texture sitting next to the SKN. Picking it
    // up here means the user sees their mod's texture instead of the
    // hue-placeholder fallback.
    let scan_default = scan_sibling_default_texture(&skn_path);

    // Sibling `.tex`/`.dds` candidates for per-submesh NAME matching.
    // This is what lets a "Weapon" submesh find `..._weapon_tx_cm.tex`
    // even with no BIN (or a BIN whose material names don't line up).
    // Without it, every submesh fell through to `scan_default` — i.e.
    // the body texture got slapped on the weapon, fish, etc.
    let sibling_candidates = gather_sibling_tex_candidates(&skn_path);
    // Noise tokens that carry no submesh identity: the SKN's own stem
    // tokens (e.g. `jax`, `base`, `skin14`) plus universal texture
    // suffixes. Excluding these stops "Weapon" from tying on the shared
    // `jax`/`base`/`tx`/`cm` tokens that EVERY sibling texture has.
    let skn_stem = std::path::Path::new(&skn_path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_lowercase();
    let mut noise: Vec<String> = tokenize(&skn_stem);
    for t in ["tx", "cm", "tex", "dds", "diffuse", "dx9", "dx11", "mat", "material", "color", "albedo", "base", "main"] {
        noise.push(t.to_string());
    }
    let match_by_name = |name: &str| -> Option<String> {
        // Token-overlap scorer first (handles "Bluefish" → `..._fish_tx`),
        // then the legacy exact/strip/whole-string cascade as a backstop.
        match_submesh_token(&sibling_candidates, name, &noise)
            .or_else(|| {
                let n = name.to_lowercase();
                match_exact(&sibling_candidates, &n)
                    .or_else(|| match_strip_digits(&sibling_candidates, &n))
                    .or_else(|| match_fuzzy(&sibling_candidates, &n))
            })
            .map(|(p, _)| p)
    };

    let Some(map) = map else {
        eprintln!(
            "[textures] no BIN map; scan_default={:?}, submeshes={:?}",
            scan_default, submesh_names
        );
        // No BIN: synthesize a binding per submesh by name-matching the
        // sibling textures. Each submesh keeps its own best match and
        // only falls back to the folder default when nothing matches.
        if let Some(names) = submesh_names.filter(|n| !n.is_empty()) {
            let bindings: Vec<TextureBinding> = names
                .into_iter()
                .map(|name| {
                    let path = match_by_name(&name).or_else(|| scan_default.clone());
                    TextureBinding {
                        texture_disk_path: path,
                        chunk_hash_hex: None,
                        material: name,
                        texture_path: String::new(),
                    }
                })
                .collect();
            return Ok(Some(SknTextureBindings {
                bin_path: String::new(),
                bin_path_hash_hex: format!("{:016x}", 0u64),
                default_texture: None,
                default_chunk_hash_hex: None,
                default_texture_disk_path: scan_default,
                bindings,
                shadow_texture: None,
                shadow_chunk_hash_hex: None,
            }));
        }
        // No submesh names supplied — fall back to the single default.
        if let Some(default_disk) = scan_default {
            return Ok(Some(SknTextureBindings {
                bin_path: String::new(),
                bin_path_hash_hex: format!("{:016x}", 0u64),
                default_texture: None,
                default_chunk_hash_hex: None,
                default_texture_disk_path: Some(default_disk),
                bindings: Vec::new(),
                shadow_texture: None,
                shadow_chunk_hash_hex: None,
            }));
        }
        return Ok(None);
    };

    // Resolve the default texture, falling back to the folder-scan
    // default when the BIN's reference doesn't exist on disk.
    let default_via_bin = map.default_texture.as_deref().and_then(&resolve);
    let default_via_bin_present = default_via_bin.is_some();
    let default_texture_disk_path = default_via_bin.or_else(|| scan_default.clone());

    let bindings: Vec<TextureBinding> = map
        .materials
        .into_iter()
        .map(|m| {
            // Tiered: BIN-referenced path → sibling name-match on the
            // material name → folder default. The name-match tier is
            // what stops a renamed-but-unmatched submesh from grabbing
            // the body texture when a same-named sibling exists.
            let final_path = resolve(&m.texture_path)
                .or_else(|| match_by_name(&m.material))
                .or_else(|| scan_default.clone());
            TextureBinding {
                texture_disk_path: final_path,
                chunk_hash_hex: None,
                material: m.material,
                texture_path: m.texture_path,
            }
        })
        .collect();

    eprintln!(
        "[textures] resolved: default_via_bin={} scan_default={:?} bindings={}",
        default_via_bin_present,
        scan_default,
        bindings.len()
    );

    Ok(Some(SknTextureBindings {
        bin_path: map.bin_path,
        bin_path_hash_hex: map.bin_path_hash_hex,
        default_texture: map.default_texture,
        default_chunk_hash_hex: None,
        default_texture_disk_path,
        bindings,
        shadow_texture: map.shadow_texture,
        shadow_chunk_hash_hex: None,
    }))
}

/// Collect sibling `.tex`/`.dds` files next to the SKN as match
/// candidates `(absolute_path, lowercased_stem, 0)`. The trailing `0`
/// is an unused hash slot so the same `match_*` cascade the WAD path
/// uses works unchanged on disk.
fn gather_sibling_tex_candidates(skn_path: &str) -> Vec<(String, String, u64)> {
    let folder = match std::path::Path::new(skn_path).parent() {
        Some(p) => p.to_path_buf(),
        None => return Vec::new(),
    };
    let read_dir = match std::fs::read_dir(&folder) {
        Ok(rd) => rd,
        Err(_) => return Vec::new(),
    };
    let mut candidates = Vec::new();
    for entry in read_dir.flatten() {
        let p = entry.path();
        let lower_name = match p.file_name().and_then(|n| n.to_str()) {
            Some(n) => n.to_lowercase(),
            None => continue,
        };
        if !(lower_name.ends_with(".tex") || lower_name.ends_with(".dds")) {
            continue;
        }
        let stem = match lower_name.rfind('.') {
            Some(i) => lower_name[..i].to_string(),
            None => continue,
        };
        candidates.push((p.to_string_lossy().into_owned(), stem, 0u64));
    }
    candidates
}

/// Pick a fallback default texture for an SKN that has no sibling
/// skin BIN — common when a mod ships only the modified mesh + the
/// replacement texture, without the BIN that would normally tell us
/// which texture belongs to which submesh. Preference order:
///   1. A file in the SKN's folder whose stem shares the SKN stem
///      (e.g. `leblanc_skin19_*.dds` next to `leblanc_skin19.skn`).
///      Disambiguates when the folder holds multiple textures (the
///      `..._weapon_tx_cm.dds` next to the body's `_tx_cm.dds`).
///   2. Any `.tex` / `.dds` / `.png` / `.jpg` in the folder.
/// Returns absolute disk path. Loadscreen / icon textures (filenames
/// containing `loadscreen` / `icon` / `circle`) are skipped — those
/// are obviously wrong as a body texture and trip the heuristic.
fn scan_sibling_default_texture(skn_path: &str) -> Option<String> {
    use std::path::Path;
    let p = Path::new(skn_path);
    let folder = p.parent()?;
    let stem = p.file_stem()?.to_str()?.to_lowercase();
    let read = std::fs::read_dir(folder).ok()?;
    let exts: &[&str] = &["dds", "tex", "png", "jpg", "jpeg", "bmp"];
    let skip_keywords: &[&str] = &["loadscreen", "_icon", "circle", "splash", "tile_", "_dx9"];

    let mut stem_match: Option<String> = None;
    let mut any_match: Option<String> = None;

    for entry in read.flatten() {
        let path = entry.path();
        if !path.is_file() { continue; }
        let Some(name) = path.file_name().and_then(|s| s.to_str()) else { continue };
        let lower = name.to_lowercase();
        let Some(ext_idx) = lower.rfind('.') else { continue };
        let ext = &lower[ext_idx + 1..];
        if !exts.iter().any(|e| *e == ext) { continue; }
        // Skip obvious non-body textures.
        if skip_keywords.iter().any(|k| lower.contains(k)) { continue; }
        let absolute = path.to_string_lossy().into_owned();
        // Stem-aligned match wins outright; first one found is good
        // enough since the loop order is undefined.
        if lower.starts_with(&stem) && stem_match.is_none() {
            stem_match = Some(absolute.clone());
        }
        if any_match.is_none() {
            any_match = Some(absolute);
        }
    }
    stem_match.or(any_match)
}

/// Disk-side fuzzy texture lookup. Mirrors the cascade
/// `wad_guess_textures` runs in-memory, but against `.tex`/`.dds`
/// files that already live in the SKN's folder on disk. Used as a
/// fallback by the Studio when the BIN's `materialOverride` lookup
/// misses a submesh (e.g. Akali, where SKN submesh names don't
/// align with BIN material names).
#[tauri::command]
pub async fn disk_guess_textures(
    skn_path: String,
    submesh_names: Vec<String>,
) -> Result<Vec<Option<String>>, String> {
    tokio::task::spawn_blocking(move || {
        let folder = match std::path::Path::new(&skn_path).parent() {
            Some(p) => p.to_path_buf(),
            None => return Ok(vec![None; submesh_names.len()]),
        };
        let mut candidates: Vec<(String, String, u64)> = Vec::new();
        let read_dir = match std::fs::read_dir(&folder) {
            Ok(rd) => rd,
            Err(_) => return Ok(vec![None; submesh_names.len()]),
        };
        for entry in read_dir.flatten() {
            let p = entry.path();
            let lower_name = match p.file_name().and_then(|n| n.to_str()) {
                Some(n) => n.to_lowercase(),
                None => continue,
            };
            if !(lower_name.ends_with(".tex") || lower_name.ends_with(".dds")) {
                continue;
            }
            let stem = match lower_name.rfind('.') {
                Some(i) => lower_name[..i].to_string(),
                None => continue,
            };
            let path_str = p.to_string_lossy().into_owned();
            // `match_*` helpers only care about (path, stem, _hash);
            // hash unused on disk side so synthesize a stable zero.
            candidates.push((path_str, stem, 0));
        }
        let mut out: Vec<Option<String>> = Vec::with_capacity(submesh_names.len());
        for raw in submesh_names {
            let name = raw.to_lowercase();
            let hit = match_exact(&candidates, &name)
                .or_else(|| match_strip_digits(&candidates, &name))
                .or_else(|| match_fuzzy(&candidates, &name))
                .map(|(p, _)| p);
            out.push(hit);
        }
        Ok::<Vec<Option<String>>, String>(out)
    })
    .await
    .map_err(|e| format!("disk guess textures join: {e}"))?
}

/// Resolve the SKN's skin BIN → AnimationGraphData link → animation
/// BIN, and return its `AtomicClipData` clips with resolved chunk
/// hashes. Returns `null` for any structural miss (no skin BIN, no
/// animation graph, animation BIN not in mount). Heavy enough on
/// big champion BINs that we run on the blocking pool.
#[tauri::command]
pub async fn wad_read_skn_animations(
    id: u64,
    path_hash_hex: String,
) -> Result<Option<AnimationListing>, String> {
    let trimmed = path_hash_hex
        .trim()
        .trim_start_matches("0x")
        .trim_start_matches("0X");
    let hash = u64::from_str_radix(trimmed, 16)
        .map_err(|e| format!("Invalid hex hash '{}': {}", path_hash_hex, e))?;

    let listing = tokio::task::spawn_blocking(move || read_skn_animations(id, hash))
        .await
        .map_err(|e| format!("animations task join failed: {e}"))??;

    Ok(listing)
}

/// Resolve every texture path the SKN's skin BIN references to its
/// chunk hash inside `mount_id`. Returns `null` if the SKN's BIN can't
/// be located in the mount.
#[tauri::command]
pub async fn wad_read_skin_textures(
    id: u64,
    path_hash_hex: String,
) -> Result<Option<SknTextureBindings>, String> {
    let trimmed = path_hash_hex
        .trim()
        .trim_start_matches("0x")
        .trim_start_matches("0X");
    let hash = u64::from_str_radix(trimmed, 16)
        .map_err(|e| format!("Invalid hex hash '{}': {}", path_hash_hex, e))?;

    // Heavy work — running BIN→text on the blocking pool keeps the
    // Tauri runtime responsive even on chunky champion BINs.
    let map = tokio::task::spawn_blocking(move || read_skin_textures_for_skn(id, hash))
        .await
        .map_err(|e| format!("texture-map task join failed: {e}"))??;

    let Some(map) = map else { return Ok(None) };

    // Build the set of chunk hashes in this mount once so we can do
    // O(1) presence checks per texture path. (Some champions reference
    // dozens of textures via shared materials.)
    let chunk_hashes: HashSet<u64> = with_mount(id, |m| {
        m.chunks.iter().map(|c| c.path_hash).collect()
    })
    .unwrap_or_default();

    // For each texture path, try the canonical hash + a couple of
    // common variants. Riot is inconsistent with `assets/` vs. `data/`
    // and case (paths in BINs are sometimes upper-cased ASSETS/...).
    let resolve = |path: &str| -> Option<String> {
        for candidate in path_candidates(path) {
            let h = xxh64_lower(&candidate);
            if chunk_hashes.contains(&h) {
                return Some(format!("{:016x}", h));
            }
        }
        None
    };

    let mut default_chunk_hash_hex = map.default_texture.as_deref().and_then(&resolve);
    let bindings = map
        .materials
        .into_iter()
        .map(|m| TextureBinding {
            chunk_hash_hex: resolve(&m.texture_path),
            material: m.material,
            texture_path: m.texture_path,
            texture_disk_path: None,
        })
        .collect();

    // Belt-and-suspenders: if the BIN's `texture: string` line didn't
    // xxh64-resolve to a chunk in this WAD — which happens whenever the
    // chunk is named slightly differently than the BIN's reference
    // (e.g. `.dds` vs `.tex` already covered by `path_candidates`, but
    // also when the texture lives in a sibling folder, or under a stem
    // the BIN doesn't predict) — fall back to scanning the SKN's
    // folder for a likely "main" diffuse. Same heuristics
    // `wad_guess_textures` uses: prefer `*_tx_cm`, `*_diffuse`,
    // `mainTexture`, etc., skip obvious effect maps.
    if default_chunk_hash_hex.is_none() {
        default_chunk_hash_hex = find_folder_main_texture(id, hash);
        if default_chunk_hash_hex.is_some() {
            eprintln!(
                "[textures] BIN default '{}' didn't resolve in mount {}; falling back to folder-scanned main texture",
                map.default_texture.as_deref().unwrap_or("(none)"),
                id,
            );
        }
    }

    let shadow_chunk_hash_hex = map.shadow_texture.as_deref().and_then(&resolve);

    Ok(Some(SknTextureBindings {
        bin_path: map.bin_path,
        bin_path_hash_hex: map.bin_path_hash_hex,
        default_texture: map.default_texture,
        default_chunk_hash_hex,
        default_texture_disk_path: None,
        bindings,
        shadow_texture: map.shadow_texture,
        shadow_chunk_hash_hex,
    }))
}

/// Scan the SKN's folder for the most likely "main" diffuse texture
/// chunk, returning its hex hash. Used as a fallback when the BIN's
/// own `texture:` string doesn't resolve to anything in the mount —
/// covers cases where Riot renamed the chunk slightly between BIN
/// authoring and shipping, or stripped extensions, or moved a file
/// into a sibling folder.
///
/// Heuristic priority (mirrors `wad_guess_textures`):
///   1. Texture whose stem contains `_tx_cm` or `tx_cm`
///   2. Texture whose stem contains `diffuse` / `main_texture` /
///      `_color` / `base`
///   3. First non-effect texture found
fn find_folder_main_texture(mount_id: u64, skn_hash: u64) -> Option<String> {
    const EFFECT_HINTS: &[&str] = &[
        "erosion", "_n.", "_dn.", "normal", "noise", "_mask",
        "alphaerosion", "_em.", "emissive",
    ];
    const PRIMARY_HINTS: &[&str] = &["_tx_cm", "tx_cm"];
    const SECONDARY_HINTS: &[&str] = &["diffuse", "main_texture", "_color", "base"];

    let candidates: Vec<(String, u64)> = with_mount(mount_id, |m| {
        let skn_path = m.resolved.get(&skn_hash)?;
        let lower_skn = skn_path.to_lowercase();
        let folder = lower_skn.rfind('/').map(|i| &lower_skn[..i])?.to_string();
        Some(
            m.chunks
                .iter()
                .filter_map(|c| {
                    let path = m.resolved.get(&c.path_hash)?;
                    let lower = path.to_lowercase();
                    if !(lower.ends_with(".tex") || lower.ends_with(".dds")) {
                        return None;
                    }
                    let chunk_folder = lower.rfind('/').map(|i| &lower[..i])?;
                    if chunk_folder != folder {
                        return None;
                    }
                    Some((lower, c.path_hash))
                })
                .collect(),
        )
    })
    .flatten()
    .unwrap_or_default();

    let is_effect = |p: &str| EFFECT_HINTS.iter().any(|kw| p.contains(kw));

    // Pass 1: primary hint, no effect.
    for (p, h) in &candidates {
        if !is_effect(p) && PRIMARY_HINTS.iter().any(|kw| p.contains(kw)) {
            return Some(format!("{:016x}", h));
        }
    }
    // Pass 2: secondary hint, no effect.
    for (p, h) in &candidates {
        if !is_effect(p) && SECONDARY_HINTS.iter().any(|kw| p.contains(kw)) {
            return Some(format!("{:016x}", h));
        }
    }
    // Pass 3: first non-effect.
    for (p, h) in &candidates {
        if !is_effect(p) {
            return Some(format!("{:016x}", h));
        }
    }
    None
}

/// Resolve the chroma's per-submesh texture overrides on top of the
/// base skin BIN, returning the merged binding list (base → chroma
/// overrides win). `chroma_id` is CDragon's chroma id (e.g. 266001).
///
/// The chroma's overrides live as a separate `SkinCharacterDataProperties`
/// inside the *same* skin BIN, linked from the parent via `chromas`
/// or `chromaList`. Returns `Ok(None)` if the chroma isn't found in
/// the BIN — the caller should keep the base bindings unchanged.
#[tauri::command]
pub async fn wad_read_chroma_textures(
    id: u64,
    path_hash_hex: String,
    chroma_id: u32,
) -> Result<Option<SknTextureBindings>, String> {
    use crate::core::bin::{read_bin_engine, JadeBin as BinTree};
    use crate::core::bin::jade::view;
    use crate::core::mesh::skin_bin::{find_chroma_bin, find_skin_bin};
    use crate::core::mesh::skin_textures::{extract_textures_from_trees, SkinTextureMap};

    let trimmed = path_hash_hex
        .trim()
        .trim_start_matches("0x")
        .trim_start_matches("0X");
    let skn_hash = u64::from_str_radix(trimmed, 16)
        .map_err(|e| format!("Invalid hex hash '{}': {}", path_hash_hex, e))?;

    // Chromas live in their own `skinNN.bin` slot, siblings of the
    // base skin on disk. CDragon's chroma id is `<championKey> * 1000
    // + skinNum`, so the last three digits give the skin number to
    // load. The chroma BIN is just another skin BIN — same parser,
    // same texture-extractor, same dependency walk.
    let chroma_skin_num = chroma_id % 1000;

    let combined = tokio::task::spawn_blocking(move || -> Result<Option<SkinTextureMap>, String> {
        // Locate both BINs up front: base (for the merge floor) and
        // chroma (for the overrides). Either missing → bail.
        let base_match = match find_skin_bin(id, skn_hash) {
            Some(m) => m,
            None => return Ok(None),
        };
        let chroma_match = match find_chroma_bin(id, skn_hash, chroma_skin_num) {
            Some(m) => m,
            None => return Ok(None),
        };

        // Inline helper: read a BIN by chunk hash + walk its
        // `tree.dependencies` for sibling material BINs, returning the
        // full tree set (primary first). Mirrors the read flow in the
        // base texture command — chromas can cross-BIN too.
        let read_with_deps = |bin_hash_hex: &str, bin_label: &str| -> Result<Vec<BinTree>, String> {
            let bin_hash = u64::from_str_radix(bin_hash_hex, 16)
                .map_err(|e| format!("bad {bin_label} bin hash hex: {e}"))?;
            let info = with_mount(id, |m| {
                m.chunks
                    .iter()
                    .find(|c| c.path_hash == bin_hash)
                    .map(|c| (m.path.clone(), *c))
            })
            .flatten()
            .ok_or_else(|| format!("{bin_label} bin chunk {bin_hash_hex} not in mount {id}"))?;
            let bytes = read_chunk_decompressed_bytes(&info.0, &info.1)
                .map_err(|e| format!("read {bin_label} bin chunk: {e}"))?;
            let primary = read_bin_engine(&bytes)
                .map_err(|e| format!("parse {bin_label} bin tree: {e}"))?;

            let primary_deps = view::dependencies(&primary);
            let mut trees: Vec<BinTree> = Vec::with_capacity(1 + primary_deps.len());
            for dep_path in &primary_deps {
                let lower = dep_path.to_lowercase();
                let dep_hash = xxh64_lower(&lower);
                let dep_info = with_mount(id, |m| {
                    m.chunks
                        .iter()
                        .find(|c| c.path_hash == dep_hash)
                        .map(|c| (m.path.clone(), *c))
                })
                .flatten();
                let Some(dep_info) = dep_info else { continue };
                let Ok(dep_bytes) = read_chunk_decompressed_bytes(&dep_info.0, &dep_info.1) else {
                    continue;
                };
                if let Ok(t) = read_bin_engine(&dep_bytes) {
                    trees.push(t);
                }
            }
            // Primary must lead — `extract_textures_from_trees` reads
            // SCDPs from `trees[0]` and uses the rest only for cross-
            // BIN material/texture resolution.
            trees.insert(0, primary);
            Ok(trees)
        };

        let base_trees = read_with_deps(&base_match.path_hash_hex, "base")?;
        let chroma_trees = read_with_deps(&chroma_match.path_hash_hex, "chroma")?;

        let (base_default, base_materials, base_shadow) =
            extract_textures_from_trees(&base_trees);
        let (chroma_default, chroma_materials, chroma_shadow) =
            extract_textures_from_trees(&chroma_trees);

        // Merge: chroma overlays base. Defaults / shadow swap only if
        // the chroma supplies one; per-submesh material overrides win
        // on name match, otherwise append.
        let mut default_texture = base_default;
        if chroma_default.is_some() {
            default_texture = chroma_default;
        }
        let mut shadow_texture = base_shadow;
        if chroma_shadow.is_some() {
            shadow_texture = chroma_shadow;
        }
        let mut materials = base_materials;
        for override_entry in chroma_materials {
            if let Some(slot) = materials
                .iter_mut()
                .find(|m| m.material.eq_ignore_ascii_case(&override_entry.material))
            {
                slot.texture_path = override_entry.texture_path;
            } else {
                materials.push(override_entry);
            }
        }

        Ok(Some(SkinTextureMap {
            // Report the **chroma** BIN's path so the frontend can
            // tell which file was actually loaded (useful for debug).
            bin_path: chroma_match.path,
            bin_path_hash_hex: chroma_match.path_hash_hex,
            default_texture,
            materials,
            shadow_texture,
        }))
    })
    .await
    .map_err(|e| format!("chroma-texture task join: {e}"))??;

    let Some(map) = combined else { return Ok(None) };

    let chunk_hashes: HashSet<u64> = with_mount(id, |m| {
        m.chunks.iter().map(|c| c.path_hash).collect()
    })
    .unwrap_or_default();

    let resolve = |path: &str| -> Option<String> {
        for candidate in path_candidates(path) {
            let h = xxh64_lower(&candidate);
            if chunk_hashes.contains(&h) {
                return Some(format!("{:016x}", h));
            }
        }
        None
    };

    let default_chunk_hash_hex = map.default_texture.as_deref().and_then(resolve);
    let bindings = map
        .materials
        .into_iter()
        .map(|m| TextureBinding {
            chunk_hash_hex: resolve(&m.texture_path),
            material: m.material,
            texture_path: m.texture_path,
            texture_disk_path: None,
        })
        .collect();

    let shadow_chunk_hash_hex = map.shadow_texture.as_deref().and_then(&resolve);

    Ok(Some(SknTextureBindings {
        bin_path: map.bin_path,
        bin_path_hash_hex: map.bin_path_hash_hex,
        default_texture: map.default_texture,
        default_chunk_hash_hex,
        default_texture_disk_path: None,
        bindings,
        shadow_texture: map.shadow_texture,
        shadow_chunk_hash_hex,
    }))
}

/// Result of the BIN-driven SKN lookup. Both forms of the path are
/// returned so the frontend can decide whether to consume the chunk
/// directly via hash or render a "not found" message including the
/// path the BIN pointed at.
#[derive(Serialize)]
pub struct SimpleSknRef {
    /// BIN-form path the engine references (e.g.
    /// `assets/characters/rell/skins/base/rell_base.skn`), lowercased.
    pub bin_path: String,
    /// 16-char hex of the SKN chunk inside `mount_id`, or `None` if the
    /// path didn't resolve to a chunk (very rare — only if the WAD is
    /// missing the SKN the BIN claims to need).
    pub chunk_hash_hex: Option<String>,
}

/// Read the `simpleSkin: string` line from the skin BIN that
/// corresponds to `(champion, skin_num)`, then resolve it to a chunk
/// hash inside the mount. This is the **canonical** way to find the
/// engine-rendered SKN for a champion's skin — beats any filename
/// heuristic because the BIN is the ground truth.
///
/// Returns `null` when the skin BIN itself can't be found in the
/// mount, or when the BIN has no `simpleSkin` field on its first
/// SkinCharacterDataProperties.
#[tauri::command]
pub async fn viewer_resolve_skn(
    id: u64,
    champion: String,
    skin_num: u32,
) -> Result<Option<SimpleSknRef>, String> {
    use crate::core::mesh::skin_textures::extract_simple_skin;

    let result = tokio::task::spawn_blocking(move || -> Result<Option<SimpleSknRef>, String> {
        // Construct the canonical skin BIN paths and find which one
        // is actually in the mount. Mirrors the candidate generator
        // used by `find_skin_bin` but works from `(champ, skin_num)`
        // instead of an SKN path.
        let champ_lower = champion.to_lowercase();
        let mut bin_candidates: Vec<String> = Vec::new();
        if skin_num == 0 {
            bin_candidates.push(format!("data/characters/{champ_lower}/skins/skin0.bin"));
            bin_candidates.push(format!("data/characters/{champ_lower}/skins/base.bin"));
        } else {
            bin_candidates.push(format!("data/characters/{champ_lower}/skins/skin{skin_num}.bin"));
            // Zero-padded variant for Riot's inconsistent naming.
            bin_candidates.push(format!(
                "data/characters/{champ_lower}/skins/skin{:02}.bin",
                skin_num
            ));
        }

        // Find the first candidate path that maps to a chunk in the mount.
        let mount_info = with_mount(id, |m| {
            for cand in &bin_candidates {
                let h = xxh64_lower(cand);
                if let Some(c) = m.chunks.iter().find(|c| c.path_hash == h) {
                    return Some((m.path.clone(), *c));
                }
            }
            None
        })
        .flatten();
        let (wad_path, bin_chunk) = match mount_info {
            Some(t) => t,
            None => return Ok(None),
        };

        // Read + parse the skin BIN, pull `simpleSkin` from the first SCDP.
        let bytes = read_chunk_decompressed_bytes(&wad_path, &bin_chunk)
            .map_err(|e| format!("read skin bin: {e}"))?;
        let tree = read_bin_engine(&bytes).map_err(|e| format!("parse skin bin: {e}"))?;
        let simple_skin = match extract_simple_skin(&tree) {
            Some(s) => s,
            None => return Ok(None),
        };

        // Resolve the simpleSkin path to a chunk hash inside the same
        // mount. Re-use `path_candidates` so `assets/`/`data/` and
        // `.tex`/`.dds` variants (irrelevant for .skn but cheap to try)
        // both flow through the same logic the texture binder uses.
        let chunk_hashes: HashSet<u64> = with_mount(id, |m| {
            m.chunks.iter().map(|c| c.path_hash).collect()
        })
        .unwrap_or_default();
        let chunk_hash_hex = path_candidates(&simple_skin)
            .into_iter()
            .find_map(|c| {
                let h = xxh64_lower(&c);
                if chunk_hashes.contains(&h) {
                    Some(format!("{:016x}", h))
                } else {
                    None
                }
            });

        Ok(Some(SimpleSknRef {
            bin_path: simple_skin,
            chunk_hash_hex,
        }))
    })
    .await
    .map_err(|e| format!("simpleSkin task join: {e}"))??;

    Ok(result)
}

/// Collect every chunk hash in the mounted WAD that belongs to a
/// specific champion+skin: SKN/SKL/textures/particles under
/// `assets/.../skins/<skin>/` and `data/.../skins/<skin>/`, plus the
/// standalone skin BIN at `data/.../skins/skin{N}.bin`. Returns
/// 16-char hex strings ready to feed straight to `wad_extract`'s
/// `selected_hashes` parameter.
///
/// Used by the Viewer's "Export skin files" button — re-uses the
/// existing extract pipeline (parallel rayon write, structure/flat
/// modes, progress events) without forking a parallel exporter.
#[tauri::command]
pub async fn viewer_collect_skin_chunks(
    id: u64,
    champion: String,
    skin_num: u32,
) -> Result<Vec<String>, String> {
    let result = tokio::task::spawn_blocking(move || -> Result<Vec<String>, String> {
        let champ_lower = champion.to_lowercase();
        let skin_folder = if skin_num == 0 {
            "base".to_string()
        } else {
            format!("skin{skin_num}")
        };
        let zero_padded = if skin_num == 0 {
            None
        } else {
            Some(format!("skin{:02}", skin_num))
        };

        let mut folder_prefixes: Vec<String> = vec![
            format!("assets/characters/{champ_lower}/skins/{skin_folder}/"),
            format!("data/characters/{champ_lower}/skins/{skin_folder}/"),
        ];
        if let Some(zp) = &zero_padded {
            folder_prefixes.push(format!("assets/characters/{champ_lower}/skins/{zp}/"));
            folder_prefixes.push(format!("data/characters/{champ_lower}/skins/{zp}/"));
        }
        let exact_files: Vec<String> = vec![
            format!("data/characters/{champ_lower}/skins/skin{skin_num}.bin"),
            format!("data/characters/{champ_lower}/skins/skin{:02}.bin", skin_num),
        ];

        let hashes: Vec<String> = with_mount(id, |m| {
            let mut out: Vec<String> = Vec::new();
            for chunk in &m.chunks {
                let Some(path) = m.resolved.get(&chunk.path_hash) else { continue };
                let lower = path.to_lowercase();
                let matches = folder_prefixes.iter().any(|p| lower.starts_with(p))
                    || exact_files.iter().any(|p| lower == *p);
                if matches {
                    out.push(format!("{:016x}", chunk.path_hash));
                }
            }
            out
        })
        .unwrap_or_default();

        if hashes.is_empty() {
            return Err(format!(
                "No chunks matched skin{} for {}",
                skin_num, champion
            ));
        }
        Ok(hashes)
    })
    .await
    .map_err(|e| format!("collect-skin-chunks task join: {e}"))??;

    Ok(result)
}

/// Decompressed skin-BIN bytes plus the BIN's WAD path. Frontend pipes
/// the bytes through `convert_bin_bytes_to_text` to get a Monaco-ready
/// text buffer and opens it as a new editor tab.
#[derive(Serialize)]
pub struct SkinBinBytes {
    pub bin_path: String,
    pub bytes: Vec<u8>,
}

/// Read + decompress the skin BIN that corresponds to
/// `(champion, skin_num)` from a mounted WAD. Mirrors
/// [`viewer_resolve_skn`]'s lookup logic (same candidate path set) but
/// returns the BIN's raw bytes instead of following its `simpleSkin`
/// pointer. Returns `Ok(None)` if the BIN can't be found in the mount.
#[tauri::command]
pub async fn viewer_read_skin_bin(
    id: u64,
    champion: String,
    skin_num: u32,
) -> Result<Option<SkinBinBytes>, String> {
    let result = tokio::task::spawn_blocking(move || -> Result<Option<SkinBinBytes>, String> {
        let champ_lower = champion.to_lowercase();
        let mut bin_candidates: Vec<String> = Vec::new();
        if skin_num == 0 {
            bin_candidates.push(format!("data/characters/{champ_lower}/skins/skin0.bin"));
            bin_candidates.push(format!("data/characters/{champ_lower}/skins/base.bin"));
        } else {
            bin_candidates.push(format!("data/characters/{champ_lower}/skins/skin{skin_num}.bin"));
            bin_candidates.push(format!(
                "data/characters/{champ_lower}/skins/skin{:02}.bin",
                skin_num
            ));
        }

        let mount_info = with_mount(id, |m| {
            for cand in &bin_candidates {
                let h = xxh64_lower(cand);
                if let Some(c) = m.chunks.iter().find(|c| c.path_hash == h) {
                    return Some((m.path.clone(), *c, cand.clone()));
                }
            }
            None
        })
        .flatten();
        let (wad_path, bin_chunk, bin_path) = match mount_info {
            Some(t) => t,
            None => return Ok(None),
        };

        let bytes = read_chunk_decompressed_bytes(&wad_path, &bin_chunk)
            .map_err(|e| format!("read skin bin: {e}"))?;
        Ok(Some(SkinBinBytes { bin_path, bytes }))
    })
    .await
    .map_err(|e| format!("read-skin-bin task join: {e}"))??;

    Ok(result)
}

/// Extract everything in the skin's folder (SKN, SKL, BIN, textures,
/// particle .tex/.dds files, …) from a mounted WAD to a temp dir on
/// disk, returning the SKN's filesystem path. Used by the Viewer's
/// "Send to Photo Studio" action — the Studio's existing disk-load
/// flow + `read_skn_textures_disk` then pick everything up from disk
/// without any WAD plumbing of its own.
///
/// We mirror the WAD's `assets/.../skins/<skin>/` and `data/.../skins/<skin>/`
/// subtrees plus the standalone `data/.../skins/skin{N}.bin` so the BIN
/// walker's `disk_layout_for_skn` can resolve every texture path the
/// usual way.
///
/// Temp dir lives under the app's config dir (`<config>/viewer_temp/`)
/// so it's stable across sessions and easy for the user to clean up.
/// Each call uses a millisecond-stamped subdir to keep concurrent
/// extractions from clobbering each other.
#[tauri::command]
pub async fn viewer_extract_for_studio(
    id: u64,
    champion: String,
    skin_num: u32,
    skn_chunk_hash_hex: String,
    shadow_form: Option<bool>,
    // chroma_skin_num: when Some, copy the chroma's skin{N}.bin bytes
    // OVER the parent skin's BIN file on disk so the studio's disk
    // texture pipeline reads chroma material refs (mesh stays parent
    // SKN). Chroma's `tree.dependencies` also get extracted so cross-
    // BIN material links resolve (Evelynn-style sibling BINs).
    chroma_skin_num: Option<u32>,
    // Authoritative per-submesh texture binding the Viewer resolved.
    // When provided, we write a sidecar `.jade_texture_map.json` in
    // the extracted SKN folder so the Studio uses the Viewer's
    // mapping verbatim instead of re-deriving it.
    texture_bindings: Option<Vec<ViewerTextureBindingIn>>,
) -> Result<String, String> {
    use crate::app_commands::get_config_dir;
    use crate::core::mesh::skin_textures::read_skin_textures_for_skn;

    let trimmed = skn_chunk_hash_hex
        .trim()
        .trim_start_matches("0x")
        .trim_start_matches("0X");
    let skn_hash = u64::from_str_radix(trimmed, 16)
        .map_err(|e| format!("Invalid hex hash '{}': {}", skn_chunk_hash_hex, e))?;
    let shadow_form = shadow_form.unwrap_or(false);

    let result = tokio::task::spawn_blocking(move || -> Result<String, String> {
        let champ_lower = champion.to_lowercase();
        let skin_folder = if skin_num == 0 {
            "base".to_string()
        } else {
            format!("skin{skin_num}")
        };
        let zero_padded = if skin_num == 0 {
            None
        } else {
            Some(format!("skin{:02}", skin_num))
        };

        // Folder prefixes (with trailing slash) of every chunk we'll
        // extract. Hits SKN/SKL/textures/particles/etc. — anything
        // Riot put in the skin's folder.
        let mut folder_prefixes: Vec<String> = vec![
            format!("assets/characters/{champ_lower}/skins/{skin_folder}/"),
            format!("data/characters/{champ_lower}/skins/{skin_folder}/"),
        ];
        if let Some(zp) = &zero_padded {
            folder_prefixes.push(format!("assets/characters/{champ_lower}/skins/{zp}/"));
            folder_prefixes.push(format!("data/characters/{champ_lower}/skins/{zp}/"));
        }
        // Files (exact paths) — the skin BIN sits at the parent
        // `skins/` level, not inside the per-skin folder.
        let exact_files: Vec<String> = vec![
            format!("data/characters/{champ_lower}/skins/skin{skin_num}.bin"),
            format!("data/characters/{champ_lower}/skins/skin{:02}.bin", skin_num),
        ];

        // Build the initial plan (skin folder + skin BIN) then peek
        // inside the skin BIN to also collect its `linked:`
        // dependencies — those live OUTSIDE the per-skin folder for
        // multi-skin champions like Evelynn (her material def is in
        // `data/characters/evelynn/evelynn_multi_skins_*.bin`). Without
        // the linked deps the disk-side texture binder fails to
        // resolve her diffuse.
        let mut plan: Vec<(crate::core::wad::WadChunk, std::path::PathBuf)> = with_mount(id, |m| {
            let mut out: Vec<(crate::core::wad::WadChunk, std::path::PathBuf)> = Vec::new();
            for chunk in &m.chunks {
                let Some(path) = m.resolved.get(&chunk.path_hash) else { continue };
                let lower = path.to_lowercase();
                let matches_folder = folder_prefixes.iter().any(|p| lower.starts_with(p));
                let matches_file = exact_files.iter().any(|p| lower == *p);
                if !matches_folder && !matches_file {
                    continue;
                }
                out.push((*chunk, std::path::PathBuf::from(&lower)));
            }
            out
        })
        .unwrap_or_default();

        if plan.is_empty() {
            return Err(format!(
                "No chunks matched skin{} for {}",
                skin_num, champion
            ));
        }

        // Pull dependency paths from the skin BIN's header so we can
        // also extract any sibling material / VFX BINs referenced from
        // it. Failures are non-fatal — we still ship the basic mesh.
        let dep_lowered: Vec<String> = (|| -> Vec<String> {
            let wad_for_bin = match with_mount(id, |m| m.path.clone()) {
                Some(p) => p,
                None => return Vec::new(),
            };
            let bin_chunk = plan
                .iter()
                .find(|(_, rel)| {
                    let s = rel.to_string_lossy().to_lowercase();
                    exact_files.iter().any(|p| s == *p)
                })
                .map(|(c, _)| *c);
            let Some(bc) = bin_chunk else { return Vec::new() };
            let bytes = match read_chunk_decompressed_bytes(&wad_for_bin, &bc) {
                Ok(b) => b,
                Err(_) => return Vec::new(),
            };
            let tree = match crate::core::bin::read_bin_engine(&bytes) {
                Ok(t) => t,
                Err(_) => return Vec::new(),
            };
            crate::core::bin::jade::view::dependencies(&tree)
                .iter()
                .map(|d| d.to_lowercase())
                .collect()
        })();

        if !dep_lowered.is_empty() {
            let already: std::collections::HashSet<u64> =
                plan.iter().map(|(c, _)| c.path_hash).collect();
            let extra: Vec<(crate::core::wad::WadChunk, std::path::PathBuf)> =
                with_mount(id, |m| {
                    let mut out = Vec::new();
                    for chunk in &m.chunks {
                        if already.contains(&chunk.path_hash) {
                            continue;
                        }
                        let Some(path) = m.resolved.get(&chunk.path_hash) else { continue };
                        let lower = path.to_lowercase();
                        if dep_lowered.iter().any(|d| d == &lower) {
                            out.push((*chunk, std::path::PathBuf::from(&lower)));
                        }
                    }
                    out
                })
                .unwrap_or_default();
            plan.extend(extra);
        }

        // ── Union in viewer-binding textures ──────────────────────
        // The viewer reads textures directly from WAD chunks, so a
        // weapon/accessory texture may live anywhere in the WAD —
        // not necessarily under the skin folder we just enumerated.
        // For every chunk hash the viewer's bindings reference, add
        // the chunk to the plan if it isn't already there. Without
        // this, sending a champion like Akali to Studio drops every
        // texture that lives outside `skins/<skin>/`.
        if let Some(ref bindings) = texture_bindings {
            let already: std::collections::HashSet<u64> =
                plan.iter().map(|(c, _)| c.path_hash).collect();
            let wanted_hashes: std::collections::HashSet<u64> = bindings
                .iter()
                .filter_map(|b| {
                    let hex = b.chunk_hash_hex.as_deref()?;
                    let trimmed = hex
                        .trim()
                        .trim_start_matches("0x")
                        .trim_start_matches("0X");
                    u64::from_str_radix(trimmed, 16).ok()
                })
                .collect();
            let texture_extras: Vec<(crate::core::wad::WadChunk, std::path::PathBuf)> =
                with_mount(id, |m| {
                    let mut out = Vec::new();
                    for chunk in &m.chunks {
                        if already.contains(&chunk.path_hash) {
                            continue;
                        }
                        if !wanted_hashes.contains(&chunk.path_hash) {
                            continue;
                        }
                        let Some(path) = m.resolved.get(&chunk.path_hash) else { continue };
                        out.push((*chunk, std::path::PathBuf::from(path.to_lowercase())));
                    }
                    out
                })
                .unwrap_or_default();
            plan.extend(texture_extras);
        }

        // ── BIN-referenced texture extraction (base skin) ─────────
        // Same idea as the chroma branch below — ask the WAD-side
        // BIN walker for every texture path the skin's materials
        // reference (default + per-material + shadow), then ensure
        // each one has its chunk in the extraction plan. This is
        // what catches champions whose weapon / accessory textures
        // live OUTSIDE the per-skin folder (Akali) — the folder-
        // prefix sweep above misses them, the viewer-binding pass
        // only sees what the host happened to pass us, but the BIN
        // itself knows exactly which textures it needs.
        {
            let mut bin_tex_paths: Vec<String> = Vec::new();
            if let Ok(Some(tmap)) = read_skin_textures_for_skn(id, skn_hash) {
                if let Some(d) = tmap.default_texture {
                    bin_tex_paths.push(d);
                }
                for m in tmap.materials {
                    bin_tex_paths.push(m.texture_path);
                }
                if let Some(s) = tmap.shadow_texture {
                    bin_tex_paths.push(s);
                }
            }
            if !bin_tex_paths.is_empty() {
                let already: std::collections::HashSet<u64> =
                    plan.iter().map(|(c, _)| c.path_hash).collect();
                let mut want_hashes: std::collections::HashMap<u64, String> =
                    std::collections::HashMap::new();
                for tex in &bin_tex_paths {
                    for cand in path_candidates(tex) {
                        want_hashes.insert(xxh64_lower(&cand), cand);
                    }
                }
                let tex_extras: Vec<(crate::core::wad::WadChunk, std::path::PathBuf)> =
                    with_mount(id, |m| {
                        let mut out = Vec::new();
                        for chunk in &m.chunks {
                            if already.contains(&chunk.path_hash) {
                                continue;
                            }
                            if let Some(p) = want_hashes.get(&chunk.path_hash) {
                                out.push((*chunk, std::path::PathBuf::from(p)));
                            }
                        }
                        out
                    })
                    .unwrap_or_default();
                plan.extend(tex_extras);
            }
        }

        // Build the temp dir.
        let cfg_dir = get_config_dir().map_err(|e| format!("config dir: {e}"))?;
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let temp_dir = cfg_dir.join("viewer_temp").join(format!("studio_{ts}"));
        std::fs::create_dir_all(&temp_dir)
            .map_err(|e| format!("create temp dir: {e}"))?;

        // Need a snapshot of the WAD path — chunks are pulled via
        // `read_chunk_decompressed_bytes` against that path.
        let wad_path = with_mount(id, |m| m.path.clone())
            .ok_or_else(|| format!("mount {id} not registered"))?;

        let mut skn_out: Option<std::path::PathBuf> = None;
        for (chunk, rel_path) in &plan {
            let out_path = temp_dir.join(rel_path);
            if let Some(parent) = out_path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            let bytes = match read_chunk_decompressed_bytes(&wad_path, chunk) {
                Ok(b) => b,
                Err(e) => {
                    eprintln!("[studio] skip chunk: {e}");
                    continue;
                }
            };
            if let Err(e) = std::fs::write(&out_path, &bytes) {
                eprintln!("[studio] write {} failed: {}", out_path.display(), e);
                continue;
            }
            if chunk.path_hash == skn_hash {
                skn_out = Some(out_path);
            }
        }

        let skn_out = skn_out.ok_or_else(|| {
            format!("Requested SKN {} not in extracted set", skn_chunk_hash_hex)
        })?;

        // Shadow-form swap. When the user had the alt-form toggle on in
        // the viewer, the Studio should see the shadow texture as the
        // default diffuse — because Studio's disk-based binder doesn't
        // know what "shadow form" means, we just copy the shadow file's
        // bytes over the diffuse file's location. Both paths come from
        // the same StaticMaterialDef so they're guaranteed to be in the
        // extracted folder.
        if shadow_form {
            match read_skin_textures_for_skn(id, skn_hash) {
                Ok(Some(map)) => {
                    let diffuse_rel = map.default_texture.as_deref();
                    let shadow_rel = map.shadow_texture.as_deref();
                    if let (Some(diffuse), Some(shadow)) = (diffuse_rel, shadow_rel) {
                        // Resolve to actual extracted file paths. The
                        // BIN reference may be `.tex` while the chunk
                        // shipped as `.dds` (or vice versa) — same
                        // `path_candidates` set the texture binder
                        // uses. Pick the first variant that exists on
                        // disk under our temp dir.
                        let find_on_disk = |rel: &str| -> Option<std::path::PathBuf> {
                            for cand in path_candidates(rel) {
                                let p = temp_dir.join(&cand);
                                if p.is_file() {
                                    return Some(p);
                                }
                            }
                            None
                        };
                        match (find_on_disk(diffuse), find_on_disk(shadow)) {
                            (Some(dst), Some(src)) => {
                                if let Err(e) = std::fs::copy(&src, &dst) {
                                    eprintln!(
                                        "[studio] shadow-form copy failed ({} -> {}): {}",
                                        src.display(),
                                        dst.display(),
                                        e,
                                    );
                                }
                            }
                            _ => {
                                eprintln!(
                                    "[studio] shadow-form swap: diffuse or shadow not on disk (diffuse='{}', shadow='{}')",
                                    diffuse, shadow,
                                );
                            }
                        }
                    }
                }
                Ok(None) => {}
                Err(e) => eprintln!("[studio] shadow-form: texture map read failed: {e}"),
            }
        }

        // ── Chroma BIN swap ───────────────────────────────────────
        // When a chroma is selected, overwrite the parent skin's BIN
        // file with the chroma's BIN bytes. The disk pipeline reads
        // material references from `skin{parent}.bin`, so substituting
        // the bytes makes it pick up the chroma's textures while the
        // mesh continues to be loaded from the parent skin's SKN.
        // Also extract the chroma BIN's `tree.dependencies` so any
        // cross-BIN material refs (Evelynn-style sibling BINs) resolve.
        if let Some(chroma_num) = chroma_skin_num {
            if chroma_num != skin_num {
                let champ_lower = champion.to_lowercase();
                let chroma_bin_candidates = [
                    format!("data/characters/{champ_lower}/skins/skin{chroma_num}.bin"),
                    format!("data/characters/{champ_lower}/skins/skin{:02}.bin", chroma_num),
                ];
                let chroma_bin_chunk = with_mount(id, |m| {
                    for cand in &chroma_bin_candidates {
                        let h = xxh64_lower(cand);
                        if let Some(c) = m.chunks.iter().find(|c| c.path_hash == h) {
                            return Some(*c);
                        }
                    }
                    None
                })
                .flatten();
                if let Some(chunk) = chroma_bin_chunk {
                    if let Ok(chroma_bytes) = read_chunk_decompressed_bytes(&wad_path, &chunk) {
                        // Write chroma BIN bytes over the parent skin BIN
                        // path so disk texture binder reads chroma refs.
                        let parent_bin_rel = if skin_num == 0 {
                            format!("data/characters/{champ_lower}/skins/skin0.bin")
                        } else {
                            format!("data/characters/{champ_lower}/skins/skin{skin_num}.bin")
                        };
                        let parent_bin_path = temp_dir.join(&parent_bin_rel);
                        if let Some(parent) = parent_bin_path.parent() {
                            let _ = std::fs::create_dir_all(parent);
                        }
                        if let Err(e) = std::fs::write(&parent_bin_path, &chroma_bytes) {
                            eprintln!("[studio] chroma BIN swap write failed: {e}");
                        }

                        // Pull chroma BIN's dependencies + extract.
                        // Parse the chroma BIN (already have its bytes)
                        // PLUS its dependencies to build a full tree set,
                        // then run the same texture extractor we use for
                        // base skins. This gives us the chroma's actual
                        // material refs — the parent-BIN version would
                        // return the BASE textures, which is the bug
                        // that landed us with "missing texture" on the
                        // model when the chroma was supposed to swap in.
                        if let Ok(chroma_tree) = crate::core::bin::read_bin_engine(&chroma_bytes) {
                            let dep_hashes: Vec<(u64, String)> =
                                crate::core::bin::jade::view::dependencies(&chroma_tree)
                                    .iter()
                                    .map(|d| (xxh64_lower(&d.to_lowercase()), d.to_lowercase()))
                                    .collect();

                            // Build a `trees` slice (primary chroma BIN +
                            // its parsed deps) and ask the shared texture
                            // walker for the chroma's effective bindings.
                            // Mirrors what the live `wad_read_chroma_textures`
                            // command does at runtime, but materialised
                            // to disk paths for the studio's binder.
                            let mut linked_trees: Vec<crate::core::bin::JadeBin> = Vec::new();
                            for (dep_hash, _dep_path) in &dep_hashes {
                                let dep_chunk_opt = with_mount(id, |m| {
                                    m.chunks
                                        .iter()
                                        .find(|c| c.path_hash == *dep_hash)
                                        .copied()
                                })
                                .flatten();
                                let Some(dep_chunk) = dep_chunk_opt else { continue };
                                let Ok(dep_bytes) =
                                    read_chunk_decompressed_bytes(&wad_path, &dep_chunk)
                                else {
                                    continue;
                                };
                                if let Ok(t) = crate::core::bin::read_bin_engine(&dep_bytes) {
                                    linked_trees.push(t);
                                }
                            }
                            let mut trees: Vec<crate::core::bin::JadeBin> =
                                Vec::with_capacity(1 + linked_trees.len());
                            trees.push(chroma_tree);
                            trees.extend(linked_trees);

                            let (default_tex, materials, _shadow) =
                                crate::core::mesh::skin_textures::extract_textures_from_trees(
                                    &trees,
                                );
                            let mut texture_paths: Vec<String> = Vec::new();
                            if let Some(d) = default_tex {
                                texture_paths.push(d);
                            }
                            for m in materials {
                                texture_paths.push(m.texture_path);
                            }
                            // Extract dep BINs + every candidate path
                            // for each texture reference.
                            let extra_chunks: Vec<(crate::core::wad::WadChunk, std::path::PathBuf)> =
                                with_mount(id, |m| {
                                    let mut out: Vec<(crate::core::wad::WadChunk, std::path::PathBuf)> =
                                        Vec::new();
                                    let mut want: std::collections::HashMap<u64, String> =
                                        std::collections::HashMap::new();
                                    for (h, p) in &dep_hashes {
                                        want.insert(*h, p.clone());
                                    }
                                    for tex in &texture_paths {
                                        for cand in path_candidates(tex) {
                                            want.insert(xxh64_lower(&cand), cand);
                                        }
                                    }
                                    for chunk in &m.chunks {
                                        if let Some(p) = want.get(&chunk.path_hash) {
                                            out.push((*chunk, std::path::PathBuf::from(p)));
                                        }
                                    }
                                    out
                                })
                                .unwrap_or_default();
                            for (chunk, rel) in &extra_chunks {
                                let out_path = temp_dir.join(rel);
                                if let Some(parent) = out_path.parent() {
                                    let _ = std::fs::create_dir_all(parent);
                                }
                                if let Ok(bytes) =
                                    read_chunk_decompressed_bytes(&wad_path, chunk)
                                {
                                    let _ = std::fs::write(&out_path, &bytes);
                                }
                            }
                        }
                    }
                }
            }
        }

        // ── Animation file extraction ─────────────────────────────
        // The disk-side animation reader follows the skin BIN's
        // `animationGraphData` link to the anim BIN, then resolves
        // each clip to an ANM file path. If the ANM files aren't
        // extracted to disk, only animations that happen to live in
        // the per-skin folder are playable (which is just a couple
        // for most champions). Walk the anim BIN here and extract
        // every referenced ANM.
        {
            // Use the just-written parent skin BIN bytes (which may
            // now be the chroma's BIN after the swap above — both
            // reference the same animationGraphData target).
            let champ_lower = champion.to_lowercase();
            let parent_bin_rel = if skin_num == 0 {
                format!("data/characters/{champ_lower}/skins/skin0.bin")
            } else {
                format!("data/characters/{champ_lower}/skins/skin{skin_num}.bin")
            };
            let parent_bin_path = temp_dir.join(&parent_bin_rel);
            let anm_paths: Vec<String> = (|| -> Option<Vec<String>> {
                use crate::core::mesh::skin_animations::{
                    collect_clips, find_animation_graph_link, resolve_animation_bin_path,
                    H_CLIP_DATA_MAP,
                };
                let skin_bytes = std::fs::read(&parent_bin_path).ok()?;
                let skin_tree = crate::core::bin::read_bin_engine(&skin_bytes).ok()?;
                let link_hash = find_animation_graph_link(&skin_tree)?;
                let anim_bin_rel = resolve_animation_bin_path(&skin_tree, link_hash)?;
                // The anim BIN itself is usually a dep of the skin BIN,
                // so it should already be on disk from the dep extract
                // pass above. Read it.
                let anim_bin_disk = temp_dir.join(&anim_bin_rel);
                let anim_bytes = std::fs::read(&anim_bin_disk).ok()?;
                let anim_tree = crate::core::bin::read_bin_engine(&anim_bytes).ok()?;
                let graph_obj = crate::core::bin::jade::view::object(&anim_tree, link_hash)?;
                let clip_map_value =
                    crate::core::bin::jade::view::field(graph_obj.fields, H_CLIP_DATA_MAP)?;
                let map_entries = match clip_map_value {
                    crate::core::bin::BinValue::Map { items, .. } => items.as_slice(),
                    _ => return None,
                };
                // Resolver returns nothing — we only care about the
                // `anm_path` strings to drive WAD extraction.
                let clips = collect_clips(map_entries, |_| (None, None));
                Some(clips.into_iter().map(|c| c.anm_path.to_lowercase()).collect())
            })()
            .unwrap_or_default();

            if !anm_paths.is_empty() {
                let extracted_hashes: std::collections::HashSet<u64> = plan
                    .iter()
                    .map(|(c, _)| c.path_hash)
                    .collect();
                let want_hashes: Vec<(u64, String)> = anm_paths
                    .iter()
                    .map(|p| (xxh64_lower(p), p.clone()))
                    .filter(|(h, _)| !extracted_hashes.contains(h))
                    .collect();
                let anm_chunks: Vec<(crate::core::wad::WadChunk, std::path::PathBuf)> =
                    with_mount(id, |m| {
                        let mut out: Vec<(crate::core::wad::WadChunk, std::path::PathBuf)> =
                            Vec::new();
                        let want_map: std::collections::HashMap<u64, &String> =
                            want_hashes.iter().map(|(h, p)| (*h, p)).collect();
                        for chunk in &m.chunks {
                            if let Some(p) = want_map.get(&chunk.path_hash) {
                                out.push((*chunk, std::path::PathBuf::from(p.as_str())));
                            }
                        }
                        out
                    })
                    .unwrap_or_default();
                for (chunk, rel) in &anm_chunks {
                    let out_path = temp_dir.join(rel);
                    if let Some(parent) = out_path.parent() {
                        let _ = std::fs::create_dir_all(parent);
                    }
                    if let Ok(bytes) = read_chunk_decompressed_bytes(&wad_path, chunk) {
                        let _ = std::fs::write(&out_path, &bytes);
                    }
                }
            }
        }

        // ── Viewer texture-binding sidecar ────────────────────────
        // When the viewer passed us its authoritative per-submesh
        // binding, resolve each chunk hash to its on-disk path under
        // temp_dir and write a small JSON sidecar next to the SKN.
        // The studio reads this on load and uses it as the source of
        // truth, bypassing the BIN walk + fuzzy disk match entirely.
        if let Some(bindings) = texture_bindings {
            let mut entries: Vec<(String, String)> = Vec::with_capacity(bindings.len());
            for b in bindings {
                let Some(hash_hex) = b.chunk_hash_hex.as_deref() else { continue };
                let trimmed = hash_hex.trim().trim_start_matches("0x").trim_start_matches("0X");
                let Ok(hash) = u64::from_str_radix(trimmed, 16) else { continue };
                let wad_rel = with_mount(id, |m| m.resolved.get(&hash).cloned()).flatten();
                let Some(wad_rel) = wad_rel else { continue };
                let disk_path = temp_dir.join(wad_rel.to_lowercase());
                if !disk_path.is_file() {
                    continue;
                }
                entries.push((
                    b.submesh_name,
                    disk_path.to_string_lossy().replace('\\', "/"),
                ));
            }
            if !entries.is_empty() {
                let sidecar = ViewerTextureMapSidecar { entries };
                if let (Some(parent), Ok(json)) = (skn_out.parent(), serde_json::to_string_pretty(&sidecar)) {
                    let path = parent.join(".jade_texture_map.json");
                    if let Err(e) = std::fs::write(&path, json.as_bytes()) {
                        eprintln!("[studio] write texture-map sidecar failed: {e}");
                    }
                }
            }
        }

        Ok(skn_out.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| format!("extract-for-studio task join: {e}"))??;

    Ok(result)
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewerTextureBindingIn {
    pub submesh_name: String,
    pub chunk_hash_hex: Option<String>,
}

#[derive(serde::Serialize, serde::Deserialize)]
pub struct ViewerTextureMapSidecar {
    // (submesh_name, absolute disk path of resolved texture)
    pub entries: Vec<(String, String)>,
}

/// Read the `.jade_texture_map.json` sidecar (if any) that
/// `viewer_extract_for_studio` writes next to the SKN. Studio uses
/// it as the authoritative per-submesh texture mapping.
#[tauri::command]
pub async fn read_viewer_texture_map_sidecar(
    skn_path: String,
) -> Result<Option<ViewerTextureMapSidecar>, String> {
    tokio::task::spawn_blocking(move || {
        let Some(parent) = std::path::Path::new(&skn_path).parent() else {
            return Ok(None);
        };
        let path = parent.join(".jade_texture_map.json");
        let Ok(bytes) = std::fs::read(&path) else {
            return Ok(None);
        };
        match serde_json::from_slice::<ViewerTextureMapSidecar>(&bytes) {
            Ok(s) => Ok(Some(s)),
            Err(e) => {
                eprintln!("[studio] texture-map sidecar parse failed: {e}");
                Ok(None)
            }
        }
    })
    .await
    .map_err(|e| format!("read sidecar join: {e}"))?
}

/// Find the diffuse texture for a static mesh (SCB / SCO) by walking
/// the skin BIN for any object that references the mesh's path,
/// then scoring the texture strings in that same object's subtree.
/// See `find_static_mesh_texture` for the algorithm.
///
/// Returns `null` if no candidate is found or the mesh path can't be
/// resolved through the mount.
#[tauri::command]
pub async fn wad_find_static_mesh_texture(
    id: u64,
    mesh_path_hash_hex: String,
) -> Result<Option<TextureBinding>, String> {
    let trimmed = mesh_path_hash_hex
        .trim()
        .trim_start_matches("0x")
        .trim_start_matches("0X");
    let mesh_hash = u64::from_str_radix(trimmed, 16)
        .map_err(|e| format!("Invalid hex hash '{}': {}", mesh_path_hash_hex, e))?;

    // Need the mesh's resolved path so we can string-match it inside
    // the BIN tree. If the mount only knows the hex fallback, we
    // can't find string-based references → bail.
    let mesh_path = with_mount(id, |m| m.resolved.get(&mesh_hash).cloned()).flatten();
    let Some(mesh_path) = mesh_path else {
        return Ok(None);
    };

    // Locate the skin BIN — same heuristic as for SKN. SCB/SCO files
    // sit alongside the skin's other assets so the BIN that owns the
    // skin owns the mesh's texture wiring too.
    let bin_match = match find_skin_bin(id, mesh_hash) {
        Some(m) => m,
        None => return Ok(None),
    };
    let bin_hash = u64::from_str_radix(&bin_match.path_hash_hex, 16)
        .map_err(|e| format!("bad bin hash hex: {e}"))?;

    let info = with_mount(id, |m| {
        m.chunks
            .iter()
            .find(|c| c.path_hash == bin_hash)
            .map(|c| (m.path.clone(), *c))
    })
    .flatten()
    .ok_or_else(|| format!("bin chunk not in mount {}", id))?;

    let texture_path: Option<String> = tokio::task::spawn_blocking(move || {
        let bytes = read_chunk_decompressed_bytes(&info.0, &info.1)
            .map_err(|e| format!("read bin: {e}"))?;
        let tree = read_bin_engine(&bytes).map_err(|e| format!("parse bin: {e}"))?;
        Ok::<Option<String>, String>(find_static_mesh_texture(&tree, &mesh_path))
    })
    .await
    .map_err(|e| format!("static-tex task join: {e}"))??;

    let Some(texture_path) = texture_path else {
        return Ok(None);
    };

    // Resolve to a chunk hash inside the same mount. Try the
    // canonical lowercase form first, then a `data/`-mirrored variant
    // — same path-candidate machinery the SKN texture binder uses.
    let chunk_hashes: HashSet<u64> = with_mount(id, |m| {
        m.chunks.iter().map(|c| c.path_hash).collect()
    })
    .unwrap_or_default();
    let chunk_hash_hex = path_candidates(&texture_path)
        .into_iter()
        .find_map(|c| {
            let h = xxh64_lower(&c);
            chunk_hashes.contains(&h).then(|| format!("{:016x}", h))
        });

    Ok(Some(TextureBinding {
        material: bin_match.path,
        texture_path,
        chunk_hash_hex,
        texture_disk_path: None,
    }))
}

/// Guess texture bindings when no skin BIN is available (or the user
/// wants to override what the BIN says).
///
/// Searches **only the folder the SKN lives in** — Riot mod / extracted
/// trees keep meshes and their sibling textures together (e.g.
/// `data/characters/veigar/skins/baron/veigar_baron.skn` next to
/// `veigar_baron_tx_cm.tex`). Searching the whole mount would falsely
/// pull in unrelated textures from neighbouring skins.
///
/// Strategy:
///   1. Resolve the SKN's path → folder.
///   2. Find every `.tex` / `.dds` chunk whose resolved path is in
///      that exact folder.
///   3. For each requested submesh name, try in priority order:
///        a. exact stem match (`"Body"` → `body.tex`)
///        b. trailing-digit-stripped match (`"Body2"` → `body.tex`)
///        c. fuzzy substring match
///   4. Pick a "main" texture using `skn_basename` + common naming
///      heuristics (`*_tx_cm`, `*_diffuse`, `mainTex`, etc.) and use
///      it as a fallback for submeshes that nothing else matched.
///
/// Returns one entry per requested submesh; `chunk_hash_hex` is null
/// when no candidate stuck.
#[tauri::command]
pub async fn wad_guess_textures(
    id: u64,
    skn_path_hash_hex: String,
    submesh_names: Vec<String>,
    skn_basename: Option<String>,
) -> Result<Vec<TextureBinding>, String> {
    let trimmed = skn_path_hash_hex
        .trim()
        .trim_start_matches("0x")
        .trim_start_matches("0X");
    let skn_hash = u64::from_str_radix(trimmed, 16)
        .map_err(|e| format!("Invalid hex hash '{}': {}", skn_path_hash_hex, e))?;

    // Resolve the SKN to its folder (everything up to the last '/').
    // If the SKN's path isn't in the resolved table — i.e. it's still
    // a 16-char hex fallback — we have no folder to search and bail
    // with empty bindings.
    let skn_folder: Option<String> = with_mount(id, |m| {
        let path = m.resolved.get(&skn_hash)?;
        let lower = path.to_lowercase();
        let cut = lower.rfind('/')?;
        Some(lower[..cut].to_string())
    })
    .ok_or_else(|| format!("mount {} not registered", id))?;
    let Some(skn_folder) = skn_folder else {
        return Ok(submesh_names
            .into_iter()
            .map(|name| TextureBinding {
                material: name,
                texture_path: String::new(),
                chunk_hash_hex: None,
                texture_disk_path: None,
            })
            .collect());
    };

    // Find every texture chunk that lives in the SAME folder as the
    // SKN. That's where Riot puts the matching textures in extracted
    // mod trees, and limiting to one folder keeps cross-skin
    // pollution out (an "armoraegis" texture from a neighbour skin
    // shouldn't get pulled into Veigar Baron's preview).
    let candidates: Vec<(String, String, u64)> = with_mount(id, |m| {
        m.chunks
            .iter()
            .filter_map(|c| {
                let path = m.resolved.get(&c.path_hash)?;
                let lower = path.to_lowercase();
                if !(lower.ends_with(".tex") || lower.ends_with(".dds")) {
                    return None;
                }
                let chunk_folder = lower.rfind('/').map(|i| &lower[..i])?;
                if chunk_folder != skn_folder {
                    return None;
                }
                let stem = file_stem_lower(&lower)?;
                Some((path.clone(), stem, c.path_hash))
            })
            .collect()
    })
    .unwrap_or_default();

    if candidates.is_empty() {
        return Ok(submesh_names
            .into_iter()
            .map(|name| TextureBinding {
                material: name,
                texture_path: String::new(),
                chunk_hash_hex: None,
                texture_disk_path: None,
            })
            .collect());
    }

    // Pick a "main" texture once for the fallback path. Priority:
    //   1. stem matches the SKN's basename (e.g. SKN `aatrox.skn` →
    //      `aatrox.tex` is the body).
    //   2. stem ends in `_tx_cm` (Riot convention for color-map).
    //   3. stem contains "diffuse".
    //   4. stem contains "main_texture" / "main".
    //   5. first candidate alphabetically (just so it's stable).
    let main_chunk_hex = pick_main_texture(&candidates, skn_basename.as_deref())
        .map(|h| format!("{:016x}", h));

    // Run the per-submesh match cascade. Once one path lands we move
    // on — a hit at exact wins over loose, etc.
    let mut out = Vec::with_capacity(submesh_names.len());
    for raw_name in submesh_names {
        let name = raw_name.to_lowercase();

        let hit = match_exact(&candidates, &name)
            .or_else(|| match_strip_digits(&candidates, &name))
            .or_else(|| match_fuzzy(&candidates, &name))
            .map(|(path, h)| (path, format!("{:016x}", h)));

        let (path, hex) = match hit {
            Some(h) => (h.0, Some(h.1)),
            None => match main_chunk_hex.as_deref() {
                // Use the same texture path string as the resolved
                // "main" chunk so the frontend can log it — but
                // chunk_hash_hex is what actually matters for
                // fetching. Fall back to empty path string.
                Some(_) => {
                    let main_path = candidates
                        .iter()
                        .find(|(_, _, h)| Some(format!("{:016x}", h)) == main_chunk_hex)
                        .map(|(p, _, _)| p.clone())
                        .unwrap_or_default();
                    (main_path, main_chunk_hex.clone())
                }
                None => (String::new(), None),
            },
        };

        out.push(TextureBinding {
            material: raw_name,
            texture_path: path,
            chunk_hash_hex: hex,
            texture_disk_path: None,
        });
    }

    Ok(out)
}

fn file_stem_lower(path: &str) -> Option<String> {
    let last_slash = path.rfind('/').map(|i| i + 1).unwrap_or(0);
    let basename = &path[last_slash..];
    let dot = basename.rfind('.')?;
    Some(basename[..dot].to_string())
}

fn match_exact(candidates: &[(String, String, u64)], name: &str) -> Option<(String, u64)> {
    candidates
        .iter()
        .find(|(_, stem, _)| stem == name)
        .map(|(p, _, h)| (p.clone(), *h))
}

fn match_strip_digits(candidates: &[(String, String, u64)], name: &str) -> Option<(String, u64)> {
    let stripped = name.trim_end_matches(|c: char| c.is_ascii_digit());
    if stripped.is_empty() || stripped == name {
        return None;
    }
    candidates
        .iter()
        .find(|(_, stem, _)| stem == stripped || stem.trim_end_matches(|c: char| c.is_ascii_digit()) == stripped)
        .map(|(p, _, h)| (p.clone(), *h))
}

fn match_fuzzy(candidates: &[(String, String, u64)], name: &str) -> Option<(String, u64)> {
    // "Stem contains material name OR vice versa." Cheap heuristic
    // that catches things like `aatrox_body_tx_cm` ↔ `body`.
    candidates
        .iter()
        .find(|(_, stem, _)| stem.contains(name) || name.contains(stem.as_str()))
        .map(|(p, _, h)| (p.clone(), *h))
}

/// Split an identifier into lowercase alphanumeric tokens, also
/// splitting camelCase boundaries (so `BlueFish` → `blue`, `fish`).
fn tokenize(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut prev_lower = false;
    for ch in s.chars() {
        if ch.is_ascii_alphanumeric() {
            // camelCase boundary: lower→Upper starts a new token.
            if ch.is_ascii_uppercase() && prev_lower && !cur.is_empty() {
                out.push(std::mem::take(&mut cur));
            }
            cur.push(ch.to_ascii_lowercase());
            prev_lower = ch.is_ascii_lowercase() || ch.is_ascii_digit();
        } else if !cur.is_empty() {
            out.push(std::mem::take(&mut cur));
            prev_lower = false;
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

/// Per-submesh texture matcher via distinctive-token overlap. Scores
/// each sibling texture by the longest meaningful token shared with the
/// submesh name (substring either way, so `Bluefish` matches a
/// `..._fish_tx_cm` texture), ignoring `noise` tokens (the SKN stem +
/// universal suffixes like `tx`/`cm`). The highest score wins; ties
/// keep the first candidate. Returns `None` if nothing distinctive
/// overlaps — the caller then falls back to the legacy cascade / folder
/// default rather than mis-assigning.
fn match_submesh_token(
    candidates: &[(String, String, u64)],
    submesh: &str,
    noise: &[String],
) -> Option<(String, u64)> {
    let is_noise = |t: &str| t.len() < 3 || noise.iter().any(|n| n == t);
    let sub_lower = submesh.to_lowercase();
    let sub_tokens = tokenize(submesh);

    let mut best: Option<(usize, &(String, String, u64))> = None;
    for cand in candidates {
        let mut score = 0usize;
        // Distinctive token of the texture stem appearing in the submesh
        // name (catches `fish` inside `bluefish`).
        for tok in tokenize(&cand.1) {
            if is_noise(&tok) {
                continue;
            }
            if sub_lower.contains(&tok) {
                score = score.max(tok.len());
            }
        }
        // …and the reverse: a submesh-name token appearing in the stem.
        for tok in &sub_tokens {
            if is_noise(tok) {
                continue;
            }
            if cand.1.contains(tok.as_str()) {
                score = score.max(tok.len());
            }
        }
        if score > 0 && best.map_or(true, |(bs, _)| score > bs) {
            best = Some((score, cand));
        }
    }
    best.map(|(_, c)| (c.0.clone(), c.2))
}

fn pick_main_texture(
    candidates: &[(String, String, u64)],
    skn_basename: Option<&str>,
) -> Option<u64> {
    if let Some(base) = skn_basename {
        let base = base.to_lowercase();
        if let Some((_, _, h)) = candidates.iter().find(|(_, s, _)| s == &base) {
            return Some(*h);
        }
    }
    let priority = ["_tx_cm", "tx_cm", "diffuse", "main_texture", "main"];
    for needle in &priority {
        if let Some((_, _, h)) = candidates.iter().find(|(_, s, _)| s.contains(needle)) {
            return Some(*h);
        }
    }
    // Stable fallback so the same WAD always picks the same default.
    candidates
        .iter()
        .min_by(|a, b| a.1.cmp(&b.1))
        .map(|(_, _, h)| *h)
}

/// Generate plausible canonical paths for a BIN-referenced texture.
/// BIN paths come in a few flavors:
///   - `ASSETS/Characters/...` (mod-tree convention, capitalized)
///   - `assets/characters/...` (lowercase canonical)
///   - `Characters/...` (rare, leading `assets/` stripped)
/// We try the lowercase form first (matches how Quartz/our LMDB tables
/// are keyed), then a `data/...` variant for paths that erroneously
/// pointed at the asset side of a mirrored layout.
fn path_candidates(path: &str) -> Vec<String> {
    let lower = path.to_lowercase();
    let mut bases = vec![lower.clone()];
    // `assets/...` paths in BINs sometimes correspond to chunks
    // stored under their `data/...` mirror. Cheap to try.
    if let Some(rest) = lower.strip_prefix("assets/") {
        bases.push(format!("data/{rest}"));
    }
    // Try both texture extensions — BINs typically say `.tex` but
    // Riot ships some textures as `.dds` (and vice versa). Without
    // these swaps, the default-texture path frequently resolves to
    // nothing, leaving every fallback submesh untextured.
    let mut out: Vec<String> = Vec::with_capacity(bases.len() * 2);
    for base in &bases {
        out.push(base.clone());
        if let Some(stem) = base.strip_suffix(".tex") {
            out.push(format!("{stem}.dds"));
        } else if let Some(stem) = base.strip_suffix(".dds") {
            out.push(format!("{stem}.tex"));
        }
    }
    out
}

fn xxh64_lower(s: &str) -> u64 {
    let mut h = XxHash64::with_seed(0);
    h.write(s.as_bytes());
    h.finish()
}

// ─────────────────────────────────────────────────────────────────────
// Native texture decode — binary IPC
//
// Earlier iterations went through:
//   - JS-side TEX/DDS decoder + canvas → PNG → data URL → Image
//   - Then a batched Rust decoder returning base64-encoded RGBA in a
//     JSON response
//
// The base64 + JSON round-trip became the bottleneck (each 2K texture
// = ~22 MB of base64 string; serialize, transport, JSON.parse, atob
// each cost 100-300 ms). Binary IPC bypasses all of that — bytes go
// from a `Vec<u8>` straight into a JS `ArrayBuffer`, no encoding.
//
// Wire format (single texture per call):
//   bytes 0..4   : width  (u32 LE)
//   bytes 4..8   : height (u32 LE)
//   bytes 8..12  : flags  (u32 LE)  — bit 0 = has_alpha; rest reserved
//   bytes 12..16 : reserved (zero)
//   bytes 16..   : `width * height * 4` RGBA8 bytes
//
// Frontend reads the header off the ArrayBuffer with a DataView, then
// feeds the rest as a Uint8Array view to RawTexture.CreateRGBATexture.
// ─────────────────────────────────────────────────────────────────────

const TEX_HEADER_LEN: usize = 16;
const FLAG_HAS_ALPHA: u32 = 1 << 0;

/// Read + decompress + decode one texture chunk and return the RGBA
/// bytes (with a 16-byte metadata header) as a binary IPC response.
#[tauri::command]
pub async fn wad_decode_texture(
    id: u64,
    path_hash_hex: String,
) -> Result<tauri::ipc::Response, String> {
    let trimmed = path_hash_hex
        .trim()
        .trim_start_matches("0x")
        .trim_start_matches("0X");
    let hash = u64::from_str_radix(trimmed, 16)
        .map_err(|e| format!("Invalid hex hash '{}': {}", path_hash_hex, e))?;

    let info = with_mount(id, |m| {
        m.chunks
            .iter()
            .find(|c| c.path_hash == hash)
            .map(|c| (m.path.clone(), *c))
    })
    .flatten()
    .ok_or_else(|| format!("chunk {} not in mount {}", path_hash_hex, id))?;
    let (wad_path, chunk) = info;

    // Run read+decode on the blocking pool — texpresso block decode
    // is CPU-bound and we don't want to sit on the Tauri async runtime.
    let blob = tokio::task::spawn_blocking(move || -> Result<Vec<u8>, String> {
        let bytes = read_chunk_decompressed_bytes(&wad_path, &chunk)
            .map_err(|e| format!("read chunk: {e}"))?;
        let decoded = decode_auto(&bytes).map_err(|e| format!("decode: {e}"))?;

        // Build the [16-byte header | RGBA] payload. Pre-allocate so
        // we don't realloc once the RGBA chunk lands.
        let mut out = Vec::with_capacity(TEX_HEADER_LEN + decoded.rgba.len());
        out.extend_from_slice(&decoded.width.to_le_bytes());
        out.extend_from_slice(&decoded.height.to_le_bytes());
        let flags = if decoded.has_alpha { FLAG_HAS_ALPHA } else { 0 };
        out.extend_from_slice(&flags.to_le_bytes());
        out.extend_from_slice(&0u32.to_le_bytes()); // reserved
        debug_assert_eq!(out.len(), TEX_HEADER_LEN);
        out.extend_from_slice(&decoded.rgba);
        Ok(out)
    })
    .await
    .map_err(|e| format!("decode task join failed: {e}"))??;

    Ok(tauri::ipc::Response::new(blob))
}

/// Decode an arbitrary `.tex` / `.dds` blob already in memory (e.g.
/// the bytes the preview pane fetched via `wad_read_chunk_b64`).
/// Returns a base64-encoded PNG plus dimensions + format name +
/// alpha flag — same shape the in-browser TS decoder would yield,
/// but routed through the Rust decoder which covers BC5 / BC7 and
/// any future formats too. The preview pane falls back to this when
/// the in-browser decoder reports "Unsupported texture format: N".
#[derive(serde::Serialize)]
pub struct TextureDecodeResult {
    pub data_url: String,
    pub width: u32,
    pub height: u32,
    pub format: String,
    pub has_alpha: bool,
}

#[tauri::command]
pub async fn decode_texture_bytes_to_png(
    bytes_b64: String,
) -> Result<TextureDecodeResult, String> {
    use base64::{engine::general_purpose::STANDARD as B64_STD, Engine as _};
    use image::{codecs::png::PngEncoder, ColorType, ImageEncoder};

    tokio::task::spawn_blocking(move || -> Result<TextureDecodeResult, String> {
        let raw = B64_STD
            .decode(bytes_b64.as_bytes())
            .map_err(|e| format!("base64 decode: {e}"))?;
        let decoded = decode_auto(&raw).map_err(|e| format!("decode: {e}"))?;
        // Encode RGBA → PNG. `image::codecs::png::PngEncoder` works
        // straight on the byte buffer, no intermediate `ImageBuffer`
        // allocation needed.
        let mut png_bytes: Vec<u8> = Vec::with_capacity(decoded.rgba.len() / 2);
        PngEncoder::new(&mut png_bytes)
            .write_image(&decoded.rgba, decoded.width, decoded.height, ColorType::Rgba8.into())
            .map_err(|e| format!("PNG encode: {e}"))?;
        let png_b64 = B64_STD.encode(&png_bytes);
        Ok(TextureDecodeResult {
            data_url: format!("data:image/png;base64,{png_b64}"),
            width: decoded.width,
            height: decoded.height,
            format: decoded.format,
            has_alpha: decoded.has_alpha,
        })
    })
    .await
    .map_err(|e| format!("decode task join: {e}"))?
}

/// One result row in a batched texture-thumbnail call. Either
/// `data_url` is set (success) or `error` is set (failure) — never
/// both. `path` mirrors the input path so the caller can match the
/// row back to its request without trusting return order.
#[derive(serde::Serialize)]
pub struct TextureThumbResult {
    pub path: String,
    pub data_url: Option<String>,
    pub width: u32,
    pub height: u32,
    pub error: Option<String>,
}

/// Batched texture → PNG decoder used by the File Explorer grid view
/// for thumbnail loading. The frontend collects up to ~16 visible
/// cells via IntersectionObserver and ships them in one IPC call so
/// IPC overhead doesn't dominate scrolling a folder of 5000 images.
/// Each entry is decoded on a blocking worker; failures are reported
/// per-entry so one bad file doesn't poison the whole batch.
///
/// Supports the same source formats as [`decode_auto`] (.tex / .dds /
/// any image crate format — PNG, JPG, BMP, WEBP, GIF). Output is a
/// base64-encoded PNG data URL ready to hand to `<img src>`.
#[tauri::command]
pub async fn decode_texture_paths_to_png(
    paths: Vec<String>,
) -> Result<Vec<TextureThumbResult>, String> {
    use base64::{engine::general_purpose::STANDARD as B64_STD, Engine as _};
    use image::{codecs::png::PngEncoder, imageops, ColorType, ImageBuffer, ImageEncoder, Rgba};
    use rayon::prelude::*;

    /// Max longest-side of the thumbnail PNG handed back to the
    /// frontend. The grid cells display at ~96 CSS px; rendering at
    /// 192 covers HiDPI / zoom without bloating the PNG payload.
    /// Decoded League textures are routinely 1024² or 2048² — sending
    /// the full RGBA → PNG → base64 → IPC chain for those is what was
    /// stalling the explorer's grid view.
    const THUMB_MAX_SIDE: u32 = 192;

    tokio::task::spawn_blocking(move || -> Result<Vec<TextureThumbResult>, String> {
        // Decode + encode each path on rayon's thread pool. Each
        // texture is independent — `decode_auto` is CPU-bound (BC*
        // block decompression), `imageops::thumbnail` is CPU-bound,
        // PNG encode is CPU-bound. Sequential iteration was leaving
        // (cores - 1) idle while a single thread churned through 16
        // 1024² textures.
        let out: Vec<TextureThumbResult> = paths
            .into_par_iter()
            .map(|path| {
                let res: Result<(String, u32, u32), String> = (|| {
                    let bytes = std::fs::read(&path).map_err(|e| format!("read: {e}"))?;
                    let decoded = decode_auto(&bytes).map_err(|e| format!("decode: {e}"))?;
                    let orig_w = decoded.width;
                    let orig_h = decoded.height;

                    // Downscale BEFORE PNG-encoding. PNG encode cost
                    // is roughly proportional to pixel count, so a
                    // 2048² → 192² shrink is ~115× cheaper to encode
                    // and the resulting data URL is small enough to
                    // ship without chewing IPC bandwidth.
                    let img: ImageBuffer<Rgba<u8>, Vec<u8>> =
                        ImageBuffer::from_raw(orig_w, orig_h, decoded.rgba)
                            .ok_or_else(|| "rgba → image buffer failed".to_string())?;
                    let (thumb_w, thumb_h) = if orig_w <= THUMB_MAX_SIDE && orig_h <= THUMB_MAX_SIDE {
                        (orig_w, orig_h)
                    } else if orig_w >= orig_h {
                        (THUMB_MAX_SIDE, ((orig_h as u64 * THUMB_MAX_SIDE as u64) / orig_w as u64).max(1) as u32)
                    } else {
                        ((orig_w as u64 * THUMB_MAX_SIDE as u64 / orig_h as u64).max(1) as u32, THUMB_MAX_SIDE)
                    };
                    let thumb = if (thumb_w, thumb_h) == (orig_w, orig_h) {
                        img
                    } else {
                        // `thumbnail` uses a fast averaging filter
                        // tuned for downscaling. Better visual result
                        // than nearest, much cheaper than full
                        // lanczos.
                        imageops::thumbnail(&img, thumb_w, thumb_h)
                    };

                    let mut png_bytes: Vec<u8> = Vec::with_capacity((thumb.width() * thumb.height()) as usize);
                    PngEncoder::new(&mut png_bytes)
                        .write_image(
                            thumb.as_raw(),
                            thumb.width(),
                            thumb.height(),
                            ColorType::Rgba8.into(),
                        )
                        .map_err(|e| format!("png encode: {e}"))?;
                    let png_b64 = B64_STD.encode(&png_bytes);
                    Ok((format!("data:image/png;base64,{png_b64}"), orig_w, orig_h))
                })();
                match res {
                    Ok((data_url, w, h)) => TextureThumbResult {
                        path,
                        data_url: Some(data_url),
                        width: w,
                        height: h,
                        error: None,
                    },
                    Err(e) => TextureThumbResult {
                        path,
                        data_url: None,
                        width: 0,
                        height: 0,
                        error: Some(e),
                    },
                }
            })
            .collect();
        Ok(out)
    })
    .await
    .map_err(|e| format!("decode task join: {e}"))?
}

/// Result of [`fetch_vanilla_animations`] — what we extracted and where.
#[derive(serde::Serialize)]
pub struct FetchVanillaAnimResult {
    /// Absolute path to the borrowed-animations folder under the
    /// app's config dir. The frontend hangs onto this so a later
    /// scene-close can wipe the folder, and so subsequent animation
    /// listings can scan it as an "extra dir".
    pub borrowed_dir: String,
    /// Number of distinct ANM files in the borrowed dir.
    pub final_count: u32,
    /// True when we layered the base skin's animations under the
    /// requested skin's. Driven by an internal "few clips ⇒ probably
    /// an epic skin that only overrides a couple of clips" threshold.
    pub base_layer_included: bool,
    /// Name of the WAD we pulled from, for the toast.
    pub wad_name: String,
}

/// Pull a champion's animation .anm files out of their vanilla WAD and
/// drop them next to the user's SKN, so a mod that ships only the
/// mesh can still play vanilla animations in Photo Studio.
///
/// Behaviour:
///   - Probes the League install (PBE / live based on `use_pbe`).
///   - Mounts `<install>/Game/DATA/FINAL/Champions/<Champion>.wad.client`.
///   - For the requested skin, enumerates every chunk whose resolved
///     WAD path is `assets/characters/<champ>/animations/<skin_folder>/*.anm`
///     and writes each into the target folder beside the SKN.
///   - Threshold-based base-skin layering: when the requested skin
///     has fewer than 15 ANMs (typical of an Epic / Ultimate skin
///     that only overrides recall / homeguard etc.), we ALSO extract
///     skin 0's full set BEFORE the requested skin so the skin's
///     overrides land on top of the base layer.
///   - Returns the target dir + a summary the UI can toast.
#[tauri::command]
pub async fn fetch_vanilla_animations(
    skn_disk_path: String,
    champion: String,
    skin_num: u32,
    use_pbe: Option<bool>,
) -> Result<FetchVanillaAnimResult, String> {
    use crate::core::mesh::skin_bin::disk_layout_for_skn;
    use crate::core::wad::{mount, unmount};

    /// Below this many ANMs in the skin folder we assume it's an
    /// override layer (epic / ultimate skin pattern). Standard
    /// champions ship ~50+ per skin, so 15 is a safe cutoff.
    const EPIC_SKIN_THRESHOLD: u32 = 15;

    let champ_lower = champion.to_lowercase();
    let champ_title = title_case_champion(&champion);

    // 1. Find the install. PBE first if the user asked for it,
    //    otherwise live. Don't silently fall back across the two —
    //    a user with both installed could end up loading the wrong
    //    patch's animations.
    let install = if use_pbe.unwrap_or(false) {
        crate::extra_commands::detect_league_pbe_install()
            .ok_or_else(|| "PBE install not found. Open Settings to set the location.".to_string())?
    } else {
        crate::extra_commands::detect_league_install()
            .ok_or_else(|| "League of Legends install not found. Open Settings to set the location.".to_string())?
    };

    // 2. WAD path — `detect_league_install` resolves to `Game/DATA/FINAL`
    //    when present, so champion WADs live one folder deeper.
    let wad_path = std::path::PathBuf::from(&install)
        .join("Champions")
        .join(format!("{}.wad.client", champ_title));
    if !wad_path.exists() {
        return Err(format!(
            "Champion WAD not found at {}",
            wad_path.display()
        ));
    }
    let wad_name = wad_path.file_name().unwrap_or_default().to_string_lossy().into_owned();
    let wad_path_for_chunks = wad_path.clone();

    // 3. Borrowed-animations directory — lives under the app's
    //    config dir, NOT next to the user's mod. We don't want to
    //    pollute their folder; the frontend cleans this up when the
    //    studio scene closes, and uses it as an "extra dir" for
    //    `read_skn_animations_disk_cmd` so the clips show up
    //    alongside whatever's actually next to the SKN.
    //
    //    Unique-per-scene subdir based on the SKN's path hash + a
    //    timestamp so two concurrent scenes of the same champion
    //    don't clobber each other's pulls.
    let skin_folder_name = if skin_num == 0 { "base".to_string() } else { format!("skin{skin_num}") };
    let config_dir = crate::app_commands::get_config_dir()
        .map_err(|e| format!("config dir: {e}"))?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let skn_hash = {
        use std::collections::hash_map::DefaultHasher;
        use std::hash::{Hash, Hasher};
        let mut hasher = DefaultHasher::new();
        skn_disk_path.to_lowercase().hash(&mut hasher);
        hasher.finish()
    };
    let target_dir = config_dir
        .join("anim_borrow")
        .join(format!("{}_{:x}_{}", champ_lower, skn_hash, stamp));
    std::fs::create_dir_all(&target_dir)
        .map_err(|e| format!("create borrowed-anim dir: {e}"))?;
    // disk_layout_for_skn is consulted elsewhere; this command no
    // longer needs it directly but I'm keeping the import live so a
    // future "place next to SKN" toggle is a one-line change.
    let _ = disk_layout_for_skn;

    let target_dir_clone = target_dir.clone();
    let champ_lower_clone = champ_lower.clone();

    // 4. Mount + extract on the blocking pool. The rest of the work
    //    is pure I/O / decompression; keep it off the async runtime.
    let mount_result = tokio::task::spawn_blocking(move || -> Result<(u32, bool), String> {
        let mount_id = mount(&wad_path_for_chunks).map_err(|e| e.to_string())?;
        let result: Result<(u32, bool), String> = (|| {
            // Always pre-stage skin0's count so the threshold check
            // works even when the user asked for skin0 directly.
            let skin_count = extract_anms_for_skin_folder(
                mount_id,
                &wad_path_for_chunks,
                &champ_lower_clone,
                skin_num,
                &target_dir_clone,
            )?;

            // Epic-skin layering: pull base under the requested skin.
            // Skip when the user is fetching base itself, or when
            // the requested skin already brought back a full set.
            let layer_base = skin_num != 0 && skin_count < EPIC_SKIN_THRESHOLD;
            if layer_base {
                // Extract base FIRST so the override-skin ANMs we
                // just wrote stay on top (we re-extract skin to
                // assert that order).
                let _base_count = extract_anms_for_skin_folder(
                    mount_id,
                    &wad_path_for_chunks,
                    &champ_lower_clone,
                    0,
                    &target_dir_clone,
                )?;
                // Re-extract requested skin so its files clobber any
                // same-named base files. (Filenames usually match —
                // it's the contents that differ for the override
                // clips like recall/homeguard.)
                let _skin_re = extract_anms_for_skin_folder(
                    mount_id,
                    &wad_path_for_chunks,
                    &champ_lower_clone,
                    skin_num,
                    &target_dir_clone,
                )?;
            }

            // Count the final on-disk set so the toast is honest
            // about what landed.
            let final_count = match std::fs::read_dir(&target_dir_clone) {
                Ok(rd) => rd
                    .flatten()
                    .filter(|e| {
                        e.path()
                            .extension()
                            .and_then(|s| s.to_str())
                            .map(|s| s.eq_ignore_ascii_case("anm"))
                            .unwrap_or(false)
                    })
                    .count() as u32,
                Err(_) => 0,
            };
            Ok((final_count, layer_base))
        })();
        unmount(mount_id);
        result
    })
    .await
    .map_err(|e| format!("fetch task join: {e}"))?;

    let (final_count, base_layer_included) = mount_result?;

    if final_count == 0 {
        return Err(format!(
            "No ANM files matched assets/characters/{champ_lower}/skins/{skin_folder_name}/animations/ in {wad_name}. Wrong champion or skin number?"
        ));
    }

    Ok(FetchVanillaAnimResult {
        borrowed_dir: target_dir.to_string_lossy().into_owned(),
        final_count,
        base_layer_included,
        wad_name,
    })
}

/// Delete a borrowed-animations directory created by
/// `fetch_vanilla_animations`. Frontend calls this when the studio
/// scene that owned the borrow closes, so the temp ANMs don't
/// accumulate under the config dir. Best-effort — a missing dir is
/// not an error.
#[tauri::command]
pub async fn cleanup_anim_borrow_dir(borrow_dir: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let p = std::path::Path::new(&borrow_dir);
        // Safety net: only delete paths that look like our borrow
        // folder so a stray bad call can't nuke an unrelated dir.
        let lower = borrow_dir.replace('\\', "/").to_lowercase();
        if !lower.contains("/anim_borrow/") {
            return Err(format!("refusing to delete non-anim-borrow path: {}", borrow_dir));
        }
        if p.is_dir() {
            let _ = std::fs::remove_dir_all(p);
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("cleanup task join: {e}"))?
}

/// Extract every chunk whose resolved WAD path matches
/// `assets/characters/<champ>/animations/<skin_folder>/*.anm` into
/// `target_dir`. Returns the number of files actually written.
fn extract_anms_for_skin_folder(
    mount_id: u64,
    wad_path: &std::path::Path,
    champ_lower: &str,
    skin_num: u32,
    target_dir: &std::path::Path,
) -> Result<u32, String> {
    use crate::core::wad::{with_mount, read_chunk_decompressed_bytes};

    let skin_folder = if skin_num == 0 { "base".to_string() } else { format!("skin{skin_num}") };
    // The canonical Riot layout puts ANMs inside the per-skin
    // folder, not in a top-level `animations/<skin>/` sibling:
    //   assets/characters/<champ>/skins/<skin>/animations/*.anm
    // Some older champs also have a zero-padded variant
    // (`skin01/animations/`), so we accept that too.
    let prefix_a = format!("assets/characters/{champ_lower}/skins/{skin_folder}/animations/");
    let prefix_b = if skin_num == 0 {
        None
    } else {
        Some(format!("assets/characters/{champ_lower}/skins/skin{:02}/animations/", skin_num))
    };

    let plan: Vec<(crate::core::wad::WadChunk, String)> = with_mount(mount_id, |m| {
        let mut out = Vec::new();
        for chunk in &m.chunks {
            let Some(path) = m.resolved.get(&chunk.path_hash) else { continue };
            let lower = path.to_lowercase();
            let matches = lower.starts_with(&prefix_a)
                || prefix_b.as_ref().map(|p| lower.starts_with(p)).unwrap_or(false);
            if !matches { continue; }
            if !lower.ends_with(".anm") { continue; }
            out.push((*chunk, lower));
        }
        out
    })
    .unwrap_or_default();

    let mut written: u32 = 0;
    for (chunk, lower) in plan {
        let basename = lower.rsplit('/').next().unwrap_or(&lower);
        let target = target_dir.join(basename);
        let bytes = match read_chunk_decompressed_bytes(wad_path, &chunk) {
            Ok(b) => b,
            Err(_) => continue, // skip silently — one bad chunk shouldn't kill the batch
        };
        if std::fs::write(&target, &bytes).is_ok() {
            written += 1;
        }
    }
    Ok(written)
}

/// "akali" / "AKALI" / "akAli" → "Akali". Champion WAD filenames are
/// Title-Case (`Akali.wad.client`); the user might type any case in
/// the picker.
fn title_case_champion(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for (i, ch) in s.chars().enumerate() {
        if i == 0 {
            out.extend(ch.to_uppercase());
        } else {
            out.extend(ch.to_lowercase());
        }
    }
    out
}

/// Disk-source counterpart of [`wad_decode_texture`]. Reads the
/// texture (.tex / .dds) straight from `path` and returns the same
/// `[16-byte header | RGBA]` payload, so the frontend's RGBA upload
/// path stays a single code path regardless of source.
#[tauri::command]
pub async fn decode_texture_disk(
    path: String,
) -> Result<tauri::ipc::Response, String> {
    let pb = PathBuf::from(&path);
    let blob = tokio::task::spawn_blocking(move || -> Result<Vec<u8>, String> {
        let bytes = std::fs::read(&pb).map_err(|e| format!("read texture '{}': {}", pb.display(), e))?;
        let decoded = decode_auto(&bytes).map_err(|e| format!("decode: {e}"))?;
        let mut out = Vec::with_capacity(TEX_HEADER_LEN + decoded.rgba.len());
        out.extend_from_slice(&decoded.width.to_le_bytes());
        out.extend_from_slice(&decoded.height.to_le_bytes());
        let flags = if decoded.has_alpha { FLAG_HAS_ALPHA } else { 0 };
        out.extend_from_slice(&flags.to_le_bytes());
        out.extend_from_slice(&0u32.to_le_bytes()); // reserved
        debug_assert_eq!(out.len(), TEX_HEADER_LEN);
        out.extend_from_slice(&decoded.rgba);
        Ok(out)
    })
    .await
    .map_err(|e| format!("decode task join failed: {e}"))??;

    Ok(tauri::ipc::Response::new(blob))
}
