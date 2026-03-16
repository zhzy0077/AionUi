/**
 * QQ Bot API wrapper for AionUi
 * Adapted from QQBot/src/api.ts with multi-instance support
 */

import { computeFileHash, getCachedFileInfo, setCachedFileInfo } from './utils/upload-cache';
import { sanitizeFileName } from './utils/platform';

const API_BASE = 'https://api.sgroup.qq.com';
const TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken';

// Runtime config
let currentMarkdownSupport = false;

// Outbound message callback hook - triggered when message sent successfully with ref_idx
// Registered by outer layer (gateway/outbound) for unified bot outbound message refIdx caching

/** Outbound message metadata (structured storage, no pre-formatting) */
export interface OutboundMeta {
  /** Message text content */
  text?: string;
  /** Media type */
  mediaType?: 'image' | 'voice' | 'video' | 'file';
  /** Media source: online URL */
  mediaUrl?: string;
  /** Media source: local file path or file name */
  mediaLocalPath?: string;
  /** TTS raw text (only valid for voice type, used to store text before TTS) */
  ttsText?: string;
}

type OnMessageSentCallback = (refIdx: string, meta: OutboundMeta) => void;
let onMessageSentHook: OnMessageSentCallback | null = null;

/**
 * Register outbound message callback
 * Triggered automatically when message sent successfully and QQ returns ref_idx
 * Used to unify caching of bot outbound message refIdx at the lowest level
 */
export function onMessageSent(callback: OnMessageSentCallback): void {
  onMessageSentHook = callback;
}

/**
 * Initialize API config
 * @param options.markdownSupport - Whether to support markdown messages (default false, requires bot to have the permission)
 */
export function initApiConfig(options: { markdownSupport?: boolean }): void {
  currentMarkdownSupport = options.markdownSupport === true;
}

/**
 * Get current markdown support status
 */
export function isMarkdownSupport(): boolean {
  return currentMarkdownSupport;
}

// =========================================================================
// Token management - Map-based isolation by appId, solving multi-instance conflicts
// =========================================================================
const tokenCacheMap = new Map<string, { token: string; expiresAt: number; appId: string }>();
const tokenFetchPromises = new Map<string, Promise<string>>();

/**
 * Get AccessToken (with caching + singleflight concurrency safety)
 *
 * Uses singleflight pattern: when multiple requests find Token expired simultaneously,
 * only the first request will actually fetch new Token, others reuse the same Promise.
 *
 * Isolated by appId, supporting multi-bot concurrent requests.
 */
export async function getAccessToken(appId: string, clientSecret: string): Promise<string> {
  const normalizedAppId = String(appId).trim();
  const cachedToken = tokenCacheMap.get(normalizedAppId);

  // Check cache: reuse if not expired and appId unchanged
  if (cachedToken && Date.now() < cachedToken.expiresAt - 5 * 60 * 1000) {
    return cachedToken.token;
  }

  // Singleflight: if there's already a Token fetch in progress for this appId, reuse it
  let fetchPromise = tokenFetchPromises.get(normalizedAppId);
  if (fetchPromise) {
    console.log(`[qqbot-api:${normalizedAppId}] Token fetch in progress, waiting for existing request...`);
    return fetchPromise;
  }

  // Create new Token fetch Promise (singleflight entry)
  fetchPromise = (async () => {
    try {
      return await doFetchToken(normalizedAppId, clientSecret);
    } finally {
      // Clear Promise cache whether success or failure
      tokenFetchPromises.delete(normalizedAppId);
    }
  })();

  tokenFetchPromises.set(normalizedAppId, fetchPromise);
  return fetchPromise;
}

/**
 * Internal function that actually performs Token fetch
 */
