/**
 * Image size utilities
 * Used to get image dimensions, generate QQBot markdown image format
 *
 * QQBot markdown image format: ![#widthpx #heightpx](url)
 */

import { Buffer } from 'buffer';

export interface ImageSize {
  width: number;
  height: number;
}

/** Default image size (used when unable to determine) */
export const DEFAULT_IMAGE_SIZE: ImageSize = { width: 512, height: 512 };

/**
 * Parse image size from PNG file header
 * PNG file header: first 8 bytes are signature, IHDR chunk starts at byte 8
 * IHDR chunk: length(4) + type(4, "IHDR") + width(4) + height(4) + ...
 */
function parsePngSize(buffer: Buffer): ImageSize | null {
  // PNG signature: 89 50 4E 47 0D 0A 1A 0A
  if (buffer.length < 24) return null;
  if (buffer[0] !== 0x89 || buffer[1] !== 0x50 || buffer[2] !== 0x4e || buffer[3] !== 0x47) {
    return null;
  }
  // IHDR chunk starts at byte 8, width at bytes 16-19, height at bytes 20-23
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  return { width, height };
}

/**
 * Parse image size from JPEG file
 * JPEG dimensions are in SOF0/SOF2 blocks
 */
function parseJpegSize(buffer: Buffer): ImageSize | null {
  // JPEG signature: FF D8 FF
  if (buffer.length < 4) return null;
  if (buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    return null;
  }

  let offset = 2;
  while (offset < buffer.length - 9) {
    if (buffer[offset] !== 0xff) {
      offset++;
      continue;
    }

    const marker = buffer[offset + 1];
    // SOF0 (0xC0) or SOF2 (0xC2) contains image dimensions
    if (marker === 0xc0 || marker === 0xc2) {
      // Format: FF C0 length(2) precision(1) height(2) width(2)
      if (offset + 9 <= buffer.length) {
        const height = buffer.readUInt16BE(offset + 5);
        const width = buffer.readUInt16BE(offset + 7);
        return { width, height };
      }
    }

    // Skip current block
    if (offset + 3 < buffer.length) {
      const blockLength = buffer.readUInt16BE(offset + 2);
      offset += 2 + blockLength;
    } else {
      break;
    }
  }

  return null;
}

/**
 * Parse image size from GIF file header
 * GIF header: GIF87a or GIF89a (6 bytes) + width(2) + height(2)
 */
function parseGifSize(buffer: Buffer): ImageSize | null {
  if (buffer.length < 10) return null;
  const signature = buffer.toString('ascii', 0, 6);
  if (signature !== 'GIF87a' && signature !== 'GIF89a') {
    return null;
  }
  const width = buffer.readUInt16LE(6);
  const height = buffer.readUInt16LE(8);
  return { width, height };
}

/**
 * Parse image size from WebP file
 * WebP header: RIFF(4) + file size(4) + WEBP(4) + VP8/VP8L/VP8X(4) + ...
 */
function parseWebpSize(buffer: Buffer): ImageSize | null {
  if (buffer.length < 30) return null;

  // Check RIFF and WEBP signatures
  const riff = buffer.toString('ascii', 0, 4);
  const webp = buffer.toString('ascii', 8, 12);
  if (riff !== 'RIFF' || webp !== 'WEBP') {
    return null;
  }

  const chunkType = buffer.toString('ascii', 12, 16);

  // VP8 (lossy compression)
  if (chunkType === 'VP8 ') {
    // VP8 frame header starts at byte 23, check signature 9D 01 2A
    if (buffer.length >= 30 && buffer[23] === 0x9d && buffer[24] === 0x01 && buffer[25] === 0x2a) {
      const width = buffer.readUInt16LE(26) & 0x3fff;
      const height = buffer.readUInt16LE(28) & 0x3fff;
      return { width, height };
    }
  }

  // VP8L (lossless compression)
  if (chunkType === 'VP8L') {
    // VP8L signature: 0x2F
    if (buffer.length >= 25 && buffer[20] === 0x2f) {
      const bits = buffer.readUInt32LE(21);
      const width = (bits & 0x3fff) + 1;
      const height = ((bits >> 14) & 0x3fff) + 1;
      return { width, height };
    }
  }

  // VP8X (extended format)
  if (chunkType === 'VP8X') {
    if (buffer.length >= 30) {
      // Width and height at bytes 24-26 and 27-29 (24-bit little-endian)
      const width = (buffer[24] | (buffer[25] << 8) | (buffer[26] << 16)) + 1;
      const height = (buffer[27] | (buffer[28] << 8) | (buffer[29] << 16)) + 1;
      return { width, height };
    }
  }

  return null;
}

