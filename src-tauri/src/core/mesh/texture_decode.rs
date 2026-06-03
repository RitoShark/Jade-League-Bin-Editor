//! Native texture decoder for the 3D-preview pipeline.
//!
//! The TS port in `src/lib/texFormat.ts` is fine for one-off previews
//! (BIN preview pane, texture popups), but model previews routinely
//! decode 8–12 textures back-to-back, and JS-side DXT decompression +
//! the canvas → PNG → data URL → Image → GPU round-trip stack up to
//! multiple seconds. This decoder runs in Rust, decodes blocks via
//! `texpresso`, and the caller (mesh_commands) wraps it in a
//! rayon-parallel batched IPC command. Output is raw RGBA bytes —
//! the frontend uploads them directly to a Babylon `RawTexture`,
//! skipping PNG entirely.
//!
//! Supported inputs:
//!   - Riot TEX  (`TEX\0` magic)  — formats: DXT1 (BC1), DXT5 (BC3), BGRA8
//!   - DDS       (`DDS ` magic)   — formats: DXT1 (BC1), DXT5 (BC3),
//!                                  BGRA8, RGBA8
//!
//! ETC1/ETC2 (mobile-only Riot formats) are not supported here — they
//! shouldn't appear in PC client WADs and the JS decoder doesn't
//! handle them either.

use serde::Serialize;
use texpresso::Format as BcFormat;

use super::error::{MeshError, Result};

/// Decoded texture in straight `RGBA8` byte order, top-left-origin
/// pixel layout — same shape Babylon's `RawTexture.CreateRGBATexture`
/// wants on the JS side.
#[derive(Debug, Clone, Serialize)]
pub struct DecodedTexture {
    pub width: u32,
    pub height: u32,
    /// Source-format string for diagnostic / metrics use. Frontend
    /// doesn't act on it; the GPU only sees RGBA8 bytes.
    pub format: String,
    /// `width × height × 4` bytes in `R,G,B,A,R,G,B,A,…` order.
    pub rgba: Vec<u8>,
    /// `true` if any pixel's alpha is < 255. Drives the PBR
    /// transparency-mode selection on the JS side, just like the TS
    /// decoder's `hasAnyTransparency` scan.
    pub has_alpha: bool,
}

/// Sniff the magic bytes and dispatch to the right header parser.
///
/// Order of detection:
/// 1. `DDS ` magic → DDS (compressed BCn texture)
/// 2. Common raster magics (PNG, JPEG, etc.) → image crate
/// 3. Fall through to TEX (Riot's bespoke format) — must be last
///    because TEX has no fixed magic and our parser does its own
///    structural validation.
///
/// The image-crate branch covers FBX / PBR-pack textures the studio
/// imports alongside SKN models. Routing them through Rust gives the
/// JS-side pipeline ONE upload path (`RawTexture.CreateRGBATexture`
/// with `invertY = true`), which matches `meshBuilder.ts`'s
/// SKN-UV V-flip and the studio's procedural / DDS / TEX textures.
/// Mixing in the webview's native `new Texture(url, …)` loader for
/// PNGs flipped the V at a different stage and produced
/// misregistered sampling on League mod SKNs with PNG diffuse maps.
pub fn decode_auto(bytes: &[u8]) -> Result<DecodedTexture> {
    if bytes.len() < 4 {
        return Err(MeshError::Malformed(format!(
            "texture too small: {} bytes",
            bytes.len()
        )));
    }
    if &bytes[..4] == b"DDS " {
        return decode_dds(bytes);
    }
    if looks_like_raster(bytes) {
        return decode_raster(bytes);
    }
    decode_tex(bytes)
}