async function doFetchToken(appId: string, clientSecret: string): Promise<string> {
  const requestBody = { appId, clientSecret };
  const requestHeaders = { 'Content-Type': 'application/json' };

  // Print request info (hide sensitive info)
  console.log(`[qqbot-api:${appId}] >>> POST ${TOKEN_URL}`);

  let response: Response;
  try {
    response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: requestHeaders,
      body: JSON.stringify(requestBody),
    });
  } catch (err) {
    console.error(`[qqbot-api:${appId}] <<< Network error:`, err);
    throw new Error(`Network error getting access_token: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Print response headers
  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    responseHeaders[key] = value;
  });
  const tokenTraceId = response.headers.get('x-tps-trace-id') ?? '';
  console.log(`[qqbot-api:${appId}] <<< Status: ${response.status} ${response.statusText}${tokenTraceId ? ` | TraceId: ${tokenTraceId}` : ''}`);

  let data: { access_token?: string; expires_in?: number };
  let rawBody: string;
  try {
    rawBody = await response.text();
    // Hide token value
    const logBody = rawBody.replace(/"access_token"\s*:\s*"[^"]+"/g, '"access_token": "***"');
    console.log(`[qqbot-api:${appId}] <<< Body:`, logBody);
    data = JSON.parse(rawBody) as { access_token?: string; expires_in?: number };
  } catch (err) {
    console.error(`[qqbot-api:${appId}] <<< Parse error:`, err);
    throw new Error(`Failed to parse access_token response: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!data.access_token) {
    throw new Error(`Failed to get access_token: ${JSON.stringify(data)}`);
  }

  const expiresAt = Date.now() + (data.expires_in ?? 7200) * 1000;

  tokenCacheMap.set(appId, {
    token: data.access_token,
    expiresAt,
    appId,
  });

  console.log(`[qqbot-api:${appId}] Token cached, expires at: ${new Date(expiresAt).toISOString()}`);
  return data.access_token;
}

/**
 * Clear Token cache
 * @param appId Optional. If provided, only clears that account's cache; otherwise clears all.
 */
export function clearTokenCache(appId?: string): void {
  if (appId) {
    const normalizedAppId = String(appId).trim();
    tokenCacheMap.delete(normalizedAppId);
    console.log(`[qqbot-api:${normalizedAppId}] Token cache cleared manually.`);
  } else {
    tokenCacheMap.clear();
    console.log(`[qqbot-api] All token caches cleared.`);
  }
}

/**
 * Get Token cache status (for monitoring)
 */
export function getTokenStatus(appId: string): { status: 'valid' | 'expired' | 'refreshing' | 'none'; expiresAt: number | null } {
  if (tokenFetchPromises.has(appId)) {
    return { status: 'refreshing', expiresAt: tokenCacheMap.get(appId)?.expiresAt ?? null };
  }
  const cached = tokenCacheMap.get(appId);
  if (!cached) {
    return { status: 'none', expiresAt: null };
  }
  const isValid = Date.now() < cached.expiresAt - 5 * 60 * 1000;
  return { status: isValid ? 'valid' : 'expired', expiresAt: cached.expiresAt };
}

/**
 * Get globally unique message sequence number (range 0 ~ 65535)
 * Uses millisecond timestamp low bits + random number XOR mix, stateless, avoids collision
 */
export function getNextMsgSeq(_msgId: string): number {
  const timePart = Date.now() % 100000000; // Millisecond timestamp last 8 digits
  const random = Math.floor(Math.random() * 65536); // 0~65535
  return (timePart ^ random) % 65536; // XOR mix then limit to 0~65535
}

// API request timeout config (ms)
const DEFAULT_API_TIMEOUT = 30000; // Default 30 seconds
const FILE_UPLOAD_TIMEOUT = 120000; // File upload 120 seconds

/**
 * API request wrapper
 */
