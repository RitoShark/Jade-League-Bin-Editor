//! WAD serializer — the mirror of [`crate::core::wad::reader`].
//!
//! Always emits v3.3 (the layout `read_chunk_v3_1` parses): 272-byte
//! header (magic + version + zeroed signature/checksum block + count)
//! followed by 32-byte TOC records, then the chunk data section. The
//! launcher never validates the signature block for mod WADs, so we
//! zero it like every community packer does.
//!
//! ZstdMulti chunks can't be carried over as-is — their `start_frame`
//! indexes a subchunk table we don't rebuild, and v3.3 records only
//! have 16 bits for it — so callers must hand us single-frame data
//! (None / GZip / Zstd). The Manage pipeline recompresses ZstdMulti
//! to plain Zstd before it gets here.

use crate::core::wad::format::WadCompression;
use crate::error::{Error, Result};
use byteorder::{LittleEndian, WriteBytesExt};
use std::io::Write;

/// One chunk ready to serialize. `compressed` is the on-disk byte run
/// (already compressed per `compression`); `checksum` is XXH3-64 of
/// those bytes (preserve the source WAD's value when raw-copying).
pub struct OutChunk {
    pub path_hash: u64,
    pub compression: WadCompression,
    pub compressed: Vec<u8>,
    pub uncompressed_size: u64,
    pub checksum: u64,
}

/// Compress fresh (edited) data into an [`OutChunk`]. Uses zstd level 3
/// — same ballpark ratio as Riot's own chunks at a fraction of the
/// pack time — and falls back to stored when compression doesn't help
/// (tiny bins, already-compressed payloads).
pub fn fresh_chunk(path_hash: u64, data: &[u8]) -> OutChunk {
    let compressed = zstd::stream::encode_all(data, 3).unwrap_or_else(|_| data.to_vec());
    let (compression, bytes) = if compressed.len() < data.len() {
        (WadCompression::Zstd, compressed)
    } else {
        (WadCompression::None, data.to_vec())
    };
    let checksum = twox_hash::xxh3::hash64(&bytes);
    OutChunk {
        path_hash,
        compression,
        compressed: bytes,
        uncompressed_size: data.len() as u64,
        checksum,
    }
}

/// Serialize chunks into a complete v3.3 WAD. Sorts the TOC by path
/// hash (the game binary-searches it) and lays data out in the same
/// order. Duplicate hashes are an input error — the game would only
/// ever see one of them.
pub fn write_wad(chunks: &[OutChunk]) -> Result<Vec<u8>> {
    let mut order: Vec<usize> = (0..chunks.len()).collect();
    order.sort_by_key(|&i| chunks[i].path_hash);
    for w in order.windows(2) {
        if chunks[w[0]].path_hash == chunks[w[1]].path_hash {
            return Err(Error::Wad {
                message: format!(
                    "Duplicate chunk hash {:016x} — two files would land on the same path",
                    chunks[w[0]].path_hash
                ),
                path: None,
            });
        }
    }

    const HEADER_LEN: u64 = 2 + 1 + 1 + 256 + 8 + 4;
    const RECORD_LEN: u64 = 32;
    let data_start = HEADER_LEN + RECORD_LEN * chunks.len() as u64;

    let total_data: u64 = chunks.iter().map(|c| c.compressed.len() as u64).sum();
    let mut out = Vec::with_capacity((data_start + total_data) as usize);

    let io_err = |e: std::io::Error| Error::Wad {
        message: format!("WAD serialize failed: {}", e),
        path: None,
    };

    out.write_all(b"RW").map_err(io_err)?;
    out.write_u8(3).map_err(io_err)?;
    out.write_u8(3).map_err(io_err)?;
    out.write_all(&[0u8; 256 + 8]).map_err(io_err)?;
    out.write_i32::<LittleEndian>(chunks.len() as i32).map_err(io_err)?;

    // TOC — offsets are u32 in the record, so refuse >4GB outputs
    // rather than silently truncating.
    let mut offset = data_start;
    for &i in &order {
        let c = &chunks[i];
        if offset + c.compressed.len() as u64 > u32::MAX as u64 {
            return Err(Error::Wad {
                message: "WAD would exceed 4GB — offsets no longer fit in the TOC".to_string(),
                path: None,
            });
        }
        out.write_u64::<LittleEndian>(c.path_hash).map_err(io_err)?;
        out.write_u32::<LittleEndian>(offset as u32).map_err(io_err)?;
        out.write_i32::<LittleEndian>(c.compressed.len() as i32).map_err(io_err)?;
        out.write_i32::<LittleEndian>(c.uncompressed_size as i32).map_err(io_err)?;
        out.write_u8(c.compression as u8).map_err(io_err)?; // frame_count 0 in high nibble
        out.write_u8(0).map_err(io_err)?; // is_duplicated
        out.write_u16::<LittleEndian>(0).map_err(io_err)?; // start_frame
        out.write_u64::<LittleEndian>(c.checksum).map_err(io_err)?;
        offset += c.compressed.len() as u64;
    }

    for &i in &order {
        out.write_all(&chunks[i].compressed).map_err(io_err)?;
    }

    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::wad::reader::read_wad_toc;
    use std::io::Write as _;

    #[test]
    fn round_trips_through_reader() {
        let a = fresh_chunk(0xdead_beef_0000_0001, b"hello bin world, this compresses ok ok ok ok ok");
        let b = fresh_chunk(0xdead_beef_0000_0002, b"x");
        let bytes = write_wad(&[b, a]).expect("write");

        let mut tmp = std::env::temp_dir();
        tmp.push("jade-wad-writer-test.wad.client");
        let mut f = std::fs::File::create(&tmp).expect("tmp");
        f.write_all(&bytes).expect("tmp write");
        drop(f);

        let toc = read_wad_toc(&tmp).expect("re-read");
        assert_eq!(toc.version.major, 3);
        assert_eq!(toc.version.minor, 3);
        assert_eq!(toc.chunks.len(), 2);
        // Sorted ascending by hash even though we passed them reversed.
        assert!(toc.chunks[0].path_hash < toc.chunks[1].path_hash);
        let _ = std::fs::remove_file(&tmp);
    }

    #[test]
    fn rejects_duplicate_hashes() {
        let a = fresh_chunk(42, b"one");
        let b = fresh_chunk(42, b"two");
        assert!(write_wad(&[a, b]).is_err());
    }
}
