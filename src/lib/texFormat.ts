/**
 * League of Legends .tex file format handler
 * TypeScript port of Quartz-main/src/filetypes/texFormat.js
 */

export const TEXFormat = {
  ETC1: 1,
  ETC2_EAC: 2,
  ETC2: 3,
  DXT1: 10,
  DXT5: 12,
  // Patch 16.10+ — BC7 sRGB atlases + BC5 normal maps. The Rust
  // decoder handles these via texture2ddecoder; the TS path here
  // doesn't (BC7 in particular is a substantial port), so it falls
  // through to the "Unknown" branch and the preview pane reports
  // the format name only.
  BC7: 13,
  BC5: 14,
  BGRA8: 20
} as const;

export type TEXFormatValue = typeof TEXFormat[keyof typeof TEXFormat];

export interface TEXData {
  width: number;
  height: number;
  format: TEXFormatValue;
  mipmaps: boolean;
  data: Uint8Array[];
}

export function readTEX(buffer: ArrayBuffer): TEXData {
  const view = new DataView(buffer);
  let offset = 0;

  const signature = view.getUint32(offset, true);
  offset += 4;

  if (signature !== 0x00584554) {
    throw new Error(`Invalid .tex file signature: 0x${signature.toString(16)}`);
  }

  const width = view.getUint16(offset, true);
  offset += 2;
  const height = view.getUint16(offset, true);
  offset += 2;

  view.getUint8(offset++); // unknown1
  const format = view.getUint8(offset++) as TEXFormatValue;
  view.getUint8(offset++); // unknown2
  const mipmaps = view.getUint8(offset++) !== 0;

  const dataArray: Uint8Array[] = [];

  if (mipmaps && (format === TEXFormat.DXT1 || format === TEXFormat.DXT5 || format === TEXFormat.BGRA8)) {
    const maxDim = Math.max(width, height);
    const mipmapCount = Math.floor(Math.log2(maxDim)) + 1;

    let blockSize: number, bytesPerBlock: number;
    if (format === TEXFormat.DXT1) {
      blockSize = 4;
      bytesPerBlock = 8;
    } else if (format === TEXFormat.DXT5) {
      blockSize = 4;
      bytesPerBlock = 16;
    } else {
      blockSize = 1;
      bytesPerBlock = 4;
    }

    for (let i = mipmapCount - 1; i >= 0; i--) {
      const currentWidth = Math.max(Math.floor(width / (1 << i)), 1);
      const currentHeight = Math.max(Math.floor(height / (1 << i)), 1);
      const blockWidth = Math.floor((currentWidth + blockSize - 1) / blockSize);
      const blockHeight = Math.floor((currentHeight + blockSize - 1) / blockSize);
      const currentSize = bytesPerBlock * blockWidth * blockHeight;

      const dataChunk = new Uint8Array(buffer, offset, currentSize);
      dataArray.push(dataChunk);
      offset += currentSize;
    }
  } else {
    const remainingData = new Uint8Array(buffer, offset);
    dataArray.push(remainingData);
  }

  return { width, height, format, mipmaps, data: dataArray };
}

function decompressDXT1Block(
  blockData: Uint8Array,
  x: number, y: number,
  width: number, height: number,
  pixels: Uint8Array
): void {
  if (blockData.length < 8) return;
  const view = new DataView(blockData.buffer, blockData.byteOffset, 8);
  const color0 = view.getUint16(0, true);
  const color1 = view.getUint16(2, true);
  const bits = view.getUint32(4, true);

  const r0 = ((color0 >> 11) & 0x1F) << 3;
  const g0 = ((color0 >> 5) & 0x3F) << 2;
  const b0 = (color0 & 0x1F) << 3;
  const r1 = ((color1 >> 11) & 0x1F) << 3;
  const g1 = ((color1 >> 5) & 0x3F) << 2;
  const b1 = (color1 & 0x1F) << 3;

  const colors: [number, number, number, number][] = [
    [r0, g0, b0, 255],
    [r1, g1, b1, 255],
    color0 > color1
      ? [Math.floor((r0 * 2 + r1) / 3), Math.floor((g0 * 2 + g1) / 3), Math.floor((b0 * 2 + b1) / 3), 255]
      : [Math.floor((r0 + r1) / 2), Math.floor((g0 + g1) / 2), Math.floor((b0 + b1) / 2), 255],
    color0 > color1
      ? [Math.floor((r0 + r1 * 2) / 3), Math.floor((g0 + g1 * 2) / 3), Math.floor((b0 + b1 * 2) / 3), 255]
      : [0, 0, 0, 0]
  ];

  for (let py = 0; py < 4; py++) {
    for (let px = 0; px < 4; px++) {
      if (x + px < width && y + py < height) {
        const idx = py * 4 + px;
        const colorIdx = (bits >> (idx * 2)) & 3;
        const pixelIdx = ((y + py) * width + (x + px)) * 4;
        const color = colors[colorIdx];
        pixels[pixelIdx] = color[0];
        pixels[pixelIdx + 1] = color[1];
        pixels[pixelIdx + 2] = color[2];
        pixels[pixelIdx + 3] = color[3];
      }
    }
  }
}

