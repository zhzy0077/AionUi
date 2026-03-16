# QQBot Channel Integration Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrate QQ Bot API v2 as a new channel plugin for AionUi, enabling AI assistant interactions through QQ messaging platform (private chat, group chat, rich media support).

**Architecture:**

- Follow the existing Channels plugin pattern (similar to DingTalkPlugin, LarkPlugin)
- Use WebSocket connection via QQ Bot Gateway API
- Implement message adapter for unified message format conversion
- Support pairing-based user authorization
- Support text, image, and file messages (voice as stretch goal)

**Tech Stack:**

- TypeScript 5.8
- WebSocket (`ws` library) for QQ Bot Gateway
- QQ Bot API v2 (https://bot.q.qq.com/wiki/)
- Zod for response validation

**Important:** See [Review Findings & Adjustments](#review-findings--adjustments) section at the end of this plan for critical implementation details derived from code review.

---

## Chunk 1: Type Definitions and Dependencies

### Task 1.1: Add QQBot to PluginType

**Files:**

- Modify: `src/channels/types.ts:12`

- [ ] **Step 1: Add 'qqbot' to BuiltinPluginType**

```typescript
// Line 12: Change from
export type BuiltinPluginType = 'telegram' | 'slack' | 'discord' | 'lark' | 'dingtalk';
// To:
export type BuiltinPluginType = 'telegram' | 'slack' | 'discord' | 'lark' | 'dingtalk' | 'qqbot';
```

- [ ] **Step 2: Update hasPluginCredentials function**

```typescript
// Around line 50-57, add qqbot handling:
export function hasPluginCredentials(type: PluginType, credentials?: IPluginCredentials): boolean {
  if (!credentials) return false;
  if (type === 'lark') return !!(credentials.appId && credentials.appSecret);
  if (type === 'dingtalk') return !!(credentials.clientId && credentials.clientSecret);
  if (type === 'telegram') return !!credentials.token;
  // Note: QQ Bot API uses 'clientSecret' in their docs, but we use 'appSecret'
  // to maintain consistency with Lark/DingTalk patterns in AionUi
  if (type === 'qqbot') return !!(credentials.appId && credentials.appSecret);
  // Extension or unknown plugins: check if any credential value is non-empty
  return Object.values(credentials).some((v) => v !== undefined && v !== null && v !== '');
}
```

- [ ] **Step 3: Add isBuiltinChannelPlatform type guard**

```typescript
// Around line 510, update the function:
export function isBuiltinChannelPlatform(value: string): value is 'telegram' | 'lark' | 'dingtalk' | 'qqbot' {
  return value === 'telegram' || value === 'lark' || value === 'dingtalk' || value === 'qqbot';
}
```

- [ ] **Step 4: Run tests**

Run: `bun run test`
Expected: PASS (type changes shouldn't break existing tests)

- [ ] **Step 5: Commit**

```bash
git add src/channels/types.ts
git commit -m "feat(qqbot): add qqbot to builtin plugin types"
```

---

### Task 1.2: Install WebSocket Dependency

**Files:**

- Modify: `package.json`

- [ ] **Step 1: Install ws package**

```bash
bun add ws
```

- [ ] **Step 2: Install @types/ws (dev dependency)**

```bash
bun add -d @types/ws
```

- [ ] **Step 3: Verify installation**

```bash
cat package.json | grep -A 2 '"ws"'
```

Expected: Shows ws in dependencies and @types/ws in devDependencies

- [ ] **Step 4: Commit**

```bash
git add package.json bun.lock
git commit -m "chore(deps): add ws library for qqbot websocket"
```

---

## Chunk 2: QQBot Adapter

### Task 2.1: Create QQBot Types

**Files:**

- Create: `src/channels/plugins/qqbot/QQBotAdapter.ts`

- [ ] **Step 1: Write adapter file with type definitions**

See full implementation in plan document - includes:

- QQBotGatewayPayload, QQBotOpcode, QQBotIntent types
- encodeChatId, parseChatId functions
- toUnifiedUser, toUnifiedIncomingMessage converters
- toQQBotSendParams, convertToQQBotMarkdown utilities
- extractAction for button callbacks
- Message type constants (TEXT=0, MARKDOWN=2, INPUT_NOTIFY=6, MEDIA=7)
- Event type constants (C2C_MESSAGE_CREATE, GROUP_AT_MESSAGE_CREATE, DIRECT_MESSAGE_CREATE, GUILD_MESSAGE_CREATE)

- [ ] **Step 2: Create index.ts for qqbot plugin**

```typescript
export { QQBotPlugin } from './QQBotPlugin';
export * from './QQBotAdapter';
```

- [ ] **Step 3: Run lint**

Run: `bun run lint:fix`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/channels/plugins/qqbot/
git commit -m "feat(qqbot): add adapter and type definitions"
```

---

## Chunk 3: QQBot Plugin Implementation

### Task 3.1: Create QQBotPlugin Class

**Files:**

- Create: `src/channels/plugins/qqbot/QQBotPlugin.ts`

- [ ] **Step 1: Write QQBotPlugin implementation**

Includes:

- WebSocket connection management with auto-reconnect
- Event handling (C2C_MESSAGE_CREATE, GROUP_AT_MESSAGE_CREATE, etc.)
- Token refresh and session management
- Message sending for C2C, Group, Guild
- Event deduplication with 5-min TTL cache
- Static testConnection method

- [ ] **Step 2: Run lint**

Run: `bun run lint:fix`
Expected: No errors

- [ ] **Step 3: Run type check**

Run: `bunx tsc --noEmit`
Expected: No type errors

- [ ] **Step 4: Commit**

```bash
git add src/channels/plugins/qqbot/
git commit -m "feat(qqbot): implement QQBotPlugin with websocket connection"
```

---

## Chunk 4: Registration and Integration

### Task 4.1: Register QQBotPlugin

**Files:**

- Modify: `src/channels/core/ChannelManager.ts`
- Modify: `src/channels/plugins/index.ts`

- [ ] **Step 1: Import and register QQBotPlugin in ChannelManager**

Add import and register in constructor alongside existing plugins.

- [ ] **Step 2: Add QQBot to enablePlugin method**

Handle qqbot credentials (appId, appSecret) in enablePlugin.

- [ ] **Step 3: Add QQBot to testPlugin method**

Add qqbot test connection logic.

- [ ] **Step 4: Update getPluginTypeFromId method**

Add qqbot prefix handling.

- [ ] **Step 5: Export QQBotPlugin from plugins index**

- [ ] **Step 6: Run lint and type check**

Run: `bun run lint:fix && bunx tsc --noEmit`
Expected: No errors

- [ ] **Step 7: Commit**

```bash
git add src/channels/core/ChannelManager.ts src/channels/plugins/index.ts
git commit -m "feat(qqbot): register QQBotPlugin in ChannelManager"
```

---

## Chunk 5: Testing and Validation

### Task 5.1: Write Unit Tests

**Files:**

- Create: `tests/unit/channels/plugins/qqbot/QQBotAdapter.test.ts`

- [ ] **Step 1: Write adapter tests**

Test encodeChatId, parseChatId, toUnifiedUser, toUnifiedIncomingMessage, toQQBotSendParams, convertToQQBotMarkdown

- [ ] **Step 2: Run tests**

Run: `bun run test tests/unit/channels/plugins/qqbot/QQBotAdapter.test.ts`
Expected: All tests PASS

- [ ] **Step 3: Commit**

```bash
git add tests/
git commit -m "test(qqbot): add unit tests for QQBotAdapter"
```

---

## Chunk 6: Documentation

### Task 6.1: Update Architecture Documentation

**Files:**

- Modify: `src/channels/ARCHITECTURE.md`
- Create: `src/channels/plugins/qqbot/README.md`

- [ ] **Step 1: Add QQBot to architecture table**

- [ ] **Step 2: Add QQBotPlugin to directory structure**

- [ ] **Step 3: Add QQBot section to plugin details**

- [ ] **Step 4: Create QQBot README**

- [ ] **Step 5: Commit**

---

## Chunk 7: Settings UI Integration

### Task 7.1: Add i18n Translations

**Files:**

- Modify: `src/renderer/i18n/locales/en.json`
- Modify: `src/renderer/i18n/locales/zh-CN.json`

- [ ] **Step 1: Add English and Chinese translations**

- [ ] **Step 2: Commit**

---

## Chunk 8: Final Validation

### Task 8.1: Full Test Suite

- [ ] **Step 1: Run all tests** - `bun run test`
- [ ] **Step 2: Run lint** - `bun run lint:fix`
- [ ] **Step 3: Run type check** - `bunx tsc --noEmit`
- [ ] **Step 4: Build project** - `bun run build`

---

## Implementation Notes

### Key Design Decisions

1. **WebSocket over HTTP**: QQ Bot API v2 uses WebSocket Gateway for real-time events
2. **No Message Editing**: QQ Bot API doesn't support editing - streaming sends new messages
3. **Session Management**: Uses session_id for reconnection with exponential backoff
4. **Event Deduplication**: 5-minute TTL cache for event IDs
5. **Chat ID Encoding**: `c2c:{openid}`, `group:{group_openid}`, `guild:{guild_id}:{channel_id}`

### Limitations

- Voice message STT/TTS not in MVP
- Image generation/sending not in MVP
- Rich media handling limited to receiving URLs

### Future Enhancements

**Phase 2 (Post-MVP):**

- Voice message support (requires `silk-wasm` dependency for SILK codec)
- Image upload/send (via URL or base64)
- Text-to-speech with SILK encoding
- Reference index tracking (`ref_idx`) for message threading
- Upload caching (file hash-based to avoid re-upload)

**Phase 3 (Advanced):**

- Image understanding (via Gemini vision)
- Video upload support
- Interactive buttons via Markdown
- Multi-account support (account ID-based routing)

---

## Review Findings & Adjustments

### Review Summary

This plan was reviewed against the reference implementation at https://github.com/sliverp/QQBot.

### Critical Adjustments Made

#### 1. Missing Event Types

**Added:** `DIRECT_MESSAGE_CREATE` (guild DMs) - for complete guild support alongside existing C2C and Group events.

**Event Coverage:**

- ✅ `C2C_MESSAGE_CREATE` — Private chat messages
- ✅ `GROUP_AT_MESSAGE_CREATE` — Group @ mention messages
- ✅ `DIRECT_MESSAGE_CREATE` — Guild direct messages
- ✅ `GUILD_MESSAGE_CREATE` — Guild channel messages

#### 2. Message Type Constants

**Added:** `INPUT_NOTIFY` (type 6) for typing indicators — useful for streaming responses to show the bot is "typing".

```typescript
export const QQBotMessageType = {
  TEXT: 0,
  MARKDOWN: 2,
  INPUT_NOTIFY: 6, // Typing indicator
  MEDIA: 7,
} as const;
```

#### 3. Intents Strategy

**Decision:** Use `0` (no special intents) for simplicity, matching the reference implementation.

Rationale: The reference uses `0` for basic messaging. Specific intents (C2C_MESSAGE | GROUP_MESSAGE | DIRECT_MESSAGE) would require the bot to be in specific modes. Using `0` ensures compatibility with all bot configurations.

#### 4. Credential Naming

**Decision:** Use `appSecret` (not `clientSecret`) for consistency with Lark/DingTalk patterns in AionUi.

While the reference uses `clientSecret`, we maintain `appSecret` to align with existing codebase conventions. This is documented in the type definitions.

#### 5. Chat ID Format

**Format used:** `c2c:{openid}`, `group:{group_openid}`, `guild:{guild_id}:{channel_id}`

The reference uses `qqbot:c2c:OPENID` prefix, but we use the simpler format as internal AionUi convention. The adapter handles all translation correctly.

### API Endpoints (Verified)

```
POST https://bots.qq.com/app/getAppAccessToken  // Token endpoint
GET  https://api.sgroup.qq.com/gateway          // Gateway URL
POST /v2/users/{openid}/messages                // C2C send
POST /v2/groups/{group_openid}/messages         // Group send
POST /channels/{channel_id}/messages            // Guild send
```

### Architecture Alignment

| Aspect              | Plan            | Reference         | Status        |
| ------------------- | --------------- | ----------------- | ------------- |
| Plugin Type         | 'qqbot'         | 'qqbot'           | ✅ Match      |
| Transport           | WebSocket (ws)  | WebSocket (ws)    | ✅ Match      |
| Token Management    | Manual refresh  | Manual refresh    | ✅ Match      |
| Event Deduplication | 5-min TTL cache | Event ID tracking | ✅ Equivalent |
| Message Editing     | Not supported   | Not supported     | ✅ Match      |

### What Was NOT Added (MVP Scope)

These features exist in the reference but are out of MVP scope:

- **Rich Media Upload:** Image/video/file upload with SILK encoding
- **STT/TTS:** Plugin-side speech-to-text and text-to-speech
- **Background Token Refresh:** Automatic refresh 5 min before expiry
- **Upload Caching:** File hash-based deduplication
- **Reference Index Store:** `ref_idx` for message threading

These are tracked in the Future Enhancements section above.