export async function apiRequest<T = unknown>(accessToken: string, method: string, path: string, body?: unknown, timeoutMs?: number): Promise<T> {
  const url = `${API_BASE}${path}`;
  const headers: Record<string, string> = {
    Authorization: `QQBot ${accessToken}`,
    'Content-Type': 'application/json',
  };

  const isFileUpload = path.includes('/files');
  const timeout = timeoutMs ?? (isFileUpload ? FILE_UPLOAD_TIMEOUT : DEFAULT_API_TIMEOUT);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, timeout);

  const options: RequestInit = {
    method,
    headers,
    signal: controller.signal,
  };

  if (body) {
    options.body = JSON.stringify(body);
  }

  // Print request info
  console.log(`[qqbot-api] >>> ${method} ${url} (timeout: ${timeout}ms)`);
  if (body) {
    const logBody = { ...(body as Record<string, unknown>) };
    if (typeof logBody.file_data === 'string') {
      logBody.file_data = `<base64 ${(logBody.file_data as string).length} chars>`;
    }
    console.log(`[qqbot-api] >>> Body:`, JSON.stringify(logBody));
  }

  let res: Response;
  try {
    res = await fetch(url, options);
  } catch (err) {
    clearTimeout(timeoutId);
    if (err instanceof Error && err.name === 'AbortError') {
      console.error(`[qqbot-api] <<< Request timeout after ${timeout}ms`);
      throw new Error(`Request timeout[${path}]: exceeded ${timeout}ms`);
    }
    console.error(`[qqbot-api] <<< Network error:`, err);
    throw new Error(`Network error [${path}]: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timeoutId);
  }

  const responseHeaders: Record<string, string> = {};
  res.headers.forEach((value, key) => {
    responseHeaders[key] = value;
  });
  const traceId = res.headers.get('x-tps-trace-id') ?? '';
  console.log(`[qqbot-api] <<< Status: ${res.status} ${res.statusText}${traceId ? ` | TraceId: ${traceId}` : ''}`);

  let data: T;
  let rawBody: string;
  try {
    rawBody = await res.text();
    console.log(`[qqbot-api] <<< Body:`, rawBody);
    data = JSON.parse(rawBody) as T;
  } catch (err) {
    throw new Error(`Failed to parse response[${path}]: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!res.ok) {
    const error = data as { message?: string; code?: number };
    throw new Error(`API Error [${path}]: ${error.message ?? JSON.stringify(data)}`);
  }

  return data;
}

// ============ Upload retry (exponential backoff) ============

const UPLOAD_MAX_RETRIES = 2;
const UPLOAD_BASE_DELAY_MS = 1000;