function decompressDXT3Block(
  blockData: Uint8Array,
  x: number, y: number,
  width: number, height: number,
  pixels: Uint8Array
): void {
  if (blockData.length < 16) return;
  const view = new DataView(blockData.buffer, blockData.byteOffset, 16);

  // Bytes 0..7: 16 explicit 4-bit alpha values, row-major.
  const alphas: number[] = new Array(16);
  for (let i = 0; i < 8; i++) {
    const b = view.getUint8(i);
    const a0 = b & 0x0F;
    const a1 = (b >> 4) & 0x0F;
    alphas[i * 2] = (a0 << 4) | a0;
    alphas[i * 2 + 1] = (a1 << 4) | a1;
  }

  // Bytes 8..15: DXT1-style color block, but always 4-color (no 1-bit-alpha branch).
  const color0 = view.getUint16(8, true);
  const color1 = view.getUint16(10, true);
  const bits = view.getUint32(12, true);

  const r0 = ((color0 >> 11) & 0x1F) << 3;
  const g0 = ((color0 >> 5) & 0x3F) << 2;
  const b0 = (color0 & 0x1F) << 3;
  const r1 = ((color1 >> 11) & 0x1F) << 3;
  const g1 = ((color1 >> 5) & 0x3F) << 2;
  const b1 = (color1 & 0x1F) << 3;

  const colors: [number, number, number][] = [
    [r0, g0, b0],
    [r1, g1, b1],
    [Math.floor((r0 * 2 + r1) / 3), Math.floor((g0 * 2 + g1) / 3), Math.floor((b0 * 2 + b1) / 3)],
    [Math.floor((r0 + r1 * 2) / 3), Math.floor((g0 + g1 * 2) / 3), Math.floor((b0 + b1 * 2) / 3)]
  ];

  for (let py = 0; py < 4; py++) {
    for (let px = 0; px < 4; px++) {
      if (x + px < width && y + py < height) {
        const idx = py * 4 + px;
        const colorIdx = (bits >> (idx * 2)) & 3;
        const pixelIdx = ((y + py) * width + (x + px)) * 4;
        const color = colors[colorIdx];
        pixels[pixelIdx] = color[0];
        pixels[pixelIdx + 1] = color[1];
        pixels[pixelIdx + 2] = color[2];
        pixels[pixelIdx + 3] = alphas[idx];
      }
    }
  }
}

