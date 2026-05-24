//! FBX importer for the Photo Studio.
//!
//! Static-only — geometry + materials + diffuse texture references.
//! Skinning, blend shapes, animation curves, and the rest of FBX's
//! deformer stack are intentionally out of scope; rigged characters
//! load in their bind pose only. This keeps the parser small and
//! avoids FBX's gnarlier corners (the Deformer chain, multi-take
//! animation, etc.) which are where most third-party FBX loaders get
//! stuck.
//!
//! Uses `ufbx` for the heavy lifting:
//!   - Handles binary AND ASCII FBX from version 6 through 7.x
//!   - Pre-triangulates faces (we still call `triangulate_face` to
//!     decompose n-gons into triangles)
//!   - Normalises axes via `target_axes = left_handed_y_up` so
//!     Babylon doesn't need a coordinate flip
//!   - Normalises units via `target_unit_meters = 1.0` (some Maya
//!     exports use cm; this stops models showing up 100× too small)
//!
//! Output shape is one DTO entry per material part — one part per
//! (mesh, material) combination — so the JS side gets a flat list it
//! can map directly onto Babylon meshes.

use serde::Serialize;
use std::path::PathBuf;
use std::collections::HashMap;

/// One renderable submesh: a chunk of geometry that shares a single
/// material. Maps 1:1 to a Babylon `Mesh` on the frontend.
#[derive(Serialize, Default)]
pub struct FbxSubmeshDTO {
    /// Display name. Falls back to "submesh_N" when the source FBX
    /// doesn't name its nodes.
    pub name: String,
    /// Flat `[x0, y0, z0, x1, y1, z1, ...]` in Babylon-friendly
    /// left-handed Y-up coords (ufbx does the conversion at load).
    pub positions: Vec<f32>,
    /// Flat `[x, y, z]` per vertex.
    pub normals: Vec<f32>,
    /// Flat `[u, v]` per vertex.
    pub uvs: Vec<f32>,
    /// Triangle indices into the per-submesh vertex buffer above.
    pub indices: Vec<u32>,
    /// Index into the scene-level `materials` array, or `None` if
    /// the submesh has no material assignment.
    pub material_index: Option<usize>,
}

#[derive(Serialize, Default)]
pub struct FbxMaterialDTO {
    pub name: String,
    /// 0..1 RGB, used as the placeholder color when no diffuse
    /// texture is found.
    pub diffuse_color: [f32; 3],
    /// Resolved disk path to a diffuse / albedo texture, or `None`.
    /// We try absolute_filename → relative_filename (resolved
    /// against the FBX's directory) → bare filename next to the FBX.
    /// First existing file wins.
    pub diffuse_texture_path: Option<String>,
    /// Diagnostic dump: every texture path the parser considered for
    /// this material, regardless of which slot won. Logged by the
    /// frontend when `diffuse_texture_path` ends up `None` so users
    /// can see what was available vs what was picked.
    pub debug_textures_seen: Vec<String>,
}

#[derive(Serialize, Default)]
pub struct FbxSceneDTO {
    pub submeshes: Vec<FbxSubmeshDTO>,
    pub materials: Vec<FbxMaterialDTO>,
}

