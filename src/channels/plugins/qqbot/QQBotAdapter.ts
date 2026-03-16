/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { IMessageAction, IUnifiedIncomingMessage, IUnifiedMessageContent, IUnifiedOutgoingMessage, IUnifiedUser } from '../../types';

// ==================== Constants ====================

/**
 * QQ Bot message length limit
 */
export const QQBOT_MESSAGE_LIMIT = 4000;

// QQ Bot API Gateway URL
export const QQBOT_GATEWAY_URL = 'wss://api.sgroup.qq.com/websocket';

// QQ Bot API base URLs
export const QQBOT_API_BASE = 'https://api.sgroup.qq.com';
export const QQBOT_TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken';

// ==================== Message Types ====================

/**
 * QQ Bot message type constants
 * 0: plain text
 * 2: markdown
 * 3: ark
 * 4: embed
 * 6: input_notify (typing indicator)
 * 7: media (file/image)
 */
export const QQBotMessageType = {
  TEXT: 0,
  MARKDOWN: 2,
  ARK: 3,
  EMBED: 4,
  INPUT_NOTIFY: 6,
  MEDIA: 7,
} as const;

// ==================== QQ Bot Types ====================

/**
 * QQ Bot Gateway payload (WebSocket message)
 */
export interface QQBotGatewayPayload {
  op: number; // Opcode
  d?: unknown; // Data
  s?: number; // Sequence number
  t?: string; // Event type
  id?: string; // Event ID
}

/**
 * QQ Bot opcodes
 */
export enum QQBotOpcode {
  DISPATCH = 0, // Receive
  HEARTBEAT = 1, // Send/Receive
  IDENTIFY = 2, // Send
  RESUME = 6, // Send
  RECONNECT = 7, // Receive
  INVALID_SESSION = 9, // Receive
  HELLO = 10, // Receive
  HEARTBEAT_ACK = 11, // Receive
  HTTP_CALLBACK_ACK = 12, // Send
}

/**
 * QQ Bot intents (event subscriptions)
 * Using 0 (no special intents) for simplicity as per reference implementation
 */
export enum QQBotIntent {
  GUILDS = 1 << 0,
  GUILD_MEMBERS = 1 << 1,
  GUILD_MESSAGES = 1 << 9,
  GUILD_MESSAGE_REACTIONS = 1 << 10,
  DIRECT_MESSAGE = 1 << 12,
  C2C_MESSAGE = 1 << 25,
  GROUP_MESSAGE = 1 << 26,
}

/**
 * QQ Bot event types
 */
export type QQBotEventType =
  | 'C2C_MESSAGE_CREATE' // Private chat message
  | 'GROUP_AT_MESSAGE_CREATE' // Group @ mention message
  | 'AT_MESSAGE_CREATE' // Guild @ mention message
  | 'DIRECT_MESSAGE_CREATE' // Guild direct message
  | 'GUILD_MESSAGE_CREATE' // Guild channel message
  | 'READY' // Connection ready
  | 'RESUMED' // Connection resumed
  | string;

/**
 * QQ Bot message structure
 */
export interface QQBotMessage {
  id: string;
  author?: {
    id: string;
    username?: string;
    avatar?: string;
  };
  content?: string;
  timestamp?: string;
  msg_type?: number; // 0=text, 2=markdown, 3=ark, 4=embed, 6=input_notify, 7=media
  message_reference?: {
    message_id: string;
  };
  // For C2C messages
  openid?: string;
  // For group messages
  group_openid?: string;
  group_member_openid?: string;
  // For guild/channel messages
  guild_id?: string;
  channel_id?: string;
  member?: {
    nick?: string;
  };
  // Rich content
  attachments?: Array<{
    url: string;
    content_type?: string;
    filename?: string;
    size?: number;
    width?: number;
    height?: number;
  }>;
}

/**
 * QQ Bot API response structure
 */
export interface QQBotApiResponse {
  id?: string;
  code?: number;
  message?: string;
  data?: unknown;
  // Token response fields
  access_token?: string;
  expires_in?: number;
}

// ==================== Helper Types ====================

export type QQBotChatType = 'c2c' | 'group' | 'guild';

export interface ParsedChatId {
  type: QQBotChatType;
  id: string;
  subId?: string; // channel_id for guild messages
}

// ==================== Incoming Message Conversion ====================

/**
 * Encode chatId based on message type
 * Format:
 * - C2C: c2c:{openid}
 * - Group: group:{group_openid}
 * - Guild: guild:{guild_id}:{channel_id}
 */