/// Magic-byte sniff for the formats the `image` crate is feature-
/// gated to read in our Cargo.toml. Cheap to check; avoids invoking
/// `image::load_from_memory` on TEX files (which would error since
/// TEX has no known image-crate header).
fn looks_like_raster(b: &[u8]) -> bool {
    if b.len() >= 8 && &b[..8] == b"\x89PNG\r\n\x1a\n" { return true; }            // PNG
    if b.len() >= 3 && b[..3] == [0xFF, 0xD8, 0xFF] { return true; }                // JPEG
    if b.len() >= 12 && &b[..4] == b"RIFF" && &b[8..12] == b"WEBP" { return true; } // WEBP
    if b.len() >= 2 && b[0] == 0x42 && b[1] == 0x4D { return true; }                // BMP
    // TGA has no magic — sniff by the rare-but-valid header layout
    // (image type byte in [0,1,2,3,9,10,11], bit-depth in {8,16,24,32}).
    // ColorMap-type byte is 0 or 1. This pattern reliably rejects DDS
    // (which we caught above) and TEX (its first byte is 'T' = 0x54
    // which doesn't match a valid TGA color-map type).
    if b.len() >= 18 {
        let cmap = b[1];
        let img_type = b[2];
        let depth = b[16];
        if cmap <= 1
            && matches!(img_type, 0 | 1 | 2 | 3 | 9 | 10 | 11)
            && matches!(depth, 8 | 16 | 24 | 32)
        {
            return true;
        }
    }
    false
}

fn decode_raster(bytes: &[u8]) -> Result<DecodedTexture> {
    let dynamic = image::load_from_memory(bytes)
        .map_err(|e| MeshError::Malformed(format!("raster decode: {e}")))?;
    let rgba = dynamic.to_rgba8();
    let (w, h) = (rgba.width(), rgba.height());
    let pixels = rgba.into_raw();
    // Scan for any sub-255 alpha so the JS side picks the right
    // material transparency mode — same shape DDS/TEX uses.
    let has_alpha = pixels.chunks_exact(4).any(|p| p[3] < 255);
    Ok(DecodedTexture {
        width: w,
        height: h,
        format: "RASTER (image crate)".to_string(),
        rgba: pixels,
        has_alpha,
    })
}

// ── Riot TEX ────────────────────────────────────────────────────────

/// Format byte values from Riot's TEX header. Same numeric values as
/// the TS port's `TEXFormat` enum.
mod tex_format {
    pub const DXT1: u8 = 10;
    pub const DXT5: u8 = 12;
    /// BC7 sRGB — UI atlases + modern champion atlases. Added by
    /// Riot in patch 16.10. Decoded via `texture2ddecoder` since
    /// `texpresso` doesn't ship a BC7 implementation.
    pub const BC7: u8 = 13;
    /// BC5 (signed normal maps). Added by Riot in patch 16.10 —
    /// used for water surfaces in Map11 and increasingly for
    /// champion normal maps. We treat SNORM/UNORM identically for
    /// preview purposes; the slight color shift is invisible at
    /// thumbnail size.
    pub const BC5: u8 = 14;
    pub const BGRA8: u8 = 20;
    // ETC1=1, ETC2_EAC=2, ETC2=3 — explicitly unsupported here.
}