pub fn parse_static_fbx(path: &str) -> Result<FbxSceneDTO, String> {
    let opts = ufbx::LoadOpts {
        target_axes: ufbx::CoordinateAxes::left_handed_y_up(),
        // No unit conversion. Setting `target_unit_meters: 1.0` told
        // ufbx to scale the model down to meters, which for FBX from
        // Blender (default unit = 1m) is fine, but for FBX from
        // Maya/Max (default unit = 1cm) it shrinks the model 100×
        // and you have to crank the studio scale to 1000 just to see
        // it. Leaving this at 0 (default) preserves the source unit
        // so the model lands at its authored scale, matching how
        // Blender / Maya / Babylon-by-default treat the file.
        generate_missing_normals: true,
        // Keep CCW winding through the axis flip — without this,
        // flipping Z would reverse triangle winding and the model
        // would render inside-out.
        handedness_conversion_retain_winding: true,
        ..Default::default()
    };
    // We DON'T use `SpaceConversion::ModifyGeometry` or the matching
    // `GeometryTransformHandling::ModifyGeometry` because ufbx then
    // double-applies the conversion when the source FBX is already
    // close to Y-up (most Blender exports), leaving the model
    // rotated by -90° instead of fixing the original +90°. Instead
    // we apply each mesh's `geometry_to_world` matrix manually
    // below, which bakes the FINAL world transform (axis-convert ×
    // node-pivots × parent-chain) into the vertices in one pass and
    // works regardless of the source file's axes.
    let scene = ufbx::load_file(path, opts).map_err(|e| format!("ufbx: {:?}", e))?;
    let fbx_dir = PathBuf::from(path)
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_default();

    // Build a file-index of the FBX's directory tree (up to a few
    // levels deep) so basename-only texture lookups can find files
    // tucked in sibling folders like `textures/` or `Textures/Maps/`.
    // Done once per parse to avoid re-walking the FS for every probe.
    let disk_index = build_disk_index(&fbx_dir);

    // Materials: serialise once, in scene-order, so each submesh can
    // reference them by index. ufbx hands us materials per-mesh; we
    // dedupe by element_id to share one DTO entry per source material.
    let mut materials: Vec<FbxMaterialDTO> = Vec::new();
    let mut material_lookup: HashMap<u32, usize> = HashMap::new();
    for mat in scene.materials.iter() {
        let id = mat.element.element_id;
        if material_lookup.contains_key(&id) {
            continue;
        }
        let color = pick_diffuse_color(mat);
        let tex_path = pick_diffuse_texture(mat, &fbx_dir, &disk_index, path);
        let debug = collect_debug_textures(mat, &disk_index);
        material_lookup.insert(id, materials.len());
        materials.push(FbxMaterialDTO {
            name: mat.element.name.to_string(),
            diffuse_color: color,
            diffuse_texture_path: tex_path,
            debug_textures_seen: debug,
        });
    }

    // Geometry: walk each Mesh's material_parts, triangulate, and
    // emit one DTO submesh per part.
    let mut submeshes: Vec<FbxSubmeshDTO> = Vec::new();
    let mut tri_buf: Vec<u32> = Vec::with_capacity(64);

    for mesh in scene.meshes.iter() {
        // Determine the source node's display name and its world
        // transform. Node instances own the visible name + transform
        // in FBX; the mesh element is shared by instances and named
        // generically. `geometry_to_world` includes the full chain
        // of: axis-convert (root) × node-pivots × parent transforms
        // × the mesh's own geometry transform — so applying it once
        // gives us final world-space positions.
        let inst = mesh.element.instances.iter().next();
        let node_name = inst
            .map(|n| n.element.name.to_string())
            .unwrap_or_else(|| mesh.element.name.to_string());
        // Identity matrix when there's no instance (shouldn't happen
        // for renderable meshes, but defensive).
        let geom_to_world: ufbx::Matrix = inst
            .map(|n| n.geometry_to_world)
            .unwrap_or(ufbx::Matrix {
                m00: 1.0, m01: 0.0, m02: 0.0, m03: 0.0,
                m10: 0.0, m11: 1.0, m12: 0.0, m13: 0.0,
                m20: 0.0, m21: 0.0, m22: 1.0, m23: 0.0,
            });

        for (part_idx, part) in mesh.material_parts.iter().enumerate() {
            if part.num_triangles == 0 {
                continue;
            }

            // Each material_part is parallel to mesh.materials; map
            // through to the scene-level material index.
            let material_index = mesh
                .materials
                .iter()
                .nth(part_idx)
                .and_then(|m| material_lookup.get(&m.element.element_id).copied());

            let mut positions: Vec<f32> = Vec::with_capacity(part.num_triangles * 9);
            let mut normals: Vec<f32> = Vec::with_capacity(part.num_triangles * 9);
            let mut uvs: Vec<f32> = Vec::with_capacity(part.num_triangles * 6);
            let mut indices: Vec<u32> = Vec::with_capacity(part.num_triangles * 3);
            let has_uv = mesh.vertex_uv.values.len() > 0;
            let mut next_idx: u32 = 0;

            for &face_idx in part.face_indices.iter() {
                let face = mesh.faces[face_idx as usize];
                if face.num_indices < 3 {
                    continue;
                }
                // Triangulate (n-gons → triangle strips). triangulate_face
                // writes 3*tri vertex indices into the buffer.
                tri_buf.resize((face.num_indices as usize - 2) * 3, 0);
                let n_tri = ufbx::triangulate_face(&mut tri_buf, mesh, face) as usize;

                for tri in 0..n_tri {
                    // Standard CCW winding. With ufbx's
                    // `handedness_conversion_retain_winding` enabled,
                    // the engine flips axes without reversing the
                    // triangle order, so we can emit straight (0,1,2).
                    for k in 0..3 {
                        let vi = tri_buf[tri * 3 + k] as usize;
                        let p_local = ufbx::get_vertex_vec3(&mesh.vertex_position, vi);
                        let n_local = ufbx::get_vertex_vec3(&mesh.vertex_normal, vi);
                        // Bake the node's world transform into the
                        // vertex (positions get full transform_position;
                        // normals only the rotation/scale via
                        // transform_direction).
                        let p = ufbx::transform_position(&geom_to_world, p_local);
                        let n = ufbx::transform_direction(&geom_to_world, n_local);
                        positions.extend_from_slice(&[p.x as f32, p.y as f32, p.z as f32]);
                        normals.extend_from_slice(&[n.x as f32, n.y as f32, n.z as f32]);
                        if has_uv {
                            let uv = ufbx::get_vertex_vec2(&mesh.vertex_uv, vi);
                            // No V flip here. The studio loads
                            // textures with `invertY: true` (the
                            // Babylon default), which already
                            // flips the image vertically at upload
                            // time. Flipping UVs HERE on top of
                            // that double-applies the conversion
                            // and produces visibly wrong sampling
                            // (mirrored vertical bands / upside-
                            // down detail). Leave UVs raw so the
                            // single invertY pass lands the
                            // textures right-side-up.
                            uvs.extend_from_slice(&[uv.x as f32, uv.y as f32]);
                        } else {
                            uvs.extend_from_slice(&[0.0, 0.0]);
                        }
                        indices.push(next_idx);
                        next_idx += 1;
                    }
                }
            }

            if indices.is_empty() {
                continue;
            }

            let name = if mesh.material_parts.len() == 1 {
                node_name.clone()
            } else {
                format!("{}#{}", node_name, part_idx)
            };

            submeshes.push(FbxSubmeshDTO {
                name,
                positions,
                normals,
                uvs,
                indices,
                material_index,
            });
        }
    }

    Ok(FbxSceneDTO {
        submeshes,
        materials,
    })
}