async function apiRequestWithRetry<T = unknown>(accessToken: string, method: string, path: string, body?: unknown, maxRetries = UPLOAD_MAX_RETRIES): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await apiRequest<T>(accessToken, method, path, body);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      const errMsg = lastError.message;
      if (errMsg.includes('400') || errMsg.includes('401') || errMsg.includes('Invalid') || errMsg.includes('上传超时') || errMsg.includes('timeout') || errMsg.includes('Timeout')) {
        throw lastError;
      }

      if (attempt < maxRetries) {
        const delay = UPLOAD_BASE_DELAY_MS * Math.pow(2, attempt);
        console.log(`[qqbot-api] Upload attempt ${attempt + 1} failed, retrying in ${delay}ms: ${errMsg.slice(0, 100)}`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError!;
}

export async function getGatewayUrl(accessToken: string): Promise<string> {
  const data = await apiRequest<{ url: string }>(accessToken, 'GET', '/gateway');
  return data.url;
}

// ============ Message sending interfaces ============

export interface MessageResponse {
  id: string;
  timestamp: number | string;
  /** Message reference index info (returned by QQ server on outbound) */
  ext_info?: {
    ref_idx?: string;
  };
}

/**
 * Send message and automatically trigger refIdx callback
 * All message sending functions go through here to ensure every outbound message's refIdx is captured
 */
async function sendAndNotify(accessToken: string, method: string, path: string, body: unknown, meta: OutboundMeta): Promise<MessageResponse> {
  const result = await apiRequest<MessageResponse>(accessToken, method, path, body);
  if (result.ext_info?.ref_idx && onMessageSentHook) {
    try {
      onMessageSentHook(result.ext_info.ref_idx, meta);
    } catch (err) {
      console.error(`[qqbot-api] onMessageSent hook error: ${err}`);
    }
  }
  return result;
}

function buildMessageBody(content: string, msgId: string | undefined, msgSeq: number, messageReference?: string): Record<string, unknown> {
  const body: Record<string, unknown> = currentMarkdownSupport
    ? {
        markdown: { content },
        msg_type: 2,
        msg_seq: msgSeq,
      }
    : {
        content,
        msg_type: 0,
        msg_seq: msgSeq,
      };

  if (msgId) {
    body.msg_id = msgId;
  }
  if (messageReference && !currentMarkdownSupport) {
    body.message_reference = { message_id: messageReference };
  }
  return body;
}

export async function sendC2CMessage(accessToken: string, openid: string, content: string, msgId?: string, messageReference?: string): Promise<MessageResponse> {
  const msgSeq = msgId ? getNextMsgSeq(msgId) : 1;
  const body = buildMessageBody(content, msgId, msgSeq, messageReference);
  return sendAndNotify(accessToken, 'POST', `/v2/users/${openid}/messages`, body, { text: content });
}

export async function sendC2CInputNotify(accessToken: string, openid: string, msgId?: string, inputSecond: number = 60): Promise<{ refIdx?: string }> {
  const msgSeq = msgId ? getNextMsgSeq(msgId) : 1;
  const body = {
    msg_type: 6,
    input_notify: {
      input_type: 1,
      input_second: inputSecond,
    },
    msg_seq: msgSeq,
    ...(msgId ? { msg_id: msgId } : {}),
  };
  const response = await apiRequest<{ ext_info?: { ref_idx?: string } }>(accessToken, 'POST', `/v2/users/${openid}/messages`, body);
  return { refIdx: response.ext_info?.ref_idx };
}

export async function sendChannelMessage(accessToken: string, channelId: string, content: string, msgId?: string, messageReference?: string): Promise<{ id: string; timestamp: string }> {
  const body: Record<string, unknown> = {
    content,
    ...(msgId ? { msg_id: msgId } : {}),
  };
  if (messageReference) {
    body.message_reference = { message_id: messageReference };
  }
  return apiRequest(accessToken, 'POST', `/channels/${channelId}/messages`, body);
}

export async function sendGroupMessage(accessToken: string, groupOpenid: string, content: string, msgId?: string, messageReference?: string): Promise<MessageResponse> {
  const msgSeq = msgId ? getNextMsgSeq(msgId) : 1;
  const body = buildMessageBody(content, msgId, msgSeq, messageReference);
  return sendAndNotify(accessToken, 'POST', `/v2/groups/${groupOpenid}/messages`, body, { text: content });
}

function buildProactiveMessageBody(content: string): Record<string, unknown> {
  if (!content || content.trim().length === 0) {
    throw new Error('Proactive message content cannot be empty (markdown.content is empty)');
  }
  if (currentMarkdownSupport) {
    return { markdown: { content }, msg_type: 2 };
  } else {
    return { content, msg_type: 0 };
  }
}

export async function sendProactiveC2CMessage(accessToken: string, openid: string, content: string): Promise<MessageResponse> {
  const body = buildProactiveMessageBody(content);
  return sendAndNotify(accessToken, 'POST', `/v2/users/${openid}/messages`, body, { text: content });
}

export async function sendProactiveGroupMessage(accessToken: string, groupOpenid: string, content: string): Promise<{ id: string; timestamp: string }> {
  const body = buildProactiveMessageBody(content);
  return apiRequest(accessToken, 'POST', `/v2/groups/${groupOpenid}/messages`, body);
}

// ============ Rich media message support ============

export enum MediaFileType {
  IMAGE = 1,
  VIDEO = 2,
  VOICE = 3,
  FILE = 4,
}

export interface UploadMediaResponse {
  file_uuid: string;
  file_info: string;
  ttl: number;
  id?: string;
}

export async function uploadC2CMedia(accessToken: string, openid: string, fileType: MediaFileType, url?: string, fileData?: string, srvSendMsg = false, fileName?: string): Promise<UploadMediaResponse> {
  if (!url && !fileData) throw new Error('uploadC2CMedia: url or fileData is required');

  if (fileData) {
    const contentHash = computeFileHash(fileData);
    const cachedInfo = getCachedFileInfo(contentHash, 'c2c', openid, fileType);
    if (cachedInfo) {
      return { file_uuid: '', file_info: cachedInfo, ttl: 0 };
    }
  }

  const body: Record<string, unknown> = { file_type: fileType, srv_send_msg: srvSendMsg };
  if (url) body.url = url;
  else if (fileData) body.file_data = fileData;
  if (fileType === MediaFileType.FILE && fileName) body.file_name = sanitizeFileName(fileName);

  const result = await apiRequestWithRetry<UploadMediaResponse>(accessToken, 'POST', `/v2/users/${openid}/files`, body);

  if (fileData && result.file_info && result.ttl > 0) {
    const contentHash = computeFileHash(fileData);
    setCachedFileInfo(contentHash, 'c2c', openid, fileType, result.file_info, result.file_uuid, result.ttl);
  }
  return result;
}

export async function uploadGroupMedia(accessToken: string, groupOpenid: string, fileType: MediaFileType, url?: string, fileData?: string, srvSendMsg = false, fileName?: string): Promise<UploadMediaResponse> {
  if (!url && !fileData) throw new Error('uploadGroupMedia: url or fileData is required');

  if (fileData) {
    const contentHash = computeFileHash(fileData);
    const cachedInfo = getCachedFileInfo(contentHash, 'group', groupOpenid, fileType);
    if (cachedInfo) {
      return { file_uuid: '', file_info: cachedInfo, ttl: 0 };
    }
  }

  const body: Record<string, unknown> = { file_type: fileType, srv_send_msg: srvSendMsg };
  if (url) body.url = url;
  else if (fileData) body.file_data = fileData;
  if (fileType === MediaFileType.FILE && fileName) body.file_name = sanitizeFileName(fileName);

  const result = await apiRequestWithRetry<UploadMediaResponse>(accessToken, 'POST', `/v2/groups/${groupOpenid}/files`, body);

  if (fileData && result.file_info && result.ttl > 0) {
    const contentHash = computeFileHash(fileData);
    setCachedFileInfo(contentHash, 'group', groupOpenid, fileType, result.file_info, result.file_uuid, result.ttl);
  }
  return result;
}

export async function sendC2CMediaMessage(accessToken: string, openid: string, fileInfo: string, msgId?: string, content?: string, meta?: OutboundMeta): Promise<MessageResponse> {
  const msgSeq = msgId ? getNextMsgSeq(msgId) : 1;
  return sendAndNotify(
    accessToken,
    'POST',
    `/v2/users/${openid}/messages`,
    {
      msg_type: 7,
      media: { file_info: fileInfo },
      msg_seq: msgSeq,
      ...(content ? { content } : {}),
      ...(msgId ? { msg_id: msgId } : {}),
    },
    meta ?? { text: content }
  );
}

export async function sendGroupMediaMessage(accessToken: string, groupOpenid: string, fileInfo: string, msgId?: string, content?: string): Promise<{ id: string; timestamp: string }> {
  const msgSeq = msgId ? getNextMsgSeq(msgId) : 1;
  return apiRequest(accessToken, 'POST', `/v2/groups/${groupOpenid}/messages`, {
    msg_type: 7,
    media: { file_info: fileInfo },
    msg_seq: msgSeq,
    ...(content ? { content } : {}),
    ...(msgId ? { msg_id: msgId } : {}),
  });
}

export async function sendC2CImageMessage(accessToken: string, openid: string, imageUrl: string, msgId?: string, content?: string, localPath?: string): Promise<MessageResponse> {
  let uploadResult: UploadMediaResponse;
  const isBase64 = imageUrl.startsWith('data:');
  if (isBase64) {
    const matches = imageUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!matches) throw new Error('Invalid Base64 Data URL format');
    uploadResult = await uploadC2CMedia(accessToken, openid, MediaFileType.IMAGE, undefined, matches[2], false);
  } else {
    uploadResult = await uploadC2CMedia(accessToken, openid, MediaFileType.IMAGE, imageUrl, undefined, false);
  }
  const meta: OutboundMeta = {
    text: content,
    mediaType: 'image',
    ...(!isBase64 ? { mediaUrl: imageUrl } : {}),
    ...(localPath ? { mediaLocalPath: localPath } : {}),
  };
  return sendC2CMediaMessage(accessToken, openid, uploadResult.file_info, msgId, content, meta);
}

