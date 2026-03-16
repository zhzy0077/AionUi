/**
 * QQ Bot Gateway - WebSocket Connection with Message Queue
 *
 * Core WebSocket gateway implementation for QQ Bot channel.
 * Handles connection, reconnection, message parsing, and per-user message queue.
 *
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import WebSocket from 'ws';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { ResolvedQQBotAccount, WSPayload, C2CMessageEvent, GuildMessageEvent, GroupMessageEvent } from './types';
import { getAccessToken, getGatewayUrl, sendC2CMessage, sendChannelMessage, sendGroupMessage, clearTokenCache, sendC2CImageMessage, sendGroupImageMessage, sendC2CVoiceMessage, sendGroupVoiceMessage, sendC2CVideoMessage, sendGroupVideoMessage, sendC2CFileMessage, sendGroupFileMessage, initApiConfig, startBackgroundTokenRefresh, stopBackgroundTokenRefresh, sendC2CInputNotify, onMessageSent } from './api';
import { loadSession, saveSession, clearSession, type SessionState } from './session-store';
import { setRefIndex, getRefIndex, formatRefEntryForAgent, flushRefIndex, type RefAttachmentSummary } from './ref-index-store';
import { getQQBotDataDir, isLocalPath as isLocalFilePath, looksLikeLocalPath, normalizePath, sanitizeFileName, runDiagnostics } from './utils/platform';
import { normalizeMediaTags } from './utils/media-tags';
import { checkFileSize, readFileAsync, fileExistsAsync, isLargeFile, formatFileSize } from './utils/file-utils';
import { convertSilkToWav, isVoiceAttachment, formatDuration, resolveTTSConfig, textToSilk, audioFileToSilkBase64, waitForFile, isAudioFile } from './utils/audio-convert';

// ============================================================================
// STT (Speech-to-Text) Configuration
// ============================================================================

/**
 * STT (Speech-to-Text) Configuration
 *
 * Why do STT at plugin side instead of going through framework pipeline?
 * Framework's applyMediaUnderstanding simultaneously runs runCapability("audio") and extractFileBlocks.
 * The latter injects WAV file's PCM binary as text into Body (looksLikeUtf8Text misjudgment), causing context explosion.
 * By completing STT at plugin side and not putting WAV into MediaPaths, we can avoid this framework bug.
 *
 * Config resolution strategy (unified two-level fallback with TTS):
 * 1. Priority channels.qqbot.stt (plugin专属配置)
 * 2. Fallback to tools.media.audio.models[0] (framework-level config)
 * 3. Then inherit apiKey/baseUrl from models.providers.[provider]
 * 4. Support any OpenAI-compatible STT service
 */
export interface STTConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

/**
 * Resolve STT config from plugin configuration
 */
