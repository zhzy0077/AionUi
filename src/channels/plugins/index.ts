/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

export { BasePlugin } from './BasePlugin';
export type { PluginMessageHandler } from './BasePlugin';

// Telegram plugin
export { TelegramPlugin } from './telegram/TelegramPlugin';
export * from './telegram/TelegramAdapter';
export * from './telegram/TelegramKeyboards';

// DingTalk plugin
export { DingTalkPlugin } from './dingtalk/DingTalkPlugin';

// QQBot plugin
export { QQBotPlugin } from './qqbot/QQBotPlugin';
export { QQBOT_MESSAGE_LIMIT, QQBOT_API_BASE, QQBOT_TOKEN_URL, QQBOT_INTENT_LEVELS, QQBotMessageType, type QQBotGatewayPayload, type QQBotMessage, type QQBotApiResponse, type QQBotChatType, type ParsedChatId, type QQBotSendParams, QQBotOpcode, QQBotIntent } from './qqbot/QQBotAdapter';
