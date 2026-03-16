/**
 * QQ Bot Outbound Message Module
 * Handles message sending with reply limits and media tag processing
 * Adapted from QQBot/src/outbound.ts for AionUi
 */

import * as path from 'node:path';
import type { ResolvedQQBotAccount } from './types';
import { getAccessToken, sendC2CMessage, sendChannelMessage, sendGroupMessage, sendProactiveC2CMessage, sendProactiveGroupMessage, sendC2CImageMessage, sendGroupImageMessage, sendC2CFileMessage, sendGroupFileMessage } from './api';

import { normalizeMediaTags } from './utils/media-tags';
import { checkFileSize, readFileAsync, fileExistsAsync, isLargeFile, formatFileSize } from './utils/file-utils';
import { isLocalPath as isLocalFilePath, normalizePath, sanitizeFileName } from './utils/platform';

// ============ Message Reply Limiter ============
// Same message_id can be replied to max 4 times within 1 hour (exceeds 1 hour = must use proactive message)
const MESSAGE_REPLY_LIMIT = 4;
const MESSAGE_REPLY_TTL = 60 * 60 * 1000; // 1 hour

interface MessageReplyRecord {
  count: number;
  firstReplyAt: number;
}

const messageReplyTracker = new Map<string, MessageReplyRecord>();

/** Reply limit check result */
export interface ReplyLimitResult {
  /** Whether passive reply is allowed */
  allowed: boolean;
  /** Remaining passive reply count */
  remaining: number;
  /** Whether need to fallback to proactive message (expired or exceeded limit) */
  shouldFallbackToProactive: boolean;
  /** Fallback reason */
  fallbackReason?: 'expired' | 'limit_exceeded';
  /** Hint message */
  message?: string;
}

/**
 * Check if can reply to this message (limit check)
 * @param messageId Message ID
 * @returns ReplyLimitResult
 */
export function checkMessageReplyLimit(messageId: string): ReplyLimitResult {
  const now = Date.now();
  const record = messageReplyTracker.get(messageId);

  // Cleanup expired records (prevent memory leak)
  if (messageReplyTracker.size > 10000) {
    for (const [id, rec] of messageReplyTracker) {
      if (now - rec.firstReplyAt > MESSAGE_REPLY_TTL) {
        messageReplyTracker.delete(id);
      }
    }
  }

  // New message, first reply
  if (!record) {
    return {
      allowed: true,
      remaining: MESSAGE_REPLY_LIMIT,
      shouldFallbackToProactive: false,
    };
  }

  // Check if exceeded 1 hour (message_id expired)
  if (now - record.firstReplyAt > MESSAGE_REPLY_TTL) {
    // Over 1 hour, passive reply not available, need to fallback to proactive message
    return {
      allowed: false,
      remaining: 0,
      shouldFallbackToProactive: true,
      fallbackReason: 'expired',
      message: `Message exceeded 1 hour validity, will send as proactive message`,
    };
  }

  // Check if exceeded reply limit
  const remaining = MESSAGE_REPLY_LIMIT - record.count;
  if (remaining <= 0) {
    return {
      allowed: false,
      remaining: 0,
      shouldFallbackToProactive: true,
      fallbackReason: 'limit_exceeded',
      message: `Message reached max reply limit (${MESSAGE_REPLY_LIMIT} times within 1 hour), will send as proactive message`,
    };
  }

  return {
    allowed: true,
    remaining,
    shouldFallbackToProactive: false,
  };
}

/**
 * Record a message reply
 * @param messageId Message ID
 */
export function recordMessageReply(messageId: string): void {
  const now = Date.now();
  const record = messageReplyTracker.get(messageId);

  if (!record) {
    messageReplyTracker.set(messageId, { count: 1, firstReplyAt: now });
  } else {
    // Check if expired, if so reset count
    if (now - record.firstReplyAt > MESSAGE_REPLY_TTL) {
      messageReplyTracker.set(messageId, { count: 1, firstReplyAt: now });
    } else {
      record.count++;
    }
  }
  console.log(`[qqbot] recordMessageReply: ${messageId}, count=${messageReplyTracker.get(messageId)?.count}`);
}

/**
 * Get message reply statistics
 */
export function getMessageReplyStats(): { trackedMessages: number; totalReplies: number } {
  let totalReplies = 0;
  for (const record of messageReplyTracker.values()) {
    totalReplies += record.count;
  }
  return { trackedMessages: messageReplyTracker.size, totalReplies };
}

/**
 * Get message reply limit config (for external query)
 */
export function getMessageReplyConfig(): { limit: number; ttlMs: number; ttlHours: number } {
  return {
    limit: MESSAGE_REPLY_LIMIT,
    ttlMs: MESSAGE_REPLY_TTL,
    ttlHours: MESSAGE_REPLY_TTL / (60 * 60 * 1000),
  };
}

export interface OutboundContext {
  to: string;
  text: string;
  accountId?: string | null;
  replyToId?: string | null;
  account: ResolvedQQBotAccount;
}

export interface MediaOutboundContext extends OutboundContext {
  mediaUrl: string;
}

export interface OutboundResult {
  channel: string;
  messageId?: string;
  timestamp?: string | number;
  error?: string;
  /** Outbound message reference index (ext_info.ref_idx), for message reference caching */
  refIdx?: string;
}

/**
 * Parse target address
 * Format:
 *   - openid (32 hex) -> C2C private chat
 *   - group:xxx -> Group chat
 *   - channel:xxx -> Channel
 *   - Pure number -> Channel
 */