export function resolveSTTConfig(cfg: Record<string, unknown>): STTConfig | null {
  const c = cfg as Record<string, unknown>;
  // Priority: channels.qqbot.stt (plugin-specific config)
  const channels = c?.channels as Record<string, unknown> | undefined;
  const qqbotCfg = channels?.qqbot as Record<string, unknown> | undefined;
  const channelStt = qqbotCfg?.stt as Record<string, unknown> | undefined;
  if (channelStt && channelStt.enabled !== false) {
  const channels = c?.channels as Record<string, unknown> | undefined;
  const qqbotCfg = channels?.qqbot as Record<string, unknown> | undefined;
  if (channelStt && channelStt.enabled !== false) {
    const providerId: string = (channelStt?.provider as string) || 'openai';
    const models = c?.models as Record<string, unknown> | undefined;
    const providers = models?.providers as Record<string, unknown> | undefined;
    const providerCfg = providers?.[providerId] as Record<string, unknown> | undefined;
    const baseUrl: string | undefined = (channelStt?.baseUrl as string) || (providerCfg?.baseUrl as string);
    const apiKey: string | undefined = (channelStt?.apiKey as string) || (providerCfg?.apiKey as string);
    const model: string = (channelStt?.model as string) || 'whisper-1';
    if (baseUrl && apiKey) {
      return { baseUrl: baseUrl.replace(/\/+$/, ''), apiKey, model };
    }
  }

  // Fallback: tools.media.audio.models[0] (framework-level config)
  const tools = c?.tools as Record<string, unknown> | undefined;
  const media = tools?.media as Record<string, unknown> | undefined;
  const audio = media?.audio as Record<string, unknown> | undefined;
  const audioModels = audio?.models as Record<string, unknown>[] | undefined;
  const audioModelEntry = audioModels?.[0] as Record<string, unknown> | undefined;
  if (audioModelEntry) {
    const providerId: string = (audioModelEntry?.provider as string) || 'openai';
    const models = c?.models as Record<string, unknown> | undefined;
    const providers = models?.providers as Record<string, unknown> | undefined;
    const providerCfg = providers?.[providerId] as Record<string, unknown> | undefined;
  const audioModelEntry = (c?.tools as Record<string, unknown>)?.media?.audio?.models?.[0] as Record<string, unknown> | undefined;
  if (audioModelEntry) {
    const providerId: string = (audioModelEntry?.provider as string) || 'openai';
    const models = c?.models as Record<string, unknown> | undefined;
    const providers = models?.providers as Record<string, unknown> | undefined;
    const providerCfg = providers?.[providerId] as Record<string, unknown> | undefined;
    const baseUrl: string | undefined = (audioModelEntry?.baseUrl as string) || (providerCfg?.baseUrl as string);
    const apiKey: string | undefined = (audioModelEntry?.apiKey as string) || (providerCfg?.apiKey as string);
    const model: string = (audioModelEntry?.model as string) || 'whisper-1';
    if (baseUrl && apiKey) {
      return { baseUrl: baseUrl.replace(/\/+$/, ''), apiKey, model };
    }
  }

  return null;
}

/**
 * Transcribe audio file using STT service
 */
export async function transcribeAudio(audioPath: string, cfg: Record<string, unknown>): Promise<string | null> {
  const sttCfg = resolveSTTConfig(cfg);
  if (!sttCfg) return null;

  const fileBuffer = fs.readFileSync(audioPath);
  const fileName = sanitizeFileName(path.basename(audioPath));
  const mime = fileName.endsWith('.wav') ? 'audio/wav' : fileName.endsWith('.mp3') ? 'audio/mpeg' : fileName.endsWith('.ogg') ? 'audio/ogg' : 'application/octet-stream';

  const form = new FormData();
  form.append('file', new Blob([fileBuffer], { type: mime }), fileName);
  form.append('model', sttCfg.model);

  const resp = await fetch(`${sttCfg.baseUrl}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${sttCfg.apiKey}` },
    body: form,
  });

  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    throw new Error(`STT failed (HTTP ${resp.status}): ${detail.slice(0, 300)}`);
  }

  const result = (await resp.json()) as { text?: string };
  return result.text?.trim() || null;
}

// ============================================================================
// QQ Intents & Gateway Configuration
// ============================================================================

/** QQ Bot Intents - grouped by permission level */
export const INTENTS = {
  // Basic permissions (default)
  GUILDS: 1 << 0, // Channel related
  GUILD_MEMBERS: 1 << 1, // Channel members
  PUBLIC_GUILD_MESSAGES: 1 << 30, // Channel public messages (public domain)
  // Permissions requiring application
  DIRECT_MESSAGE: 1 << 12, // Channel DM
  GROUP_AND_C2C: 1 << 25, // Group chat and C2C private chat (requires application)
};

/** Permission levels: from high to low */
export const INTENT_LEVELS = [
  // Level 0: Full permissions (group + DM + channel)
  {
    name: 'full',
    intents: INTENTS.PUBLIC_GUILD_MESSAGES | INTENTS.DIRECT_MESSAGE | INTENTS.GROUP_AND_C2C,
    description: '群聊+私信+频道',
  },
  // Level 1: Group + Channel (no DM)
  {
    name: 'group+channel',
    intents: INTENTS.PUBLIC_GUILD_MESSAGES | INTENTS.GROUP_AND_C2C,
    description: '群聊+频道',
  },
  // Level 2: Channel only (basic permissions)
  {
    name: 'channel-only',
    intents: INTENTS.PUBLIC_GUILD_MESSAGES | INTENTS.GUILD_MEMBERS,
    description: '仅频道消息',
  },
];

// Reconnection configuration
export const RECONNECT_DELAYS = [1000, 2000, 5000, 10000, 30000, 60000]; // Incremental delay
export const RATE_LIMIT_DELAY = 60000; // Wait 60s when hitting rate limit
export const MAX_RECONNECT_ATTEMPTS = 100;
export const MAX_QUICK_DISCONNECT_COUNT = 3; // Quick disconnect threshold
export const QUICK_DISCONNECT_THRESHOLD = 5000; // 5s disconnect = quick disconnect

// Image server configuration
export const IMAGE_SERVER_PORT = parseInt(process.env.QQBOT_IMAGE_SERVER_PORT || '18765', 10);
export const IMAGE_SERVER_DIR = process.env.QQBOT_IMAGE_SERVER_DIR || getQQBotDataDir('images');

