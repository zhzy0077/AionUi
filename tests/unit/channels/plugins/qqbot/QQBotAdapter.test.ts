/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { encodeChatId, parseChatId, toUnifiedUser, toUnifiedIncomingMessage, toQQBotSendParams, convertToQQBotMarkdown, QQBOT_MESSAGE_LIMIT, QQBotMessageType, type QQBotMessage } from '@/channels/plugins/qqbot/QQBotAdapter';

describe('QQBotAdapter', () => {
  describe('encodeChatId', () => {
    it('should encode c2c chatId', () => {
      const message: QQBotMessage = { id: '1', openid: 'user123' };
      expect(encodeChatId(message, 'c2c')).toBe('c2c:user123');
    });

    it('should encode c2c chatId with author id fallback', () => {
      const message: QQBotMessage = {
        id: '1',
        author: { id: 'author456', username: 'testuser' },
      };
      expect(encodeChatId(message, 'c2c')).toBe('c2c:author456');
    });

    it('should encode group chatId', () => {
      const message: QQBotMessage = { id: '1', group_openid: 'group456' };
      expect(encodeChatId(message, 'group')).toBe('group:group456');
    });

    it('should encode guild chatId', () => {
      const message: QQBotMessage = {
        id: '1',
        guild_id: 'guild789',
        channel_id: 'channel000',
      };
      expect(encodeChatId(message, 'guild')).toBe('guild:guild789:channel000');
    });
  });

  describe('parseChatId', () => {
    it('should parse c2c chatId', () => {
      expect(parseChatId('c2c:user123')).toEqual({ type: 'c2c', id: 'user123' });
    });

    it('should parse group chatId', () => {
      expect(parseChatId('group:group456')).toEqual({
        type: 'group',
        id: 'group456',
      });
    });

    it('should parse guild chatId', () => {
      expect(parseChatId('guild:guild789:channel000')).toEqual({
        type: 'guild',
        id: 'guild789',
        subId: 'channel000',
      });
    });

    it('should default to c2c for unknown format', () => {
      expect(parseChatId('unknown')).toEqual({ type: 'c2c', id: 'unknown' });
    });
  });

  describe('toUnifiedUser', () => {
    it('should convert message author to unified user', () => {
      const message: QQBotMessage = {
        id: '1',
        author: {
          id: 'user123',
          username: 'testuser',
          avatar: 'http://example.com/avatar.png',
        },
      };
      const user = toUnifiedUser(message);
      expect(user).toEqual({
        id: 'user123',
        username: 'testuser',
        displayName: 'testuser',
        avatarUrl: 'http://example.com/avatar.png',
      });
    });

    it('should use member nick for display name if available', () => {
      const message: QQBotMessage = {
        id: '1',
        author: { id: 'user123', username: 'testuser' },
        member: { nick: 'Nickname' },
      };
      const user = toUnifiedUser(message);
      expect(user?.displayName).toBe('Nickname');
    });

    it('should use openid if author not present', () => {
      const message: QQBotMessage = { id: '1', openid: 'user456' };
      const user = toUnifiedUser(message);
      expect(user?.id).toBe('user456');
    });

    it('should return null for empty user', () => {
      const message: QQBotMessage = { id: '1' };
      expect(toUnifiedUser(message)).toBeNull();
    });
  });

  describe('toUnifiedIncomingMessage', () => {
    it('should convert text message', () => {
      const message: QQBotMessage = {
        id: 'msg123',
        author: { id: 'user123', username: 'testuser' },
        content: 'Hello World',
        msg_type: QQBotMessageType.TEXT,
        timestamp: '2024-01-01T00:00:00.000Z',
      };
      const unified = toUnifiedIncomingMessage(message, 'C2C_MESSAGE_CREATE');
      expect(unified).toMatchObject({
        id: 'msg123',
        platform: 'qqbot',
        content: { type: 'text', text: 'Hello World' },
      });
      expect(unified?.timestamp).toBeGreaterThan(0);
    });

    it('should remove @ mentions in group messages', () => {
      const message: QQBotMessage = {
        id: 'msg123',
        author: { id: 'user123' },
        content: '<@!123456> Hello World',
        msg_type: QQBotMessageType.TEXT,
      };
      const unified = toUnifiedIncomingMessage(message, 'GROUP_AT_MESSAGE_CREATE');
      expect(unified?.content.text).toBe('Hello World');
    });

    it('should handle markdown messages', () => {
      const message: QQBotMessage = {
        id: 'msg123',
        author: { id: 'user123' },
        content: '**Bold** text',
        msg_type: QQBotMessageType.MARKDOWN,
      };
      const unified = toUnifiedIncomingMessage(message, 'C2C_MESSAGE_CREATE');
      expect(unified?.content.text).toBe('**Bold** text');
    });

    it('should handle media messages with image', () => {
      const message: QQBotMessage = {
        id: 'msg123',
        author: { id: 'user123' },
        content: 'Check this image',
        msg_type: QQBotMessageType.MEDIA,
        attachments: [
          {
            url: 'http://example.com/image.png',
            content_type: 'image/png',
            filename: 'image.png',
            size: 1024,
          },
        ],
      };
      const unified = toUnifiedIncomingMessage(message, 'C2C_MESSAGE_CREATE');
      expect(unified?.content.type).toBe('photo');
      expect(unified?.content.attachments).toHaveLength(1);
      expect(unified?.content.attachments?.[0].fileId).toBe('http://example.com/image.png');
    });

    it('should handle reply message', () => {
      const message: QQBotMessage = {
        id: 'msg123',
        author: { id: 'user123' },
        content: 'Reply text',
        msg_type: QQBotMessageType.TEXT,
        message_reference: { message_id: 'original_msg_id' },
      };
      const unified = toUnifiedIncomingMessage(message, 'C2C_MESSAGE_CREATE');
      expect(unified?.replyToMessageId).toBe('original_msg_id');
    });

    it('should handle action messages', () => {
      const message: QQBotMessage = {
        id: 'msg123',
        author: { id: 'user123' },
        content: 'action.test',
      };
      const actionInfo = { type: 'system' as const, name: 'action.test' };
      const unified = toUnifiedIncomingMessage(message, 'C2C_MESSAGE_CREATE', actionInfo);
      expect(unified?.content.type).toBe('action');
      expect(unified?.action).toEqual(actionInfo);
    });
  });

  describe('toQQBotSendParams', () => {
    it('should convert simple text message', () => {
      const result = toQQBotSendParams({ type: 'text', text: 'Hello' });
      expect(result.contentType).toBe('text');
      expect(result.content.content).toBe('Hello');
    });

    it('should convert message with buttons to markdown', () => {
      const result = toQQBotSendParams({
        type: 'text',
        text: 'Test message',
        buttons: [[{ label: 'Button 1', action: 'test.action1' }]],
      });
      expect(result.contentType).toBe('markdown');
      expect(result.content.content).toContain('Test message');
      expect(result.content.content).toContain('Button 1');
    });
  });

  describe('convertToQQBotMarkdown', () => {
    it('should convert HTML bold to markdown', () => {
      const html = '<b>Bold</b> and <strong>Strong</strong>';
      const markdown = convertToQQBotMarkdown(html);
      expect(markdown).toBe('**Bold** and **Strong**');
    });

    it('should convert HTML italic to markdown', () => {
      const html = '<i>Italic</i> and <em>Emphasis</em>';
      const markdown = convertToQQBotMarkdown(html);
      expect(markdown).toBe('*Italic* and *Emphasis*');
    });

    it('should convert HTML code to markdown', () => {
      const html = '<code>inline code</code> text';
      const markdown = convertToQQBotMarkdown(html);
      expect(markdown).toBe('`inline code` text');
    });

    it('should convert HTML links to markdown', () => {
      const html = '<a href="https://example.com">Link</a>';
      const markdown = convertToQQBotMarkdown(html);
      expect(markdown).toBe('[Link](https://example.com)');
    });

    it('should truncate long text', () => {
      const longText = 'a'.repeat(QQBOT_MESSAGE_LIMIT + 100);
      const markdown = convertToQQBotMarkdown(longText);
      expect(markdown.length).toBeLessThanOrEqual(QQBOT_MESSAGE_LIMIT);
      expect(markdown.endsWith('...')).toBe(true);
    });

    it('should handle HTML entities', () => {
      const html = 'Test &amp; Example &quot;quoted&quot;';
      const markdown = convertToQQBotMarkdown(html);
      expect(markdown).toBe('Test & Example "quoted"');
    });
  });

  describe('QQBotMessageType constants', () => {
    it('should have correct message type values', () => {
      expect(QQBotMessageType.TEXT).toBe(0);
      expect(QQBotMessageType.MARKDOWN).toBe(2);
      expect(QQBotMessageType.ARK).toBe(3);
      expect(QQBotMessageType.EMBED).toBe(4);
      expect(QQBotMessageType.INPUT_NOTIFY).toBe(6);
      expect(QQBotMessageType.MEDIA).toBe(7);
    });
  });
});