fn pick_diffuse_color(mat: &ufbx::Material) -> [f32; 3] {
    // Prefer PBR base color; fall back to legacy FBX diffuse_color.
    // ufbx normalises both into 0..1 floats.
    let pbr = &mat.pbr.base_color;
    if pbr.has_value {
        return [
            pbr.value_vec4.x as f32,
            pbr.value_vec4.y as f32,
            pbr.value_vec4.z as f32,
        ];
    }
    let fbx = &mat.fbx.diffuse_color;
    if fbx.has_value {
        return [
            fbx.value_vec4.x as f32,
            fbx.value_vec4.y as f32,
            fbx.value_vec4.z as f32,
        ];
    }
    [0.8, 0.8, 0.85]
}

fn pick_diffuse_texture(
    mat: &ufbx::Material,
    fbx_dir: &PathBuf,
    disk_index: &HashMap<String, PathBuf>,
    fbx_path: &str,
) -> Option<String> {
    // Strategy (in order of preference):
    //
    //   1. Find disk files whose basename starts with the material
    //      name, then pick the most-diffuse-looking suffix from that
    //      set. This is the strongest signal for PBR packs because
    //      authors ship `<material>_D.png`, `<material>_N.png`,
    //      `<material>_S.png` etc. side-by-side.
    //
    //   2. Fall back to ufbx-reported texture entries (typed slots
    //      and the generic `material.textures` list), scored by prop
    //      name + filename suffix the same way.
    //
    //   3. Last resort: embedded-blob extraction inside (2)'s path
    //      resolver for Mixamo-style FBX with inline textures.
    let mat_name = mat.element.name.to_string().to_ascii_lowercase();
    if !mat_name.is_empty() {
        if let Some(p) = search_by_material_name(&mat_name, disk_index) {
            return Some(p);
        }
    }

    if let Some(tex) = mat.pbr.base_color.texture.as_ref() {
        if let Some(p) = resolve_any(tex, fbx_dir, disk_index, fbx_path) { return Some(p); }
    }
    if let Some(tex) = mat.fbx.diffuse_color.texture.as_ref() {
        if let Some(p) = resolve_any(tex, fbx_dir, disk_index, fbx_path) { return Some(p); }
    }
    // Score each entry in `material.textures` and pick the most
    // diffuse-looking one. We can't rely on the FBX property name
    // alone — Blender's principled-BSDF export sometimes writes
    // ambiguous prop names, and PBR packs ship textures using
    // filename suffixes (`_D`, `_N`, `_R`, `_M`, `_S`, etc.) as the
    // semantic signal instead. Scoring by both prop AND filename
    // catches both worlds and avoids picking a normal map for the
    // diffuse slot.
    let mut best: Option<(i32, &ufbx::Texture)> = None;
    for entry in mat.textures.iter() {
        let prop = entry.material_prop.to_string().to_ascii_lowercase();
        let fname = entry
            .texture
            .filename
            .to_string()
            .to_ascii_lowercase();
        let basename: String = std::path::Path::new(&fname)
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        let score = score_diffuse(&prop, &basename);
        match best {
            None => best = Some((score, &entry.texture)),
            Some((s, _)) if score > s => best = Some((score, &entry.texture)),
            _ => {}
        }
    }
    if let Some((_, tex)) = best {
        if let Some(p) = resolve_any(tex, fbx_dir, disk_index, fbx_path) {
            return Some(p);
        }
    }
    None
}