function parseTarget(to: string): { type: 'c2c' | 'group' | 'channel'; id: string } {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [qqbot] parseTarget: input=${to}`);

  // Remove qqbot: prefix
  const id = to.replace(/^qqbot:/i, '');

  if (id.startsWith('c2c:')) {
    const userId = id.slice(4);
    if (!userId || userId.length === 0) {
      const error = `Invalid c2c target format: ${to} - missing user ID`;
      console.error(`[${timestamp}] [qqbot] parseTarget: ${error}`);
      throw new Error(error);
    }
    console.log(`[${timestamp}] [qqbot] parseTarget: c2c target, user ID=${userId}`);
    return { type: 'c2c', id: userId };
  }

  if (id.startsWith('group:')) {
    const groupId = id.slice(6);
    if (!groupId || groupId.length === 0) {
      const error = `Invalid group target format: ${to} - missing group ID`;
      console.error(`[${timestamp}] [qqbot] parseTarget: ${error}`);
      throw new Error(error);
    }
    console.log(`[${timestamp}] [qqbot] parseTarget: group target, group ID=${groupId}`);
    return { type: 'group', id: groupId };
  }

  if (id.startsWith('channel:')) {
    const channelId = id.slice(8);
    if (!channelId || channelId.length === 0) {
      const error = `Invalid channel target format: ${to} - missing channel ID`;
      console.error(`[${timestamp}] [qqbot] parseTarget: ${error}`);
      throw new Error(error);
    }
    console.log(`[${timestamp}] [qqbot] parseTarget: channel target, channel ID=${channelId}`);
    return { type: 'channel', id: channelId };
  }

  // Default to c2c (private)
  if (!id || id.length === 0) {
    const error = `Invalid target format: ${to} - empty ID after removing qqbot: prefix`;
    console.error(`[${timestamp}] [qqbot] parseTarget: ${error}`);
    throw new Error(error);
  }

  console.log(`[${timestamp}] [qqbot] parseTarget: default c2c target, ID=${id}`);
  return { type: 'c2c', id };
}

/**
 * Send text message
 * - Has replyToId: passive reply, max 4 times within 1 hour
 * - No replyToId: proactive send, has quota limit (4 times/month/user/group)
 *
 * Note:
 * 1. Proactive message (no replyToId) must have message content, no streaming support
 * 2. When passive reply unavailable (expired or exceeded limit), auto fallback to proactive
 * 3. Support <qqimg>path</qqimg> or <qqimg>path</img> format for image sending
 */
export async function sendText(ctx: OutboundContext): Promise<OutboundResult> {
  const { to, account } = ctx;
  let { text, replyToId } = ctx;
  let fallbackToProactive = false;

  console.log('[qqbot] sendText ctx:', JSON.stringify({ to, text: text?.slice(0, 50), replyToId, accountId: account.accountId }, null, 2));

  // ============ Message Reply Limit Check ============
  // If has replyToId, check if can passive reply
  if (replyToId) {
    const limitCheck = checkMessageReplyLimit(replyToId);

    if (!limitCheck.allowed) {
      // Check if need to fallback to proactive message
      if (limitCheck.shouldFallbackToProactive) {
        console.warn(`[qqbot] sendText: Passive reply unavailable, fallback to proactive message - ${limitCheck.message}`);
        fallbackToProactive = true;
        replyToId = null; // Clear replyToId, use proactive message
      } else {
        // Should not happen, but as fallback
        console.error(`[qqbot] sendText: Message reply limited but no fallback set - ${limitCheck.message}`);
        return {
          channel: 'qqbot',
          error: limitCheck.message,
        };
      }
    } else {
      console.log(`[qqbot] sendText: Message ${replyToId} remaining passive replies: ${limitCheck.remaining}/${MESSAGE_REPLY_LIMIT}`);
    }
  }

  // ============ Media Tag Detection & Processing ============
  // Support four tags:
  //   <qqimg>path</qqimg> or <qqimg>path</img> — Image
  //   <qqvoice>path</qqvoice>                   — Voice
  //   <qqvideo>path or URL</qqvideo>             — Video
  //   <qqfile>path</qqfile>                     — File

  // Preprocess: fix common tag typos and format issues
  text = normalizeMediaTags(text);

  const mediaTagRegex = /<(qqimg|qqvoice|qqvideo|qqfile)>([^<>]+)<\/(?:qqimg|qqvoice|qqvideo|qqfile|img)>/gi;
  const mediaTagMatches = text.match(mediaTagRegex);

  if (mediaTagMatches && mediaTagMatches.length > 0) {
    console.log(`[qqbot] sendText: Detected ${mediaTagMatches.length} media tag(s), processing...`);

    // Build send queue: send in order of actual position in original text
    const sendQueue: Array<{ type: 'text' | 'image' | 'voice' | 'video' | 'file'; content: string }> = [];

    let lastIndex = 0;
    const mediaTagRegexWithIndex = /<(qqimg|qqvoice|qqvideo|qqfile)>([^<>]+)<\/(?:qqimg|qqvoice|qqvideo|qqfile|img)>/gi;
    let match;

    while ((match = mediaTagRegexWithIndex.exec(text)) !== null) {
      // Add text before tag
      const textBefore = text
        .slice(lastIndex, match.index)
        .replace(/\n{3,}/g, '\n\n')
        .trim();
      if (textBefore) {
        sendQueue.push({ type: 'text', content: textBefore });
      }

      const tagName = match[1]!.toLowerCase(); // "qqimg" or "qqvoice" or "qqfile"

      // Strip MEDIA: prefix (may be injected by framework), expand ~ path
      let mediaPath = match[2]?.trim() ?? '';
      if (mediaPath.startsWith('MEDIA:')) {
        mediaPath = mediaPath.slice('MEDIA:'.length);
      }
      mediaPath = normalizePath(mediaPath);

      // Handle path escaping by model
      // 1. Double backslash -> single backslash (Markdown escape)
      mediaPath = mediaPath.replace(/\\\\/g, '\\');

      // 2. Octal escape sequence + UTF-8 double encoding fix
      try {
        const hasOctal = /\\[0-7]{1,3}/.test(mediaPath);
        const hasNonASCII = /[\u0080-\u00FF]/.test(mediaPath);

        if (hasOctal || hasNonASCII) {
          console.log(`[qqbot] sendText: Decoding path with mixed encoding: ${mediaPath}`);

          // Step 1: Convert octal escapes to bytes
          const decoded = mediaPath.replace(/\\([0-7]{1,3})/g, (_: string, octal: string) => {
            return String.fromCharCode(parseInt(octal, 8));
          });

          // Step 2: Extract all bytes (including Latin-1 characters)
          const bytes: number[] = [];
          for (let i = 0; i < decoded.length; i++) {
            const code = decoded.charCodeAt(i);
            if (code <= 0xff) {
              bytes.push(code);
            } else {
              const charBytes = Buffer.from(decoded[i], 'utf8');
              bytes.push(...charBytes);
            }
          }

          // Step 3: Try UTF-8 decode
          const buffer = Buffer.from(bytes);
          const utf8Decoded = buffer.toString('utf8');

          if (!utf8Decoded.includes('\uFFFD') || utf8Decoded.length < decoded.length) {
            mediaPath = utf8Decoded;
            console.log(`[qqbot] sendText: Successfully decoded path: ${mediaPath}`);
          }
        }
      } catch (decodeErr) {
        console.error(`[qqbot] sendText: Path decode error: ${decodeErr}`);
      }

      if (mediaPath) {
        if (tagName === 'qqvoice') {
          sendQueue.push({ type: 'voice', content: mediaPath });
          console.log(`[qqbot] sendText: Found voice path in <qqvoice>: ${mediaPath}`);
        } else if (tagName === 'qqvideo') {
          sendQueue.push({ type: 'video', content: mediaPath });
          console.log(`[qqbot] sendText: Found video URL in <qqvideo>: ${mediaPath}`);
        } else if (tagName === 'qqfile') {
          sendQueue.push({ type: 'file', content: mediaPath });
          console.log(`[qqbot] sendText: Found file path in <qqfile>: ${mediaPath}`);
        } else {
          sendQueue.push({ type: 'image', content: mediaPath });
          console.log(`[qqbot] sendText: Found image path in <qqimg>: ${mediaPath}`);
        }
      }

      lastIndex = match.index + match[0].length;
    }

    // Add text after last tag
    const textAfter = text
      .slice(lastIndex)
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    if (textAfter) {
      sendQueue.push({ type: 'text', content: textAfter });
    }

    console.log(`[qqbot] sendText: Send queue: ${sendQueue.map((item) => item.type).join(' -> ')}`);

    // Send in order
    if (!account.appId || !account.clientSecret) {
      return { channel: 'qqbot', error: 'QQBot not configured (missing appId or clientSecret)' };
    }

    const accessToken = await getAccessToken(account.appId, account.clientSecret);
    const target = parseTarget(to);
    let lastResult: OutboundResult = { channel: 'qqbot' };

    for (const item of sendQueue) {
      try {
        if (item.type === 'text') {
          // Send text
          if (replyToId) {
            // Passive reply
            if (target.type === 'c2c') {
              const result = await sendC2CMessage(accessToken, target.id, item.content, replyToId);
              recordMessageReply(replyToId);
              lastResult = { channel: 'qqbot', messageId: result.id, timestamp: result.timestamp, refIdx: result.ext_info?.ref_idx };
            } else if (target.type === 'group') {
              const result = await sendGroupMessage(accessToken, target.id, item.content, replyToId);
              recordMessageReply(replyToId);
              lastResult = { channel: 'qqbot', messageId: result.id, timestamp: result.timestamp, refIdx: result.ext_info?.ref_idx };
            } else {
              const result = await sendChannelMessage(accessToken, target.id, item.content, replyToId);
              recordMessageReply(replyToId);
              lastResult = { channel: 'qqbot', messageId: result.id, timestamp: result.timestamp, refIdx: (result as unknown as { ext_info?: { ref_idx?: string } }).ext_info?.ref_idx };
            }
          } else {
            // Proactive message
            if (target.type === 'c2c') {
              const result = await sendProactiveC2CMessage(accessToken, target.id, item.content);
              lastResult = { channel: 'qqbot', messageId: result.id, timestamp: result.timestamp, refIdx: (result as unknown as { ext_info?: { ref_idx?: string } }).ext_info?.ref_idx };
            } else if (target.type === 'group') {
              const result = await sendProactiveGroupMessage(accessToken, target.id, item.content);
              lastResult = { channel: 'qqbot', messageId: result.id, timestamp: result.timestamp, refIdx: (result as unknown as { ext_info?: { ref_idx?: string } }).ext_info?.ref_idx };
            } else {
              const result = await sendChannelMessage(accessToken, target.id, item.content);
              lastResult = { channel: 'qqbot', messageId: result.id, timestamp: result.timestamp, refIdx: (result as unknown as { ext_info?: { ref_idx?: string } }).ext_info?.ref_idx };
            }
          }
          console.log(`[qqbot] sendText: Sent text part: ${item.content.slice(0, 30)}...`);
        } else if (item.type === 'image') {
          // Send image
          const imagePath = item.content;
          const isHttpUrl = imagePath.startsWith('http://') || imagePath.startsWith('https://');

          let imageUrl = imagePath;

          // If local file path, read and convert to Base64
          if (!isHttpUrl && !imagePath.startsWith('data:')) {
            if (!(await fileExistsAsync(imagePath))) {
              console.error(`[qqbot] sendText: Image file not found: ${imagePath}`);
              continue;
            }
            // File size check
            const sizeCheck = checkFileSize(imagePath);
            if (!sizeCheck.ok) {
              console.error(`[qqbot] sendText: ${sizeCheck.error}`);
              continue;
            }
            const fileBuffer = await readFileAsync(imagePath);
            const ext = path.extname(imagePath).toLowerCase();
            const mimeTypes: Record<string, string> = {
              '.jpg': 'image/jpeg',
              '.jpeg': 'image/jpeg',
              '.png': 'image/png',
              '.gif': 'image/gif',
              '.webp': 'image/webp',
              '.bmp': 'image/bmp',
            };
            const mimeType = mimeTypes[ext] ?? 'image/png';
            imageUrl = `data:${mimeType};base64,${fileBuffer.toString('base64')}`;
            console.log(`[qqbot] sendText: Converted local image to Base64 (size: ${formatFileSize(fileBuffer.length)})`);
          }

          // Send image
          if (target.type === 'c2c') {
            const result = await sendC2CImageMessage(accessToken, target.id, imageUrl, replyToId ?? undefined, undefined, isHttpUrl ? undefined : imagePath);
            lastResult = { channel: 'qqbot', messageId: result.id, timestamp: result.timestamp };
          } else if (target.type === 'group') {
            const result = await sendGroupImageMessage(accessToken, target.id, imageUrl, replyToId ?? undefined);
            lastResult = { channel: 'qqbot', messageId: result.id, timestamp: result.timestamp };
          } else if (isHttpUrl) {
            // Channel uses Markdown format (only supports public URL)
            const result = await sendChannelMessage(accessToken, target.id, `![](${imagePath})`, replyToId ?? undefined);
            lastResult = { channel: 'qqbot', messageId: result.id, timestamp: result.timestamp };
          }
          console.log(`[qqbot] sendText: Sent image via <qqimg> tag: ${imagePath.slice(0, 60)}...`);
        } else if (item.type === 'voice') {
          // Send voice file
          const voicePath = item.content;

          // Wait for file ready (TTS tool async generation, file may not be written yet)
          const fileSize = await waitForFile(voicePath);
          if (fileSize === 0) {
            console.error(`[qqbot] sendText: Voice file not ready after waiting: ${voicePath}`);
            // Send friendly hint to user
            try {
              if (target.type === 'c2c') {
                await sendC2CMessage(accessToken, target.id, '语音生成失败，请稍后重试', replyToId ?? undefined);
              } else if (target.type === 'group') {
                await sendGroupMessage(accessToken, target.id, '语音生成失败，请稍后重试', replyToId ?? undefined);
              }
            } catch {}
            continue;
          }

          // Convert to SILK format (QQ Bot API voice only supports SILK)
          const silkBase64 = await audioFileToSilkBase64(voicePath);
          if (!silkBase64) {
            const ext = path.extname(voicePath).toLowerCase();
            console.error(`[qqbot] sendText: Voice conversion to SILK failed: ${ext} (${fileSize} bytes)`);
            try {
              if (target.type === 'c2c') {
                await sendC2CMessage(accessToken, target.id, '语音格式转换失败，请稍后重试', replyToId ?? undefined);
              } else if (target.type === 'group') {
                await sendGroupMessage(accessToken, target.id, '语音格式转换失败，请稍后重试', replyToId ?? undefined);
              }
            } catch {}
            continue;
          }
          console.log(`[qqbot] sendText: Voice converted to SILK (${fileSize} bytes)`);

          if (target.type === 'c2c') {
            const result = await sendC2CVoiceMessage(accessToken, target.id, silkBase64, replyToId ?? undefined);
            lastResult = { channel: 'qqbot', messageId: result.id, timestamp: result.timestamp };
          } else if (target.type === 'group') {
            const result = await sendGroupVoiceMessage(accessToken, target.id, silkBase64, replyToId ?? undefined);
            lastResult = { channel: 'qqbot', messageId: result.id, timestamp: result.timestamp };
          } else {
            const result = await sendChannelMessage(accessToken, target.id, `[语音消息暂不支持频道发送]`, replyToId ?? undefined);
            lastResult = { channel: 'qqbot', messageId: result.id, timestamp: result.timestamp };
          }
          console.log(`[qqbot] sendText: Sent voice via <qqvoice> tag: ${voicePath.slice(0, 60)}...`);
        } else if (item.type === 'video') {
          // Send video (support public URL and local file)
          const videoPath = item.content;
          const isHttpUrl = videoPath.startsWith('http://') || videoPath.startsWith('https://');

          if (isHttpUrl) {
            // Public URL
            if (target.type === 'c2c') {
              const result = await sendC2CVideoMessage(accessToken, target.id, videoPath, undefined, replyToId ?? undefined);
              lastResult = { channel: 'qqbot', messageId: result.id, timestamp: result.timestamp };
            } else if (target.type === 'group') {
              const result = await sendGroupVideoMessage(accessToken, target.id, videoPath, undefined, replyToId ?? undefined);
              lastResult = { channel: 'qqbot', messageId: result.id, timestamp: result.timestamp };
            } else {
              const result = await sendChannelMessage(accessToken, target.id, `[视频消息暂不支持频道发送]`, replyToId ?? undefined);
              lastResult = { channel: 'qqbot', messageId: result.id, timestamp: result.timestamp };
            }
          } else {
            // Local file: read as Base64
            if (!(await fileExistsAsync(videoPath))) {
              console.error(`[qqbot] sendText: Video file not found: ${videoPath}`);
              continue;
            }
            const videoSizeCheck = checkFileSize(videoPath);
            if (!videoSizeCheck.ok) {
              console.error(`[qqbot] sendText: ${videoSizeCheck.error}`);
              continue;
            }
            // Large file progress hint
            if (isLargeFile(videoSizeCheck.size)) {
              try {
                const hint = `⏳ 正在上传视频 (${formatFileSize(videoSizeCheck.size)})...`;
                if (target.type === 'c2c') {
                  await sendC2CMessage(accessToken, target.id, hint, replyToId ?? undefined);
                } else if (target.type === 'group') {
                  await sendGroupMessage(accessToken, target.id, hint, replyToId ?? undefined);
                }
              } catch {}
            }
            const fileBuffer = await readFileAsync(videoPath);
            const videoBase64 = fileBuffer.toString('base64');
            console.log(`[qqbot] sendText: Read local video (${formatFileSize(fileBuffer.length)}): ${videoPath}`);

            if (target.type === 'c2c') {
              const result = await sendC2CVideoMessage(accessToken, target.id, undefined, videoBase64, replyToId ?? undefined, undefined, videoPath);
              lastResult = { channel: 'qqbot', messageId: result.id, timestamp: result.timestamp };
            } else if (target.type === 'group') {
              const result = await sendGroupVideoMessage(accessToken, target.id, undefined, videoBase64, replyToId ?? undefined);
              lastResult = { channel: 'qqbot', messageId: result.id, timestamp: result.timestamp };
            } else {
              const result = await sendChannelMessage(accessToken, target.id, `[视频消息暂不支持频道发送]`, replyToId ?? undefined);
              lastResult = { channel: 'qqbot', messageId: result.id, timestamp: result.timestamp };
            }
          }
          console.log(`[qqbot] sendText: Sent video via <qqvideo> tag: ${videoPath.slice(0, 60)}...`);
        } else if (item.type === 'file') {
          // Send file
          const filePath = item.content;
          const isHttpUrl = filePath.startsWith('http://') || filePath.startsWith('https://');
          const fileName = sanitizeFileName(path.basename(filePath));

          if (isHttpUrl) {
            // Public URL: upload directly via url parameter
            if (target.type === 'c2c') {
              const result = await sendC2CFileMessage(accessToken, target.id, undefined, filePath, replyToId ?? undefined, fileName);
              lastResult = { channel: 'qqbot', messageId: result.id, timestamp: result.timestamp };
            } else if (target.type === 'group') {
              const result = await sendGroupFileMessage(accessToken, target.id, undefined, filePath, replyToId ?? undefined, fileName);
              lastResult = { channel: 'qqbot', messageId: result.id, timestamp: result.timestamp };
            } else {
              const result = await sendChannelMessage(accessToken, target.id, `[文件消息暂不支持频道发送]`, replyToId ?? undefined);
              lastResult = { channel: 'qqbot', messageId: result.id, timestamp: result.timestamp };
            }
          } else {
            // Local file: read and convert to Base64 for upload
            if (!(await fileExistsAsync(filePath))) {
              console.error(`[qqbot] sendText: File not found: ${filePath}`);
              continue;
            }
            const fileSizeCheck = checkFileSize(filePath);
            if (!fileSizeCheck.ok) {
              console.error(`[qqbot] sendText: ${fileSizeCheck.error}`);
              continue;
            }
            // Large file progress hint
            if (isLargeFile(fileSizeCheck.size)) {
              try {
                const hint = `⏳ 正在上传文件 ${fileName} (${formatFileSize(fileSizeCheck.size)})...`;
                if (target.type === 'c2c') {
                  await sendC2CMessage(accessToken, target.id, hint, replyToId ?? undefined);
                } else if (target.type === 'group') {
                  await sendGroupMessage(accessToken, target.id, hint, replyToId ?? undefined);
                }
              } catch {}
            }
            const fileBuffer = await readFileAsync(filePath);
            const fileBase64 = fileBuffer.toString('base64');
            console.log(`[qqbot] sendText: Read local file (${formatFileSize(fileBuffer.length)}): ${filePath}`);

            if (target.type === 'c2c') {
              const result = await sendC2CFileMessage(accessToken, target.id, fileBase64, undefined, replyToId ?? undefined, fileName, filePath);
              lastResult = { channel: 'qqbot', messageId: result.id, timestamp: result.timestamp };
            } else if (target.type === 'group') {
              const result = await sendGroupFileMessage(accessToken, target.id, fileBase64, undefined, replyToId ?? undefined, fileName);
              lastResult = { channel: 'qqbot', messageId: result.id, timestamp: result.timestamp };
            } else {
              const result = await sendChannelMessage(accessToken, target.id, `[文件消息暂不支持频道发送]`, replyToId ?? undefined);
              lastResult = { channel: 'qqbot', messageId: result.id, timestamp: result.timestamp };
            }
          }
          console.log(`[qqbot] sendText: Sent file via <qqfile> tag: ${filePath.slice(0, 60)}...`);
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`[qqbot] sendText: Failed to send ${item.type}: ${errMsg}`);
        // Continue sending other items in queue
      }
    }

    return lastResult;
  }

  // ============ Proactive Message Validation ============
  // If proactive message (no replyToId or degraded), must have message content
  if (!replyToId) {
    if (!text || text.trim().length === 0) {
      console.error('[qqbot] sendText error: Proactive message content cannot be empty (text is empty)');
      return {
        channel: 'qqbot',
        error: 'Proactive message must have content (--message parameter cannot be empty)',
      };
    }
    if (fallbackToProactive) {
      console.log(`[qqbot] sendText: [Fallback] Sending proactive message to ${to}, content length: ${text.length}`);
    } else {
      console.log(`[qqbot] sendText: Sending proactive message to ${to}, content length: ${text.length}`);
    }
  }

  if (!account.appId || !account.clientSecret) {
    return { channel: 'qqbot', error: 'QQBot not configured (missing appId or clientSecret)' };
  }

  try {
    const accessToken = await getAccessToken(account.appId, account.clientSecret);
    const target = parseTarget(to);
    console.log('[qqbot] sendText target:', JSON.stringify(target));

    // If no replyToId, use proactive send API
    if (!replyToId) {
      let outResult: OutboundResult;
      if (target.type === 'c2c') {
        const result = await sendProactiveC2CMessage(accessToken, target.id, text);
        outResult = { channel: 'qqbot', messageId: result.id, timestamp: result.timestamp, refIdx: (result as unknown as { ext_info?: { ref_idx?: string } }).ext_info?.ref_idx };
      } else if (target.type === 'group') {
        const result = await sendProactiveGroupMessage(accessToken, target.id, text);
        outResult = { channel: 'qqbot', messageId: result.id, timestamp: result.timestamp, refIdx: (result as unknown as { ext_info?: { ref_idx?: string } }).ext_info?.ref_idx };
      } else {
        // Channel doesn't support proactive message yet
        const result = await sendChannelMessage(accessToken, target.id, text);
        outResult = { channel: 'qqbot', messageId: result.id, timestamp: result.timestamp, refIdx: (result as unknown as { ext_info?: { ref_idx?: string } }).ext_info?.ref_idx };
      }
      return outResult;
    }

    // Has replyToId, use passive reply API
    if (target.type === 'c2c') {
      const result = await sendC2CMessage(accessToken, target.id, text, replyToId);
      // Record reply count
      recordMessageReply(replyToId);
      return { channel: 'qqbot', messageId: result.id, timestamp: result.timestamp, refIdx: result.ext_info?.ref_idx };
    } else if (target.type === 'group') {
      const result = await sendGroupMessage(accessToken, target.id, text, replyToId);
      // Record reply count
      recordMessageReply(replyToId);
      return { channel: 'qqbot', messageId: result.id, timestamp: result.timestamp, refIdx: result.ext_info?.ref_idx };
    } else {
      const result = await sendChannelMessage(accessToken, target.id, text, replyToId);
      // Record reply count
      recordMessageReply(replyToId);
      return { channel: 'qqbot', messageId: result.id, timestamp: result.timestamp, refIdx: (result as unknown as { ext_info?: { ref_idx?: string } }).ext_info?.ref_idx };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { channel: 'qqbot', error: message };
  }
}

/**
 * Send proactive message (no replyToId needed, has quota limit: 4 times/month/user/group)
 *
 * @param account - Account config
 * @param to - Target address, format: openid (C2C) or group:xxx (group)
 * @param text - Message content
 */
export async function sendProactiveMessage(account: ResolvedQQBotAccount, to: string, text: string): Promise<OutboundResult> {
  const timestamp = new Date().toISOString();

  if (!account.appId || !account.clientSecret) {
    const errorMsg = 'QQBot not configured (missing appId or clientSecret)';
    console.error(`[${timestamp}] [qqbot] sendProactiveMessage: ${errorMsg}`);
    return { channel: 'qqbot', error: errorMsg };
  }

  console.log(`[${timestamp}] [qqbot] sendProactiveMessage: starting, to=${to}, text length=${text.length}, accountId=${account.accountId}`);

  try {
    console.log(`[${timestamp}] [qqbot] sendProactiveMessage: getting access token for appId=${account.appId}`);
    const accessToken = await getAccessToken(account.appId, account.clientSecret);

    console.log(`[${timestamp}] [qqbot] sendProactiveMessage: parsing target=${to}`);
    const target = parseTarget(to);
    console.log(`[${timestamp}] [qqbot] sendProactiveMessage: target parsed, type=${target.type}, id=${target.id}`);

    let outResult: OutboundResult;
    if (target.type === 'c2c') {
      console.log(`[${timestamp}] [qqbot] sendProactiveMessage: sending proactive C2C message to user=${target.id}`);
      const result = await sendProactiveC2CMessage(accessToken, target.id, text);
      console.log(`[${timestamp}] [qqbot] sendProactiveMessage: proactive C2C message sent successfully, messageId=${result.id}`);
      outResult = { channel: 'qqbot', messageId: result.id, timestamp: result.timestamp, refIdx: (result as unknown as { ext_info?: { ref_idx?: string } }).ext_info?.ref_idx };
    } else if (target.type === 'group') {
      console.log(`[${timestamp}] [qqbot] sendProactiveMessage: sending proactive group message to group=${target.id}`);
      const result = await sendProactiveGroupMessage(accessToken, target.id, text);
      console.log(`[${timestamp}] [qqbot] sendProactiveMessage: proactive group message sent successfully, messageId=${result.id}`);
      outResult = { channel: 'qqbot', messageId: result.id, timestamp: result.timestamp, refIdx: (result as unknown as { ext_info?: { ref_idx?: string } }).ext_info?.ref_idx };
    } else {
      // Channel doesn't support proactive message, use regular send
      console.log(`[${timestamp}] [qqbot] sendProactiveMessage: sending channel message to channel=${target.id}`);
      const result = await sendChannelMessage(accessToken, target.id, text);
      console.log(`[${timestamp}] [qqbot] sendProactiveMessage: channel message sent successfully, messageId=${result.id}`);
      outResult = { channel: 'qqbot', messageId: result.id, timestamp: result.timestamp, refIdx: (result as unknown as { ext_info?: { ref_idx?: string } }).ext_info?.ref_idx };
    }
    return outResult;
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error(`[${timestamp}] [qqbot] sendProactiveMessage: error: ${errorMessage}`);
    console.error(`[${timestamp}] [qqbot] sendProactiveMessage: error stack: ${err instanceof Error ? err.stack : 'No stack trace'}`);
    return { channel: 'qqbot', error: errorMessage };
  }
}

/**
 * Send rich media message (image)
 *
 * Supports mediaUrl formats:
 * - Public URL: https://example.com/image.png
 * - Base64 Data URL: data:image/png;base64,xxxxx
 * - Local file path: /path/to/image.png (auto read and convert to Base64)
 *
 * @param ctx - Send context, contains mediaUrl
 * @returns Send result
 *
 * @example
 * ```typescript
 * // Send network image
 * const result = await sendMedia({
 *   to: "group:xxx",
 *   text: "这是图片说明",
 *   mediaUrl: "https://example.com/image.png",
 *   account,
 *   replyToId: msgId,
 * });
 *
 * // Send Base64 image
 * const result = await sendMedia({
 *   to: "group:xxx",
 *   text: "这是图片说明",
 *   mediaUrl: "data:image/png;base64,iVBORw0KGgo...",
 *   account,
 *   replyToId: msgId,
 * });
 *
 * // Send local file (auto read and convert to Base64)
 * const result = await sendMedia({
 *   to: "group:xxx",
 *   text: "这是图片说明",
 *   mediaUrl: "/tmp/generated-chart.png",
 *   account,
 *   replyToId: msgId,
 * });
 * ```
 */
export async function sendMedia(ctx: MediaOutboundContext): Promise<OutboundResult> {
  const { to, text, replyToId, account } = ctx;
  // Expand tilde path: ~/Desktop/file.png → /Users/xxx/Desktop/file.png
  const mediaUrl = normalizePath(ctx.mediaUrl);

  if (!account.appId || !account.clientSecret) {
    return { channel: 'qqbot', error: 'QQBot not configured (missing appId or clientSecret)' };
  }

  if (!mediaUrl) {
    return { channel: 'qqbot', error: 'mediaUrl is required for sendMedia' };
  }

  // Check if voice file (local file path + audio extension)
  const isLocalPath = isLocalFilePath(mediaUrl);
  const isHttpUrl = mediaUrl.startsWith('http://') || mediaUrl.startsWith('https://');

  if (isLocalPath && isAudioFile(mediaUrl)) {
    return sendVoiceFile(ctx);
  }

  // Check if video (public URL or local video file)
  if (isVideoFile(mediaUrl)) {
    if (isHttpUrl) {
      return sendVideoUrl(ctx);
    }
    if (isLocalPath) {
      return sendVideoFile(ctx);
    }
  }

  // Check if document/file (non-image, non-audio, non-video local file)
  if (isLocalPath && !isImageFile(mediaUrl) && !isAudioFile(mediaUrl)) {
    return sendDocumentFile(ctx);
  }

  // === Below is image sending logic (original) ===

  const isDataUrl = mediaUrl.startsWith('data:');

  let processedMediaUrl = mediaUrl;

  if (isLocalPath) {
    console.log(`[qqbot] sendMedia: local file path detected: ${mediaUrl}`);

    try {
      if (!(await fileExistsAsync(mediaUrl))) {
        return { channel: 'qqbot', error: `本地文件不存在: ${mediaUrl}` };
      }

      // File size check
      const sizeCheck = checkFileSize(mediaUrl);
      if (!sizeCheck.ok) {
        return { channel: 'qqbot', error: sizeCheck.error! };
      }

      const fileBuffer = await readFileAsync(mediaUrl);
      const base64Data = fileBuffer.toString('base64');

      const ext = path.extname(mediaUrl).toLowerCase();
      const mimeTypes: Record<string, string> = {
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.png': 'image/png',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.bmp': 'image/bmp',
      };

      const mimeType = mimeTypes[ext];
      if (!mimeType) {
        return {
          channel: 'qqbot',
          error: `不支持的图片格式: ${ext}。支持的格式: ${Object.keys(mimeTypes).join(', ')}`,
        };
      }

      processedMediaUrl = `data:${mimeType};base64,${base64Data}`;
      console.log(`[qqbot] sendMedia: local file converted to Base64 (size: ${fileBuffer.length} bytes, type: ${mimeType})`);
    } catch (readErr) {
      const errMsg = readErr instanceof Error ? readErr.message : String(readErr);
      console.error(`[qqbot] sendMedia: failed to read local file: ${errMsg}`);
      return { channel: 'qqbot', error: `读取本地文件失败: ${errMsg}` };
    }
  } else if (!isHttpUrl && !isDataUrl) {
    console.log(`[qqbot] sendMedia: unsupported media format: ${mediaUrl.slice(0, 50)}`);
    return {
      channel: 'qqbot',
      error: `不支持的媒体格式: ${mediaUrl.slice(0, 50)}...。支持: 公网 URL、Base64 Data URL 或本地文件路径（图片/音频）。`,
    };
  } else if (isDataUrl) {
    console.log(`[qqbot] sendMedia: sending Base64 image (length: ${mediaUrl.length})`);
  } else {
    console.log(`[qqbot] sendMedia: sending image URL: ${mediaUrl.slice(0, 80)}...`);
  }

  try {
    const accessToken = await getAccessToken(account.appId, account.clientSecret);
    const target = parseTarget(to);

    let imageResult: { id: string; timestamp: number | string };
    if (target.type === 'c2c') {
      imageResult = await sendC2CImageMessage(accessToken, target.id, processedMediaUrl, replyToId ?? undefined, undefined, isLocalPath ? mediaUrl : undefined);
    } else if (target.type === 'group') {
      imageResult = await sendGroupImageMessage(accessToken, target.id, processedMediaUrl, replyToId ?? undefined, undefined);
    } else {
      const displayUrl = isLocalPath ? '[本地文件]' : mediaUrl;
      const textWithUrl = text ? `${text}\n${displayUrl}` : displayUrl;
      const result = await sendChannelMessage(accessToken, target.id, textWithUrl, replyToId ?? undefined);
      return { channel: 'qqbot', messageId: result.id, timestamp: result.timestamp };
    }

    if (text?.trim()) {
      try {
        if (target.type === 'c2c') {
          await sendC2CMessage(accessToken, target.id, text, replyToId ?? undefined);
        } else if (target.type === 'group') {
          await sendGroupMessage(accessToken, target.id, text, replyToId ?? undefined);
        }
      } catch (textErr) {
        console.error(`[qqbot] Failed to send text after image: ${textErr}`);
      }
    }

    return { channel: 'qqbot', messageId: imageResult.id, timestamp: imageResult.timestamp, refIdx: (imageResult as unknown as { ext_info?: { ref_idx?: string } }).ext_info?.ref_idx };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { channel: 'qqbot', error: message };
  }
}

/**
 * Send voice file message
 * Process: similar to image sending - read local audio file → convert to SILK Base64 → upload → send
 */
async function sendVoiceFile(ctx: MediaOutboundContext): Promise<OutboundResult> {
  const { to, text, replyToId, account, mediaUrl } = ctx;

  console.log(`[qqbot] sendVoiceFile: ${mediaUrl}`);

  // Wait for file ready (TTS tool async generation, file may not be written yet)
  const fileSize = await waitForFile(mediaUrl);
  if (fileSize === 0) {
    return { channel: 'qqbot', error: '语音生成失败，请稍后重试' };
  }

  try {
    // Try to convert to SILK format (QQ voice requires SILK format), support config to skip conversion
    const directFormats = account.config?.audioFormatPolicy?.uploadDirectFormats ?? account.config?.voiceDirectUploadFormats;
    const silkBase64 = await audioFileToSilkBase64(mediaUrl, directFormats);
    if (!silkBase64) {
      // If cannot convert to SILK, read file directly as Base64 upload (let API try to handle)
      const buf = await readFileAsync(mediaUrl);
      const fallbackBase64 = buf.toString('base64');
      console.log(`[qqbot] sendVoiceFile: not SILK format, uploading raw file (${formatFileSize(buf.length)})`);

      const accessToken = await getAccessToken(account.appId!, account.clientSecret!);
      const target = parseTarget(to);

      let result: { id: string; timestamp: number | string };
      if (target.type === 'c2c') {
        result = await sendC2CVoiceMessage(accessToken, target.id, fallbackBase64, replyToId ?? undefined);
      } else if (target.type === 'group') {
        result = await sendGroupVoiceMessage(accessToken, target.id, fallbackBase64, replyToId ?? undefined);
      } else {
        const r = await sendChannelMessage(accessToken, target.id, `[语音消息暂不支持频道发送]`, replyToId ?? undefined);
        return { channel: 'qqbot', messageId: r.id, timestamp: r.timestamp };
      }

      return { channel: 'qqbot', messageId: result.id, timestamp: result.timestamp };
    }

    console.log(`[qqbot] sendVoiceFile: SILK format ready, uploading...`);

    const accessToken = await getAccessToken(account.appId!, account.clientSecret!);
    const target = parseTarget(to);

    let voiceResult: { id: string; timestamp: number | string };
    if (target.type === 'c2c') {
      voiceResult = await sendC2CVoiceMessage(accessToken, target.id, silkBase64, replyToId ?? undefined);
    } else if (target.type === 'group') {
      voiceResult = await sendGroupVoiceMessage(accessToken, target.id, silkBase64, replyToId ?? undefined);
    } else {
      const r = await sendChannelMessage(accessToken, target.id, `[语音消息暂不支持频道发送]`, replyToId ?? undefined);
      return { channel: 'qqbot', messageId: r.id, timestamp: r.timestamp };
    }

    // If has text description, send another text message
    if (text?.trim()) {
      try {
        if (target.type === 'c2c') {
          await sendC2CMessage(accessToken, target.id, text, replyToId ?? undefined);
        } else if (target.type === 'group') {
          await sendGroupMessage(accessToken, target.id, text, replyToId ?? undefined);
        }
      } catch (textErr) {
        console.error(`[qqbot] Failed to send text after voice: ${textErr}`);
      }
    }

    console.log(`[qqbot] sendVoiceFile: voice message sent`);
    return { channel: 'qqbot', messageId: voiceResult.id, timestamp: voiceResult.timestamp, refIdx: (voiceResult as unknown as { ext_info?: { ref_idx?: string } }).ext_info?.ref_idx };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[qqbot] sendVoiceFile: failed: ${message}`);
    return { channel: 'qqbot', error: message };
  }
}