export function encodeChatId(message: QQBotMessage, type: QQBotChatType): string {
  switch (type) {
    case 'c2c':
      return `c2c:${message.openid || message.author?.id || ''}`;
    case 'group':
      return `group:${message.group_openid || ''}`;
    case 'guild':
      return `guild:${message.guild_id || ''}:${message.channel_id || ''}`;
    default:
      return `c2c:${message.openid || ''}`;
  }
}

/**
 * Parse encoded chatId
 */
export function parseChatId(chatId: string): ParsedChatId {
  if (chatId.startsWith('c2c:')) {
    return { type: 'c2c', id: chatId.slice(4) };
  }
  if (chatId.startsWith('group:')) {
    return { type: 'group', id: chatId.slice(6) };
  }
  if (chatId.startsWith('guild:')) {
    const parts = chatId.slice(6).split(':');
    return { type: 'guild', id: parts[0], subId: parts[1] };
  }
  // Default to c2c for unknown format
  return { type: 'c2c', id: chatId };
}

/**
 * Convert QQ Bot message to unified user
 */
export function toUnifiedUser(message: QQBotMessage): IUnifiedUser | null {
  const userId = message.author?.id || message.openid || message.group_member_openid || '';
  if (!userId) return null;

  return {
    id: userId,
    username: message.author?.username,
    displayName: message.member?.nick || message.author?.username || `User ${userId.slice(-8)}`,
    avatarUrl: message.author?.avatar,
  };
}

/**
 * Detect message type from event
 */
export function detectMessageType(eventType: string): QQBotChatType {
  switch (eventType) {
    case 'C2C_MESSAGE_CREATE':
      return 'c2c';
    case 'GROUP_AT_MESSAGE_CREATE':
      return 'group';
    case 'AT_MESSAGE_CREATE':
    case 'DIRECT_MESSAGE_CREATE':
    case 'GUILD_MESSAGE_CREATE':
      return 'guild';
    default:
      return 'c2c';
  }
}

/**
 * Extract message content from QQ Bot message
 */
function extractMessageContent(message: QQBotMessage): IUnifiedMessageContent {
  const msgType = message.msg_type ?? QQBotMessageType.TEXT;

  switch (msgType) {
    case QQBotMessageType.TEXT:
    case QQBotMessageType.MARKDOWN: {
      let text = message.content || '';
      // Remove @bot mentions in group chats (pattern: <@!user_id>)
      text = text.replace(/<@!\d+>\s*/g, '').trim();
      return { type: 'text', text };
    }

    case QQBotMessageType.MEDIA:
      if (message.attachments && message.attachments.length > 0) {
        const attachment = message.attachments[0];
        const contentType = attachment.content_type || '';

        if (contentType.startsWith('image/')) {
          return {
            type: 'photo',
            text: message.content || '',
            attachments: [
              {
                type: 'photo',
                fileId: attachment.url,
                fileName: attachment.filename,
                mimeType: contentType,
                size: attachment.size,
              },
            ],
          };
        }

        if (contentType.startsWith('video/')) {
          return {
            type: 'video',
            text: message.content || '',
            attachments: [
              {
                type: 'video',
                fileId: attachment.url,
                fileName: attachment.filename,
                mimeType: contentType,
                size: attachment.size,
              },
            ],
          };
        }

        if (contentType.startsWith('audio/')) {
          return {
            type: 'audio',
            text: message.content || '',
            attachments: [
              {
                type: 'audio',
                fileId: attachment.url,
                fileName: attachment.filename,
                mimeType: contentType,
                size: attachment.size,
              },
            ],
          };
        }

        // Default to document for other types
        return {
          type: 'document',
          text: message.content || '',
          attachments: [
            {
              type: 'document',
              fileId: attachment.url,
              fileName: attachment.filename,
              mimeType: contentType,
              size: attachment.size,
            },
          ],
        };
      }
      return { type: 'text', text: message.content || '' };

    default:
      return { type: 'text', text: message.content || '' };
  }
}

/**
 * Convert QQ Bot message to unified incoming message
 */