/// Walk the disk index for files whose basename starts with (or
/// contains) the material name, then pick the highest-scoring diffuse
/// candidate from the matches. Returns `None` if nothing relevant
/// turned up — the caller falls back to ufbx's texture list.
fn search_by_material_name(
    mat_name: &str,
    disk_index: &HashMap<String, PathBuf>,
) -> Option<String> {
    let mut best: Option<(i32, &PathBuf)> = None;
    for (basename, path) in disk_index.iter() {
        // Only consider image-y extensions — anything else (a `.fbx`
        // or `.txt` near the model) shouldn't be treated as a
        // texture even if the name matches.
        if !is_image_extension(basename) {
            continue;
        }
        let stem = std::path::Path::new(basename)
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        let stem_lc = stem.to_ascii_lowercase();
        // Material-name match: prefer "starts with" but accept
        // "contains" as a softer signal for packs that prefix file
        // names with the model name (e.g. `Trigger_Body_D.png`).
        let mat_bonus = if stem_lc.starts_with(mat_name) {
            6
        } else if stem_lc.contains(mat_name) {
            3
        } else {
            continue;
        };
        let score = mat_bonus + score_diffuse("", &stem_lc);
        match best {
            None => best = Some((score, path)),
            Some((s, _)) if score > s => best = Some((score, path)),
            _ => {}
        }
    }
    // Negative-scoring picks mean every match was clearly a non-
    // diffuse (normal / spec) — don't return those, fall through to
    // the ufbx-driven path instead.
    best.filter(|(s, _)| *s > 0).map(|(_, p)| p.to_string_lossy().into_owned())
}

