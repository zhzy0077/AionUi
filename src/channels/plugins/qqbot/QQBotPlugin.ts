/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import WebSocket from 'ws';
import https from 'https';
import type { BotInfo, IChannelPluginConfig, IUnifiedOutgoingMessage, PluginType } from '../../types';
import { BasePlugin } from '../BasePlugin';
import { QQBOT_GATEWAY_URL, QQBOT_API_BASE, QQBOT_TOKEN_URL, QQBOT_MESSAGE_LIMIT, QQBotOpcode, QQBotMessageType, type QQBotGatewayPayload, type QQBotMessage, type QQBotApiResponse, encodeChatId, parseChatId, toUnifiedIncomingMessage, toQQBotSendParams, detectMessageType } from './QQBotAdapter';

/**
 * QQBotPlugin - QQ Bot integration for Personal Assistant
 *
 * Uses QQ Bot API v2 with WebSocket Gateway connection.
 * Supports C2C private chat, group @ messages, and guild channel messages.
 */

// Constants
const HEARTBEAT_INTERVAL = 30 * 1000; // 30 seconds (will be updated by HELLO)
const RECONNECT_DELAY_BASE = 1000; // 1 second base delay
const MAX_RECONNECT_ATTEMPTS = 10;
const EVENT_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const EVENT_CACHE_CLEANUP_INTERVAL = 60 * 1000; // 1 minute

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

  private ws: WebSocket | null = null;
  private isConnected = false;
  private isReconnecting = false;
  private reconnectAttempts = 0;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private eventCleanupTimer: ReturnType<typeof setInterval> | null = null;

  // Credentials
  private appId = '';
  private appSecret = '';

  // Session info
  private sessionId: string | null = null;
  private sequenceNumber: number | null = null;
  private heartbeatIntervalMs = HEARTBEAT_INTERVAL;

  // Token cache
  private tokenCache: ITokenCache | null = null;

  // Event deduplication
  private processedEvents: Map<string, number> = new Map();

  // Active users tracking
  private activeUsers: Set<string> = new Set();

  // Session cache for tracking sent messages
  private sessionCache: Map<string, ISessionCache> = new Map();

  // ==================== Lifecycle Methods ====================

  protected async onInitialize(config: IChannelPluginConfig): Promise<void> {
    const appId = config.credentials?.appId;
    const appSecret = config.credentials?.appSecret;

    if (!appId || !appSecret) {
      throw new Error('QQ Bot App ID and App Secret are required');
    }

    this.appId = appId;
    this.appSecret = appSecret;
  }

  protected async onStart(): Promise<void> {
    try {
      // Get access token first
      await this.refreshAccessToken();

      // Connect to WebSocket
      const wsUrl = QQBOT_GATEWAY_URL;
      await this.connectWebSocket(wsUrl);

      // Start event cleanup
      this.startEventCleanup();

      console.log(`[QQBotPlugin] Started for app ${this.appId}`);
    } catch (error) {
      console.error('[QQBotPlugin] Failed to start:', error);
      throw error;
    }
  }

  protected async onStop(): Promise<void> {
    this.stopEventCleanup();
    this.stopHeartbeat();
    this.closeWebSocket(1000, 'Plugin stopped');
    this.isConnected = false;
    this.isReconnecting = false;
    this.reconnectAttempts = 0;
    this.sessionId = null;
    this.sequenceNumber = null;
    this.tokenCache = null;
    this.activeUsers.clear();
    this.sessionCache.clear();

    console.log('[QQBotPlugin] Stopped and cleaned up');
  }

  // ==================== WebSocket Connection ====================

  private async connectWebSocket(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(url);

        this.ws.on('open', () => {
          console.log('[QQBotPlugin] WebSocket connected');
        });

        this.ws.on('message', (data: Buffer) => {
          try {
            const payload = JSON.parse(data.toString()) as QQBotGatewayPayload;
            void this.handlePayload(payload).catch((error) => {
              console.error('[QQBotPlugin] Error handling payload:', error);
            });
          } catch (error) {
            console.error('[QQBotPlugin] Failed to parse WebSocket message:', error);
          }
        });

        this.ws.on('close', (code: number, reason: Buffer) => {
          console.log(`[QQBotPlugin] WebSocket closed: ${code} ${reason.toString()}`);
          this.isConnected = false;
          this.stopHeartbeat();

          // Attempt reconnection if not intentionally stopped
          if (code !== 1000 && code !== 1001) {
            void this.attemptReconnect();
          }
        });

        this.ws.on('error', (error: Error) => {
          console.error('[QQBotPlugin] WebSocket error:', error);
          reject(error);
        });

        // Wait for READY event before resolving
        const checkReady = setInterval(() => {
          if (this.isConnected) {
            clearInterval(checkReady);
            resolve();
          }
        }, 100);

        // Timeout after 30 seconds
        setTimeout(() => {
          clearInterval(checkReady);
          if (!this.isConnected) {
            reject(new Error('Connection timeout waiting for READY'));
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
        await this.refreshAccessToken();
        const wsUrl = QQBOT_GATEWAY_URL;
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
    // Resume session using existing session_id and sequence_number
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      const wsUrl = QQBOT_GATEWAY_URL;
      await this.connectWebSocket(wsUrl);
    }

    const resumePayload: QQBotGatewayPayload = {
      op: QQBotOpcode.RESUME,
      d: {
        token: `QQBot ${this.appId}.${this.tokenCache?.accessToken || ''}`,
        session_id: this.sessionId,
        seq: this.sequenceNumber,
      },
    };

    this.sendPayload(resumePayload);
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
        void this.attemptReconnect();
        break;
      case QQBotOpcode.INVALID_SESSION:
        console.log('[QQBotPlugin] Invalid session, clearing session data');
        this.sessionId = null;
        this.sequenceNumber = null;
        void this.attemptReconnect();
        break;
      default:
        console.log(`[QQBotPlugin] Unhandled opcode: ${payload.op}`);
    }
  }

  private async handleHello(data: { heartbeat_interval: number }): Promise<void> {
    this.heartbeatIntervalMs = data.heartbeat_interval || HEARTBEAT_INTERVAL;

    // Send IDENTIFY
    const identifyPayload: QQBotGatewayPayload = {
      op: QQBotOpcode.IDENTIFY,
      d: {
        token: `QQBot ${this.appId}.${this.tokenCache?.accessToken || ''}`,
        // Using 0 for intents as per reference implementation
        intents: 0,
        shard: [0, 1],
        properties: {
          $os: process.platform,
          $browser: 'aionui',
          $device: 'aionui',
        },
      },
    };

    this.sendPayload(identifyPayload);
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
      console.log(`[QQBotPlugin] Session ready: ${this.sessionId}`);
      return;
    }

    // Handle RESUMED event
    if (eventType === 'RESUMED') {
      this.isConnected = true;
      this.isReconnecting = false;
      this.reconnectAttempts = 0;
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

  // ==================== Token Management ====================

  private async refreshAccessToken(): Promise<void> {
    try {
      const response = await this.httpPost(QQBOT_TOKEN_URL, {
        appId: this.appId,
        clientSecret: this.appSecret,
      });

      if (response?.access_token) {
        this.tokenCache = {
          accessToken: response.access_token,
          expiresAt: Date.now() + (response.expires_in || 7200) * 1000,
        };
      } else {
        throw new Error('No access token in response');
      }
    } catch (error) {
      console.error('[QQBotPlugin] Failed to refresh access token:', error);
      throw error;
    }
  }

  private async ensureAccessToken(): Promise<string> {
    const now = Date.now();
    // Refresh if token expires in less than 60 seconds
    if (!this.tokenCache || this.tokenCache.expiresAt - now < 60 * 1000) {
      await this.refreshAccessToken();
    }
    return this.tokenCache?.accessToken || '';
  }

  // ==================== Message Sending ====================

  async sendMessage(chatId: string, message: IUnifiedOutgoingMessage): Promise<string> {
    await this.ensureAccessToken();

    const { type, id, subId } = parseChatId(chatId);
    const { contentType, content } = toQQBotSendParams(message);

    let response: QQBotApiResponse;

    switch (type) {
      case 'c2c':
        response = await this.sendC2CMessage(id, contentType, content);
        break;
      case 'group':
        response = await this.sendGroupMessage(id, contentType, content);
        break;
      case 'guild':
        response = await this.sendGuildMessage(subId || id, contentType, content);
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

  async editMessage(chatId: string, messageId: string, message: IUnifiedOutgoingMessage): Promise<void> {
    // QQ Bot API doesn't support editing messages
    // Send a new message with updated content instead
    console.log('[QQBotPlugin] Edit not supported by QQ Bot API, sending new message');
    await this.sendMessage(chatId, message);
  }

  private async sendC2CMessage(openid: string, contentType: string, content: Record<string, unknown>): Promise<QQBotApiResponse> {
    const baseUrl = QQBOT_API_BASE;
    const token = await this.ensureAccessToken();

    const body: Record<string, unknown> = {
      ...content,
      msg_type: this.getMsgType(contentType),
    };

    return this.apiRequest('POST', `/v2/users/${openid}/messages`, token, body);
  }

  private async sendGroupMessage(groupOpenid: string, contentType: string, content: Record<string, unknown>): Promise<QQBotApiResponse> {
    const baseUrl = QQBOT_API_BASE;
    const token = await this.ensureAccessToken();

    const body: Record<string, unknown> = {
      ...content,
      msg_type: this.getMsgType(contentType),
    };

    return this.apiRequest('POST', `/v2/groups/${groupOpenid}/messages`, token, body);
  }

  private async sendGuildMessage(channelId: string, contentType: string, content: Record<string, unknown>): Promise<QQBotApiResponse> {
    const baseUrl = QQBOT_API_BASE;
    const token = await this.ensureAccessToken();

    const body: Record<string, unknown> = {
      ...content,
      msg_type: this.getMsgType(contentType),
    };

    return this.apiRequest('POST', `/channels/${channelId}/messages`, token, body);
  }

  private getMsgType(contentType: string): number {
    switch (contentType) {
      case 'text':
        return QQBotMessageType.TEXT;
      case 'markdown':
        return QQBotMessageType.MARKDOWN;
      case 'ark':
        return QQBotMessageType.ARK;
      case 'embed':
        return QQBotMessageType.EMBED;
      case 'media':
        return QQBotMessageType.MEDIA;
      case 'input_notify':
        return QQBotMessageType.INPUT_NOTIFY;
      default:
        return QQBotMessageType.TEXT;
    }
  }

  // ==================== HTTP Helpers ====================

  private async apiRequest(method: string, path: string, token: string, body?: Record<string, unknown>): Promise<QQBotApiResponse> {
    const baseUrl = QQBOT_API_BASE;
    const url = `${baseUrl}${path}`;

    return this.httpRequest(method, url, body, {
      Authorization: `QQBot ${this.appId}.${token}`,
      'Content-Type': 'application/json',
    });
  }

  private async httpPost(url: string, body: Record<string, unknown>): Promise<QQBotApiResponse> {
    return this.httpRequest('POST', url, body, {
      'Content-Type': 'application/json',
    });
  }

  private async httpRequest(method: string, url: string, body?: Record<string, unknown>, headers?: Record<string, string>): Promise<QQBotApiResponse> {
    return new Promise((resolve, reject) => {
      const urlObj = new URL(url);
      const data = body ? JSON.stringify(body) : undefined;

      const options = {
        hostname: urlObj.hostname,
        port: urlObj.port || 443,
        path: urlObj.pathname + urlObj.search,
        method,
        headers: {
          ...headers,
          ...(data ? { 'Content-Length': Buffer.byteLength(data).toString() } : {}),
        },
      };

      const req = https.request(options, (res) => {
        let responseData = '';
        res.on('data', (chunk) => {
          responseData += chunk;
        });
        res.on('end', () => {
          try {
            const parsed = responseData ? JSON.parse(responseData) : {};
            if (res.statusCode && res.statusCode >= 400) {
              reject(new Error(`HTTP ${res.statusCode}: ${JSON.stringify(parsed)}`));
            } else {
              resolve(parsed);
            }
          } catch {
            resolve(responseData as unknown as QQBotApiResponse);
          }
        });
      });

      req.on('error', reject);
      req.setTimeout(30000, () => {
        req.destroy(new Error('Request timeout'));
      });

      if (data) {
        req.write(data);
      }
      req.end();
    });
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

  static async testConnection(appId: string, appSecret?: string): Promise<{ success: boolean; botInfo?: { name?: string }; error?: string }> {
    if (!appSecret) {
      return { success: false, error: 'App Secret is required for QQ Bot' };
    }

    try {
      const response = await new Promise<QQBotApiResponse>((resolve, reject) => {
        const data = JSON.stringify({
          appId,
          clientSecret: appSecret,
        });

        const options = {
          hostname: 'bots.qq.com',
          port: 443,
          path: '/app/getAppAccessToken',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(data).toString(),
          },
        };

        const req = https.request(options, (res) => {
          let responseData = '';
          res.on('data', (chunk) => {
            responseData += chunk;
          });
          res.on('end', () => {
            try {
              resolve(JSON.parse(responseData));
            } catch {
              reject(new Error('Invalid response'));
            }
          });
        });

        req.on('error', reject);
        req.setTimeout(10000, () => {
          req.destroy(new Error('Connection timeout'));
        });
        req.write(data);
        req.end();
      });

      if (response?.access_token) {
        return { success: true, botInfo: { name: 'QQ Bot' } };
      }

      return {
        success: false,
        error: response?.message || 'Failed to get access token',
      };
    } catch (error: any) {
      return {
        success: false,
        error: error.message || 'Failed to connect to QQ Bot API',
      };
    }
  }
}