export async function sendGroupImageMessage(accessToken: string, groupOpenid: string, imageUrl: string, msgId?: string, content?: string): Promise<{ id: string; timestamp: string }> {
  let uploadResult: UploadMediaResponse;
  const isBase64 = imageUrl.startsWith('data:');
  if (isBase64) {
    const matches = imageUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!matches) throw new Error('Invalid Base64 Data URL format');
    uploadResult = await uploadGroupMedia(accessToken, groupOpenid, MediaFileType.IMAGE, undefined, matches[2], false);
  } else {
    uploadResult = await uploadGroupMedia(accessToken, groupOpenid, MediaFileType.IMAGE, imageUrl, undefined, false);
  }
  return sendGroupMediaMessage(accessToken, groupOpenid, uploadResult.file_info, msgId, content);
}

export async function sendC2CVoiceMessage(accessToken: string, openid: string, voiceBase64: string, msgId?: string, ttsText?: string, filePath?: string): Promise<MessageResponse> {
  const uploadResult = await uploadC2CMedia(accessToken, openid, MediaFileType.VOICE, undefined, voiceBase64, false);
  return sendC2CMediaMessage(accessToken, openid, uploadResult.file_info, msgId, undefined, {
    mediaType: 'voice',
    ...(ttsText ? { ttsText } : {}),
    ...(filePath ? { mediaLocalPath: filePath } : {}),
  });
}

