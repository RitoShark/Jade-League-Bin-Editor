//! ANM (animation) parser — uncompressed `r3d2anmd` format.
//!
//! Three on-disk versions, all reduced to the same in-memory shape so
//! downstream code (the baker, the IPC layer, the JS player) doesn't
//! care which file shape it came from:
//!
//! - **v3** (legacy): 32-byte ASCII joint names hashed via ELF, full
//!   16-byte quaternions, no scale tracks (every frame's scale is 1).
//! - **v4**: joint hashes embedded in each frame, full 16-byte
//!   quaternions, vector palette + quat palette + frame index table.
//! - **v5**: joint hashes in a separate section, 6-byte quantized
//!   quaternions (decompressed at parse time).
//!
//! Compressed (`r3d2canm`) is detected and reported with a clean
//! error — that format requires a substantial separate decoder we
//! haven't ported yet.
//!
//! Cross-checked against `ltk_anim::Uncompressed::from_reader` and
//! Aventurine `import_anm.py`. The two agree on every byte; we
//! pattern-match the same way.

use std::collections::HashMap;
use std::io::{Cursor, Read, Seek, SeekFrom};

use byteorder::{LittleEndian, ReadBytesExt};
use glam::{Quat, Vec3};
use serde::{Deserialize, Serialize};

use super::error::{MeshError, Result};

const MAGIC_UNCOMPRESSED: &[u8; 8] = b"r3d2anmd";
const MAGIC_COMPRESSED: &[u8; 8] = b"r3d2canm";

/// One frame of TRS for a single joint, baked to flat arrays so the
/// JS animation player can build typed arrays directly without
/// per-frame parsing on the JS side.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnmFrame {
    pub translation: [f32; 3],
    pub rotation: [f32; 4], // xyzw
    pub scale: [f32; 3],
}

/// All frames for one joint. The `joint_hash` matches `SklJoint.name_hash`
/// in the SKL DTO so the JS player can resolve track → bone in one pass.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnmTrack {
    pub joint_hash: u32,
    pub frames: Vec<AnmFrame>,
}

/// Baked animation ready for IPC + playback. `frame_count` and the
/// per-track `frames.len()` always match — joints with no movement
/// still ship a frame at every index (rest-pose entries) so the
/// player can index by frame_id without bounds checks.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BakedAnimation {
    pub duration: f32,
    pub fps: f32,
    pub frame_count: u32,
    pub tracks: Vec<AnmTrack>,
}

pub fn parse_anm(bytes: &[u8]) -> Result<BakedAnimation> {
    if bytes.len() < 12 {
        return Err(MeshError::Malformed("ANM file truncated".to_string()));
    }
    let mut magic = [0u8; 8];
    magic.copy_from_slice(&bytes[0..8]);
    if &magic == MAGIC_COMPRESSED {
        return super::anm_compressed::parse_compressed_anm(bytes);
    }
    if &magic != MAGIC_UNCOMPRESSED {
        return Err(MeshError::InvalidSignature {
            format: "ANM",
            // First 4 bytes as u32 — gives a recognizable hex tag in
            // the error message.
            expected: u32::from_le_bytes([
                MAGIC_UNCOMPRESSED[0],
                MAGIC_UNCOMPRESSED[1],
                MAGIC_UNCOMPRESSED[2],
                MAGIC_UNCOMPRESSED[3],
            ]),
            got: u32::from_le_bytes([magic[0], magic[1], magic[2], magic[3]]),
        });
    }

    let mut r = Cursor::new(bytes);
    r.set_position(8); // skip magic
    let version = r.read_u32::<LittleEndian>()?;
    match version {
        3 => parse_v3(&mut r),
        4 => parse_v4(&mut r),
        5 => parse_v5(&mut r),
        _ => Err(MeshError::UnsupportedVersion {
            format: "ANM",
            major: version as u16,
            minor: 0,
        }),
    }
}

// ── v5 ───────────────────────────────────────────────────────────────