/// Parse a Riot `.tex` header + decompress the largest mip.
///
/// Layout:
/// ```text
///   u32  magic           "TEX\0"
///   u16  width
///   u16  height
///   u8   _unknown1
///   u8   format
///   u8   _unknown2
///   u8   mipmaps_flag    // non-zero ⇒ data is mip0..mipN concatenated
///                        //   in *ascending* order — i.e. SMALLEST
///                        //   mip first, LARGEST mip last. We want
///                        //   the largest, so we read from the END.
/// ```
pub fn decode_tex(bytes: &[u8]) -> Result<DecodedTexture> {
    if bytes.len() < 12 {
        return Err(MeshError::Malformed("TEX truncated header".into()));
    }
    if &bytes[..4] != b"TEX\0" {
        return Err(MeshError::InvalidSignature {
            format: "TEX",
            expected: 0x0058_4554,
            got: u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]),
        });
    }

    let width = u16::from_le_bytes([bytes[4], bytes[5]]) as u32;
    let height = u16::from_le_bytes([bytes[6], bytes[7]]) as u32;
    let format = bytes[9];
    let has_mipmaps = bytes[11] != 0;

    let pixel_data = &bytes[12..];

    match format {
        tex_format::DXT1 => decode_bc_with_optional_mipmaps(
            pixel_data,
            width,
            height,
            BcFormat::Bc1,
            8,
            has_mipmaps,
            "DXT1",
        ),
        tex_format::DXT5 => decode_bc_with_optional_mipmaps(
            pixel_data,
            width,
            height,
            BcFormat::Bc3,
            16,
            has_mipmaps,
            "DXT5",
        ),
        // BC5 + BC7 mirror DXT1/DXT5's mip layout (smallest first,
        // largest last) but the block decode goes through
        // `texture2ddecoder` since `texpresso` doesn't cover them.
        tex_format::BC5 => decode_t2d_bc_with_optional_mipmaps(
            pixel_data,
            width,
            height,
            T2dBc::Bc5,
            has_mipmaps,
            "BC5",
        ),
        tex_format::BC7 => decode_t2d_bc_with_optional_mipmaps(
            pixel_data,
            width,
            height,
            T2dBc::Bc7,
            has_mipmaps,
            "BC7",
        ),
        tex_format::BGRA8 => {
            // Uncompressed; one byte per channel. With mipmaps the
            // largest mip is last — same convention as DXT.
            let largest_mip_size = (width as usize) * (height as usize) * 4;
            let mip_bytes = if has_mipmaps && pixel_data.len() > largest_mip_size {
                let start = pixel_data.len() - largest_mip_size;
                &pixel_data[start..]
            } else {
                pixel_data
            };
            if mip_bytes.len() < largest_mip_size {
                return Err(MeshError::Malformed(format!(
                    "TEX BGRA8 truncated: have {} bytes, need {}",
                    mip_bytes.len(),
                    largest_mip_size
                )));
            }
            let rgba = swizzle_bgra8_to_rgba(&mip_bytes[..largest_mip_size]);
            let has_alpha = scan_has_alpha(&rgba);
            Ok(DecodedTexture {
                width,
                height,
                format: "BGRA8".into(),
                rgba,
                has_alpha,
            })
        }
        other => Err(MeshError::InvalidField {
            format: "TEX",
            field: "format",
            value: format!(
                "{} (only DXT1=10, DXT5=12, BGRA8=20 are supported)",
                other
            ),
        }),
    }
}

// ── DDS ─────────────────────────────────────────────────────────────

const DDS_MAGIC: [u8; 4] = *b"DDS ";
const FOURCC_DXT1: u32 = 0x3154_5844; // "DXT1" little-endian
const FOURCC_DXT3: u32 = 0x3354_5844; // "DXT3"
const FOURCC_DXT5: u32 = 0x3554_5844; // "DXT5"
const DDPF_FOURCC: u32 = 0x4;
const DDPF_RGB: u32 = 0x40;
const DDPF_ALPHAPIXELS: u32 = 0x1;
const DDS_PIXEL_DATA_OFFSET: usize = 128;