// Message queue configuration (async processing, prevent blocking heartbeat)
export const MESSAGE_QUEUE_SIZE = 1000; // Max queue size (global total)
export const PER_USER_QUEUE_SIZE = 20; // Max queued messages per user
export const MAX_CONCURRENT_USERS = 10; // Max concurrent users

// ============================================================================
// Message Reply Limiting
// ============================================================================

// Same message_id can reply up to 4 times within 1 hour, after 1 hour need to downgrade to proactive message
const MESSAGE_REPLY_LIMIT = 4;
const MESSAGE_REPLY_TTL = 60 * 60 * 1000; // 1 hour

interface MessageReplyRecord {
  count: number;
  firstReplyAt: number;
}

const messageReplyTracker = new Map<string, MessageReplyRecord>();

/**
 * Check if can reply to message (rate limit check)
 */
export function checkMessageReplyLimit(messageId: string): { allowed: boolean; remaining: number } {
  const now = Date.now();
  const record = messageReplyTracker.get(messageId);

  // Cleanup expired records periodically
  if (messageReplyTracker.size > 10000) {
    for (const [id, rec] of messageReplyTracker) {
      if (now - rec.firstReplyAt > MESSAGE_REPLY_TTL) {
        messageReplyTracker.delete(id);
      }
    }
  }

  if (!record) {
    return { allowed: true, remaining: MESSAGE_REPLY_LIMIT };
  }

  // Check if expired
  if (now - record.firstReplyAt > MESSAGE_REPLY_TTL) {
    messageReplyTracker.delete(messageId);
    return { allowed: true, remaining: MESSAGE_REPLY_LIMIT };
  }

  // Check if exceeded limit
  const remaining = MESSAGE_REPLY_LIMIT - record.count;
  return { allowed: remaining > 0, remaining: Math.max(0, remaining) };
}

/**
 * Record a message reply
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
}

// ============================================================================
// Message Parsing Utilities
// ============================================================================

/**
 * Parse QQ face tags, convert <faceType=1,faceId="13",ext="base64..."> format
 * to 【表情: 中文名】 format
 * ext field is Base64 encoded JSON, format like {"text":"呲牙"}
 */
export function parseFaceTags(text: string): string {
  if (!text) return text;

  // Match face tags in format <faceType=...,faceId="...",ext="...">
  return text.replace(/<faceType=\d+,faceId="[^"]*",ext="([^"]*)">/g, (_match, ext: string) => {
    try {
      const decoded = Buffer.from(ext, 'base64').toString('utf-8');
      const parsed = JSON.parse(decoded);
      const faceName = parsed.text || '未知表情';
      return `【表情: ${faceName}】`;
    } catch {
      return _match;
    }
  });
}

/**
 * Filter internal markers (like [[reply_to: xxx]])
 * These markers may be incorrectly learned and output by AI, need to remove before sending
 */
export function filterInternalMarkers(text: string): string {
  if (!text) return text;

  // Filter internal markers in [[xxx: yyy]] format
  // Example: [[reply_to: ROBOT1.0_kbc...]]
  let result = text.replace(/\[\[[a-z_]+:\s*[^\]]*\]\]/gi, '');

  // Clean up possible extra newlines
  result = result.replace(/\n{3,}/g, '\n\n').trim();

  return result;
}

/**
 * Convert media upload/send errors to user-friendly messages
 */
export function formatMediaErrorMessage(mediaType: string, err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes('上传超时') || msg.includes('timeout') || msg.includes('Timeout')) {
    return `抱歉，${mediaType}资源加载超时，可能是网络原因或文件太大，请稍后再试～`;
  }
  if (msg.includes('文件不存在') || msg.includes('not found') || msg.includes('Not Found')) {
    return `抱歉，${mediaType}文件不存在或已失效，无法发送～`;
  }
  if (msg.includes('文件大小') || msg.includes('too large') || msg.includes('exceed')) {
    return `抱歉，${mediaType}文件太大了，超出了发送限制～`;
  }
  if (msg.includes('Network error') || msg.includes('ECONNREFUSED') || msg.includes('ENOTFOUND')) {
    return `抱歉，网络连接异常，${mediaType}发送失败，请稍后再试～`;
  }
  return `抱歉，${mediaType}发送失败了，请稍后再试～`;
}

// ============================================================================
// Gateway Context Interfaces
// ============================================================================