function decompressDXT5Block(
  blockData: Uint8Array,
  x: number, y: number,
  width: number, height: number,
  pixels: Uint8Array
): void {
  if (blockData.length < 16) return;
  const view = new DataView(blockData.buffer, blockData.byteOffset, 16);

  const alpha0 = view.getUint8(0);
  const alpha1 = view.getUint8(1);

  let alphaBits = 0n;
  for (let i = 0; i < 6; i++) {
    alphaBits |= BigInt(view.getUint8(2 + i)) << BigInt(i * 8);
  }

  const alphas: number[] = [alpha0, alpha1];
  if (alpha0 > alpha1) {
    for (let i = 1; i < 7; i++) {
      alphas.push(Math.floor(((7 - i) * alpha0 + i * alpha1) / 7));
    }
  } else {
    for (let i = 1; i < 5; i++) {
      alphas.push(Math.floor(((5 - i) * alpha0 + i * alpha1) / 5));
    }
    alphas.push(0, 255);
  }

  const color0 = view.getUint16(8, true);
  const color1 = view.getUint16(10, true);
  const colorBits = view.getUint32(12, true);

  const r0 = ((color0 >> 11) & 0x1F) << 3;
  const g0 = ((color0 >> 5) & 0x3F) << 2;
  const b0 = (color0 & 0x1F) << 3;
  const r1 = ((color1 >> 11) & 0x1F) << 3;
  const g1 = ((color1 >> 5) & 0x3F) << 2;
  const b1 = (color1 & 0x1F) << 3;

  const colors: [number, number, number][] = [
    [r0, g0, b0],
    [r1, g1, b1],
    [Math.floor((r0 * 2 + r1) / 3), Math.floor((g0 * 2 + g1) / 3), Math.floor((b0 * 2 + b1) / 3)],
    [Math.floor((r0 + r1 * 2) / 3), Math.floor((g0 + g1 * 2) / 3), Math.floor((b0 + b1 * 2) / 3)]
  ];

  for (let py = 0; py < 4; py++) {
    for (let px = 0; px < 4; px++) {
      if (x + px < width && y + py < height) {
        const idx = py * 4 + px;
        const alphaIdx = Number((alphaBits >> BigInt(idx * 3)) & 7n);
        const colorIdx = (colorBits >> (idx * 2)) & 3;
        const pixelIdx = ((y + py) * width + (x + px)) * 4;
        const color = colors[colorIdx];
        pixels[pixelIdx] = color[0];
        pixels[pixelIdx + 1] = color[1];
        pixels[pixelIdx + 2] = color[2];
        pixels[pixelIdx + 3] = alphas[alphaIdx];
      }
    }
  }
}

export function decompressTEX(tex: TEXData): Uint8Array {
  const { width, height, format, mipmaps, data } = tex;
  const pixels = new Uint8Array(width * height * 4);
  const textureData = (mipmaps && data.length > 1) ? data[data.length - 1] : data[0];

  if (format === TEXFormat.BGRA8) {
    for (let i = 0; i < textureData.length; i += 4) {
      pixels[i] = textureData[i + 2];
      pixels[i + 1] = textureData[i + 1];
      pixels[i + 2] = textureData[i];
      pixels[i + 3] = textureData[i + 3];
    }
  } else if (format === TEXFormat.DXT1) {
    const blockSize = 8;
    const blockWidth = Math.floor((width + 3) / 4);
    const blockHeight = Math.floor((height + 3) / 4);
    for (let by = 0; by < blockHeight; by++) {
      for (let bx = 0; bx < blockWidth; bx++) {
        const blockIdx = (by * blockWidth + bx) * blockSize;
        if (blockIdx + blockSize <= textureData.length) {
          decompressDXT1Block(textureData.subarray(blockIdx, blockIdx + blockSize), bx * 4, by * 4, width, height, pixels);
        }
      }
    }
  } else if (format === TEXFormat.DXT5) {
    const blockSize = 16;
    const blockWidth = Math.floor((width + 3) / 4);
    const blockHeight = Math.floor((height + 3) / 4);
    for (let by = 0; by < blockHeight; by++) {
      for (let bx = 0; bx < blockWidth; bx++) {
        const blockIdx = (by * blockWidth + bx) * blockSize;
        if (blockIdx + blockSize <= textureData.length) {
          decompressDXT5Block(textureData.subarray(blockIdx, blockIdx + blockSize), bx * 4, by * 4, width, height, pixels);
        }
      }
    }
  } else {
    throw new Error(`Unsupported texture format: ${format}`);
  }

  return pixels;
}

// ── DDS file support ────────────────────────────────────────────────

const DDS_MAGIC = 0x20534444; // "DDS "
const FOURCC_DXT1 = 0x31545844; // "DXT1"
const FOURCC_DXT3 = 0x33545844; // "DXT3"
const FOURCC_DXT5 = 0x35545844; // "DXT5"
const DDPF_FOURCC = 0x4;
const DDPF_RGB = 0x40;
const DDPF_ALPHAPIXELS = 0x1;

type DDSFormat = 'DXT1' | 'DXT3' | 'DXT5' | 'BGRA8' | 'RGBA8';

interface DDSData {
  width: number;
  height: number;
  format: DDSFormat;
  data: Uint8Array; // largest mip only
}