/// Parse a DDS header and decode the largest (mip 0) texture. DDS
/// stores mip 0 *first*, so we just read from offset 128 onward.
pub fn decode_dds(bytes: &[u8]) -> Result<DecodedTexture> {
    if bytes.len() < DDS_PIXEL_DATA_OFFSET {
        return Err(MeshError::Malformed("DDS truncated header".into()));
    }
    if bytes[..4] != DDS_MAGIC {
        return Err(MeshError::InvalidSignature {
            format: "DDS",
            expected: u32::from_le_bytes(DDS_MAGIC),
            got: u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]),
        });
    }

    // DDS_HEADER fields are 32-bit at offset 4 onward.
    let height = u32::from_le_bytes([bytes[12], bytes[13], bytes[14], bytes[15]]);
    let width = u32::from_le_bytes([bytes[16], bytes[17], bytes[18], bytes[19]]);

    // DDS_PIXELFORMAT block starts at offset 76. Within it:
    //   +0  dwSize
    //   +4  dwFlags     (DDPF_FOURCC | DDPF_RGB | DDPF_ALPHAPIXELS …)
    //   +8  dwFourCC
    //   +12 dwRGBBitCount
    //   +16 dwRBitMask
    //   +20 dwGBitMask
    //   +24 dwBBitMask
    //   +28 dwABitMask
    let pf_flags = u32::from_le_bytes([bytes[80], bytes[81], bytes[82], bytes[83]]);
    let four_cc = u32::from_le_bytes([bytes[84], bytes[85], bytes[86], bytes[87]]);
    let rgb_bit_count = u32::from_le_bytes([bytes[88], bytes[89], bytes[90], bytes[91]]);
    let r_mask = u32::from_le_bytes([bytes[92], bytes[93], bytes[94], bytes[95]]);

    let pixel_data = &bytes[DDS_PIXEL_DATA_OFFSET..];

    if pf_flags & DDPF_FOURCC != 0 {
        match four_cc {
            FOURCC_DXT1 => decode_bc(pixel_data, width, height, BcFormat::Bc1, "DXT1"),
            FOURCC_DXT3 => decode_bc(pixel_data, width, height, BcFormat::Bc2, "DXT3"),
            FOURCC_DXT5 => decode_bc(pixel_data, width, height, BcFormat::Bc3, "DXT5"),
            other => Err(MeshError::InvalidField {
                format: "DDS",
                field: "fourCC",
                value: format!("0x{:08x} (only DXT1/DXT3/DXT5 supported)", other),
            }),
        }
    } else if (pf_flags & (DDPF_RGB | DDPF_ALPHAPIXELS)) != 0 && rgb_bit_count == 32 {
        // Uncompressed 32-bpp. Channel order is determined by the
        // R-mask: 0x00FF0000 means R is in the third byte (BGRA8),
        // anything else (typically 0x000000FF) means R first (RGBA8).
        let needed = (width as usize) * (height as usize) * 4;
        if pixel_data.len() < needed {
            return Err(MeshError::Malformed(format!(
                "DDS uncompressed truncated: have {}, need {}",
                pixel_data.len(),
                needed
            )));
        }
        let slice = &pixel_data[..needed];
        let (rgba, fmt) = if r_mask == 0x00FF_0000 {
            (swizzle_bgra8_to_rgba(slice), "BGRA8")
        } else {
            (slice.to_vec(), "RGBA8")
        };
        let has_alpha = scan_has_alpha(&rgba);
        Ok(DecodedTexture {
            width,
            height,
            format: fmt.into(),
            rgba,
            has_alpha,
        })
    } else {
        Err(MeshError::InvalidField {
            format: "DDS",
            field: "pixelFormat",
            value: format!("flags=0x{:x}, bpp={}", pf_flags, rgb_bit_count),
        })
    }
}

// ── Block decoding helpers ──────────────────────────────────────────

fn decode_bc(
    data: &[u8],
    width: u32,
    height: u32,
    fmt: BcFormat,
    fmt_name: &str,
) -> Result<DecodedTexture> {
    let mip0_size = bc_mip_size(width, height, fmt);
    if data.len() < mip0_size {
        return Err(MeshError::Malformed(format!(
            "{} mip0 truncated: have {}, need {}",
            fmt_name,
            data.len(),
            mip0_size
        )));
    }
    let mut rgba = vec![0u8; (width as usize) * (height as usize) * 4];
    fmt.decompress(
        &data[..mip0_size],
        width as usize,
        height as usize,
        &mut rgba,
    );
    let has_alpha = scan_has_alpha(&rgba);
    Ok(DecodedTexture {
        width,
        height,
        format: fmt_name.into(),
        rgba,
        has_alpha,
    })
}