fn parse_v5<R: Read + Seek>(r: &mut R) -> Result<BakedAnimation> {
    // Header layout (offset 12 onwards — 12 = magic(8) + version(4)):
    let _resource_size = r.read_u32::<LittleEndian>()?;
    let _format_token = r.read_u32::<LittleEndian>()?;
    let _version_again = r.read_u32::<LittleEndian>()?;
    let _flags = r.read_u32::<LittleEndian>()?;

    let track_count = r.read_u32::<LittleEndian>()? as usize;
    let frame_count = r.read_u32::<LittleEndian>()? as usize;
    let frame_duration = r.read_f32::<LittleEndian>()?;

    let fps = if frame_duration > 0.0 { 1.0 / frame_duration } else { 30.0 };
    let duration = frame_count as f32 * frame_duration;

    let joint_hashes_off = r.read_i32::<LittleEndian>()?;
    let _asset_name_off = r.read_i32::<LittleEndian>()?;
    let _time_off = r.read_i32::<LittleEndian>()?;
    let vector_palette_off = r.read_i32::<LittleEndian>()?;
    let quat_palette_off = r.read_i32::<LittleEndian>()?;
    let frames_off = r.read_i32::<LittleEndian>()?;

    if joint_hashes_off <= 0 || vector_palette_off <= 0 || quat_palette_off <= 0 || frames_off <= 0
    {
        return Err(MeshError::Malformed("ANM v5 missing required section".to_string()));
    }

    // Section sizes are derived from offset deltas; v5's storage
    // order is: vector_palette → quat_palette → joint_hashes → frames.
    let joint_hash_count = section_count(
        "joint hashes",
        (frames_off - joint_hashes_off) as usize,
        4,
    )?;
    let vector_count = section_count(
        "vector palette",
        (quat_palette_off - vector_palette_off) as usize,
        12,
    )?;
    let quat_count = section_count(
        "quat palette",
        (joint_hashes_off - quat_palette_off) as usize,
        6,
    )?;

    // Joint hashes
    r.seek(SeekFrom::Start(joint_hashes_off as u64 + 12))?;
    let mut joint_hashes = Vec::with_capacity(joint_hash_count);
    for _ in 0..joint_hash_count {
        joint_hashes.push(r.read_u32::<LittleEndian>()?);
    }

    // Vector palette (translation + scale, shared)
    r.seek(SeekFrom::Start(vector_palette_off as u64 + 12))?;
    let mut vector_palette = Vec::with_capacity(vector_count);
    for _ in 0..vector_count {
        vector_palette.push(read_vec3(r)?);
    }

    // Quaternion palette — 6 bytes each, 3×16-bit quantized + 2-bit
    // largest-component flag. Decompress on read so downstream code
    // sees full f32 quats.
    r.seek(SeekFrom::Start(quat_palette_off as u64 + 12))?;
    let mut quat_palette = Vec::with_capacity(quat_count);
    for _ in 0..quat_count {
        let mut bytes = [0u8; 6];
        r.read_exact(&mut bytes)?;
        quat_palette.push(decompress_quat(&bytes).normalize());
    }

    // Frames are (track_count × frame_count) × 3 u16 indices into
    // the palettes. Walk in frame-major order and sort into per-joint
    // tracks at the end.
    r.seek(SeekFrom::Start(frames_off as u64 + 12))?;
    let mut joint_frames: HashMap<u32, Vec<RawFrame>> = HashMap::with_capacity(track_count);
    for &h in &joint_hashes {
        joint_frames.insert(h, vec![RawFrame::default(); frame_count]);
    }
    for frame_id in 0..frame_count {
        for track_id in 0..track_count {
            let translation_id = r.read_u16::<LittleEndian>()?;
            let scale_id = r.read_u16::<LittleEndian>()?;
            let rotation_id = r.read_u16::<LittleEndian>()?;
            let Some(&joint_hash) = joint_hashes.get(track_id) else { continue };
            if let Some(frames) = joint_frames.get_mut(&joint_hash) {
                frames[frame_id] = RawFrame { translation_id, scale_id, rotation_id };
            }
        }
    }

    Ok(bake(
        duration,
        fps,
        frame_count,
        joint_frames,
        &vector_palette,
        &quat_palette,
    ))
}

// ── v4 ───────────────────────────────────────────────────────────────