/** Check if file is image format */
function isImageFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'].includes(ext);
}

/** Check if file/URL is video format */
function isVideoFile(filePath: string): boolean {
  // Remove URL query params then check extension
  const cleanPath = filePath.split('?')[0]!;
  const ext = path.extname(cleanPath).toLowerCase();
  return ['.mp4', '.mov', '.avi', '.mkv', '.webm', '.flv', '.wmv'].includes(ext);
}

/**
 * Send video message (public URL)
 */
async function sendVideoUrl(ctx: MediaOutboundContext): Promise<OutboundResult> {
  const { to, text, replyToId, account, mediaUrl } = ctx;

  console.log(`[qqbot] sendVideoUrl: ${mediaUrl}`);

  if (!account.appId || !account.clientSecret) {
    return { channel: 'qqbot', error: 'QQBot not configured (missing appId or clientSecret)' };
  }

  try {
    const accessToken = await getAccessToken(account.appId, account.clientSecret);
    const target = parseTarget(to);

    let videoResult: { id: string; timestamp: number | string };
    if (target.type === 'c2c') {
      videoResult = await sendC2CVideoMessage(accessToken, target.id, mediaUrl, undefined, replyToId ?? undefined);
    } else if (target.type === 'group') {
      videoResult = await sendGroupVideoMessage(accessToken, target.id, mediaUrl, undefined, replyToId ?? undefined);
    } else {
      const r = await sendChannelMessage(accessToken, target.id, `[视频消息暂不支持频道发送]`, replyToId ?? undefined);
      return { channel: 'qqbot', messageId: r.id, timestamp: r.timestamp };
    }

    // If has text description, send another text message
    if (text?.trim()) {
      try {
        if (target.type === 'c2c') {
          await sendC2CMessage(accessToken, target.id, text, replyToId ?? undefined);
        } else if (target.type === 'group') {
          await sendGroupMessage(accessToken, target.id, text, replyToId ?? undefined);
        }
      } catch (textErr) {
        console.error(`[qqbot] Failed to send text after video: ${textErr}`);
      }
    }

    console.log(`[qqbot] sendVideoUrl: video message sent`);
    return { channel: 'qqbot', messageId: videoResult.id, timestamp: videoResult.timestamp, refIdx: (videoResult as unknown as { ext_info?: { ref_idx?: string } }).ext_info?.ref_idx };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[qqbot] sendVideoUrl: failed: ${message}`);
    return { channel: 'qqbot', error: message };
  }
}

/**
 * Send local video file
 * Process: read local file → Base64 → upload (file_type=2) → send
 */
async function sendVideoFile(ctx: MediaOutboundContext): Promise<OutboundResult> {
  const { to, text, replyToId, account, mediaUrl } = ctx;

  console.log(`[qqbot] sendVideoFile: ${mediaUrl}`);

  if (!account.appId || !account.clientSecret) {
    return { channel: 'qqbot', error: 'QQBot not configured (missing appId or clientSecret)' };
  }

  try {
    if (!(await fileExistsAsync(mediaUrl))) {
      return { channel: 'qqbot', error: `视频文件不存在: ${mediaUrl}` };
    }

    // File size check
    const sizeCheck = checkFileSize(mediaUrl);
    if (!sizeCheck.ok) {
      return { channel: 'qqbot', error: sizeCheck.error! };
    }

    const fileBuffer = await readFileAsync(mediaUrl);
    const videoBase64 = fileBuffer.toString('base64');
    console.log(`[qqbot] sendVideoFile: Read local video (${formatFileSize(fileBuffer.length)})`);

    const accessToken = await getAccessToken(account.appId, account.clientSecret);
    const target = parseTarget(to);

    let videoResult: { id: string; timestamp: number | string };
    if (target.type === 'c2c') {
      videoResult = await sendC2CVideoMessage(accessToken, target.id, undefined, videoBase64, replyToId ?? undefined, undefined, mediaUrl);
    } else if (target.type === 'group') {
      videoResult = await sendGroupVideoMessage(accessToken, target.id, undefined, videoBase64, replyToId ?? undefined);
    } else {
      const r = await sendChannelMessage(accessToken, target.id, `[视频消息暂不支持频道发送]`, replyToId ?? undefined);
      return { channel: 'qqbot', messageId: r.id, timestamp: r.timestamp };
    }

    // If has text description, send another text message
    if (text?.trim()) {
      try {
        if (target.type === 'c2c') {
          await sendC2CMessage(accessToken, target.id, text, replyToId ?? undefined);
        } else if (target.type === 'group') {
          await sendGroupMessage(accessToken, target.id, text, replyToId ?? undefined);
        }
      } catch (textErr) {
        console.error(`[qqbot] Failed to send text after video: ${textErr}`);
      }
    }

    console.log(`[qqbot] sendVideoFile: video message sent`);
    return { channel: 'qqbot', messageId: videoResult.id, timestamp: videoResult.timestamp, refIdx: (videoResult as unknown as { ext_info?: { ref_idx?: string } }).ext_info?.ref_idx };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[qqbot] sendVideoFile: failed: ${message}`);
    return { channel: 'qqbot', error: message };
  }
}