/// Variant of [`decode_bc`] that handles the Riot-TEX mipmap-tail
/// quirk: when mipmaps are present, the buffer layout is `mipN ..
/// mip0` (smallest first, largest last), so we have to skip past
/// every smaller mip to land on mip0. DDS stores mip0 first so its
/// path doesn't need this.
/// BC formats handled via `texture2ddecoder` (BC5 + BC7). Block size
/// is 16 bytes for both — same as DXT5/BC3 — so the mipmap tail
/// arithmetic in `decode_t2d_bc_with_optional_mipmaps` matches.
#[derive(Copy, Clone)]
enum T2dBc { Bc5, Bc7 }

impl T2dBc {
    fn bytes_per_block(self) -> usize { 16 }
}

/// Decode a single BC5/BC7 mip via `texture2ddecoder` into our standard
/// `Vec<u8>` RGBA8 buffer.
///
/// Channel layout caveats — the underlying crate's output is two
/// different shapes depending on format:
///
/// **BC7** writes proper RGBA into each u32 (`r | g<<8 | b<<16 | a<<24`),
/// so a `to_le_bytes()` flatten gives our standard `[R, G, B, A]`.
///
/// **BC5** stores only two channels (red+green, the X+Y of a normal
/// vector). `texture2ddecoder` writes the first stored channel into
/// the u32's `B` slot (channel 2) and the second into `G` (channel 1),
/// leaving R=0 and A=0. We:
///   1. Remap the two stored bytes from B/G into R/G slots so the
///      preview shows the normal-map orientation paint.net / Photoshop
///      / Substance show by default.
///   2. Apply SNORM→UNORM display remap (`byte ^ 0x80`) because Riot
///      ships TEX format 14 as `BC5_SNORM`: raw `0x00` means axis-zero
///      and should render as mid-gray, not black.
///   3. Reconstruct B from the unit-length normal: `z = √(1 − x² − y²)`,
///      with x/y derived from the SNORM-remapped bytes. For tangent-
///      space normals this gives the canonical blue-dominant look.
///   4. Force alpha to 255 — BC5 has no alpha channel and leaving it
///      at 0 (the crate's default) makes the preview transparent.
fn decode_t2d_bc_mip(
    data: &[u8],
    width: u32,
    height: u32,
    fmt: T2dBc,
    fmt_name: &str,
) -> Result<Vec<u8>> {
    let mip_size = bc_mip_size_at_level(width, height, 0, fmt.bytes_per_block());
    if data.len() < mip_size {
        return Err(MeshError::Malformed(format!(
            "{} mip truncated: have {}, need {}",
            fmt_name, data.len(), mip_size
        )));
    }
    let pixel_count = (width as usize) * (height as usize);
    let mut pixels: Vec<u32> = vec![0; pixel_count];
    let res = match fmt {
        T2dBc::Bc5 => texture2ddecoder::decode_bc5(
            &data[..mip_size], width as usize, height as usize, &mut pixels,
        ),
        T2dBc::Bc7 => texture2ddecoder::decode_bc7(
            &data[..mip_size], width as usize, height as usize, &mut pixels,
        ),
    };
    res.map_err(|e| MeshError::Malformed(format!("{fmt_name} decode: {e}")))?;
    let mut rgba: Vec<u8> = Vec::with_capacity(pixel_count * 4);
    match fmt {
        T2dBc::Bc7 => {
            // texture2ddecoder packs pixels via
            // `color(r,g,b,a) = u32::from_le_bytes([b,g,r,a])`, so
            // `to_le_bytes()` returns memory order [B, G, R, A].
            // Pushing that straight into the RGBA buffer swapped R↔B
            // and tinted everything wrong (reds rendered as blues).
            // Re-pack into true R,G,B,A here.
            for px in &pixels {
                let b = (*px & 0xff) as u8;
                let g = ((*px >> 8) & 0xff) as u8;
                let r = ((*px >> 16) & 0xff) as u8;
                let a = ((*px >> 24) & 0xff) as u8;
                rgba.extend_from_slice(&[r, g, b, a]);
            }
        }
        T2dBc::Bc5 => {
            // Empirically Riot's TEX format 14 is BC5 *UNORM* (despite
            // the GitHub issue tagging it as SNORM): raw bytes are
            // already centered at 128 for axis-zero and read straight
            // through to display, no XOR remap needed. The earlier
            // SNORM remap inverted the data and produced harsh
            // extremes that didn't match paint.net's "looks like a
            // normal map" output.
            for px in &pixels {
                let stored_y = ((*px >> 8) & 0xff) as u8;   // crate's G slot
                let stored_x = ((*px >> 16) & 0xff) as u8;  // crate's B slot
                let r = stored_x;
                let g = stored_y;
                // Reconstruct Z from the unit-length tangent normal:
                //   x = 2r − 1, y = 2g − 1 (in [-1, 1])
                //   z = √(1 − x² − y²) ∈ [0, 1]
                // Display Z uses the SAME centered remap that paint.net /
                // Photoshop / Substance use for normal-map preview —
                // `(z + 1) * 127.5` — so the byte sits in [127, 255]
                // and matches how the rest of the world renders these.
                // Flat normals (z = 1) ⇒ pure blue 255, slopes ⇒ down
                // toward 127. Using `z * 255` (which drops to 0 on
                // steep slopes) made the image visibly darker than
                // paint.net's display of the same file.
                let xf = (r as f32 - 127.5) / 127.5;
                let yf = (g as f32 - 127.5) / 127.5;
                let zf = (1.0 - xf * xf - yf * yf).max(0.0).sqrt();
                let b = ((zf + 1.0) * 127.5).clamp(0.0, 255.0) as u8;
                rgba.extend_from_slice(&[r, g, b, 255]);
            }
        }
    }
    Ok(rgba)
}