fn parse_v4<R: Read + Seek>(r: &mut R) -> Result<BakedAnimation> {
    let _resource_size = r.read_u32::<LittleEndian>()?;
    let _format_token = r.read_u32::<LittleEndian>()?;
    let _version_again = r.read_u32::<LittleEndian>()?;
    let _flags = r.read_u32::<LittleEndian>()?;

    let track_count = r.read_u32::<LittleEndian>()? as usize;
    let frame_count = r.read_u32::<LittleEndian>()? as usize;
    let frame_duration = r.read_f32::<LittleEndian>()?;

    let fps = if frame_duration > 0.0 { 1.0 / frame_duration } else { 30.0 };
    let duration = frame_count as f32 * frame_duration;

    let _joint_hashes_off = r.read_i32::<LittleEndian>()?;
    let _asset_name_off = r.read_i32::<LittleEndian>()?;
    let _time_off = r.read_i32::<LittleEndian>()?;
    let vector_palette_off = r.read_i32::<LittleEndian>()?;
    let quat_palette_off = r.read_i32::<LittleEndian>()?;
    let frames_off = r.read_i32::<LittleEndian>()?;

    if vector_palette_off <= 0 || quat_palette_off <= 0 || frames_off <= 0 {
        return Err(MeshError::Malformed("ANM v4 missing required section".to_string()));
    }

    let vector_count = section_count(
        "vector palette",
        (quat_palette_off - vector_palette_off) as usize,
        12,
    )?;
    let quat_count = section_count(
        "quat palette",
        (frames_off - quat_palette_off) as usize,
        16, // v4 uses full quaternions
    )?;

    r.seek(SeekFrom::Start(vector_palette_off as u64 + 12))?;
    let mut vector_palette = Vec::with_capacity(vector_count);
    for _ in 0..vector_count {
        vector_palette.push(read_vec3(r)?);
    }

    r.seek(SeekFrom::Start(quat_palette_off as u64 + 12))?;
    let mut quat_palette = Vec::with_capacity(quat_count);
    for _ in 0..quat_count {
        quat_palette.push(read_quat(r)?.normalize());
    }
    // (already normalized — kept here for symmetry with v3/v5)

    // v4 frames embed the joint hash inline — no separate hash table.
    // Each frame entry: u32 hash + 3 u16 indices + u16 padding = 12 B.
    r.seek(SeekFrom::Start(frames_off as u64 + 12))?;
    let mut joint_frames: HashMap<u32, Vec<RawFrame>> = HashMap::with_capacity(track_count);
    for frame_id in 0..frame_count {
        for _ in 0..track_count {
            let joint_hash = r.read_u32::<LittleEndian>()?;
            let translation_id = r.read_u16::<LittleEndian>()?;
            let scale_id = r.read_u16::<LittleEndian>()?;
            let rotation_id = r.read_u16::<LittleEndian>()?;
            let _padding = r.read_u16::<LittleEndian>()?;

            let frames = joint_frames
                .entry(joint_hash)
                .or_insert_with(|| vec![RawFrame::default(); frame_count]);
            frames[frame_id] = RawFrame { translation_id, scale_id, rotation_id };
        }
    }

    Ok(bake(
        duration,
        fps,
        frame_count,
        joint_frames,
        &vector_palette,
        &quat_palette,
    ))
}

// ── v3 (legacy) ──────────────────────────────────────────────────────