/// Build a diagnostic list of every texture entry the parser
/// considered for this material — both ufbx-reported references and
/// disk files whose name overlaps the material name. Returned to the
/// frontend so the user can see in the console what was AVAILABLE vs
/// what got picked. Each string is `<source>: <value>`.
fn collect_debug_textures(
    mat: &ufbx::Material,
    disk_index: &HashMap<String, PathBuf>,
) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();

    let push_tex = |out: &mut Vec<String>, label: &str, t: &ufbx::Texture| {
        let abs = t.absolute_filename.to_string();
        let fname = t.filename.to_string();
        let rel = t.relative_filename.to_string();
        let embedded = t.content.size > 0
            || t.video.as_ref().map(|v| v.content.size > 0).unwrap_or(false);
        out.push(format!(
            "{}: name=\"{}\" filename=\"{}\" abs=\"{}\" rel=\"{}\" embedded={}",
            label, t.element.name, fname, abs, rel, embedded
        ));
    };
    if let Some(t) = mat.pbr.base_color.texture.as_ref() {
        push_tex(&mut out, "pbr.base_color", t);
    }
    if let Some(t) = mat.fbx.diffuse_color.texture.as_ref() {
        push_tex(&mut out, "fbx.diffuse_color", t);
    }
    for entry in mat.textures.iter() {
        push_tex(
            &mut out,
            &format!("mat.textures[prop={}]", entry.material_prop),
            &entry.texture,
        );
    }
    let mat_name = mat.element.name.to_string().to_ascii_lowercase();
    if !mat_name.is_empty() {
        let mut hits: Vec<&PathBuf> = disk_index
            .iter()
            .filter(|(k, _)| {
                if !is_image_extension(k) { return false; }
                let stem = std::path::Path::new(k.as_str())
                    .file_stem()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_default()
                    .to_ascii_lowercase();
                stem.contains(&mat_name)
            })
            .map(|(_, v)| v)
            .collect();
        hits.sort();
        for p in hits {
            out.push(format!("disk-match: {}", p.display()));
        }
    }
    out
}

fn is_image_extension(basename: &str) -> bool {
    let lc = basename.to_ascii_lowercase();
    [".png", ".jpg", ".jpeg", ".webp", ".tga", ".bmp", ".dds", ".tex"]
        .iter()
        .any(|ext| lc.ends_with(ext))
}

/// Score how likely a (material_prop, filename_stem) pair is to be a
/// diffuse map. Higher = more diffuse. Negative = explicitly non-
/// diffuse (normal / specular / etc.) — we don't want to fall back
/// to those even if the material has only one texture.
///
/// Filename suffix conventions covered (PBR packs, Substance, Quixel,
/// Mixamo): `_D`/`_BC`/`_BaseColor` → diffuse, `_N`/`_NRM`/`_Normal`
/// → normal, `_R`/`_Rough` → roughness, etc. Match on the trailing
/// underscore segment to avoid false positives like "dragon_skin" →
/// "_skin" containing "n".
fn score_diffuse(prop: &str, stem: &str) -> i32 {
    let mut score = 0;
    // FBX property name (highest signal).
    if is_diffuse_prop(prop) {
        score += 10;
    }
    // Filename heuristic. Pick out the LAST `_…` token and judge it.
    let tail = stem.rsplit('_').next().unwrap_or("");
    match tail {
        // Diffuse-ish tokens.
        "d" | "bc" | "basecolor" | "base" | "color" | "col" | "diffuse" | "albedo" | "alb" => {
            score += 8;
        }
        // Anti-tokens — never pick these as diffuse.
        "n" | "nrm" | "normal" | "normals" | "nor" | "nm" => score -= 10,
        "s" | "spec" | "specular" => score -= 10,
        "r" | "rough" | "roughness" => score -= 10,
        "m" | "metal" | "metallic" | "metalness" => score -= 10,
        "b" | "bump" => score -= 10,
        "h" | "height" | "disp" | "displacement" => score -= 10,
        "ao" | "occlusion" => score -= 10,
        "e" | "emission" | "emissive" => score -= 6,
        "opacity" | "alpha" => score -= 6,
        _ => {
            // Generic substring match for tools that don't use the
            // underscore-token convention.
            if stem.contains("diffuse") || stem.contains("basecolor")
                || stem.contains("albedo") || stem.contains("base_color") {
                score += 5;
            }
            if stem.contains("normal") || stem.contains("_nrm")
                || stem.contains("specular") || stem.contains("roughness") {
                score -= 8;
            }
        }
    }
    score
}