fn decode_t2d_bc_with_optional_mipmaps(
    data: &[u8],
    width: u32,
    height: u32,
    fmt: T2dBc,
    has_mipmaps: bool,
    fmt_name: &str,
) -> Result<DecodedTexture> {
    let bytes_per_block = fmt.bytes_per_block();
    let mip0_offset = if has_mipmaps {
        let total: usize = (0..mipmap_count(width, height))
            .map(|i| bc_mip_size_at_level(width, height, i, bytes_per_block))
            .sum();
        if data.len() < total {
            return Err(MeshError::Malformed(format!(
                "{fmt_name} mipmap chain truncated: have {}, need {}",
                data.len(), total
            )));
        }
        total - bc_mip_size_at_level(width, height, 0, bytes_per_block)
    } else {
        0
    };
    let rgba = decode_t2d_bc_mip(&data[mip0_offset..], width, height, fmt, fmt_name)?;
    let has_alpha = scan_has_alpha(&rgba);
    Ok(DecodedTexture {
        width,
        height,
        format: fmt_name.into(),
        rgba,
        has_alpha,
    })
}

fn decode_bc_with_optional_mipmaps(
    data: &[u8],
    width: u32,
    height: u32,
    fmt: BcFormat,
    bytes_per_block: usize,
    has_mipmaps: bool,
    fmt_name: &str,
) -> Result<DecodedTexture> {
    let mip0_offset = if has_mipmaps {
        // Total size of all mip levels in the buffer, summed. Mip 0
        // sits at this offset from the start. We could instead walk
        // *backwards* by `mip0_size` bytes from the end — same result
        // since the buffer's tail is always exactly mip 0.
        let total: usize = (0..mipmap_count(width, height))
            .map(|i| bc_mip_size_at_level(width, height, i, bytes_per_block))
            .sum();
        if data.len() < total {
            return Err(MeshError::Malformed(format!(
                "{} mipmap chain truncated: have {}, need {}",
                fmt_name,
                data.len(),
                total
            )));
        }
        total - bc_mip_size_at_level(width, height, 0, bytes_per_block)
    } else {
        0
    };
    decode_bc(&data[mip0_offset..], width, height, fmt, fmt_name)
}