export function toUnifiedIncomingMessage(message: QQBotMessage, eventType: string, actionInfo?: IMessageAction): IUnifiedIncomingMessage | null {
  const user = toUnifiedUser(message);
  if (!user) return null;

  const chatType = detectMessageType(eventType);
  const chatId = encodeChatId(message, chatType);

  // Handle action (button callback)
  if (actionInfo) {
    return {
      id: message.id,
      platform: 'qqbot',
      chatId,
      user,
      content: {
        type: 'action',
        text: actionInfo.name,
      },
      action: actionInfo,
      timestamp: message.timestamp ? new Date(message.timestamp).getTime() : Date.now(),
      raw: message,
    };
  }

  const content = extractMessageContent(message);

  return {
    id: message.id,
    platform: 'qqbot',
    chatId,
    user,
    content,
    timestamp: message.timestamp ? new Date(message.timestamp).getTime() : Date.now(),
    replyToMessageId: message.message_reference?.message_id,
    raw: message,
  };
}

// ==================== Outgoing Message Conversion ====================

export type QQBotContentType = 'text' | 'markdown' | 'embed' | 'ark' | 'media' | 'input_notify';

export interface QQBotSendParams {
  contentType: QQBotContentType;
  content: Record<string, unknown>;
  rawText?: string;
}

/**
 * Convert unified outgoing message to QQ Bot send parameters
 */
export function toQQBotSendParams(message: IUnifiedOutgoingMessage): QQBotSendParams {
  const text = message.text || '';

  // If has buttons, convert to markdown with button hints
  if (message.buttons && message.buttons.length > 0) {
    const markdownText = convertToQQBotMarkdown(text);
    const buttonHints = message.buttons.map((row, rowIdx) => row.map((btn, btnIdx) => `${btn.label} (回复 ${rowIdx + 1}.${btnIdx + 1})`).join(' | ')).join('\n');

    return {
      contentType: 'markdown',
      content: {
        content: `${markdownText}\n\n---\n${buttonHints}`,
      },
      rawText: text,
    };
  }

  // Default to text message
  return {
    contentType: 'text',
    content: { content: text },
    rawText: text,
  };
}

/**
 * Create input notify (typing indicator) parameters
 */
export function createInputNotifyParams(): QQBotSendParams {
  return {
    contentType: 'input_notify',
    content: { event_id: '1' },
  };
}

/**
 * Convert HTML/text to QQ Bot markdown format
 * QQ Bot supports a subset of markdown
 */
export function convertToQQBotMarkdown(html: string): string {
  let result = html;

  // Decode HTML entities
  result = result
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)));

  // Convert HTML tags to markdown
  result = result.replace(/<b>(.+?)<\/b>/gi, '**$1**');
  result = result.replace(/<strong>(.+?)<\/strong>/gi, '**$1**');
  result = result.replace(/<i>(.+?)<\/i>/gi, '*$1*');
  result = result.replace(/<em>(.+?)<\/em>/gi, '*$1*');
  result = result.replace(/<code>(.+?)<\/code>/gi, '`$1`');
  result = result.replace(/<pre><code>([\s\S]+?)<\/code><\/pre>/gi, '```\n$1\n```');
  result = result.replace(/<br\s*\/?>/gi, '\n');
  result = result.replace(/<p>(.+?)<\/p>/gi, '$1\n\n');

  // Convert links
  result = result.replace(/<a href="([^"]+)">(.+?)<\/a>/gi, '[$2]($1)');

  // Remove remaining HTML tags
  result = result.replace(/<[^>]+>/g, '');

  // Truncate if too long
  if (result.length > QQBOT_MESSAGE_LIMIT) {
    result = result.slice(0, QQBOT_MESSAGE_LIMIT - 3) + '...';
  }

  return result;
}

/**
 * Escape special characters for QQ Bot markdown
 */
export function escapeQQBotMarkdown(text: string): string {
  // QQ Bot markdown escape characters
  return text.replace(/[\\*_`[\]()~]/g, '\\$&');
}

// ==================== Card Action Utilities ====================

/**
 * Build card action value object
 */
export function buildCardActionValue(action: string, params?: Record<string, string>): Record<string, string> {
  return {
    action,
    ...params,
  };
}

/**
 * Extract action from QQ Bot interaction (for future button support)
 */
export function extractAction(data: Record<string, unknown>): IMessageAction | null {
  const actionName = (data.action as string) || '';
  if (!actionName) return null;

  const [prefix, name] = actionName.includes('.') ? actionName.split('.') : ['system', actionName];

  const actionParams: Record<string, string> = {};

  // Extract params from data
  Object.entries(data).forEach(([key, val]) => {
    if (key !== 'action' && typeof val === 'string') {
      actionParams[key] = val;
    }
  });

  return {
    type: prefix === 'pairing' ? 'platform' : prefix === 'chat' ? 'chat' : 'system',
    name: `${prefix}.${name}`,
    params: actionParams,
  };
}