export function readDDS(buffer: ArrayBuffer): DDSData {
  const view = new DataView(buffer);

  if (view.getUint32(0, true) !== DDS_MAGIC) {
    throw new Error('Invalid DDS file signature');
  }

  // DDS_HEADER at offset 4
  const height = view.getUint32(12, true);
  const width = view.getUint32(16, true);

  // DDS_PIXELFORMAT at offset 76
  const pfFlags = view.getUint32(80, true);
  const fourCC = view.getUint32(84, true);
  const rgbBitCount = view.getUint32(88, true);
  const rMask = view.getUint32(92, true);

  let format: DDSFormat;
  let bytesPerBlock: number;
  let blockDim = 4; // DXT block dimension

  if (pfFlags & DDPF_FOURCC) {
    if (fourCC === FOURCC_DXT1) { format = 'DXT1'; bytesPerBlock = 8; }
    else if (fourCC === FOURCC_DXT3) { format = 'DXT3'; bytesPerBlock = 16; }
    else if (fourCC === FOURCC_DXT5) { format = 'DXT5'; bytesPerBlock = 16; }
    else throw new Error(`Unsupported DDS FourCC: 0x${fourCC.toString(16)}`);
  } else if ((pfFlags & (DDPF_RGB | DDPF_ALPHAPIXELS)) && rgbBitCount === 32) {
    // Uncompressed 32-bit — check channel order from masks
    format = rMask === 0x00FF0000 ? 'BGRA8' : 'RGBA8';
    bytesPerBlock = 4;
    blockDim = 1;
  } else if ((pfFlags & DDPF_RGB) && rgbBitCount === 32) {
    format = rMask === 0x00FF0000 ? 'BGRA8' : 'RGBA8';
    bytesPerBlock = 4;
    blockDim = 1;
  } else {
    throw new Error(`Unsupported DDS pixel format (flags=0x${pfFlags.toString(16)}, bpp=${rgbBitCount})`);
  }

  // Pixel data starts at offset 128. DDS stores largest mip first — we only need mip 0.
  const dataOffset = 128;
  const bw = Math.ceil(width / blockDim);
  const bh = Math.ceil(height / blockDim);
  const mip0Size = bytesPerBlock * bw * bh;
  const available = Math.min(mip0Size, buffer.byteLength - dataOffset);
  const data = new Uint8Array(buffer, dataOffset, available);

  return { width, height, format, data };
}

/** Scan an RGBA pixel buffer to see if any alpha byte is below 255.
 *  Used by the 3D preview pipeline so we can put fully-opaque
 *  textures into Babylon's MATERIAL_OPAQUE bucket (proper depth
 *  occlusion) and only the genuinely-transparent ones into
 *  ALPHATESTANDBLEND (which has the see-through-back-faces tradeoff).
 *  Cheap — `Uint8Array` indexing, terminates on the first hit. */
function hasAnyTransparency(pixels: Uint8Array): boolean {
  for (let i = 3; i < pixels.length; i += 4) {
    if (pixels[i] < 255) return true;
  }
  return false;
}

/** Decompress a DDS buffer into RGBA pixels and return a data URL */
export function ddsBufferToDataURL(buffer: ArrayBuffer, maxDim?: number): { dataURL: string; width: number; height: number; format: number; ddsFormat: string; hasAlpha: boolean } {
  const dds = readDDS(buffer);
  const { width, height, format, data } = dds;
  const pixels = new Uint8Array(width * height * 4);

  if (format === 'DXT1') {
    const blockSize = 8;
    const bw = Math.ceil(width / 4);
    const bh = Math.ceil(height / 4);
    for (let by = 0; by < bh; by++) {
      for (let bx = 0; bx < bw; bx++) {
        const off = (by * bw + bx) * blockSize;
        if (off + blockSize <= data.length) {
          decompressDXT1Block(data.subarray(off, off + blockSize), bx * 4, by * 4, width, height, pixels);
        }
      }
    }
  } else if (format === 'DXT3') {
    const blockSize = 16;
    const bw = Math.ceil(width / 4);
    const bh = Math.ceil(height / 4);
    for (let by = 0; by < bh; by++) {
      for (let bx = 0; bx < bw; bx++) {
        const off = (by * bw + bx) * blockSize;
        if (off + blockSize <= data.length) {
          decompressDXT3Block(data.subarray(off, off + blockSize), bx * 4, by * 4, width, height, pixels);
        }
      }
    }
  } else if (format === 'DXT5') {
    const blockSize = 16;
    const bw = Math.ceil(width / 4);
    const bh = Math.ceil(height / 4);
    for (let by = 0; by < bh; by++) {
      for (let bx = 0; bx < bw; bx++) {
        const off = (by * bw + bx) * blockSize;
        if (off + blockSize <= data.length) {
          decompressDXT5Block(data.subarray(off, off + blockSize), bx * 4, by * 4, width, height, pixels);
        }
      }
    }
  } else if (format === 'BGRA8') {
    for (let i = 0; i < data.length; i += 4) {
      pixels[i] = data[i + 2];     // R <- B
      pixels[i + 1] = data[i + 1]; // G
      pixels[i + 2] = data[i];     // B <- R
      pixels[i + 3] = data[i + 3]; // A
    }
  } else {
    // RGBA8
    pixels.set(data.subarray(0, width * height * 4));
  }

  // Map to TEXFormat number for formatName compatibility
  const fmtNum = format === 'DXT1' ? TEXFormat.DXT1 : format === 'DXT5' ? TEXFormat.DXT5 : format === 'BGRA8' ? TEXFormat.BGRA8 : format === 'DXT3' ? 11 : 0;

  return {
    dataURL: pixelsToDataURL(pixels, width, height, maxDim),
    width,
    height,
    format: fmtNum,
    ddsFormat: format,
    hasAlpha: hasAnyTransparency(pixels),
  };
}