export interface GatewayContext {
  account: ResolvedQQBotAccount;
  abortSignal: AbortSignal;
  cfg: unknown;
  onReady?: (data: unknown) => void;
  onError?: (error: Error) => void;
  log?: {
    info: (msg: string) => void;
    error: (msg: string) => void;
    debug?: (msg: string) => void;
  };
}

/**
 * Message queue item type (for async message processing, prevent blocking heartbeat)
 */
export interface QueuedMessage {
  type: 'c2c' | 'guild' | 'dm' | 'group';
  senderId: string;
  senderName?: string;
  content: string;
  messageId: string;
  timestamp: string;
  channelId?: string;
  guildId?: string;
  groupOpenid?: string;
  attachments?: Array<{ content_type: string; url: string; filename?: string; voice_wav_url?: string; asr_refer_text?: string }>;
  /** Referenced message's refIdx (which historical message user referenced) */
  refMsgIdx?: string;
  /** Current message's own refIdx (for future reference) */
  msgIdx?: string;
}

/**
 * Parse reference indices from message_scene.ext array
 * ext format example: ["", "ref_msg_idx=REFIDX_xxx", "msg_idx=REFIDX_yyy"]
 */
export function parseRefIndices(ext?: string[]): { refMsgIdx?: string; msgIdx?: string } {
  if (!ext || ext.length === 0) return {};
  let refMsgIdx: string | undefined;
  let msgIdx: string | undefined;
  for (const item of ext) {
    if (item.startsWith('ref_msg_idx=')) {
      refMsgIdx = item.slice('ref_msg_idx='.length);
    } else if (item.startsWith('msg_idx=')) {
      msgIdx = item.slice('msg_idx='.length);
    }
  }
  return { refMsgIdx, msgIdx };
}

/**
 * Build attachment summaries from attachment list (for reference index caching)
 */
export function buildAttachmentSummaries(attachments?: Array<{ content_type: string; url: string; filename?: string; voice_wav_url?: string }>, localPaths?: Array<string | null>): RefAttachmentSummary[] | undefined {
  if (!attachments || attachments.length === 0) return undefined;
  return attachments.map((att, idx) => {
    const ct = att.content_type?.toLowerCase() ?? '';
    let type: RefAttachmentSummary['type'] = 'unknown';
    if (ct.startsWith('image/')) type = 'image';
    else if (ct === 'voice' || ct.startsWith('audio/') || ct.includes('silk') || ct.includes('amr')) type = 'voice';
    else if (ct.startsWith('video/')) type = 'video';
    else if (ct.startsWith('application/') || ct.startsWith('text/')) type = 'file';
    return {
      type,
      filename: att.filename,
      contentType: att.content_type,
      localPath: localPaths?.[idx] ?? undefined,
    };
  });
}

// ============================================================================
// Message Queue System (CRITICAL)
// ============================================================================

// Urgent commands that execute immediately without queuing
const URGENT_COMMANDS = ['/stop'];

const userQueues = new Map<string, QueuedMessage[]>(); // peerId -> message queue
const activeUsers = new Set<string>(); // Users currently being processed

/**
 * Get message peer ID (determines concurrency isolation granularity)
 */
function getMessagePeerId(msg: QueuedMessage): string {
  if (msg.type === 'guild') return `guild:${msg.channelId ?? 'unknown'}`;
  if (msg.type === 'group') return `group:${msg.groupOpenid ?? 'unknown'}`;
  return `dm:${msg.senderId}`;
}

/**
 * Enqueue message for processing
 */
function enqueueMessage(msg: QueuedMessage, userQueuesMap: Map<string, QueuedMessage[]>, activeUsersSet: Set<string>, handleMessageFnRef: ((msg: QueuedMessage) => Promise<void>) | null, log?: GatewayContext['log'], accountId?: string): void {
  const peerId = getMessagePeerId(msg);
  const content = (msg.content ?? '').trim().toLowerCase();

  // Check if urgent command
  const isUrgentCommand = URGENT_COMMANDS.some((cmd) => content.startsWith(cmd.toLowerCase()));

  if (isUrgentCommand) {
    log?.info(`[qqbot:${accountId}] Urgent command detected: ${content.slice(0, 20)}, executing immediately`);

    // Drop all queued messages for this user
    const queue = userQueuesMap.get(peerId);
    if (queue) {
      const droppedCount = queue.length;
      queue.length = 0;
      log?.info(`[qqbot:${accountId}] Dropped ${droppedCount} queued messages for ${peerId} due to urgent command`);
    }

    // Execute urgent command immediately
    if (handleMessageFnRef) {
      handleMessageFnRef(msg).catch((err) => {
        log?.error(`[qqbot:${accountId}] Urgent command error: ${err}`);
      });
    }
    return;
  }

  let queue = userQueuesMap.get(peerId);
  if (!queue) {
    queue = [];
    userQueuesMap.set(peerId, queue);
  }

  // Per-user queue overflow protection
  if (queue.length >= PER_USER_QUEUE_SIZE) {
    const dropped = queue.shift();
    log?.error(`[qqbot:${accountId}] Per-user queue full for ${peerId}, dropping oldest message ${dropped?.messageId}`);
  }

  queue.push(msg);
  log?.debug?.(`[qqbot:${accountId}] Message enqueued for ${peerId}, user queue: ${queue.length}, active users: ${activeUsersSet.size}`);

  // If user has no messages being processed, start processing immediately
  drainUserQueue(peerId, userQueuesMap, activeUsersSet, handleMessageFnRef, log, accountId);
}