fn mipmap_count(width: u32, height: u32) -> u32 {
    let max_dim = width.max(height).max(1);
    32 - max_dim.leading_zeros() // floor(log2(max_dim)) + 1
}

fn bc_mip_size(width: u32, height: u32, fmt: BcFormat) -> usize {
    let bytes_per_block = match fmt {
        BcFormat::Bc1 => 8,
        BcFormat::Bc2 | BcFormat::Bc3 => 16,
        // Other BC formats (Bc4/Bc5/Bc6h/Bc7) are unreachable here —
        // `decode_tex` only calls us with Bc1/Bc3, `decode_dds` with
        // Bc1/Bc2/Bc3.
        _ => 16,
    };
    bc_mip_size_at_level(width, height, 0, bytes_per_block)
}

fn bc_mip_size_at_level(width: u32, height: u32, level: u32, bytes_per_block: usize) -> usize {
    let w = (width >> level).max(1);
    let h = (height >> level).max(1);
    let bw = w.div_ceil(4) as usize;
    let bh = h.div_ceil(4) as usize;
    bw * bh * bytes_per_block
}

// ── Pixel utilities ─────────────────────────────────────────────────

fn swizzle_bgra8_to_rgba(bgra: &[u8]) -> Vec<u8> {
    let mut out = vec![0u8; bgra.len()];
    for chunk in bgra.chunks_exact(4).enumerate() {
        let (i, c) = chunk;
        let off = i * 4;
        out[off] = c[2];     // R ← B
        out[off + 1] = c[1]; // G
        out[off + 2] = c[0]; // B ← R
        out[off + 3] = c[3]; // A
    }
    out
}

fn scan_has_alpha(rgba: &[u8]) -> bool {
    // Every 4th byte is alpha. Terminating early on first non-255
    // hit means most opaque textures cost ~one cache line to scan.
    rgba.iter().skip(3).step_by(4).any(|&a| a < 255)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_too_short() {
        assert!(decode_auto(&[]).is_err());
        assert!(decode_auto(&[1, 2, 3]).is_err());
    }

    #[test]
    fn dispatches_dds_vs_tex() {
        // Both should fail with their *header* errors (not the magic
        // dispatcher), which is what we're testing.
        let dds_stub = b"DDS \0\0\0\0";
        assert!(matches!(
            decode_auto(dds_stub),
            Err(MeshError::Malformed(_))
        ));
        let tex_stub = b"TEX\0\0\0\0\0";
        assert!(matches!(
            decode_auto(tex_stub),
            Err(MeshError::Malformed(_))
        ));
    }

    #[test]
    fn bgra_swizzle_is_correct() {
        let bgra = [10, 20, 30, 40, 50, 60, 70, 80];
        let rgba = swizzle_bgra8_to_rgba(&bgra);
        assert_eq!(rgba, [30, 20, 10, 40, 70, 60, 50, 80]);
    }

    #[test]
    fn alpha_scan_finds_transparency() {
        let opaque = [10, 20, 30, 255, 40, 50, 60, 255];
        assert!(!scan_has_alpha(&opaque));
        let transparent = [10, 20, 30, 255, 40, 50, 60, 100];
        assert!(scan_has_alpha(&transparent));
    }

    #[test]
    fn mipmap_count_correct() {
        assert_eq!(mipmap_count(1024, 1024), 11);
        assert_eq!(mipmap_count(512, 512), 10);
        assert_eq!(mipmap_count(1, 1), 1);
        assert_eq!(mipmap_count(8, 4), 4);
    }
}
