//! ANM v4 writer — uncompressed `r3d2anmd` format, full-precision quats.
//!
//! Pairs with [`super::anm`] (the reader). We write **v4 only**:
//! - Full 16-byte quaternions (no quantisation, no slerp error on bake).
//! - Joint hash embedded inline in every frame entry (no separate hash
//!   section, unlike v5).
//! - File size delta vs v5 quantised is ~2-4× — irrelevant at mod scale
//!   and worth the simpler write path + zero rotation precision loss.
//!
//! Layout (all little-endian, offsets relative to byte 12):
//!
//! ```text
//!   0   "r3d2anmd"                       8 B
//!   8   version = 4                      4 B
//!  12   file_size (patched at end)       4 B
//!  16   format_token = 0xBE0794D3        4 B
//!  20   unknown = 0                      4 B
//!  24   flags = 0                        4 B
//!  28   joint_count                      4 B
//!  32   frame_count                      4 B
//!  36   frame_duration = 1/fps           4 B
//!  40   joint_hashes_offset = 0          4 B  (unused in v4)
//!  44   asset_name_offset   = 0          4 B  (unused in v4)
//!  48   time_offset         = 0          4 B  (unused in v4)
//!  52   vector_palette_off  = 64         4 B  (vecs always start at byte 76)
//!  56   quat_palette_off    (patched)    4 B
//!  60   frames_off          (patched)    4 B
//!  64   padding (zeroed)                12 B
//!  76   <vector palette>                 N×12 B
//!       <quat palette>                   M×16 B
//!       <frames>                         joint_count × frame_count × 12 B
//! ```
//!
//! Each frame entry: `u32 joint_hash + u16 t_id + u16 s_id + u16 r_id + u16 pad`.
//!
//! Ported from Aventurine's `write_anm_from_data`
//! (other apps/Aventurine-League-Tools-main/io/export_anm.py:542-636). The
//! upstream lives in Blender-land and applies an `EXPORT_SCALE` to flip
//! import-time scaling — we skip that because our [`BakedAnimation`] is
//! already in game units (no Blender pass).

use std::collections::HashMap;
use std::io::{Cursor, Seek, SeekFrom, Write};

use byteorder::{LittleEndian, WriteBytesExt};

use super::anm::BakedAnimation;
use super::error::Result;

/// Format token Riot writes in every v4 ANM. Constant across all
/// shipping files we've inspected — we emit the same value.
const FORMAT_TOKEN_V4: u32 = 0xBE07_94D3;

/// Writes a [`BakedAnimation`] as a v4 uncompressed `.anm` file and
/// returns the bytes. Caller writes to disk (or pipes elsewhere).
pub fn write_anm_v4(anim: &BakedAnimation) -> Result<Vec<u8>> {
    let mut buf = Vec::with_capacity(estimate_size(anim));
    write_anm_v4_into(&mut Cursor::new(&mut buf), anim)?;
    Ok(buf)
}

fn estimate_size(anim: &BakedAnimation) -> usize {
    // Header (76) + worst-case palette sizes + frame table.
    // The dedup pass usually cuts this in half, but allocating up
    // front avoids a handful of Vec growths on long animations.
    let frame_count = anim.frame_count as usize;
    let track_count = anim.tracks.len();
    let total_frames = frame_count * track_count;
    76 + total_frames * 12 /* vec palette worst-case */
        + total_frames * 16 /* quat palette worst-case */
        + total_frames * 12 /* frame table */
}