fn parse_v3<R: Read + Seek>(r: &mut R) -> Result<BakedAnimation> {
    let _skeleton_id = r.read_u32::<LittleEndian>()?;
    let track_count = r.read_u32::<LittleEndian>()? as usize;
    let frame_count = r.read_u32::<LittleEndian>()? as usize;
    let fps = r.read_u32::<LittleEndian>()? as f32;

    let duration = if fps > 0.0 { frame_count as f32 / fps } else { 0.0 };

    // v3 stores frames inline per track; we synthesise palettes and
    // a frame-index table on the fly so we can share the same baker
    // path with v4/v5.
    let mut quat_palette: Vec<Quat> = Vec::with_capacity(frame_count * track_count);
    let mut vector_palette: Vec<Vec3> = Vec::with_capacity(frame_count * track_count + 1);
    let mut joint_frames: HashMap<u32, Vec<RawFrame>> = HashMap::with_capacity(track_count);

    // Index 0 is reserved for unit scale — every v3 frame's scale_id
    // points at this since the file format doesn't carry scale.
    vector_palette.push(Vec3::ONE);

    for _ in 0..track_count {
        // 32-byte ASCII name, null-padded. Hash with ELF (lowercased)
        // to match what League computes for matching SKL bones.
        let mut name_buf = [0u8; 32];
        r.read_exact(&mut name_buf)?;
        let nul = name_buf.iter().position(|&b| b == 0).unwrap_or(32);
        let joint_name = std::str::from_utf8(&name_buf[..nul])
            .map(|s| s.to_string())
            .unwrap_or_default();
        let joint_hash = elf_hash_lower(&joint_name);
        let _flags = r.read_u32::<LittleEndian>()?;

        let mut frames = Vec::with_capacity(frame_count);
        for _ in 0..frame_count {
            // Normalize the quaternion as we read — League's older v3
            // tooling sometimes stored slightly-off-unit quats, and an
            // unnormalised quat run through `slerp` produces wonky
            // intermediate rotations that can flip a bone the wrong way.
            let rotation = read_quat(r)?.normalize();
            let translation = read_vec3(r)?;
            let rotation_id = quat_palette.len() as u16;
            quat_palette.push(rotation);
            let translation_id = vector_palette.len() as u16;
            vector_palette.push(translation);
            frames.push(RawFrame {
                translation_id,
                scale_id: 0,
                rotation_id,
            });
        }
        joint_frames.insert(joint_hash, frames);
    }

    Ok(bake(
        duration,
        fps,
        frame_count,
        joint_frames,
        &vector_palette,
        &quat_palette,
    ))
}

// ── Baker — palette dereference into flat AnmFrames ────────────────

#[derive(Default, Clone, Copy)]
struct RawFrame {
    translation_id: u16,
    scale_id: u16,
    rotation_id: u16,
}

fn bake(
    duration: f32,
    fps: f32,
    frame_count: usize,
    joint_frames: HashMap<u32, Vec<RawFrame>>,
    vector_palette: &[Vec3],
    quat_palette: &[Quat],
) -> BakedAnimation {
    let mut tracks = Vec::with_capacity(joint_frames.len());
    for (joint_hash, raw_frames) in joint_frames {
        let mut frames = Vec::with_capacity(raw_frames.len());
        for rf in raw_frames {
            // Defensive: bad palette indices fall back to identity
            // values rather than panicking. A malformed file
            // produces a frozen pose for that joint, which is far
            // less surprising than a crash mid-render.
            let translation = vector_palette
                .get(rf.translation_id as usize)
                .copied()
                .unwrap_or(Vec3::ZERO);
            let scale = vector_palette
                .get(rf.scale_id as usize)
                .copied()
                .unwrap_or(Vec3::ONE);
            let rotation = quat_palette
                .get(rf.rotation_id as usize)
                .copied()
                .unwrap_or(Quat::IDENTITY);
            frames.push(AnmFrame {
                translation: translation.to_array(),
                rotation: [rotation.x, rotation.y, rotation.z, rotation.w],
                scale: scale.to_array(),
            });
        }
        tracks.push(AnmTrack { joint_hash, frames });
    }
    BakedAnimation {
        duration,
        fps,
        frame_count: frame_count as u32,
        tracks,
    }
}

// ── Helpers ──────────────────────────────────────────────────────────

fn read_vec3<R: Read>(r: &mut R) -> Result<Vec3> {
    let x = r.read_f32::<LittleEndian>()?;
    let y = r.read_f32::<LittleEndian>()?;
    let z = r.read_f32::<LittleEndian>()?;
    Ok(Vec3::new(x, y, z))
}

fn read_quat<R: Read>(r: &mut R) -> Result<Quat> {
    let x = r.read_f32::<LittleEndian>()?;
    let y = r.read_f32::<LittleEndian>()?;
    let z = r.read_f32::<LittleEndian>()?;
    let w = r.read_f32::<LittleEndian>()?;
    Ok(Quat::from_xyzw(x, y, z, w))
}

