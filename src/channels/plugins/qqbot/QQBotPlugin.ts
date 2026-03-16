/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import WebSocket from 'ws';
import type { BotInfo, IChannelPluginConfig, IUnifiedOutgoingMessage, PluginType } from '../../types';
import { BasePlugin } from '../BasePlugin';
import { QQBOT_API_BASE, QQBOT_TOKEN_URL, QQBOT_INTENT_LEVELS, QQBotOpcode, QQBotMessageType, type QQBotGatewayPayload, type QQBotMessage, type QQBotApiResponse, encodeChatId, parseChatId, toUnifiedIncomingMessage, toQQBotSendParams, detectMessageType, extractMessageContent, type QQBotSendQueueItem } from './QQBotAdapter';
import { getAccessToken, clearTokenCache, getGatewayUrl, sendC2CMessage, sendGroupMessage, sendChannelMessage, sendC2CImageMessage, sendGroupImageMessage, sendC2CFileMessage, sendGroupFileMessage, uploadC2CMedia, uploadGroupMedia, MediaFileType, type OutboundMeta, onMessageSent, initApiConfig, startBackgroundTokenRefresh, stopBackgroundTokenRefresh } from './api';
import { loadSession, saveSession, clearSession, type SessionState } from './session-store';
import { setRefIndex, type RefIndexEntry } from './ref-index-store';
import { resolveQQBotAccount, resolveDefaultQQBotAccountId, DEFAULT_ACCOUNT_ID } from './config';
import { normalizeMediaTags } from './utils/media-tags';
import { readFileAsync } from './utils/file-utils';

// Constants
const HEARTBEAT_INTERVAL = 30 * 1000; // 30 seconds (will be updated by HELLO)
const RECONNECT_DELAY_BASE = 1000; // 1 second base delay
const MAX_RECONNECT_ATTEMPTS = 10;
const EVENT_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const EVENT_CACHE_CLEANUP_INTERVAL = 60 * 1000; // 1 minute

// Message queue for outgoing messages
interface MessageQueueItem {
  chatId: string;
  message: IUnifiedOutgoingMessage;
  resolve: (messageId: string) => void;
  reject: (error: Error) => void;
  retries: number;
  timestamp: number;
}

// Reply limit tracking
interface ReplyLimitInfo {
  count: number;
  windowStart: number;
}

const REPLY_LIMIT_MAX = 20; // Max messages per window
const REPLY_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute window

interface ITokenCache {
  accessToken: string;
  expiresAt: number;
}

interface ISessionCache {
  messageId: string;
  chatId: string;
  timestamp: number;
}

export class QQBotPlugin extends BasePlugin {
  readonly type: PluginType = 'qqbot';

  // WebSocket connection
  private ws: WebSocket | null = null;
  private isConnected = false;
  private isReconnecting = false;
  private isResuming = false;
  private reconnectAttempts = 0;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private eventCleanupTimer: ReturnType<typeof setInterval> | null = null;

  // Credentials
  private appId = '';
  private appSecret = '';
  private accountId = DEFAULT_ACCOUNT_ID;

  // Session info
  private sessionId: string | null = null;
  private sequenceNumber: number | null = null;
  private heartbeatIntervalMs = HEARTBEAT_INTERVAL;

  // Intent level for progressive downgrade
  private intentLevelIndex = 0;

  // Token cache
  private tokenCache: ITokenCache | null = null;

  // Event deduplication
  private processedEvents: Map<string, number> = new Map();

  // Active users tracking
  private activeUsers: Set<string> = new Set();

  // Session cache for tracking sent messages
  private sessionCache: Map<string, ISessionCache> = new Map();

  // Message queue for outgoing messages
  private messageQueue: MessageQueueItem[] = [];
  private isProcessingQueue = false;
  private queueProcessingInterval: ReturnType<typeof setInterval> | null = null;

  // Reply limits
  private replyLimits: Map<string, ReplyLimitInfo> = new Map();

  // ==================== Lifecycle Methods ====================