/// Writes the v4 ANM into the given seekable writer.
pub fn write_anm_v4_into<W: Write + Seek>(w: &mut W, anim: &BakedAnimation) -> Result<()> {
    // Sort tracks by joint hash so the on-disk order is deterministic
    // (and matches what readers expect from Riot's own files, which
    // also sort by hash). Round-trip stability falls out for free.
    let mut sorted_hashes: Vec<u32> = anim.tracks.iter().map(|t| t.joint_hash).collect();
    sorted_hashes.sort_unstable();

    let track_index: HashMap<u32, &super::anm::AnmTrack> =
        anim.tracks.iter().map(|t| (t.joint_hash, t)).collect();

    let frame_count = anim.frame_count as usize;
    let joint_count = sorted_hashes.len();
    let frame_duration = if anim.fps > 0.0 { 1.0 / anim.fps } else { 1.0 / 30.0 };

    // Deduplicated palettes — keyed by f32 bit pattern so identical
    // values share an index without epsilon games. Riot's own files
    // dedupe via the same approach (rest-pose values land in a single
    // palette slot regardless of how many bones / frames hold them).
    let mut vec_palette: Vec<[f32; 3]> = Vec::new();
    let mut vec_map: HashMap<[u32; 3], u16> = HashMap::new();
    let mut quat_palette: Vec<[f32; 4]> = Vec::new();
    let mut quat_map: HashMap<[u32; 4], u16> = HashMap::new();

    // Frame entries laid out in frame-major order — for each frame
    // we walk every joint and emit (hash, t_id, s_id, r_id, 0).
    // Matches the read side in `anm::parse_v4` exactly.
    let mut frame_entries: Vec<FrameEntry> =
        Vec::with_capacity(frame_count * joint_count);

    for frame_id in 0..frame_count {
        for &hash in &sorted_hashes {
            let track = match track_index.get(&hash) {
                Some(t) => *t,
                None => continue,
            };
            // If a track is shorter than frame_count, freeze it at
            // its last frame rather than emitting garbage. Mirrors
            // how the reader's `get_or` fallback behaves.
            let f = track
                .frames
                .get(frame_id)
                .or_else(|| track.frames.last());
            let (translation, rotation, scale) = match f {
                Some(f) => (f.translation, f.rotation, f.scale),
                None => ([0.0; 3], [0.0, 0.0, 0.0, 1.0], [1.0; 3]),
            };

            let t_id = intern_vec(&mut vec_palette, &mut vec_map, translation)?;
            let s_id = intern_vec(&mut vec_palette, &mut vec_map, scale)?;
            let r_id = intern_quat(&mut quat_palette, &mut quat_map, rotation)?;

            frame_entries.push(FrameEntry { hash, t_id, s_id, r_id });
        }
    }

    // ── Header ────────────────────────────────────────────────────
    w.write_all(b"r3d2anmd")?;
    w.write_u32::<LittleEndian>(4)?; // version
    let file_size_pos = w.stream_position()?; // 12
    w.write_u32::<LittleEndian>(0)?; // file size placeholder
    w.write_u32::<LittleEndian>(FORMAT_TOKEN_V4)?;
    w.write_u32::<LittleEndian>(0)?; // unknown
    w.write_u32::<LittleEndian>(0)?; // flags
    w.write_u32::<LittleEndian>(joint_count as u32)?;
    w.write_u32::<LittleEndian>(frame_count as u32)?;
    w.write_f32::<LittleEndian>(frame_duration)?;
    w.write_i32::<LittleEndian>(0)?; // joint_hashes_offset (unused in v4)
    w.write_i32::<LittleEndian>(0)?; // asset_name_offset (unused)
    w.write_i32::<LittleEndian>(0)?; // time_offset (unused)
    // Vector palette always lands at byte 76 (= header end after the
    // 12-byte pad). Stored offset is "absolute - 12" by the format's
    // convention, so 76 - 12 = 64.
    w.write_i32::<LittleEndian>(64)?; // vector_palette_offset
    let quats_off_pos = w.stream_position()?;
    w.write_i32::<LittleEndian>(0)?; // quat_palette_offset placeholder
    let frames_off_pos = w.stream_position()?;
    w.write_i32::<LittleEndian>(0)?; // frames_offset placeholder
    w.write_all(&[0u8; 12])?; // pad to byte 76

    // ── Vector palette ────────────────────────────────────────────
    for v in &vec_palette {
        w.write_f32::<LittleEndian>(v[0])?;
        w.write_f32::<LittleEndian>(v[1])?;
        w.write_f32::<LittleEndian>(v[2])?;
    }

    // ── Quat palette ──────────────────────────────────────────────
    let quat_offset = w.stream_position()? as i32 - 12;
    for q in &quat_palette {
        // Stored xyzw — matches what `anm::read_quat` reads.
        w.write_f32::<LittleEndian>(q[0])?;
        w.write_f32::<LittleEndian>(q[1])?;
        w.write_f32::<LittleEndian>(q[2])?;
        w.write_f32::<LittleEndian>(q[3])?;
    }

    // ── Frame table ───────────────────────────────────────────────
    let frame_offset = w.stream_position()? as i32 - 12;
    for fe in &frame_entries {
        w.write_u32::<LittleEndian>(fe.hash)?;
        w.write_u16::<LittleEndian>(fe.t_id)?;
        w.write_u16::<LittleEndian>(fe.s_id)?;
        w.write_u16::<LittleEndian>(fe.r_id)?;
        w.write_u16::<LittleEndian>(0)?; // padding
    }

    // ── Patch offsets + file size ─────────────────────────────────
    let file_size = w.stream_position()? as u32;
    w.seek(SeekFrom::Start(file_size_pos))?;
    w.write_u32::<LittleEndian>(file_size)?;
    w.seek(SeekFrom::Start(quats_off_pos))?;
    w.write_i32::<LittleEndian>(quat_offset)?;
    w.seek(SeekFrom::Start(frames_off_pos))?;
    w.write_i32::<LittleEndian>(frame_offset)?;
    w.seek(SeekFrom::End(0))?;

    Ok(())
}