fn section_count(name: &'static str, size: usize, element_size: usize) -> Result<usize> {
    if !size.is_multiple_of(element_size) {
        return Err(MeshError::Malformed(format!(
            "ANM {} section size {} not a multiple of {}",
            name, size, element_size
        )));
    }
    Ok(size / element_size)
}

/// Decompress a 6-byte quantized quaternion (v5 format).
///
/// Layout: 48 bits packed as [bits 0-14: c, 15-29: b, 30-44: a, 45-46:
/// max_index]. The encoder writes the first non-omitted component at
/// bit 30 (highest), second at bit 15, third at bit 0 — so decoding
/// reads `a` from the HIGH 15-bit slot and `c` from the LOW slot, not
/// the other way around. Reading these in reverse scrambles a quat
/// just enough to look kind-of-right at rest but distort badly under
/// animation slerp.
///
/// The omitted component (largest-magnitude) is recovered via
/// `sqrt(1 - a² - b² - c²)`, since q is unit-norm and the encoder
/// flips its sign positive before discarding it.
pub(super) fn decompress_quat(bytes: &[u8; 6]) -> Quat {
    // 1/sqrt(2) is the bound for non-omitted components — three
    // components in [-1/√2, 1/√2] guarantees the omitted one fits in
    // [-1, 1] under the unit-norm constraint.
    const INV_SQRT2: f32 = 0.707_106_77_f32;
    const SCALE: f32 = INV_SQRT2 / 16383.0;

    // Pack the 6 bytes into a u64. Top 16 bits stay zero.
    let bits = (bytes[0] as u64)
        | ((bytes[1] as u64) << 8)
        | ((bytes[2] as u64) << 16)
        | ((bytes[3] as u64) << 24)
        | ((bytes[4] as u64) << 32)
        | ((bytes[5] as u64) << 40);

    let max_index = ((bits >> 45) & 0x3) as usize;
    // a = first stored component (highest 15-bit field, bits 30-44).
    // b = second stored component (middle, bits 15-29).
    // c = third stored component (lowest, bits 0-14).
    // Centered on 16383 so the field maps to [-1/√2, 1/√2].
    let a = (((bits >> 30) & 0x7fff) as i32 - 16383) as f32 * SCALE;
    let b = (((bits >> 15) & 0x7fff) as i32 - 16383) as f32 * SCALE;
    let c = ((bits & 0x7fff) as i32 - 16383) as f32 * SCALE;
    // Recover the omitted component from the unit-norm constraint.
    // Clamped to non-negative because numerical drift can nudge the
    // inside of the sqrt slightly under zero.
    let recovered_sq = (1.0 - a * a - b * b - c * c).max(0.0);
    let d = recovered_sq.sqrt();

    // Slot the recovered component back into its original position.
    match max_index {
        0 => Quat::from_xyzw(d, a, b, c),
        1 => Quat::from_xyzw(a, d, b, c),
        2 => Quat::from_xyzw(a, b, d, c),
        _ => Quat::from_xyzw(a, b, c, d),
    }
}