/**
 * Send file message
 * Process: read local file → Base64 → upload (file_type=4) → send
 * Support local file path and public URL
 */
async function sendDocumentFile(ctx: MediaOutboundContext): Promise<OutboundResult> {
  const { to, text, replyToId, account, mediaUrl } = ctx;

  console.log(`[qqbot] sendDocumentFile: ${mediaUrl}`);

  if (!account.appId || !account.clientSecret) {
    return { channel: 'qqbot', error: 'QQBot not configured (missing appId or clientSecret)' };
  }

  const isHttpUrl = mediaUrl.startsWith('http://') || mediaUrl.startsWith('https://');
  const fileName = sanitizeFileName(path.basename(mediaUrl));

  try {
    const accessToken = await getAccessToken(account.appId, account.clientSecret);
    const target = parseTarget(to);

    let fileResult: { id: string; timestamp: number | string };

    if (isHttpUrl) {
      // Public URL: upload via url parameter
      console.log(`[qqbot] sendDocumentFile: uploading via URL: ${mediaUrl}`);
      if (target.type === 'c2c') {
        fileResult = await sendC2CFileMessage(accessToken, target.id, undefined, mediaUrl, replyToId ?? undefined, fileName);
      } else if (target.type === 'group') {
        fileResult = await sendGroupFileMessage(accessToken, target.id, undefined, mediaUrl, replyToId ?? undefined, fileName);
      } else {
        const r = await sendChannelMessage(accessToken, target.id, `[文件消息暂不支持频道发送]`, replyToId ?? undefined);
        return { channel: 'qqbot', messageId: r.id, timestamp: r.timestamp };
      }
    } else {
      // Local file: read and convert to Base64 for upload
      if (!(await fileExistsAsync(mediaUrl))) {
        return { channel: 'qqbot', error: `文件不存在: ${mediaUrl}` };
      }

      const sizeCheck = checkFileSize(mediaUrl);
      if (!sizeCheck.ok) {
        return { channel: 'qqbot', error: sizeCheck.error! };
      }

      // Large file progress hint
      if (isLargeFile(sizeCheck.size)) {
        try {
          const hint = `⏳ 正在上传文件 ${fileName} (${formatFileSize(sizeCheck.size)})...`;
          if (target.type === 'c2c') {
            await sendC2CMessage(accessToken, target.id, hint, replyToId ?? undefined);
          } else if (target.type === 'group') {
            await sendGroupMessage(accessToken, target.id, hint, replyToId ?? undefined);
          }
        } catch {}
      }

      const fileBuffer = await readFileAsync(mediaUrl);
      const fileBase64 = fileBuffer.toString('base64');
      console.log(`[qqbot] sendDocumentFile: Read local file (${formatFileSize(fileBuffer.length)}): ${mediaUrl}`);

      if (target.type === 'c2c') {
        fileResult = await sendC2CFileMessage(accessToken, target.id, fileBase64, undefined, replyToId ?? undefined, fileName, mediaUrl);
      } else if (target.type === 'group') {
        fileResult = await sendGroupFileMessage(accessToken, target.id, fileBase64, undefined, replyToId ?? undefined, fileName);
      } else {
        const r = await sendChannelMessage(accessToken, target.id, `[文件消息暂不支持频道发送]`, replyToId ?? undefined);
        return { channel: 'qqbot', messageId: r.id, timestamp: r.timestamp };
      }
    }

    // If has text description, send another text message
    if (text?.trim()) {
      try {
        if (target.type === 'c2c') {
          await sendC2CMessage(accessToken, target.id, text, replyToId ?? undefined);
        } else if (target.type === 'group') {
          await sendGroupMessage(accessToken, target.id, text, replyToId ?? undefined);
        }
      } catch (textErr) {
        console.error(`[qqbot] Failed to send text after file: ${textErr}`);
      }
    }

    console.log(`[qqbot] sendDocumentFile: file message sent`);
    return { channel: 'qqbot', messageId: fileResult.id, timestamp: fileResult.timestamp, refIdx: (fileResult as unknown as { ext_info?: { ref_idx?: string } }).ext_info?.ref_idx };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[qqbot] sendDocumentFile: failed: ${message}`);
    return { channel: 'qqbot', error: message };
  }
}