  protected async onInitialize(config: IChannelPluginConfig): Promise<void> {
    const resolvedAccount = resolveQQBotAccount(config, this.accountId);
    const appId = resolvedAccount.appId;
    const clientSecret = resolvedAccount.clientSecret;

    if (!appId || !clientSecret) {
      throw new Error('QQ Bot App ID and App Secret are required');
    }

    this.appId = appId;
    this.appSecret = clientSecret;
    this.accountId = resolvedAccount.accountId;

    // Initialize API config
    initApiConfig({ markdownSupport: resolvedAccount.markdownSupport });

    // Register outbound message callback for refIdx tracking
    onMessageSent((refIdx: string, meta: OutboundMeta) => {
      const entry: RefIndexEntry = {
        content: meta.text || '',
        senderId: this.appId,
        senderName: 'Bot',
        timestamp: Date.now(),
        isBot: true,
        attachments: meta.mediaType
          ? [
              {
                type: meta.mediaType,
                url: meta.mediaUrl,
                localPath: meta.mediaLocalPath,
                transcript: meta.ttsText,
                transcriptSource: meta.ttsText ? 'tts' : undefined,
              },
            ]
          : undefined,
      };
      setRefIndex(refIdx, entry);
    });

    // Try to load persisted session
    const savedSession = loadSession(this.accountId, this.appId);
    if (savedSession) {
      this.sessionId = savedSession.sessionId;
      this.sequenceNumber = savedSession.lastSeq;
      this.intentLevelIndex = savedSession.intentLevelIndex;
      console.log(`[QQBotPlugin] Loaded persisted session: ${this.sessionId}, seq: ${this.sequenceNumber}`);
    }
  }

  protected async onStart(): Promise<void> {
    try {
      // Start background token refresh
      startBackgroundTokenRefresh(this.appId, this.appSecret);

      // Get gateway URL and connect
      const token = await getAccessToken(this.appId, this.appSecret);
      const wsUrl = await getGatewayUrl(token);
      await this.connectWebSocket(wsUrl);

      // Start event cleanup timer
      this.startEventCleanup();

      // Start message queue processor
      this.startQueueProcessor();

      console.log(`[QQBotPlugin] Started for app ${this.appId} (account: ${this.accountId})`);
    } catch (error) {
      console.error('[QQBotPlugin] Failed to start:', error);
      throw error;
    }
  }

  protected async onStop(): Promise<void> {
    // Stop queue processor
    this.stopQueueProcessor();

    // Stop event cleanup
    this.stopEventCleanup();

    // Stop heartbeat
    this.stopHeartbeat();

    // Close WebSocket
    this.closeWebSocket(1000, 'Plugin stopped');

    // Reset state
    this.isConnected = false;
    this.isReconnecting = false;
    this.isResuming = false;
    this.reconnectAttempts = 0;
    this.sessionId = null;
    this.sequenceNumber = null;
    this.tokenCache = null;
    this.activeUsers.clear();
    this.sessionCache.clear();
    this.messageQueue = [];
    this.replyLimits.clear();

    // Stop background token refresh
    stopBackgroundTokenRefresh(this.appId);

    // Save session before stopping
    if (this.sessionId && this.sequenceNumber !== null) {
      saveSession({
        sessionId: this.sessionId,
        lastSeq: this.sequenceNumber,
        lastConnectedAt: Date.now(),
        intentLevelIndex: this.intentLevelIndex,
        accountId: this.accountId,
        savedAt: Date.now(),
        appId: this.appId,
      });
    }

    console.log('[QQBotPlugin] Stopped and cleaned up');
  }

  // ==================== WebSocket Connection ====================

  private async connectWebSocket(url: string): Promise<void> {
    // Close any existing WebSocket to prevent orphaned handlers
    this.closeWebSocket(1000, 'New connection');

    return new Promise((resolve, reject) => {
      try {
        const ws = new WebSocket(url);
        this.ws = ws;
        let settled = false;

        const cleanup = (): void => {
          clearInterval(checkReady);
          clearTimeout(timeout);
        };

        const settle = (fn: typeof resolve | ((reason?: unknown) => void), value?: unknown): void => {
          if (settled) return;
          settled = true;
          cleanup();
          (fn as (v?: unknown) => void)(value);
        };

        ws.on('open', () => {
          console.log('[QQBotPlugin] WebSocket connected');
        });

        ws.on('message', (data: Buffer) => {
          if (this.ws !== ws) return;
          try {
            const payload = JSON.parse(data.toString()) as QQBotGatewayPayload;
            void this.handlePayload(payload).catch((error) => {
              console.error('[QQBotPlugin] Error handling payload:', error);
            });
          } catch (error) {
            console.error('[QQBotPlugin] Failed to parse WebSocket message:', error);
          }
        });

        ws.on('close', (code: number, reason: Buffer) => {
          if (this.ws !== ws) return;
          console.log(`[QQBotPlugin] WebSocket closed: ${code} ${reason.toString()}`);
          this.isConnected = false;
          this.ws = null;
          this.stopHeartbeat();

          // If connectWebSocket is still pending, reject its promise
          const wasEstablished = settled;
          settle(reject, new Error(`WebSocket closed: ${code} ${reason.toString()}`));

          // Only auto-reconnect for established connections (not during initial connect)
          if (wasEstablished && code !== 1000 && code !== 1001) {
            void this.attemptReconnect();
          }
        });

        ws.on('error', (error: Error) => {
          if (this.ws !== ws) return;
          console.error('[QQBotPlugin] WebSocket error:', error);
          settle(reject, error);
        });

        // Wait for READY/RESUMED event before resolving
        const checkReady = setInterval(() => {
          if (this.isConnected) {
            settle(resolve);
          }
        }, 100);

        // Timeout after 30 seconds
        const timeout = setTimeout(() => {
          if (!this.isConnected) {
            this.closeWebSocket(1000, 'Connection timeout');
            settle(reject, new Error('Connection timeout waiting for READY'));
          }
        }, 30000);
      } catch (error) {
        reject(error);
      }
    });
  }