fn is_diffuse_prop(name: &str) -> bool {
    name.contains("diffuse")
        || name.contains("basecolor")
        || name.contains("base_color")
        || name.contains("albedo")
        || name == "color"
        || name == "maps" // some Maya exports
}

/// Resolve a texture to an on-disk path, extracting embedded blobs
/// (FBX's `Video` content) to a sidecar file when present.
fn resolve_any(
    tex: &ufbx::Texture,
    fbx_dir: &PathBuf,
    disk_index: &HashMap<String, PathBuf>,
    fbx_path: &str,
) -> Option<String> {
    // 1. Embedded-texture content. Mixamo / "binary FBX with media"
    //    style exports put the PNG/JPG bytes inline in the FBX. ufbx
    //    surfaces them as `texture.content` (and on the linked Video
    //    node). Write them to a temp sidecar next to the FBX so the
    //    JS-side texture loader can read them like any other file.
    let blob_bytes: &[u8] = if tex.content.size > 0 {
        &tex.content[..]
    } else if let Some(video) = tex.video.as_ref() {
        if video.content.size > 0 { &video.content[..] } else { &[] }
    } else {
        &[]
    };
    if !blob_bytes.is_empty() {
        if let Some(p) = extract_embedded(blob_bytes, tex, fbx_path) {
            return Some(p);
        }
    }

    // 2. Direct path probes.
    if let Some(p) = resolve_texture_path(tex, fbx_dir, disk_index) {
        return Some(p);
    }
    None
}

fn resolve_texture_path(
    tex: &ufbx::Texture,
    fbx_dir: &PathBuf,
    disk_index: &HashMap<String, PathBuf>,
) -> Option<String> {
    let abs = tex.absolute_filename.to_string();
    if !abs.is_empty() && std::path::Path::new(&abs).is_file() {
        return Some(abs);
    }
    let fname = tex.filename.to_string();
    if !fname.is_empty() && std::path::Path::new(&fname).is_file() {
        return Some(fname);
    }
    let rel = tex.relative_filename.to_string();
    if !rel.is_empty() {
        let joined = fbx_dir.join(&rel);
        if joined.is_file() {
            return Some(joined.to_string_lossy().into_owned());
        }
    }
    // Basename probes. FBX exporters routinely write absolute paths
    // baked from the original author's machine ("D:/Foo/textures/x.png");
    // when we don't have that drive layout we still usually have the
    // texture file with the same basename SOMEWHERE near the FBX. The
    // disk_index lets us answer "is there a `x.png` anywhere up to
    // N levels deep next to the FBX" in one HashMap lookup.
    for raw in [&abs, &fname, &rel] {
        if let Some(base) = std::path::Path::new(raw).file_name() {
            let base_str = base.to_string_lossy().to_lowercase();
            // Direct sibling first (cheapest).
            let next_to = fbx_dir.join(base);
            if next_to.is_file() {
                return Some(next_to.to_string_lossy().into_owned());
            }
            // Indexed lookup — covers `textures/x.png`,
            // `parent/textures/x.png`, etc.
            if let Some(found) = disk_index.get(&base_str) {
                return Some(found.to_string_lossy().into_owned());
            }
            // Stem-only (e.g. "x" hits "x.png" / "x.jpg") for
            // exporters that wrote the wrong extension.
            if let Some(stem) = std::path::Path::new(&base_str).file_stem() {
                let stem_s = stem.to_string_lossy().to_string();
                for (k, v) in disk_index.iter() {
                    if let Some(k_stem) = std::path::Path::new(k).file_stem() {
                        if k_stem.to_string_lossy() == stem_s {
                            return Some(v.to_string_lossy().into_owned());
                        }
                    }
                }
            }
        }
    }
    None
}