/** Render pixels to a canvas, optionally downscaling if larger than maxDim. Returns PNG data URL. */
function pixelsToDataURL(pixels: Uint8Array, width: number, height: number, maxDim?: number): string {
  const srcCanvas = document.createElement('canvas');
  srcCanvas.width = width;
  srcCanvas.height = height;
  const srcCtx = srcCanvas.getContext('2d')!;
  srcCtx.putImageData(new ImageData(new Uint8ClampedArray(pixels), width, height), 0, 0);

  if (maxDim && (width > maxDim || height > maxDim)) {
    const scale = maxDim / Math.max(width, height);
    const dw = Math.round(width * scale);
    const dh = Math.round(height * scale);
    const dstCanvas = document.createElement('canvas');
    dstCanvas.width = dw;
    dstCanvas.height = dh;
    const dstCtx = dstCanvas.getContext('2d')!;
    dstCtx.drawImage(srcCanvas, 0, 0, dw, dh);
    return dstCanvas.toDataURL('image/png');
  }

  return srcCanvas.toDataURL('image/png');
}

export function ddsFormatName(fmt: string): string {
  switch (fmt) {
    case 'DXT1': return 'DXT1 (BC1)';
    case 'DXT3': return 'DXT3 (BC2)';
    case 'DXT5': return 'DXT5 (BC3)';
    case 'BGRA8': return 'BGRA8';
    case 'RGBA8': return 'RGBA8';
    default: return fmt;
  }
}

export function loadTEXAsImageData(buffer: ArrayBuffer): ImageData {
  const tex = readTEX(buffer);
  const pixels = decompressTEX(tex);
  return new ImageData(new Uint8ClampedArray(pixels), tex.width, tex.height);
}

/** Decode a .tex ArrayBuffer and render it to a canvas, returning a PNG data URL. */
export function texBufferToDataURL(buffer: ArrayBuffer, maxDim?: number): { dataURL: string; width: number; height: number; format: number; hasAlpha: boolean } {
  const tex = readTEX(buffer);
  const pixels = decompressTEX(tex);
  return {
    dataURL: pixelsToDataURL(pixels, tex.width, tex.height, maxDim),
    width: tex.width,
    height: tex.height,
    format: tex.format,
    hasAlpha: hasAnyTransparency(pixels),
  };
}

export function formatName(format: number): string {
  switch (format) {
    case TEXFormat.DXT1: return 'DXT1 (BC1)';
    case TEXFormat.DXT5: return 'DXT5 (BC3)';
    case TEXFormat.BC5: return 'BC5';
    case TEXFormat.BC7: return 'BC7 sRGB';
    case TEXFormat.BGRA8: return 'BGRA8';
    case TEXFormat.ETC1: return 'ETC1';
    case TEXFormat.ETC2_EAC: return 'ETC2 EAC';
    case TEXFormat.ETC2: return 'ETC2';
    default: return `Unknown (${format})`;
  }
}