  private closeWebSocket(code: number, reason: string): void {
    if (this.ws) {
      try {
        this.ws.close(code, reason);
      } catch {
        // Ignore close errors
      }
      this.ws = null;
    }
  }

  private async attemptReconnect(): Promise<void> {
    if (this.isReconnecting || this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        console.error('[QQBotPlugin] Max reconnection attempts reached');
        this.setStatus('error', 'Connection lost - max retries exceeded');
      }
      return;
    }

    this.isReconnecting = true;
    this.reconnectAttempts++;

    // Exponential backoff with jitter
    const delay = RECONNECT_DELAY_BASE * Math.pow(2, this.reconnectAttempts - 1) * (0.5 + Math.random());
    console.log(`[QQBotPlugin] Reconnecting in ${Math.round(delay)}ms (attempt ${this.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);

    await new Promise((resolve) => setTimeout(resolve, delay));

    try {
      // Try to resume session if we have session_id
      if (this.sessionId) {
        await this.resumeSession();
      } else {
        // Full reconnect - get new token and connect
        const token = await getAccessToken(this.appId, this.appSecret);
        const wsUrl = await getGatewayUrl(token);
        await this.connectWebSocket(wsUrl);
      }
      this.isReconnecting = false;
      this.reconnectAttempts = 0;
    } catch (error) {
      this.isReconnecting = false;
      void this.attemptReconnect();
    }
  }

  private async resumeSession(): Promise<void> {
    await getAccessToken(this.appId, this.appSecret);
    this.isResuming = true;
    try {
      const token = await getAccessToken(this.appId, this.appSecret);
      const wsUrl = await getGatewayUrl(token);
      await this.connectWebSocket(wsUrl);
    } finally {
      this.isResuming = false;
    }
  }

  // ==================== Payload Handling ====================

  private async handlePayload(payload: QQBotGatewayPayload): Promise<void> {
    switch (payload.op) {
      case QQBotOpcode.HELLO:
        await this.handleHello(payload.d as { heartbeat_interval: number });
        break;
      case QQBotOpcode.DISPATCH:
        await this.handleDispatch(payload);
        break;
      case QQBotOpcode.HEARTBEAT_ACK:
        // Heartbeat acknowledged, do nothing
        break;
      case QQBotOpcode.RECONNECT:
        console.log('[QQBotPlugin] Server requested reconnect');
        try {
          this.ws?.close(4007, 'Server requested reconnect');
        } catch {
          /* ignore */
        }
        break;
      case QQBotOpcode.INVALID_SESSION: {
        const canResume = payload.d as boolean;
        console.log(`[QQBotPlugin] Invalid session, can resume: ${canResume}`);
        if (!canResume) {
          this.sessionId = null;
          this.sequenceNumber = null;
          this.isResuming = false;
          // Try next intent level down
          if (this.intentLevelIndex < QQBOT_INTENT_LEVELS.length - 1) {
            this.intentLevelIndex++;
            const next = QQBOT_INTENT_LEVELS[this.intentLevelIndex];
            console.log(`[QQBotPlugin] Downgrading intents to: ${next.description}`);
          }
        }
        try {
          this.ws?.close(4009, 'Invalid session');
        } catch {
          /* ignore */
        }
        break;
      }
      default:
        console.log(`[QQBotPlugin] Unhandled opcode: ${payload.op}`);
    }
  }

  private async handleHello(data: { heartbeat_interval: number }): Promise<void> {
    this.heartbeatIntervalMs = data.heartbeat_interval || HEARTBEAT_INTERVAL;

    if (this.isResuming && this.sessionId) {
      // Resume existing session
      const token = await getAccessToken(this.appId, this.appSecret);
      const resumePayload: QQBotGatewayPayload = {
        op: QQBotOpcode.RESUME,
        d: {
          token: `QQBot ${token}`,
          session_id: this.sessionId,
          seq: this.sequenceNumber,
        },
      };
      this.sendPayload(resumePayload);
    } else {
      // New connection - send IDENTIFY with current intent level
      const intentLevel = QQBOT_INTENT_LEVELS[Math.min(this.intentLevelIndex, QQBOT_INTENT_LEVELS.length - 1)];
      console.log(`[QQBotPlugin] Sending IDENTIFY with intents: ${intentLevel.intents} (${intentLevel.description})`);
      const token = await getAccessToken(this.appId, this.appSecret);
      const identifyPayload: QQBotGatewayPayload = {
        op: QQBotOpcode.IDENTIFY,
        d: {
          token: `QQBot ${token}`,
          intents: intentLevel.intents,
          shard: [0, 1],
        },
      };
      this.sendPayload(identifyPayload);
    }
  }

  private async handleDispatch(payload: QQBotGatewayPayload): Promise<void> {
    // Update sequence number
    if (payload.s !== undefined) {
      this.sequenceNumber = payload.s;
    }

    const eventType = payload.t;
    const eventId = (payload.d as { id?: string })?.id || `${eventType}_${this.sequenceNumber}`;

    // Event deduplication
    if (eventId && this.isEventProcessed(eventId)) {
      return;
    }
    if (eventId) {
      this.markEventProcessed(eventId);
    }

    // Handle READY event
    if (eventType === 'READY') {
      const readyData = payload.d as { session_id: string; user?: { id: string; username: string } };
      this.sessionId = readyData.session_id;
      this.isConnected = true;
      this.startHeartbeat();

      // Save session
      saveSession({
        sessionId: this.sessionId,
        lastSeq: this.sequenceNumber || 0,
        lastConnectedAt: Date.now(),
        intentLevelIndex: this.intentLevelIndex,
        accountId: this.accountId,
        savedAt: Date.now(),
        appId: this.appId,
      });

      console.log(`[QQBotPlugin] Session ready: ${this.sessionId}`);
      return;
    }

    // Handle RESUMED event
    if (eventType === 'RESUMED') {
      this.isConnected = true;
      this.isReconnecting = false;
      this.reconnectAttempts = 0;

      // Update session
      if (this.sessionId) {
        saveSession({
          sessionId: this.sessionId,
          lastSeq: this.sequenceNumber || 0,
          lastConnectedAt: Date.now(),
          intentLevelIndex: this.intentLevelIndex,
          accountId: this.accountId,
          savedAt: Date.now(),
          appId: this.appId,
        });
      }

      console.log('[QQBotPlugin] Session resumed');
      return;
    }

    // Handle message events
    if (eventType?.includes('MESSAGE')) {
      const message = payload.d as QQBotMessage;
      await this.handleMessage(message, eventType);
    }
  }

  private async handleMessage(message: QQBotMessage, eventType: string): Promise<void> {
    try {
      const chatType = detectMessageType(eventType);
      const userId = message.author?.id || message.openid || message.group_member_openid || '';

      if (userId) {
        this.activeUsers.add(userId);
      }

      const unifiedMessage = toUnifiedIncomingMessage(message, eventType);
      if (unifiedMessage) {
        await this.emitMessage(unifiedMessage);
      }
    } catch (error) {
      console.error('[QQBotPlugin] Error handling message:', error);
    }
  }

  // ==================== Heartbeat ====================

  private startHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }

    this.heartbeatInterval = setInterval(() => {
      this.sendHeartbeat();
    }, this.heartbeatIntervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  private sendHeartbeat(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    const heartbeat: QQBotGatewayPayload = {
      op: QQBotOpcode.HEARTBEAT,
      d: this.sequenceNumber,
    };

    this.sendPayload(heartbeat);
  }

  private sendPayload(payload: QQBotGatewayPayload): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }

  // ==================== Event Deduplication ====================

  private isEventProcessed(eventId: string): boolean {
    return this.processedEvents.has(eventId);
  }

  private markEventProcessed(eventId: string): void {
    this.processedEvents.set(eventId, Date.now());
  }

  private startEventCleanup(): void {
    if (this.eventCleanupTimer) return;

    this.eventCleanupTimer = setInterval(() => {
      this.cleanupOldEvents();
    }, EVENT_CACHE_CLEANUP_INTERVAL);
  }

  private stopEventCleanup(): void {
    if (this.eventCleanupTimer) {
      clearInterval(this.eventCleanupTimer);
      this.eventCleanupTimer = null;
    }
  }

  private cleanupOldEvents(): void {
    const now = Date.now();

    for (const [eventId, timestamp] of this.processedEvents.entries()) {
      if (now - timestamp > EVENT_CACHE_TTL) {
        this.processedEvents.delete(eventId);
      }
    }
  }

  // ==================== Message Queue ====================

  private startQueueProcessor(): void {
    if (this.queueProcessingInterval) return;

    this.queueProcessingInterval = setInterval(() => {
      this.processMessageQueue();
    }, 500); // Check queue every 500ms
  }

  private stopQueueProcessor(): void {
    if (this.queueProcessingInterval) {
      clearInterval(this.queueProcessingInterval);
      this.queueProcessingInterval = null;
    }
  }

  private async processMessageQueue(): Promise<void> {
    if (this.isProcessingQueue || this.messageQueue.length === 0) {
      return;
    }

    this.isProcessingQueue = true;

    try {
      while (this.messageQueue.length > 0) {
        const item = this.messageQueue[0];

        // Check reply limits
        const canSend = this.checkReplyLimit(item.chatId);
        if (!canSend) {
          // Wait a bit before retrying
          await new Promise((resolve) => setTimeout(resolve, 1000));
          continue;
        }

        try {
          const messageId = await this.sendMessageInternal(item.chatId, item.message);
          this.messageQueue.shift();
          item.resolve(messageId);
          this.incrementReplyLimit(item.chatId);
        } catch (error) {
          this.messageQueue.shift();
          item.reject(error instanceof Error ? error : new Error(String(error)));
        }
      }
    } finally {
      this.isProcessingQueue = false;
    }
  }

  private checkReplyLimit(chatId: string): boolean {
    const now = Date.now();
    const limit = this.replyLimits.get(chatId);

    if (!limit) {
      return true;
    }

    // Check if window has expired
    if (now - limit.windowStart > REPLY_LIMIT_WINDOW_MS) {
      this.replyLimits.set(chatId, { count: 1, windowStart: now });
      return true;
    }

    return limit.count < REPLY_LIMIT_MAX;
  }

  private incrementReplyLimit(chatId: string): void {
    const now = Date.now();
    const limit = this.replyLimits.get(chatId);

    if (!limit || now - limit.windowStart > REPLY_LIMIT_WINDOW_MS) {
      this.replyLimits.set(chatId, { count: 1, windowStart: now });
    } else {
      limit.count++;
    }
  }

  // ==================== Message Sending ====================

  async sendMessage(chatId: string, message: IUnifiedOutgoingMessage): Promise<string> {
    // Normalize media tags in message text
    const normalizedMessage = {
      ...message,
      text: message.text ? normalizeMediaTags(message.text) : undefined,
    };

    // Add to queue
    return new Promise((resolve, reject) => {
      this.messageQueue.push({
        chatId,
        message: normalizedMessage,
        resolve,
        reject,
        retries: 0,
        timestamp: Date.now(),
      });
    });
  }

  private async sendMessageInternal(chatId: string, message: IUnifiedOutgoingMessage): Promise<string> {
    const token = await getAccessToken(this.appId, this.appSecret);
    const { type, id, subId } = parseChatId(chatId);

    // Check for media attachments in message
    const queueItems = toQQBotSendParams(message);

    // Handle queue items (media uploads)
    if (queueItems.mediaItems && queueItems.mediaItems.length > 0) {
      return this.sendMediaMessage(token, type, id, subId || id, queueItems);
    }

    // Regular text message
    const { contentType, content } = queueItems;

    let response: QQBotApiResponse;

    switch (type) {
      case 'c2c':
        response = await sendC2CMessage(token, id, content.content as string);
        break;
      case 'group':
        response = await sendGroupMessage(token, id, content.content as string);
        break;
      case 'guild':
        response = await sendChannelMessage(token, subId || id, content.content as string);
        break;
      default:
        throw new Error(`Unknown chat type: ${type}`);
    }

    const messageId = response?.id || `qq_${Date.now()}`;

    // Cache session for tracking
    this.sessionCache.set(messageId, {
      messageId,
      chatId,
      timestamp: Date.now(),
    });

    return messageId;
  }

  private async sendMediaMessage(token: string, chatType: 'c2c' | 'group' | 'guild', targetId: string, channelId: string, queueItems: QQBotSendQueueItem): Promise<string> {
    const { text, mediaItems } = queueItems;

    if (!mediaItems || mediaItems.length === 0) {
      throw new Error('No media items to send');
    }

    const mediaItem = mediaItems[0];
    let messageId = '';

    switch (mediaItem.type) {
      case 'image': {
        const imageUrl = await this.resolveMediaSource(mediaItem);
        if (chatType === 'c2c') {
          const result = await sendC2CImageMessage(token, targetId, imageUrl, undefined, text);
          messageId = result.id;
        } else if (chatType === 'group') {
          const result = await sendGroupImageMessage(token, targetId, imageUrl, undefined, text);
          messageId = result.id;
        }
        break;
      }

      case 'voice': {
        const voiceData = await this.resolveMediaSource(mediaItem);
        if (chatType === 'c2c') {
          const result = await sendC2CVoiceMessage(token, targetId, voiceData, undefined, mediaItem.text);
          messageId = result.id;
        } else if (chatType === 'group') {
          const result = await sendGroupVoiceMessage(token, targetId, voiceData);
          messageId = result.id;
        }
        break;
      }

      case 'video': {
        const videoUrl = await this.resolveMediaSource(mediaItem);
        if (chatType === 'c2c') {
          const result = await sendC2CVideoMessage(token, targetId, videoUrl, undefined, text);
          messageId = result.id;
        } else if (chatType === 'group') {
          const result = await sendGroupVideoMessage(token, targetId, videoUrl, undefined, text);
          messageId = result.id;
        }
        break;
      }

      case 'file': {
        const fileUrl = await this.resolveMediaSource(mediaItem);
        if (chatType === 'c2c') {
          const result = await sendC2CFileMessage(token, targetId, undefined, fileUrl, undefined, mediaItem.fileName);
          messageId = result.id;
        } else if (chatType === 'group') {
          const result = await sendGroupFileMessage(token, targetId, undefined, fileUrl, undefined, mediaItem.fileName);
          messageId = result.id;
        }
        break;
      }

      default:
        throw new Error(`Unsupported media type: ${mediaItem.type}`);
    }

    if (!messageId) {
      throw new Error('Failed to send media message');
    }

    return messageId;
  }

  private async resolveMediaSource(item: QQBotSendQueueItem['mediaItems'][0]): Promise<string> {
    const { source, sourceType } = item;

    if (sourceType === 'url') {
      return source;
    }

    if (sourceType === 'local_path' || sourceType === 'base64') {
      // For local files, return as-is (api functions will handle reading)
      return source;
    }

    // Default: assume it's a URL
    return source;
  }

  async editMessage(chatId: string, messageId: string, message: IUnifiedOutgoingMessage): Promise<void> {
    // QQ Bot API doesn't support editing messages
    // Send a new message with updated content instead
    console.log('[QQBotPlugin] Edit not supported by QQ Bot API, sending new message');
    await this.sendMessage(chatId, message);
  }

  // ==================== Plugin Info ====================

  getActiveUserCount(): number {
    return this.activeUsers.size;
  }

  getBotInfo(): BotInfo | null {
    if (!this.appId) return null;
    return {
      id: this.appId,
      displayName: 'QQ Bot',
    };
  }

  // ==================== Static Methods ====================

  static async testConnection(token: string): Promise<{ success: boolean; botInfo?: { name?: string }; error?: string }> {
    // For QQ Bot, token is actually appId:appSecret format
    const [appId, appSecret] = token.split(':');
    if (!appId || !appSecret) {
      return { success: false, error: 'Invalid token format. Expected: appId:appSecret' };
    }

    try {
      const accessToken = await getAccessToken(appId, appSecret);
      if (accessToken) {
        return { success: true, botInfo: { name: 'QQ Bot' } };
      }
      return {
        success: false,
        error: 'Failed to get access token',
      };
    } catch (error: unknown) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to connect to QQ Bot API',
      };
    }
  }
}
