/**
 * File operation utilities - async read + size validation
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** QQ Bot API max upload file size: 20MB */
export const MAX_UPLOAD_SIZE = 20 * 1024 * 1024;

/** Large file threshold (show progress for files larger than this): 5MB */
export const LARGE_FILE_THRESHOLD = 5 * 1024 * 1024;

/**
 * File size validation result
 */
export interface FileSizeCheckResult {
  ok: boolean;
  size: number;
  error?: string;
}

/**
 * Validate file size is within upload limit
 * @param filePath - File path
 * @param maxSize - Max allowed size in bytes, default 20MB
 */
export function checkFileSize(filePath: string, maxSize = MAX_UPLOAD_SIZE): FileSizeCheckResult {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > maxSize) {
      const sizeMB = (stat.size / (1024 * 1024)).toFixed(1);
      const limitMB = (maxSize / (1024 * 1024)).toFixed(0);
      return {
        ok: false,
        size: stat.size,
        error: `File too large (${sizeMB}MB), QQ Bot API upload limit is ${limitMB}MB`,
      };
    }
    return { ok: true, size: stat.size };
  } catch (err) {
    return {
      ok: false,
      size: 0,
      error: `Cannot read file info: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Async read file content
 * Alternative to fs.readFileSync, avoids blocking event loop
 */
export async function readFileAsync(filePath: string): Promise<Buffer> {
  return fs.promises.readFile(filePath);
}

/**
 * Async check if file exists
 */
export async function fileExistsAsync(filePath: string): Promise<boolean> {
  try {
    await fs.promises.access(filePath, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Async get file size
 */
export async function getFileSizeAsync(filePath: string): Promise<number> {
  const stat = await fs.promises.stat(filePath);
  return stat.size;
}

/**
 * Determine if file is "large" (needs progress indicator)
 */
export function isLargeFile(sizeBytes: number): boolean {
  return sizeBytes >= LARGE_FILE_THRESHOLD;
}

/**
 * Format file size to human-readable string
 */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * Get MIME type based on file extension
 */
export function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const mimeTypes: Record<string, string> = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.avi': 'video/x-msvideo',
    '.mkv': 'video/x-matroska',
    '.webm': 'video/webm',
    '.pdf': 'application/pdf',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.zip': 'application/zip',
    '.tar': 'application/x-tar',
    '.gz': 'application/gzip',
    '.txt': 'text/plain',
  };
  return mimeTypes[ext] ?? 'application/octet-stream';
}