struct FrameEntry {
    hash: u32,
    t_id: u16,
    s_id: u16,
    r_id: u16,
}

fn intern_vec(
    palette: &mut Vec<[f32; 3]>,
    map: &mut HashMap<[u32; 3], u16>,
    v: [f32; 3],
) -> Result<u16> {
    let key = [v[0].to_bits(), v[1].to_bits(), v[2].to_bits()];
    if let Some(&id) = map.get(&key) {
        return Ok(id);
    }
    let id = palette.len();
    if id > u16::MAX as usize {
        return Err(super::error::MeshError::Malformed(format!(
            "ANM vector palette overflow at {} entries (max {})",
            id,
            u16::MAX
        )));
    }
    palette.push(v);
    map.insert(key, id as u16);
    Ok(id as u16)
}

fn intern_quat(
    palette: &mut Vec<[f32; 4]>,
    map: &mut HashMap<[u32; 4], u16>,
    q: [f32; 4],
) -> Result<u16> {
    let key = [
        q[0].to_bits(),
        q[1].to_bits(),
        q[2].to_bits(),
        q[3].to_bits(),
    ];
    if let Some(&id) = map.get(&key) {
        return Ok(id);
    }
    let id = palette.len();
    if id > u16::MAX as usize {
        return Err(super::error::MeshError::Malformed(format!(
            "ANM quat palette overflow at {} entries (max {})",
            id,
            u16::MAX
        )));
    }
    palette.push(q);
    map.insert(key, id as u16);
    Ok(id as u16)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::mesh::anm::{parse_anm, AnmFrame, AnmTrack, BakedAnimation};

    fn sample_anim() -> BakedAnimation {
        // Two joints, three frames — values are arbitrary but cover
        // dedup (frame 0 and frame 2 of joint A share a translation;
        // both joints share the unit-scale palette entry).
        let track_a = AnmTrack {
            joint_hash: 0x1234_5678,
            frames: vec![
                AnmFrame {
                    translation: [1.0, 2.0, 3.0],
                    rotation: [0.0, 0.0, 0.0, 1.0],
                    scale: [1.0, 1.0, 1.0],
                },
                AnmFrame {
                    translation: [4.0, 5.0, 6.0],
                    rotation: [0.1, 0.2, 0.3, 0.927362],
                    scale: [1.0, 1.0, 1.0],
                },
                AnmFrame {
                    translation: [1.0, 2.0, 3.0], // dupes frame 0
                    rotation: [0.0, 0.0, 0.0, 1.0],
                    scale: [1.0, 1.0, 1.0],
                },
            ],
        };
        let track_b = AnmTrack {
            joint_hash: 0xABCD_EF01,
            frames: vec![
                AnmFrame {
                    translation: [0.0, 0.0, 0.0],
                    rotation: [0.5, 0.5, 0.5, 0.5],
                    scale: [1.0, 1.0, 1.0],
                };
                3
            ],
        };
        BakedAnimation {
            duration: 3.0 / 30.0,
            fps: 30.0,
            frame_count: 3,
            tracks: vec![track_a, track_b],
        }
    }

    #[test]
    fn header_layout_matches_format() {
        let bytes = write_anm_v4(&sample_anim()).unwrap();
        assert_eq!(&bytes[0..8], b"r3d2anmd");
        // version = 4 at byte 8
        assert_eq!(u32::from_le_bytes(bytes[8..12].try_into().unwrap()), 4);
        // file_size at byte 12 equals total length
        assert_eq!(
            u32::from_le_bytes(bytes[12..16].try_into().unwrap()),
            bytes.len() as u32
        );
        // format token at byte 16
        assert_eq!(
            u32::from_le_bytes(bytes[16..20].try_into().unwrap()),
            FORMAT_TOKEN_V4
        );
        // vector palette offset (4th of the 6 i32 offsets) = 64
        assert_eq!(
            i32::from_le_bytes(bytes[52..56].try_into().unwrap()),
            64
        );
        // Data section begins at byte 76 (12-byte pad after header).
        assert!(bytes.len() >= 76);
    }

    #[test]
    fn roundtrip_preserves_trs() {
        let original = sample_anim();
        let bytes = write_anm_v4(&original).unwrap();
        let parsed = parse_anm(&bytes).expect("parse our own output");

        assert_eq!(parsed.frame_count, original.frame_count);
        // fps round-trips through `1.0 / fps` on write + `1.0 / dur`
        // on read, so a single ULP of drift is expected.
        assert!((parsed.fps - original.fps).abs() < 1e-3);
        assert_eq!(parsed.tracks.len(), original.tracks.len());

        // Reader returns tracks in HashMap iteration order, so sort
        // both sides by hash before comparing.
        let mut parsed_tracks = parsed.tracks.clone();
        parsed_tracks.sort_by_key(|t| t.joint_hash);
        let mut original_tracks = original.tracks.clone();
        original_tracks.sort_by_key(|t| t.joint_hash);

        for (p, o) in parsed_tracks.iter().zip(original_tracks.iter()) {
            assert_eq!(p.joint_hash, o.joint_hash);
            assert_eq!(p.frames.len(), o.frames.len());
            for (pf, of) in p.frames.iter().zip(o.frames.iter()) {
                // Translations + scales round-trip bit-exact (no
                // quantisation in v4).
                assert_eq!(pf.translation, of.translation);
                assert_eq!(pf.scale, of.scale);
                // The reader normalises quats on parse, so a non-
                // unit input drifts by ULPs even though the bytes
                // on disk match exactly. Compare within float eps.
                for i in 0..4 {
                    assert!(
                        (pf.rotation[i] - of.rotation[i]).abs() < 1e-4,
                        "rotation drift {} vs {}",
                        pf.rotation[i],
                        of.rotation[i]
                    );
                }
            }
        }
    }

    #[test]
    fn dedups_vector_palette() {
        // Sample has both joints using [1,1,1] scale + joint A repeats
        // translation [1,2,3]. Expect the vec palette to be smaller
        // than the naive frame_count × joint_count × 2.
        let bytes = write_anm_v4(&sample_anim()).unwrap();

        // Quat offset stored at bytes 56..60 (relative to byte 12,
        // so absolute = stored + 12). Vec palette spans [76, quat_abs).
        let quat_rel = i32::from_le_bytes(bytes[56..60].try_into().unwrap());
        let vec_palette_bytes = (quat_rel + 12) as usize - 76;
        let vec_count = vec_palette_bytes / 12;
        // Distinct vecs across the anim: [1,2,3], [4,5,6], [1,1,1],
        // [0,0,0] → 4 entries. Anything larger means dedup broke.
        assert_eq!(vec_count, 4, "expected 4 unique vectors after dedup");
    }
}