/// Write embedded texture bytes to a sidecar `<fbx-name>.embedded/<n>.<ext>`
/// folder next to the FBX, then return that path. We extension-sniff by
/// magic bytes so the file ends up named in a way the JS-side decoder
/// (which picks loader by extension) understands. Idempotent — second
/// call with identical bytes reuses the existing file via a content hash.
fn extract_embedded(bytes: &[u8], tex: &ufbx::Texture, fbx_path: &str) -> Option<String> {
    let ext = sniff_image_extension(bytes).unwrap_or("bin");
    let fbx_pb = PathBuf::from(fbx_path);
    let fbx_stem = fbx_pb.file_stem().map(|s| s.to_os_string()).unwrap_or_default();
    let parent = fbx_pb.parent().map(|p| p.to_path_buf()).unwrap_or_default();
    let mut out_dir = parent.clone();
    out_dir.push(format!("{}.jade-embedded", fbx_stem.to_string_lossy()));
    let _ = std::fs::create_dir_all(&out_dir);

    // Name based on the source texture name when present; falls back
    // to the byte length so we don't collide between blobs.
    let raw_name = tex.element.name.to_string();
    let safe = raw_name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '_' })
        .collect::<String>();
    let base = if safe.is_empty() { format!("tex_{}", bytes.len()) } else { safe };
    let out = out_dir.join(format!("{}.{}", base, ext));
    if !out.exists() {
        if std::fs::write(&out, bytes).is_err() {
            return None;
        }
    }
    Some(out.to_string_lossy().into_owned())
}

fn sniff_image_extension(b: &[u8]) -> Option<&'static str> {
    if b.len() >= 8 && &b[..8] == b"\x89PNG\r\n\x1a\n" { return Some("png"); }
    if b.len() >= 3 && b[..3] == [0xFF, 0xD8, 0xFF] { return Some("jpg"); }
    if b.len() >= 4 && &b[..4] == b"DDS " { return Some("dds"); }
    if b.len() >= 12 && &b[..4] == b"RIFF" && &b[8..12] == b"WEBP" { return Some("webp"); }
    if b.len() >= 4 && (&b[..4] == b"GIF8") { return Some("gif"); }
    if b.len() >= 2 && b[0] == 0x42 && b[1] == 0x4D { return Some("bmp"); }
    if b.len() >= 4 && b[0] == 0x00 && b[1] == 0x00 && (b[2] == 0x02 || b[2] == 0x0A) { return Some("tga"); }
    None
}

/// Recursively index files near the FBX, keyed by lowercased basename.
/// Used by texture lookup to find a file when the FBX's baked path is
/// wrong/absolute but the file is somewhere nearby.
///
/// Walk regions:
///   1. `<fbx_dir>/**` up to depth 3 — the obvious case.
///   2. `<fbx_dir>/../*` (one level up, shallow) — covers the very
///      common layout where the FBX sits in a per-asset folder and a
///      `Textures/` sibling holds the maps:
///        Trigger/
///          Default/
///            Trigger.fbx        ← fbx_dir
///          Textures/
///            Trigger_D.png      ← what we need
///   3. `<fbx_dir>/../<Textures-y dir>/**` shallow — also covered by
///      (2) via the same walk.
///
/// First-write-wins so the closer file (under fbx_dir) takes priority
/// over a deeper match from the parent walk.
fn build_disk_index(root: &PathBuf) -> HashMap<String, PathBuf> {
    let mut index: HashMap<String, PathBuf> = HashMap::new();
    walk_dir(root, 0, 3, &mut index);
    // Walk one level up (the FBX's parent folder + its siblings), but
    // shallower since we don't want to slurp in the entire desktop.
    if let Some(parent) = root.parent() {
        walk_dir(&parent.to_path_buf(), 0, 2, &mut index);
    }
    index
}

fn walk_dir(dir: &PathBuf, depth: usize, max_depth: usize, out: &mut HashMap<String, PathBuf>) {
    if depth > max_depth { return; }
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let p = entry.path();
        let ft = match entry.file_type() { Ok(t) => t, Err(_) => continue };
        if ft.is_dir() {
            if let Some(name) = p.file_name().and_then(|n| n.to_str()) {
                if name.starts_with('.') || name.eq_ignore_ascii_case("node_modules") {
                    continue;
                }
            }
            walk_dir(&p, depth + 1, max_depth, out);
        } else if ft.is_file() {
            if let Some(base) = p.file_name().and_then(|n| n.to_str()) {
                let key = base.to_lowercase();
                out.entry(key).or_insert(p.clone());
            }
        }
    }
}