export async function sendGroupVoiceMessage(accessToken: string, groupOpenid: string, voiceBase64: string, msgId?: string): Promise<{ id: string; timestamp: string }> {
  const uploadResult = await uploadGroupMedia(accessToken, groupOpenid, MediaFileType.VOICE, undefined, voiceBase64, false);
  return sendGroupMediaMessage(accessToken, groupOpenid, uploadResult.file_info, msgId);
}

export async function sendC2CFileMessage(accessToken: string, openid: string, fileBase64?: string, fileUrl?: string, msgId?: string, fileName?: string, localFilePath?: string): Promise<MessageResponse> {
  const uploadResult = await uploadC2CMedia(accessToken, openid, MediaFileType.FILE, fileUrl, fileBase64, false, fileName);
  return sendC2CMediaMessage(accessToken, openid, uploadResult.file_info, msgId, undefined, { mediaType: 'file', mediaUrl: fileUrl, mediaLocalPath: localFilePath ?? fileName });
}

export async function sendGroupFileMessage(accessToken: string, groupOpenid: string, fileBase64?: string, fileUrl?: string, msgId?: string, fileName?: string): Promise<{ id: string; timestamp: string }> {
  const uploadResult = await uploadGroupMedia(accessToken, groupOpenid, MediaFileType.FILE, fileUrl, fileBase64, false, fileName);
  return sendGroupMediaMessage(accessToken, groupOpenid, uploadResult.file_info, msgId);
}

export async function sendC2CVideoMessage(accessToken: string, openid: string, videoUrl?: string, videoBase64?: string, msgId?: string, content?: string, localPath?: string): Promise<MessageResponse> {
  const uploadResult = await uploadC2CMedia(accessToken, openid, MediaFileType.VIDEO, videoUrl, videoBase64, false);
  return sendC2CMediaMessage(accessToken, openid, uploadResult.file_info, msgId, content, { text: content, mediaType: 'video', ...(videoUrl ? { mediaUrl: videoUrl } : {}), ...(localPath ? { mediaLocalPath: localPath } : {}) });
}