/**
 * Process messages in user queue (serial per user)
 */
async function drainUserQueue(peerId: string, userQueuesMap: Map<string, QueuedMessage[]>, activeUsersSet: Set<string>, handleMessageFnRef: ((msg: QueuedMessage) => Promise<void>) | null, log?: GatewayContext['log'], accountId?: string): Promise<void> {
  if (activeUsersSet.has(peerId)) return; // User already has messages being processed
  if (activeUsersSet.size >= MAX_CONCURRENT_USERS) {
    log?.info(`[qqbot:${accountId}] Max concurrent users (${MAX_CONCURRENT_USERS}) reached, ${peerId} will wait`);
    return; // Wait for other users to finish processing
  }

  const queue = userQueuesMap.get(peerId);
  if (!queue || queue.length === 0) {
    userQueuesMap.delete(peerId);
    return;
  }

  activeUsersSet.add(peerId);

  try {
    while (queue.length > 0) {
      const msg = queue.shift()!;
      try {
        if (handleMessageFnRef) {
          await handleMessageFnRef(msg);
        }
      } catch (err) {
        log?.error(`[qqbot:${accountId}] Message processor error for ${peerId}: ${err}`);
      }
    }
  } finally {
    activeUsersSet.delete(peerId);
    userQueuesMap.delete(peerId);
    // After processing, check if there are users waiting for concurrency slot
    for (const [waitingPeerId, waitingQueue] of userQueuesMap) {
      if (waitingQueue.length > 0 && !activeUsersSet.has(waitingPeerId)) {
        drainUserQueue(waitingPeerId, userQueuesMap, activeUsersSet, handleMessageFnRef, log, accountId);
        break; // Only wake one at a time to avoid instant concurrency surge
      }
    }
  }
}

/**
 * Start message processor
 */
function startMessageProcessor(handleMessageFn: (msg: QueuedMessage) => Promise<void>, userQueuesMap: Map<string, QueuedMessage[]>, activeUsersSet: Set<string>, log?: GatewayContext['log'], accountId?: string): void {
  log?.info(`[qqbot:${accountId}] Message processor started (per-user concurrency, max ${MAX_CONCURRENT_USERS} users)`);
}

// ============================================================================
// Main Gateway Function
// ============================================================================

/**
 * Start Gateway WebSocket connection (with auto-reconnect)
 * Supports streaming message sending
 */