/// ELF hash, as used by League for v3 ANM joint names. Lowercases
/// the string before hashing to match how the engine stores hashes
/// for v4/v5 (where the hash is precomputed into the file).
fn elf_hash_lower(s: &str) -> u32 {
    let mut h: u32 = 0;
    for &b in s.as_bytes() {
        let c = if b.is_ascii_uppercase() { b + 32 } else { b } as u32;
        h = h.wrapping_shl(4).wrapping_add(c);
        let x = h & 0xf000_0000;
        if x != 0 {
            h ^= x >> 24;
        }
        h &= !x;
    }
    h
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_bad_magic() {
        let mut buf = vec![0u8; 12];
        buf[..8].copy_from_slice(b"deadbeef");
        assert!(matches!(parse_anm(&buf), Err(MeshError::InvalidSignature { .. })));
    }

    #[test]
    fn detects_compressed_magic() {
        let mut buf = vec![0u8; 12];
        buf[..8].copy_from_slice(MAGIC_COMPRESSED);
        let err = parse_anm(&buf).expect_err("should refuse compressed");
        match err {
            MeshError::Malformed(msg) => assert!(msg.contains("compressed")),
            other => panic!("unexpected error: {other:?}"),
        }
    }

    #[test]
    fn elf_hash_lowercases_first() {
        // ELF hash should be case-insensitive via lowercasing —
        // "Idle1" and "idle1" must produce the same hash so v3
        // joint names match what v4/v5 store for the same bones.
        assert_eq!(elf_hash_lower("Root"), elf_hash_lower("ROOT"));
        assert_eq!(elf_hash_lower("R_HAND"), elf_hash_lower("r_hand"));
    }

    #[test]
    fn quat_decompresses_identity() {
        // Identity quaternion in the largest-component-w encoding.
        // x=y=z=0, max_index=3 (w omitted, recovered=sqrt(1)=1).
        // Each 15-bit field needs to encode 0 → centered value 16383.
        // Layout (per ltk_anim's encoder): a at bits 30-44, b at 15-29,
        // c at 0-14, max_index at 45-46.
        let center: u64 = 16383;
        let bits: u64 = center | (center << 15) | (center << 30) | (3u64 << 45);
        let bytes = [
            (bits & 0xff) as u8,
            ((bits >> 8) & 0xff) as u8,
            ((bits >> 16) & 0xff) as u8,
            ((bits >> 24) & 0xff) as u8,
            ((bits >> 32) & 0xff) as u8,
            ((bits >> 40) & 0xff) as u8,
        ];
        let q = decompress_quat(&bytes);
        assert!((q.x).abs() < 1e-4);
        assert!((q.y).abs() < 1e-4);
        assert!((q.z).abs() < 1e-4);
        assert!((q.w - 1.0).abs() < 1e-4);
    }

    /// Round-trip a non-trivial quaternion through the encoding bit
    /// layout — catches the swap-a-and-c bug we just fixed and any
    /// future drift between which slot is high vs low. Encodes
    /// like ltk_anim's compressor does (first component to bit 30,
    /// second to bit 15, third to bit 0) and verifies the decoder
    /// puts them back in the right order.
    #[test]
    fn quat_decompresses_off_axis_rotation() {
        // 45° rotation around Y: (sin(22.5°)·0, sin(22.5°), 0,
        // cos(22.5°)) = (0, ~0.3827, 0, ~0.9239). Largest is W
        // (max_index=3). Stored values are x, y, z.
        // value → field: stored = round((value + 1/√2) · 16383 / (1/√2))
        //                        = round((value · √2 + 1) · 16383 / √2)
        //              ≈ round((value + 1/√2) · √2 · 16383)
        let inv_sqrt2 = 0.707_106_77_f32;
        let to_field = |v: f32| -> u64 {
            (((v + inv_sqrt2) / inv_sqrt2 * 16383.0).round() as i64).clamp(0, 32767) as u64
        };
        let x_field = to_field(0.0);
        let y_field = to_field(0.3826834);
        let z_field = to_field(0.0);
        // First non-omitted (x) → bits 30-44.
        // Second (y) → bits 15-29.
        // Third (z) → bits 0-14.
        let bits: u64 = z_field | (y_field << 15) | (x_field << 30) | (3u64 << 45);
        let bytes = [
            (bits & 0xff) as u8,
            ((bits >> 8) & 0xff) as u8,
            ((bits >> 16) & 0xff) as u8,
            ((bits >> 24) & 0xff) as u8,
            ((bits >> 32) & 0xff) as u8,
            ((bits >> 40) & 0xff) as u8,
        ];
        let q = decompress_quat(&bytes);
        // 15-bit quantisation has ~0.001 precision in this range.
        assert!((q.x - 0.0).abs() < 0.002, "x={}", q.x);
        assert!((q.y - 0.3826834).abs() < 0.002, "y={}", q.y);
        assert!((q.z - 0.0).abs() < 0.002, "z={}", q.z);
        assert!((q.w - 0.9238795).abs() < 0.002, "w={}", q.w);
    }
}