/**
 * Parse image size from image data Buffer
 */
export function parseImageSize(buffer: Buffer): ImageSize | null {
  // Try various formats
  return parsePngSize(buffer) ?? parseJpegSize(buffer) ?? parseGifSize(buffer) ?? parseWebpSize(buffer);
}

/**
 * Get image size from public URL
 * Only downloads first 64KB, enough to parse most image format headers
 */
export async function getImageSizeFromUrl(url: string, timeoutMs = 5000): Promise<ImageSize | null> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    // Use Range request to get only first 64KB
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Range: 'bytes=0-65535',
        'User-Agent': 'QQBot-Image-Size-Detector/1.0',
      },
    });

    clearTimeout(timeoutId);

    if (!response.ok && response.status !== 206) {
      console.log(`[image-size] Failed to fetch ${url}: ${response.status}`);
      return null;
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const size = parseImageSize(buffer);
    if (size) {
      console.log(`[image-size] Got size from URL: ${size.width}x${size.height} - ${url.slice(0, 60)}...`);
    }

    return size;
  } catch (err) {
    console.log(`[image-size] Error fetching ${url.slice(0, 60)}...: ${err}`);
    return null;
  }
}

/**
 * Get image size from Base64 Data URL
 */
export function getImageSizeFromDataUrl(dataUrl: string): ImageSize | null {
  try {
    // Format: data:image/png;base64,xxxxx
    const matches = dataUrl.match(/^data:image\/[^;]+;base64,(.+)$/);
    if (!matches) {
      return null;
    }

    const base64Data = matches[1];
    const buffer = Buffer.from(base64Data, 'base64');

    const size = parseImageSize(buffer);
    if (size) {
      console.log(`[image-size] Got size from Base64: ${size.width}x${size.height}`);
    }

    return size;
  } catch (err) {
    console.log(`[image-size] Error parsing Base64: ${err}`);
    return null;
  }
}

/**
 * Get image size (auto-detect source)
 * @param source - Image URL or Base64 Data URL
 * @returns Image size, or null if failed
 */
export async function getImageSize(source: string): Promise<ImageSize | null> {
  if (source.startsWith('data:')) {
    return getImageSizeFromDataUrl(source);
  }

  if (source.startsWith('http://') || source.startsWith('https://')) {
    return getImageSizeFromUrl(source);
  }

  return null;
}

/**
 * Generate QQBot markdown image format
 * Format: ![#widthpx #heightpx](url)
 *
 * @param url - Image URL
 * @param size - Image size, uses default size if null
 * @returns QQBot markdown image string
 */
export function formatQQBotMarkdownImage(url: string, size: ImageSize | null): string {
  const { width, height } = size ?? DEFAULT_IMAGE_SIZE;
  return `![#${width}px #${height}px](${url})`;
}

/**
 * Check if markdown image already contains QQBot format size info
 * Format: ![#widthpx #heightpx](url)
 */
export function hasQQBotImageSize(markdownImage: string): boolean {
  return /!\[#\d+px\s+#\d+px\]/.test(markdownImage);
}

/**
 * Extract size from existing QQBot format markdown image
 * Format: ![#widthpx #heightpx](url)
 */
export function extractQQBotImageSize(markdownImage: string): ImageSize | null {
  const match = markdownImage.match(/!\[#(\d+)px\s+#(\d+)px\]/);
  if (match) {
    return { width: parseInt(match[1], 10), height: parseInt(match[2], 10) };
  }
  return null;
}