export async function sendGroupVideoMessage(accessToken: string, groupOpenid: string, videoUrl?: string, videoBase64?: string, msgId?: string, content?: string): Promise<{ id: string; timestamp: string }> {
  const uploadResult = await uploadGroupMedia(accessToken, groupOpenid, MediaFileType.VIDEO, videoUrl, videoBase64, false);
  return sendGroupMediaMessage(accessToken, groupOpenid, uploadResult.file_info, msgId, content);
}

// ==========================================
// Background Token Refresh - Isolated by appId
// ==========================================

interface BackgroundTokenRefreshOptions {
  refreshAheadMs?: number;
  randomOffsetMs?: number;
  minRefreshIntervalMs?: number;
  retryDelayMs?: number;
  log?: {
    info: (msg: string) => void;
    error: (msg: string) => void;
    debug?: (msg: string) => void;
  };
}

const backgroundRefreshControllers = new Map<string, AbortController>();

export function startBackgroundTokenRefresh(appId: string, clientSecret: string, options?: BackgroundTokenRefreshOptions): void {
  if (backgroundRefreshControllers.has(appId)) {
    console.log(`[qqbot-api:${appId}] Background token refresh already running`);
    return;
  }

  const { refreshAheadMs = 5 * 60 * 1000, randomOffsetMs = 30 * 1000, minRefreshIntervalMs = 60 * 1000, retryDelayMs = 5 * 1000, log } = options ?? {};

  const controller = new AbortController();
  backgroundRefreshControllers.set(appId, controller);
  const signal = controller.signal;

  const refreshLoop = async () => {
    log?.info?.(`[qqbot-api:${appId}] Background token refresh started`);

    while (!signal.aborted) {
      try {
        await getAccessToken(appId, clientSecret);
        const cached = tokenCacheMap.get(appId);

        if (cached) {
          const expiresIn = cached.expiresAt - Date.now();
          const randomOffset = Math.random() * randomOffsetMs;
          const refreshIn = Math.max(expiresIn - refreshAheadMs - randomOffset, minRefreshIntervalMs);

          log?.debug?.(`[qqbot-api:${appId}] Token valid, next refresh in ${Math.round(refreshIn / 1000)}s`);
          await sleep(refreshIn, signal);
        } else {
          log?.debug?.(`[qqbot-api:${appId}] No cached token, retrying soon`);
          await sleep(minRefreshIntervalMs, signal);
        }
      } catch (err) {
        if (signal.aborted) break;
        log?.error?.(`[qqbot-api:${appId}] Background token refresh failed: ${err}`);
        await sleep(retryDelayMs, signal);
      }
    }

    backgroundRefreshControllers.delete(appId);
    log?.info?.(`[qqbot-api:${appId}] Background token refresh stopped`);
  };

  refreshLoop().catch((err) => {
    backgroundRefreshControllers.delete(appId);
    log?.error?.(`[qqbot-api:${appId}] Background token refresh crashed: ${err}`);
  });
}

/**
 * Stop background token refresh
 * @param appId Optional. If provided, only stops that account's scheduled refresh.
 */
export function stopBackgroundTokenRefresh(appId?: string): void {
  if (appId) {
    const controller = backgroundRefreshControllers.get(appId);
    if (controller) {
      controller.abort();
      backgroundRefreshControllers.delete(appId);
    }
  } else {
    for (const controller of Array.from(backgroundRefreshControllers.values())) {
      controller.abort();
    }
    backgroundRefreshControllers.clear();
  }
}

export function isBackgroundTokenRefreshRunning(appId?: string): boolean {
  if (appId) return backgroundRefreshControllers.has(appId);
  return backgroundRefreshControllers.size > 0;
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        reject(new Error('Aborted'));
        return;
      }
      const onAbort = () => {
        clearTimeout(timer);
        reject(new Error('Aborted'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}