export async function startGateway(ctx: GatewayContext): Promise<void> {
  const { account, abortSignal, cfg, onReady, onError, log } = ctx;

  if (!account.appId || !account.clientSecret) {
    throw new Error('QQBot not configured (missing appId or clientSecret)');
  }

  // Run environment diagnostics (first connection)
  const diag = await runDiagnostics();
  if (diag.warnings.length > 0) {
    for (const w of diag.warnings) {
      log?.info(`[qqbot:${account.accountId}] ${w}`);
    }
  }

  // Initialize API config (markdown support)
  initApiConfig({
    markdownSupport: account.markdownSupport,
  });
  log?.info(`[qqbot:${account.accountId}] API config: markdownSupport=${account.markdownSupport === true}`);

  // TTS config validation
  const ttsCfg = resolveTTSConfig(cfg as Record<string, unknown>);
  if (ttsCfg) {
    const maskedKey = ttsCfg.apiKey.length > 8 ? `${ttsCfg.apiKey.slice(0, 4)}****${ttsCfg.apiKey.slice(-4)}` : '****';
    log?.info(`[qqbot:${account.accountId}] TTS configured: model=${ttsCfg.model}, voice=${ttsCfg.voice}, authStyle=${ttsCfg.authStyle ?? 'bearer'}, baseUrl=${ttsCfg.baseUrl}`);
    log?.info(`[qqbot:${account.accountId}] TTS apiKey: ${maskedKey}${ttsCfg.queryParams ? `, queryParams=${JSON.stringify(ttsCfg.queryParams)}` : ''}${ttsCfg.speed !== undefined ? `, speed=${ttsCfg.speed}` : ''}`);
  } else {
    log?.info(`[qqbot:${account.accountId}] TTS not configured (voice messages will be unavailable)`);
  }

  // If public URL configured, start image server
  let imageServerBaseUrl: string | null = null;
  if (account.imageServerBaseUrl) {
    // Use user-configured public URL as baseUrl
    imageServerBaseUrl = account.imageServerBaseUrl;
    log?.info(`[qqbot:${account.accountId}] Image server enabled with URL: ${imageServerBaseUrl}`);
  } else {
    log?.info(`[qqbot:${account.accountId}] Image server disabled (no imageServerBaseUrl configured)`);
  }

  // Register outbound message refIdx cache hook
  // All message sending functions will automatically call this after getting QQ response with ref_idx
  onMessageSent((refIdx, meta) => {
    log?.info(`[qqbot:${account.accountId}] onMessageSent called: refIdx=${refIdx}, mediaType=${meta.mediaType}, ttsText=${meta.ttsText?.slice(0, 30)}`);
    const attachments: RefAttachmentSummary[] = [];
    if (meta.mediaType) {
      const localPath = meta.mediaLocalPath;
      const filename = localPath ? path.basename(localPath) : undefined;
      const attachment: RefAttachmentSummary = {
        type: meta.mediaType,
        ...(localPath ? { localPath } : {}),
        ...(filename ? { filename } : {}),
        ...(meta.mediaUrl ? { url: meta.mediaUrl } : {}),
      };
      if (meta.mediaType === 'voice' && meta.ttsText) {
        attachment.transcript = meta.ttsText;
        attachment.transcriptSource = 'tts';
        log?.info(`[qqbot:${account.accountId}] Saving voice transcript (TTS): ${meta.ttsText.slice(0, 50)}`);
      }
      attachments.push(attachment);
    }
    setRefIndex(refIdx, {
      content: (meta.text ?? '').slice(0, 500),
      senderId: account.accountId,
      senderName: account.accountId,
      timestamp: Date.now(),
      isBot: true,
      ...(attachments.length > 0 ? { attachments } : {}),
    });
    log?.info(`[qqbot:${account.accountId}] Cached outbound refIdx: ${refIdx}, attachments=${JSON.stringify(attachments)}`);
  });

  let reconnectAttempts = 0;
  let isAborted = false;
  let currentWs: WebSocket | null = null;
  let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  let sessionId: string | null = null;
  let lastSeq: number | null = null;
  let lastConnectTime: number = 0;
  const quickDisconnectCount = 0;
  let isConnecting = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let shouldRefreshToken = false;
  let intentLevelIndex = 0;
  let lastSuccessfulIntentLevel = -1;

  // Try to restore session from persistent storage
  // Pass current appId, if appId changed (changed bot), old session automatically invalid
  const savedSession = loadSession(account.accountId, account.appId);
  if (savedSession) {
    sessionId = savedSession.sessionId;
    lastSeq = savedSession.lastSeq;
    intentLevelIndex = savedSession.intentLevelIndex;
    lastSuccessfulIntentLevel = savedSession.intentLevelIndex;
    log?.info(`[qqbot:${account.accountId}] Restored session from storage: sessionId=${sessionId}, lastSeq=${lastSeq}, intentLevel=${intentLevelIndex}`);
  }

  // Message queue system (per-user concurrent, serial per user, parallel across users)
  const localUserQueues = new Map<string, QueuedMessage[]>();
  const localActiveUsers = new Set<string>();
  const messagesProcessed = 0;
  let handleMessageFnRef: ((msg: QueuedMessage) => Promise<void>) | null = null;

  const cleanup = () => {
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = null;
    }
    if (currentWs && (currentWs.readyState === WebSocket.OPEN || currentWs.readyState === WebSocket.CONNECTING)) {
      currentWs.close();
    }
    currentWs = null;
  };

  const getReconnectDelay = () => {
    const idx = Math.min(reconnectAttempts, RECONNECT_DELAYS.length - 1);
    return RECONNECT_DELAYS[idx];
  };

  const scheduleReconnect = (customDelay?: number) => {
    if (isAborted || reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      log?.error(`[qqbot:${account.accountId}] Max reconnect attempts reached or aborted`);
      return;
    }

    // Cancel existing reconnect timer
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }

    const delay = customDelay ?? getReconnectDelay();
    reconnectAttempts++;
    log?.info(`[qqbot:${account.accountId}] Reconnecting in ${delay}ms (attempt ${reconnectAttempts})`);

    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (!isAborted) {
        connect();
      }
    }, delay);
  };

  const connect = async () => {
    // Prevent concurrent connections
    if (isConnecting) {
      log?.debug?.(`[qqbot:${account.accountId}] Already connecting, skip`);
      return;
    }
    isConnecting = true;

    try {
      cleanup();

      // If marked to refresh token, clear cache
      if (shouldRefreshToken) {
        log?.info(`[qqbot:${account.accountId}] Refreshing token...`);
        clearTokenCache(account.appId);
        shouldRefreshToken = false;
      }

      const accessToken = await getAccessToken(account.appId, account.clientSecret);
      log?.info(`[qqbot:${account.accountId}] ✅ Access token obtained successfully`);
      const gatewayUrl = await getGatewayUrl(accessToken);

      log?.info(`[qqbot:${account.accountId}] Connecting to ${gatewayUrl}`);

      const ws = new WebSocket(gatewayUrl);
      currentWs = ws;

      ws.on('open', () => {
        log?.info(`[qqbot:${account.accountId}] WebSocket connected`);
      });

      ws.on('message', async (data: Buffer) => {
        try {
          const payload = data.toString();
          const wsPayload = JSON.parse(payload) as WSPayload;
          await handleWSPayload(wsPayload);
        } catch (err) {
          log?.error(`[qqbot:${account.accountId}] Error handling WebSocket message: ${err}`);
        }
      });

      ws.on('close', (code: number, reason: Buffer) => {
        log?.info(`[qqbot:${account.accountId}] WebSocket closed: ${code} ${reason.toString()}`);
        isConnecting = false;
        cleanup();
        scheduleReconnect();
      });

      ws.on('error', (err: Error) => {
        log?.error(`[qqbot:${account.accountId}] WebSocket error: ${err}`);
        isConnecting = false;
      });
    } catch (err) {
      isConnecting = false;
      log?.error(`[qqbot:${account.accountId}] Connection error: ${err}`);
      scheduleReconnect();
    }
  };

  const handleWSPayload = async (payload: WSPayload) => {
    switch (payload.op) {
      case 10: // HELLO
        handleHello(payload.d as { heartbeat_interval: number });
        break;
      case 0: // DISPATCH
        await handleDispatch(payload);
        break;
      case 11: // HEARTBEAT_ACK
        // Heartbeat acknowledged
        break;
      case 7: // RECONNECT
        log?.info(`[qqbot:${account.accountId}] Server requested reconnect`);
        break;
      case 9: // INVALID_SESSION
        const canResume = payload.d as boolean;
        log?.info(`[qqbot:${account.accountId}] Invalid session, can resume: ${canResume}`);
        if (!canResume) {
          sessionId = null;
          lastSeq = null;
          // Try next intent level down
          if (intentLevelIndex < INTENT_LEVELS.length - 1) {
            intentLevelIndex++;
            const next = INTENT_LEVELS[intentLevelIndex];
            log?.info(`[qqbot:${account.accountId}] Downgrading intents to: ${next.description}`);
          }
        }
        break;
    }
  };

  const handleHello = (data: { heartbeat_interval: number }) => {
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
    }

    heartbeatInterval = setInterval(() => {
      if (currentWs && currentWs.readyState === WebSocket.OPEN) {
        const heartbeat = {
          op: 1,
          d: lastSeq,
        };
        currentWs.send(JSON.stringify(heartbeat));
      }
    }, data.heartbeat_interval || 30000);

    if (sessionId) {
      // Resume session
      const resumePayload = {
        op: 6,
        d: {
          token: `QQBot ${getAccessToken}`, // Token will be resolved
          session_id: sessionId,
          seq: lastSeq,
        },
      };
      currentWs?.send(JSON.stringify(resumePayload));
    } else {
      // New connection - send IDENTIFY with current intent level
      const intentLevel = INTENT_LEVELS[Math.min(intentLevelIndex, INTENT_LEVELS.length - 1)];
      log?.info(`[qqbot:${account.accountId}] Sending IDENTIFY with intents: ${intentLevel.intents} (${intentLevel.description})`);

      getAccessToken(account.appId, account.clientSecret).then((token) => {
        const identifyPayload = {
          op: 2,
          d: {
            token: `QQBot ${token}`,
            intents: intentLevel.intents,
            shard: [0, 1],
          },
        };
        currentWs?.send(JSON.stringify(identifyPayload));
      });
    }
  };

  const handleDispatch = async (payload: WSPayload) => {
    if (payload.s !== undefined) {
      lastSeq = payload.s;
    }

    const eventType = payload.t;
    const eventData = payload.d;

    if (eventType === 'READY') {
      const readyData = eventData as { session_id: string; user?: { id: string; username: string } };
      sessionId = readyData.session_id;
      lastConnectTime = Date.now();
      lastSuccessfulIntentLevel = intentLevelIndex;

      // Save session
      saveSession({
        sessionId,
        lastSeq: lastSeq ?? 0,
        lastConnectedAt: Date.now(),
        intentLevelIndex,
        accountId: account.accountId,
        savedAt: Date.now(),
        appId: account.appId,
      });

      // Start background token refresh
      startBackgroundTokenRefresh(account.appId, account.clientSecret, { log });

      log?.info(`[qqbot:${account.accountId}] Session ready: ${sessionId}`);
      onReady?.(readyData);
      return;
    }

    if (eventType === 'RESUMED') {
      log?.info(`[qqbot:${account.accountId}] Session resumed`);
      return;
    }

    // Handle message events
    if (eventType === 'C2C_MESSAGE_CREATE') {
      await handleC2CMessage(eventData as C2CMessageEvent);
    } else if (eventType === 'GROUP_AT_MESSAGE_CREATE') {
      await handleGroupMessage(eventData as GroupMessageEvent);
    } else if (eventType === 'GUILD_MESSAGE_CREATE') {
      await handleGuildMessage(eventData as GuildMessageEvent);
    } else if (eventType === 'DIRECT_MESSAGE_CREATE') {
      await handleGuildMessage(eventData as GuildMessageEvent);
    }
  };

  const handleC2CMessage = async (event: C2CMessageEvent) => {
    const { refMsgIdx, msgIdx } = parseRefIndices(event.message_scene?.ext);

    const msg: QueuedMessage = {
      type: 'c2c',
      senderId: event.author.id,
      senderName: event.author.union_openid,
      content: event.content,
      messageId: event.id,
      timestamp: event.timestamp,
      attachments: event.attachments,
      refMsgIdx,
      msgIdx,
    };

    // Process through queue
    if (handleMessageFnRef) {
      enqueueMessage(msg, localUserQueues, localActiveUsers, handleMessageFnRef, log, account.accountId);
    }
  };

  const handleGroupMessage = async (event: GroupMessageEvent) => {
    const { refMsgIdx, msgIdx } = parseRefIndices(event.message_scene?.ext);

    const msg: QueuedMessage = {
      type: 'group',
      senderId: event.author.id,
      senderName: event.author.member_openid,
      content: event.content,
      messageId: event.id,
      timestamp: event.timestamp,
      groupOpenid: event.group_openid,
      attachments: event.attachments,
      refMsgIdx,
      msgIdx,
    };

    // Process through queue
    if (handleMessageFnRef) {
      enqueueMessage(msg, localUserQueues, localActiveUsers, handleMessageFnRef, log, account.accountId);
    }
  };

  const handleGuildMessage = async (event: GuildMessageEvent) => {
    const msg: QueuedMessage = {
      type: 'guild',
      senderId: event.author.id,
      senderName: event.author.username,
      content: event.content,
      messageId: event.id,
      timestamp: event.timestamp,
      channelId: event.channel_id,
      guildId: event.guild_id,
      attachments: event.attachments,
    };

    // Process through queue
    if (handleMessageFnRef) {
      enqueueMessage(msg, localUserQueues, localActiveUsers, handleMessageFnRef, log, account.accountId);
    }
  };

  // Setup message processor
  const setupMessageProcessor = (handleMessageFn: (msg: QueuedMessage) => Promise<void>) => {
    handleMessageFnRef = handleMessageFn;
    log?.info(`[qqbot:${account.accountId}] Message processor started (per-user concurrency, max ${MAX_CONCURRENT_USERS} users)`);
  };

  // Handle abort signal
  abortSignal.addEventListener('abort', () => {
    isAborted = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    cleanup();
    stopBackgroundTokenRefresh(account.appId);
    flushRefIndex();
  });

  // Start connection
  await connect();
}

// Export message queue system for external use
export { userQueues, activeUsers };

}
}
