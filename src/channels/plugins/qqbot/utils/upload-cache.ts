/**
 * Upload cache -借鉴 Telegram file_id 机制
 *
 * After QQ Bot API uploads a file, it returns file_info + ttl. Within TTL,
 * the same file can be reused directly via file_info to avoid re-uploading,
 * saving bandwidth and time.
 *
 * Cache key = md5(fileContent) + targetType(c2c/group) + targetId + fileType
 */

import * as crypto from 'node:crypto';

interface CacheEntry {
  fileInfo: string;
  fileUuid: string;
  /** Expiration timestamp (ms), expires 60 seconds before API TTL */
  expiresAt: number;
}

// In-memory cache, key format: `${contentHash}:${scope}:${targetId}:${fileType}`
const cache = new Map<string, CacheEntry>();

// Maximum cache entries to prevent memory leaks
const MAX_CACHE_SIZE = 500;

/**
 * Compute MD5 hash of file content (for cache key)
 * For Base64 data, hash directly; for file paths, read then hash
 */
export function computeFileHash(data: string | Buffer): string {
  const content = typeof data === 'string' ? data : data;
  return crypto.createHash('md5').update(content).digest('hex');
}

/**
 * Build cache key
 * @param contentHash - File content hash
 * @param scope - "c2c" | "group"
 * @param targetId - User openid or group openid
 * @param fileType - 1=IMAGE, 2=VIDEO, 3=VOICE, 4=FILE
 */
function buildCacheKey(contentHash: string, scope: string, targetId: string, fileType: number): string {
  return `${contentHash}:${scope}:${targetId}:${fileType}`;
}

/**
 * Get file_info from cache
 * @returns file_info string, returns null on miss or expiration
 */
export function getCachedFileInfo(contentHash: string, scope: 'c2c' | 'group', targetId: string, fileType: number): string | null {
  const key = buildCacheKey(contentHash, scope, targetId, fileType);
  const entry = cache.get(key);

  if (!entry) return null;

  // Check expiration
  if (Date.now() >= entry.expiresAt) {
    cache.delete(key);
    return null;
  }

  console.log(`[upload-cache] Cache HIT: key=${key.slice(0, 40)}..., fileUuid=${entry.fileUuid}`);
  return entry.fileInfo;
}

/**
 * Write upload result to cache
 * @param ttl - API returned TTL (seconds), cache expires 60 seconds earlier
 */
export function setCachedFileInfo(contentHash: string, scope: 'c2c' | 'group', targetId: string, fileType: number, fileInfo: string, fileUuid: string, ttl: number): void {
  // Lazy cleanup of expired entries
  if (cache.size >= MAX_CACHE_SIZE) {
    const now = Date.now();
    for (const [k, v] of Array.from(cache.entries())) {
      if (now >= v.expiresAt) {
        cache.delete(k);
      }
    }
    // If still over limit after cleanup, delete earliest half
    if (cache.size >= MAX_CACHE_SIZE) {
      const keys = Array.from(cache.keys());
      for (let i = 0; i < keys.length / 2; i++) {
        cache.delete(keys[i]!);
      }
    }
  }

  const key = buildCacheKey(contentHash, scope, targetId, fileType);
  // Expire 60 seconds early to avoid edge case expiration
  const safetyMargin = 60;
  const effectiveTtl = Math.max(ttl - safetyMargin, 10);

  cache.set(key, {
    fileInfo,
    fileUuid,
    expiresAt: Date.now() + effectiveTtl * 1000,
  });

  console.log(`[upload-cache] Cache SET: key=${key.slice(0, 40)}..., ttl=${effectiveTtl}s, uuid=${fileUuid}`);
}

/**
 * Get cache statistics
 */
export function getUploadCacheStats(): { size: number; maxSize: number } {
  return { size: cache.size, maxSize: MAX_CACHE_SIZE };
}

/**
 * Clear all cache
 */
export function clearUploadCache(): void {
  cache.clear();
  console.log(`[upload-cache] Cache cleared`);
}
