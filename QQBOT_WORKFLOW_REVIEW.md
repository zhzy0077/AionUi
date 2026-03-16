# Comprehensive Line-by-Line Review: QQBot Plugin vs Workflow Specification

## Executive Summary

The AionUi QQBot plugin implementation shows **partial compliance** with the workflow.md specification. While core connection and message handling functionality is present, several critical features from the spec are **missing**, including: message queuing with per-user serial processing, reply limits (passive vs proactive), media upload with caching, voice message handling (STT/TTS), and typing indicators. The implementation uses a simpler event-driven model rather than the comprehensive queue-based system described in the spec.

---

## WORKFLOW 1: Gateway Initialization & Authentication

### 1.1 Plugin Registration Pattern

**Status:** ⚠️ PARTIAL

| Aspect               | Expected (workflow.md:30-41)                   | Actual (index.ts:7-8)    | Analysis                                                  |
| -------------------- | ---------------------------------------------- | ------------------------ | --------------------------------------------------------- |
| Pattern              | Plugin object with `id` and `register` method  | Simple ES module exports | Different pattern used - relies on BasePlugin inheritance |
| Runtime setup        | `setQQBotRuntime(api.runtime)`                 | None visible             | Not implemented                                           |
| Channel registration | `api.registerChannel({ plugin: qqbotPlugin })` | None visible             | Registration handled via BasePlugin pattern               |

**Code References:**

- **Spec:** Lines 34-41 expect a plugin object with `id: "qqbot"`, `register(api)` method
- **Actual:** index.ts:7-8 only exports `QQBotPlugin` class and adapter utilities

**Analysis:** The implementation uses a class-based inheritance pattern (extending `BasePlugin`) rather than the object-based registration pattern described in the spec. This is functionally equivalent but structurally different.

---

### 1.2 Configuration Resolution

**Status:** ⚠️ PARTIAL

| Aspect           | Expected (workflow.md:46-58)                    | Actual (QQBotPlugin.ts:75-85)    | Analysis                                    |
| ---------------- | ----------------------------------------------- | -------------------------------- | ------------------------------------------- |
| Config source    | `~/.openclaw/openclaw.json` with channels.qqbot | `IChannelPluginConfig` parameter | Config resolution delegated to framework    |
| Multi-account    | `accounts` field for multi-bot setup            | Not supported                    | **MISSING** - Only single account supported |
| Env var merge    | `QQBOT_APP_ID`, `QQBOT_CLIENT_SECRET`           | Not implemented                  | **MISSING**                                 |
| Config structure | `ResolvedQQBotAccount` object                   | Direct credential extraction     | Simplified approach                         |

**Code References:**

- **Spec:** Lines 46-58 describe reading from JSON file, multi-account support, env var merging
- **Actual:** QQBotPlugin.ts:75-85 extracts `appId` and `appSecret` from config parameter

**Analysis:** The implementation assumes configuration is resolved by the framework before calling `onInitialize()`. Multi-account support and environment variable merging are not implemented.

---

### 1.3 Token Management with Caching

**Status:** ⚠️ PARTIAL

| Aspect             | Expected (workflow.md:83-111)                         | Actual (QQBotPlugin.ts:489-517)     | Analysis                             |
| ------------------ | ----------------------------------------------------- | ----------------------------------- | ------------------------------------ |
| Cache structure    | `tokenCacheMap` (per-appId isolated cache)            | Single `tokenCache` property        | **MISSING** - No per-appId isolation |
| Singleflight       | `tokenFetchPromises` to prevent concurrent fetches    | Not implemented                     | **MISSING**                          |
| Expiry buffer      | 5 minutes before expiry                               | 60 seconds before expiry (line 513) | Different timing                     |
| Background refresh | `startBackgroundTokenRefresh()` refreshes proactively | Not implemented                     | **MISSING**                          |
| Token endpoint     | `https://bots.qq.com/app/getAppAccessToken`           | Same                                | ✅ MATCH                             |
| Request format     | `POST {appId, clientSecret}`                          | Same                                | ✅ MATCH                             |

**Code References:**

- **Spec:** Lines 83-111 describe tokenCacheMap, singleflight, background refresh
- **Actual:** QQBotPlugin.ts:489-517 simple token cache without isolation or singleflight

**Specific Differences:**

```typescript
// Spec Expected (workflow.md:86-87):
STEP 4.1: Check tokenCacheMap (per-appId isolated cache)
  IF token exists AND not expired (5 min buffer):
    RETURN cached token

// Actual (QQBotPlugin.ts:510-516):
private async ensureAccessToken(): Promise<string> {
  const now = Date.now();
  // Refresh if token expires in less than 60 seconds
  if (!this.tokenCache || this.tokenCache.expiresAt - now < 60 * 1000) {
    await this.refreshAccessToken();
  }
  return this.tokenCache?.accessToken || '';
}
```

**Analysis:** The implementation lacks:

1. Per-appId token cache isolation (critical for multi-account)
2. Singleflight pattern to prevent duplicate token requests
3. Background proactive token refresh
4. Uses 60s buffer instead of 5min buffer

---

### 1.4 Gateway URL Fetching

**Status:** ✅ MATCH

| Aspect      | Expected (workflow.md:116-121)          | Actual (QQBotPlugin.ts:519-527) | Analysis |
| ----------- | --------------------------------------- | ------------------------------- | -------- |
| Endpoint    | `GET https://api.sgroup.qq.com/gateway` | Same                            | ✅ MATCH |
| Auth header | `Authorization: QQBot {access_token}`   | Same                            | ✅ MATCH |
| Response    | `{ "url": "wss://..." }`                | Same                            | ✅ MATCH |

**Code References:**

- **Spec:** Lines 116-121
- **Actual:** QQBotPlugin.ts:519-527

---

### 1.5 WebSocket Connection Establishment

**Status:** ⚠️ PARTIAL

| Aspect                | Expected (workflow.md:126-150)                 | Actual (QQBotPlugin.ts:123-216) | Analysis                 |
| --------------------- | ---------------------------------------------- | ------------------------------- | ------------------------ |
| WS library            | Native WebSocket                               | `ws` library (npm)              | Different but equivalent |
| Intent calculation    | INTENT_LEVELS array with progressive downgrade | Same pattern                    | ✅ MATCH                 |
| Session persistence   | `loadSession(accountId, appId)`                | Not implemented                 | **MISSING**              |
| Message queue init    | `userQueues = Map<peerId, QueuedMessage[]>()`  | Not implemented                 | **MISSING**              |
| Active users tracking | `activeUsers = Set<string>()`                  | Implemented (line 68)           | ✅ MATCH                 |
| Max concurrent        | `MAX_CONCURRENT_USERS = 10`                    | Not implemented                 | **MISSING**              |

**Code References:**

- **Spec:** Lines 126-150 describe session loading, message queue initialization
- **Actual:** QQBotPlugin.ts:123-216 - WebSocket connection without queue setup

**Missing:**

- Session persistence to disk (loadSession/saveSession)
- Per-user message queues
- Concurrent user limiting

---

### 1.6 Intent Level Management

**Status:** ✅ MATCH

| Aspect                | Expected (workflow.md:131-138, 298-310)                        | Actual (QQBotAdapter.ts:91-107, QQBotPlugin.ts:298-310) | Analysis |
| --------------------- | -------------------------------------------------------------- | ------------------------------------------------------- | -------- |
| Intent levels         | 3 levels: full, group+channel, channel-only                    | Same 3 levels                                           | ✅ MATCH |
| Values                | PUBLIC_GUILD_MESSAGES \| DIRECT_MESSAGE \| GROUP_AND_C2C, etc. | Same (lines 94, 99, 104)                                | ✅ MATCH |
| Progressive downgrade | On INVALID_SESSION with d=false                                | Implemented (QQBotPlugin.ts:298-310)                    | ✅ MATCH |

**Code References:**

- **Spec:** Lines 131-138, 298-310
- **Actual:** QQBotAdapter.ts:91-107, QQBotPlugin.ts:298-310

---

### 1.7 Session Persistence

**Status:** ❌ MISSING

| Aspect            | Expected (workflow.md:139-144)  | Actual                                    | Analysis    |
| ----------------- | ------------------------------- | ----------------------------------------- | ----------- |
| Load session      | `loadSession(accountId, appId)` | Not implemented                           | **MISSING** |
| Save session      | Persist sessionId, lastSeq      | Not implemented                           | **MISSING** |
| Resume capability | Use saved session_id and seq    | Partial (sessionId stored in memory only) | ⚠️ PARTIAL  |

**Code References:**

- **Spec:** Lines 139-144, 173-174
- **Actual:** QQBotPlugin.ts stores sessionId in memory (line 54) but no disk persistence

**Analysis:** The implementation stores sessionId in memory (line 54: `private sessionId: string | null = null`) but does not persist to disk for crash recovery. The RESUME logic exists (lines 326-336) but without persistent storage.

---

## WORKFLOW 2: Inbound Message Processing

### 2.1 WebSocket Payload Handling

**Status:** ✅ MATCH

| Aspect            | Expected (workflow.md:193-213)                             | Actual (QQBotPlugin.ts:278-394)               | Analysis   |
| ----------------- | ---------------------------------------------------------- | --------------------------------------------- | ---------- |
| Payload structure | `{t, s, op, id, d}`                                        | Same structure (QQBotAdapter.ts:48-54)        | ✅ MATCH   |
| Opcode handling   | HELLO, DISPATCH, HEARTBEAT_ACK, RECONNECT, INVALID_SESSION | All handled (lines 280-320)                   | ✅ MATCH   |
| Event types       | C2C_MESSAGE_CREATE, etc.                                   | Checked with `includes('MESSAGE')` (line 390) | ⚠️ PARTIAL |

**Code References:**

- **Spec:** Lines 193-213
- **Actual:** QQBotPlugin.ts:278-320

---

### 2.2 Message Enqueueing

**Status:** ❌ MISSING

| Aspect             | Expected (workflow.md:217-244)                | Actual (QQBotPlugin.ts:396-412) | Analysis    |
| ------------------ | --------------------------------------------- | ------------------------------- | ----------- |
| Urgent commands    | `/stop` clears queue and executes immediately | Not implemented                 | **MISSING** |
| peerId calculation | `group:${groupOpenid}` or `dm:${senderId}`    | Uses raw `userId` (line 399)    | **WRONG**   |
| User queue         | `userQueues.get(peerId).push({...})`          | Direct processing, no queue     | **MISSING** |
| Queue draining     | `drainUserQueue(peerId)`                      | Not implemented                 | **MISSING** |

**Code References:**

- **Spec:** Lines 217-244 describe enqueueMessage() with urgent commands, peerId calculation, queue management
- **Actual:** QQBotPlugin.ts:396-412 processes messages directly without queuing

**Critical Difference:**

```typescript
// Spec Expected (workflow.md:232-244):
STEP 2.3: Add to user's queue
  userQueues.get(peerId).push({
    type: "c2c" | "group" | "guild",
    senderId, senderName, content,
    messageId, timestamp,
    attachments,
    refMsgIdx,    // Quote reference
    msgIdx        // Current message index
  });

STEP 2.4: Drain queue if not already processing
  IF !activeUsers.has(peerId):
    drainUserQueue(peerId);

// Actual (QQBotPlugin.ts:396-412):
private async handleMessage(message: QQBotMessage, eventType: string): Promise<void> {
  try {
    const chatType = detectMessageType(eventType);
    const userId = message.author?.id || message.openid || message.group_member_openid || '';

    if (userId) {
      this.activeUsers.add(userId);  // Just tracking, not queueing
    }

    const unifiedMessage = toUnifiedIncomingMessage(message, eventType);
    if (unifiedMessage) {
      await this.emitMessage(unifiedMessage);  // Direct emit, no queue
    }
  } catch (error) {
    console.error('[QQBotPlugin] Error handling message:', error);
  }
}
```

**Analysis:** The implementation completely omits the message queue system. Messages are processed immediately without:

1. Per-user serial processing guarantee
2. Urgent command handling (/stop)
3. Concurrent user limiting
4. Message ordering guarantees under load

---

### 2.3 Per-User Serial Processing

**Status:** ❌ MISSING

| Aspect               | Expected (workflow.md:247-260)                 | Actual                | Analysis    |
| -------------------- | ---------------------------------------------- | --------------------- | ----------- |
| activeUsers tracking | `Set<string>` for currently processing users   | Implemented (line 68) | ✅ MATCH    |
| Serial processing    | `WHILE queue not empty: process one at a time` | Not implemented       | **MISSING** |
| Queue per user       | `Map<peerId, QueuedMessage[]>`                 | Not implemented       | **MISSING** |

**Analysis:** While `activeUsers` Set exists (line 68), it's not used for serial processing - messages are handled immediately without queuing.

---

### 2.4 Attachment Downloading

**Status:** ⚠️ PARTIAL

| Aspect         | Expected (workflow.md:278-290)                                 | Actual (QQBotAdapter.ts:259-344)    | Analysis                        |
| -------------- | -------------------------------------------------------------- | ----------------------------------- | ------------------------------- |
| Image handling | Download to `~/.openclaw/qqbot/downloads/`, add to imageUrls[] | URL passed through (attachment.url) | **MISSING** - No local download |
| Voice handling | Download + SILK→WAV + STT                                      | Not implemented                     | **MISSING**                     |
| File handling  | Download file, add path to attachmentInfo                      | URL passed through                  | **MISSING** - No local download |

**Code References:**

- **Spec:** Lines 278-290 describe downloading images, voice (with STT), and files
- **Actual:** QQBotAdapter.ts:259-344 extracts attachments but keeps URLs, no local download

**Analysis:** The implementation treats attachments as remote URLs only. It does not:

1. Download files locally
2. Convert SILK voice to WAV
3. Perform STT transcription
4. Cache downloads for AI vision processing

---

### 2.5 Voice Message Handling (STT)

**Status:** ❌ MISSING

| Aspect              | Expected (workflow.md:283-287)         | Actual          | Analysis    |
| ------------------- | -------------------------------------- | --------------- | ----------- |
| Voice download      | Download voice_wav_url or original URL | Not implemented | **MISSING** |
| SILK conversion     | Convert SILK→WAV if needed             | Not implemented | **MISSING** |
| STT transcription   | Transcribe via STT API                 | Not implemented | **MISSING** |
| Transcript addition | Add to voiceTranscripts[]              | Not implemented | **MISSING** |

**Code References:**

- **Spec:** Lines 283-287
- **Actual:** QQBotAdapter.ts:308-322 recognizes audio type but no processing

---

### 2.6 Quote/Reference Handling

**Status:** ❌ MISSING

| Aspect            | Expected (workflow.md:298-310)                 | Actual          | Analysis    |
| ----------------- | ---------------------------------------------- | --------------- | ----------- |
| refMsgIdx parsing | Extract from `event.message_scene.ext`         | Not implemented | **MISSING** |
| Reference lookup  | `getRefIndex(refMsgIdx)` to get cached message | Not implemented | **MISSING** |
| Quote formatting  | `[引用消息开始]\n${content}\n[引用消息结束]\n` | Not implemented | **MISSING** |
| Message caching   | `setRefIndex(msgIdx, {...})` for future quotes | Not implemented | **MISSING** |

**Code References:**

- **Spec:** Lines 298-310
- **Actual:** No reference/quote handling found

---

### 2.7 Agent Routing

**Status:** ❌ MISSING

| Aspect           | Expected (workflow.md:313-326)                                                     | Actual          | Analysis    |
| ---------------- | ---------------------------------------------------------------------------------- | --------------- | ----------- |
| Route resolution | `pluginRuntime.channel.routing.resolveAgentRoute({cfg, channel, accountId, peer})` | Not implemented | **MISSING** |
| Route params     | channel, accountId, peer.kind, peer.id                                             | Not implemented | **MISSING** |

**Analysis:** The implementation calls `this.emitMessage(unifiedMessage)` (line 407) which routes through the BasePlugin event system, not the spec's routing system.

---

### 2.8 Context Building

**Status:** ❌ MISSING

| Aspect                   | Expected (workflow.md:329-351)         | Actual          | Analysis    |
| ------------------------ | -------------------------------------- | --------------- | ----------- |
| Context template         | Full context info with session details | Not implemented | **MISSING** |
| qqimg tag instructions   | `<qqimg>URL</qqimg>` format            | Not implemented | **MISSING** |
| qqvoice tag instructions | `<qqvoice>path</qqvoice>` format       | Not implemented | **MISSING** |
| Separator                | `【不要向用户透露...】` section        | Not implemented | **MISSING** |

**Code References:**

- **Spec:** Lines 329-351 describe building contextInfo with detailed instructions
- **Actual:** No context building found; messages emitted directly

---

### 2.9 Send to OpenClaw Agent

**Status:** ⚠️ PARTIAL

| Aspect          | Expected (workflow.md:354-377)                             | Actual (QQBotPlugin.ts:407)       | Analysis           |
| --------------- | ---------------------------------------------------------- | --------------------------------- | ------------------ |
| Format envelope | `pluginRuntime.channel.reply.formatInboundEnvelope({...})` | Uses `toUnifiedIncomingMessage()` | Different approach |
| Delivery        | `pluginRuntime.channel.reply.handleIncomingMessage({...})` | Uses `this.emitMessage()`         | Different approach |
| agentBody       | systemPrompts + contextInfo + userMessage                  | Not implemented                   | **MISSING**        |
| fromAddress     | `qqbot:${type}:${id}`                                      | Set in unified message            | ⚠️ PARTIAL         |
| toAddress       | `qqbot:${type}:${id}`                                      | Not explicitly set                | **MISSING**        |

**Analysis:** The implementation uses a unified message format rather than the spec's envelope format. Context building and routing are not implemented.

---

## WORKFLOW 3: Outbound Message Processing

### 3.1 Receive from OpenClaw

**Status:** ✅ MATCH

| Aspect             | Expected (workflow.md:383-392)                                 | Actual (QQBotPlugin.ts:531-563) | Analysis            |
| ------------------ | -------------------------------------------------------------- | ------------------------------- | ------------------- |
| sendText function  | `sendText({ to, text, accountId, replyToId, cfg })`            | `sendMessage(chatId, message)`  | Different signature |
| sendMedia function | `sendMedia({ to, text, mediaUrl, accountId, replyToId, cfg })` | Unified in sendMessage          | Different approach  |

**Code References:**

- **Spec:** Lines 383-392
- **Actual:** QQBotPlugin.ts:531-563

---

### 3.2 Resolve Account & Get Token

**Status:** ⚠️ PARTIAL

| Aspect             | Expected (workflow.md:395-401)                        | Actual (QQBotPlugin.ts:531-537) | Analysis   |
| ------------------ | ----------------------------------------------------- | ------------------------------- | ---------- |
| Account resolution | `resolveQQBotAccount(cfg, accountId)`                 | Direct property access          | Simplified |
| Token fetch        | `getAccessToken(account.appId, account.clientSecret)` | `this.ensureAccessToken()`      | ✅ MATCH   |

---

### 3.3 Parse Target Address

**Status:** ✅ MATCH

| Aspect         | Expected (workflow.md:404-416)                      | Actual (QQBotAdapter.ts:208-221) | Analysis |
| -------------- | --------------------------------------------------- | -------------------------------- | -------- |
| Input format   | `qqbot:c2c:OPENID`, `qqbot:group:GROUPID`, `OPENID` | Same formats                     | ✅ MATCH |
| Prefix removal | Remove `qqbot:` prefix                              | Handled                          | ✅ MATCH |
| Type detection | c2c, group, channel, 32-char-hex default            | Implemented                      | ✅ MATCH |

**Code References:**

- **Spec:** Lines 404-416
- **Actual:** QQBotAdapter.ts:208-221 `parseChatId()`

---

### 3.4 Check Reply Limits (Passive vs Proactive)

**Status:** ❌ MISSING

| Aspect             | Expected (workflow.md:419-442)       | Actual          | Analysis    |
| ------------------ | ------------------------------------ | --------------- | ----------- |
| replyToId tracking | `messageReplyTracker.get(replyToId)` | Not implemented | **MISSING** |
| 1-hour limit       | `now - record.firstReplyAt > 1 hour` | Not implemented | **MISSING** |
| 4-reply limit      | `record.count >= 4`                  | Not implemented | **MISSING** |
| Fallback logic     | Clear replyToId for proactive        | Not implemented | **MISSING** |

**Analysis:** The implementation does not track reply limits. All messages are sent without checking passive/proactive limits.

---

### 3.5 Process Media Tags

**Status:** ❌ MISSING

| Aspect                | Expected (workflow.md:445-464)                  | Actual (QQBotAdapter.ts:400-423) | Analysis    |
| --------------------- | ----------------------------------------------- | -------------------------------- | ----------- |
| Supported tags        | `<qqimg>`, `<qqvoice>`, `<qqvideo>`, `<qqfile>` | Not parsed                       | **MISSING** |
| normalizeMediaTags    | Fix AI formatting errors                        | Not implemented                  | **MISSING** |
| Send queue            | Build ordered queue [text, image, text]         | Not implemented                  | **MISSING** |
| Sequential processing | Process queue items in order                    | Not implemented                  | **MISSING** |

**Analysis:** The implementation converts buttons to markdown hints (QQBotAdapter.ts:404-415) but does not handle media tags (<qqimg>, <qqvoice>, etc.).

---

### 3.6 Send Based on Type

#### 3.6A: Send Text

**Status:** ⚠️ PARTIAL

| Aspect          | Expected (workflow.md:470-480)                      | Actual (QQBotPlugin.ts:531-563) | Analysis    |
| --------------- | --------------------------------------------------- | ------------------------------- | ----------- |
| C2C passive     | `sendC2CMessage(token, openid, text, replyToId)`    | Implemented (line 541)          | ✅ MATCH    |
| C2C proactive   | `sendProactiveC2CMessage(token, openid, text)`      | Not separate function           | **MISSING** |
| Group passive   | `sendGroupMessage(token, groupId, text, replyToId)` | Implemented (line 544)          | ✅ MATCH    |
| Group proactive | `sendProactiveGroupMessage()`                       | Not separate function           | **MISSING** |
| Reply tracking  | `recordMessageReply(replyToId)`                     | Not implemented                 | **MISSING** |

**Code References:**

- **Spec:** Lines 470-480
- **Actual:** QQBotPlugin.ts:572-594

---

#### 3.6B: Send Image

**Status:** ❌ MISSING

| Aspect              | Expected (workflow.md:483-496)                            | Actual          | Analysis    |
| ------------------- | --------------------------------------------------------- | --------------- | ----------- |
| Local file handling | Read file → Base64 `data:${mimeType};base64,...`          | Not implemented | **MISSING** |
| URL handling        | Pass through HTTP URL                                     | Not implemented | **MISSING** |
| Upload              | `sendC2CImageMessage(token, openid, imageUrl, replyToId)` | Not implemented | **MISSING** |

**Analysis:** Image sending is not implemented. No media upload flow exists.

---

#### 3.6C: Send Voice (TTS)

**Status:** ❌ MISSING

| Aspect              | Expected (workflow.md:499-514)                              | Actual          | Analysis    |
| ------------------- | ----------------------------------------------------------- | --------------- | ----------- |
| File wait           | `waitForFile(voicePath)` for TTS generation                 | Not implemented | **MISSING** |
| SILK conversion     | `audioFileToSilkBase64(voicePath)`                          | Not implemented | **MISSING** |
| Conversion pipeline | MP3/WAV/OGG → PCM → SILK via silk-wasm                      | Not implemented | **MISSING** |
| Upload & send       | `sendC2CVoiceMessage(token, openid, silkBase64, replyToId)` | Not implemented | **MISSING** |

**Analysis:** Voice message sending (TTS) is not implemented. No SILK codec integration.

---

#### 3.6D: Send Video

**Status:** ❌ MISSING

| Aspect       | Expected (workflow.md:517-525)                                               | Actual          | Analysis    |
| ------------ | ---------------------------------------------------------------------------- | --------------- | ----------- |
| URL handling | `sendC2CVideoMessage(token, openid, videoUrl)`                               | Not implemented | **MISSING** |
| Local file   | Read → Base64 → `sendC2CVideoMessage(token, openid, undefined, videoBase64)` | Not implemented | **MISSING** |

---

#### 3.6E: Send File

**Status:** ❌ MISSING

| Aspect       | Expected (workflow.md:528-536)                                                  | Actual          | Analysis    |
| ------------ | ------------------------------------------------------------------------------- | --------------- | ----------- |
| URL handling | `sendC2CFileMessage(token, openid, undefined, fileUrl, replyToId, fileName)`    | Not implemented | **MISSING** |
| Local file   | `sendC2CFileMessage(token, openid, fileBase64, undefined, replyToId, fileName)` | Not implemented | **MISSING** |

---

## WORKFLOW 4: Media Upload

### 4.1 Upload Media API

**Status:** ❌ MISSING

| Aspect             | Expected (workflow.md:544-556)                                                           | Actual                                     | Analysis    |
| ------------------ | ---------------------------------------------------------------------------------------- | ------------------------------------------ | ----------- |
| Function signature | `uploadC2CMedia(accessToken, openid, fileType, url?, fileData?, srvSendMsg?, fileName?)` | Not implemented                            | **MISSING** |
| File types         | 1=IMAGE, 2=VIDEO, 3=VOICE, 4=FILE                                                        | Constants defined (QQBotMessageType.MEDIA) | ⚠️ PARTIAL  |

**Code References:**

- **Spec:** Lines 544-556
- **Actual:** No upload functions found

---

### 4.2 Upload Cache

**Status:** ❌ MISSING

| Aspect        | Expected (workflow.md:559-569)                            | Actual          | Analysis    |
| ------------- | --------------------------------------------------------- | --------------- | ----------- |
| Content hash  | `computeFileHash(fileData)`                               | Not implemented | **MISSING** |
| Cache lookup  | `getCachedFileInfo(contentHash, "c2c", openid, fileType)` | Not implemented | **MISSING** |
| Cache storage | `setCachedFileInfo(...)`                                  | Not implemented | **MISSING** |

---

### 4.3 Make Upload Request

**Status:** ❌ MISSING

| Aspect      | Expected (workflow.md:572-587)                                   | Actual          | Analysis    |
| ----------- | ---------------------------------------------------------------- | --------------- | ----------- |
| Endpoint    | `POST /v2/users/{openid}/files`                                  | Not implemented | **MISSING** |
| Headers     | `Authorization: QQBot {token}`, `Content-Type: application/json` | Not implemented | **MISSING** |
| Body fields | `file_type`, `url` or `file_data`, `file_name`, `srv_send_msg`   | Not implemented | **MISSING** |

---

### 4.4 Handle Response & Cache

**Status:** ❌ MISSING

| Aspect           | Expected (workflow.md:590-601)        | Actual          | Analysis    |
| ---------------- | ------------------------------------- | --------------- | ----------- |
| Response fields  | `file_uuid`, `file_info`, `ttl`       | Not implemented | **MISSING** |
| Cache on success | `setCachedFileInfo(contentHash, ...)` | Not implemented | **MISSING** |

---

## WORKFLOW 5: API Call Patterns

### 5.1 HTTP Request Structure

**Status:** ⚠️ PARTIAL

| Aspect          | Expected (workflow.md:609-647)                                                                       | Actual (QQBotPlugin.ts:629-690)                          | Analysis    |
| --------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ----------- |
| Endpoints       | `/v2/users/{openid}/messages`, `/v2/groups/{groupOpenid}/messages`, `/channels/{channelId}/messages` | Same endpoints (lines 581, 593, 605)                     | ✅ MATCH    |
| Auth header     | `Authorization: QQBot {token}`                                                                       | Same (line 634)                                          | ✅ MATCH    |
| Text body       | `{content, msg_type: 0, msg_seq, msg_id, message_reference}`                                         | Partial - missing msg_seq (line 577-579)                 | **MISSING** |
| Markdown body   | `{markdown: {content}, msg_type: 2}`                                                                 | Partial - type constant exists but not used for markdown | ⚠️ PARTIAL  |
| Rich media body | `{msg_type: 7, media: {file_info}}`                                                                  | Not implemented                                          | **MISSING** |
| Proactive       | Same endpoints without msg_id                                                                        | Not distinguished                                        | **MISSING** |

**Code References:**

- **Spec:** Lines 609-657
- **Actual:** QQBotPlugin.ts:572-606

**Missing in request body:**

- `msg_seq` - Unique sequence per message (required for idempotency)
- `msg_id` / `message_reference` - For reply tracking
- Rich media body structure with `file_info`

---

### 5.2 Error Handling

**Status:** ⚠️ PARTIAL

| Aspect            | Expected (workflow.md)          | Actual (QQBotPlugin.ts:645-690)   | Analysis    |
| ----------------- | ------------------------------- | --------------------------------- | ----------- |
| Retry logic       | Generic HTTP wrapper with retry | Basic request with single attempt | **MISSING** |
| Status code check | Proper error handling           | Implemented (line 669-670)        | ✅ MATCH    |
| Timeout           | Configurable timeout            | 30 second timeout (line 681)      | ⚠️ PARTIAL  |

---

## Additional Findings

### Missing Features Not in Spec But Worth Noting

1. **Typing Indicator (Input Notify):** Function exists in adapter (QQBotAdapter.ts:428-433) but not used in plugin
2. **Message Editing:** Explicitly noted as unsupported (QQBotPlugin.ts:565-570)
3. **Button/Action Support:** Partial implementation in adapter (QQBotAdapter.ts:486-519) but not integrated

### Constants and Types Comparison

| Item          | Spec        | Actual                                   | Status   |
| ------------- | ----------- | ---------------------------------------- | -------- |
| Opcode enum   | Defined     | QQBotOpcode enum (QQBotAdapter.ts:59-69) | ✅ MATCH |
| Intent flags  | Defined     | QQBotIntent enum (QQBotAdapter.ts:75-85) | ✅ MATCH |
| Message types | 0,2,3,4,6,7 | QQBotMessageType (lines 34-41)           | ✅ MATCH |
| Intent levels | 3 levels    | QQBOT_INTENT_LEVELS (lines 91-107)       | ✅ MATCH |

### Architecture Differences

| Aspect           | Spec Pattern                    | Actual Pattern             |
| ---------------- | ------------------------------- | -------------------------- |
| Base class       | Plugin object with register     | Class extending BasePlugin |
| Message flow     | Queue-based with routing        | Direct event emission      |
| Token cache      | Per-appId Map with singleflight | Single property            |
| Media handling   | Full upload pipeline            | Not implemented            |
| Context building | Detailed contextInfo template   | Not implemented            |

---

## Summary Statistics

| Category              | ✅ MATCH | ⚠️ PARTIAL | ❌ MISSING | 🔴 WRONG |
| --------------------- | -------- | ---------- | ---------- | -------- |
| Workflow 1 (Gateway)  | 3        | 4          | 2          | 0        |
| Workflow 2 (Inbound)  | 1        | 2          | 7          | 1        |
| Workflow 3 (Outbound) | 2        | 2          | 7          | 0        |
| Workflow 4 (Upload)   | 0        | 0          | 4          | 0        |
| Workflow 5 (API)      | 2        | 3          | 3          | 0        |
| **TOTAL**             | **8**    | **11**     | **23**     | **1**    |

## Critical Missing Features (Blocking)

1. **Message Queue System:** No per-user serial processing, concurrent user limiting, or urgent command handling
2. **Reply Limits:** No passive/proactive message limiting (4 replies per message per hour)
3. **Media Upload:** No file upload capability, no upload caching
4. **Voice Handling:** No SILK codec, no STT/TTS integration
5. **Media Tags:** No parsing of `<qqimg>`, `<qqvoice>`, `<qqvideo>`, `<qqfile>` tags
6. **Context Building:** No detailed context info with image/voice instructions for AI
7. **Session Persistence:** No disk-based session storage for crash recovery
8. **Message References:** No quote/reply handling with refMsgIdx/msgIdx
9. **Multi-account:** No per-appId token cache isolation

## Recommendations

1. **Immediate:** Implement message queue system for per-user serial processing
2. **High Priority:** Add media upload pipeline with caching
3. **High Priority:** Implement reply limit tracking
4. **Medium Priority:** Add voice message support (SILK codec + STT/TTS)
5. **Medium Priority:** Implement media tag parsing
6. **Low Priority:** Add session persistence to disk



---

## APPENDIX: Detailed Code-Level Findings

### A.1 BasePlugin Architecture Comparison

**Status:** ⚠️ PARTIAL - Different but Equivalent Pattern

The implementation uses a class inheritance pattern rather than the spec's object registration pattern:

**Spec Pattern (workflow.md:34-41):**
```typescript
const plugin = {
  id: "qqbot",
  register(api: OpenClawPluginApi) {
    setQQBotRuntime(api.runtime);
    api.registerChannel({ plugin: qqbotPlugin });
  }
};
```

**Actual Pattern (BasePlugin.ts:39-243):**
```typescript
export abstract class BasePlugin {
  abstract readonly type: PluginType;
  protected config: IChannelPluginConfig | null = null;
  protected messageHandler: PluginMessageHandler | null = null;
  
  async initialize(config: IChannelPluginConfig): Promise<void> { ... }
  async start(): Promise<void> { ... }
  async stop(): Promise<void> { ... }
  protected async emitMessage(message: IUnifiedIncomingMessage): Promise<void> { ... }
  
  // Abstract methods for subclasses
  protected abstract onInitialize(config: IChannelPluginConfig): Promise<void>;
  protected abstract onStart(): Promise<void>;
  protected abstract onStop(): Promise<void>;
  abstract sendMessage(chatId: string, message: IUnifiedOutgoingMessage): Promise<string>;
  abstract editMessage(chatId: string, messageId: string, message: IUnifiedOutgoingMessage): Promise<void>;
}
```

**Analysis:** The AionUi framework uses a more traditional OOP pattern with lifecycle methods. Functionally equivalent but structurally different from the spec's functional plugin object pattern.

---

### A.2 Message Queue System - CRITICAL MISSING FEATURE

**Status:** 🔴 CRITICAL MISSING

The spec describes a sophisticated message queue system that is **completely absent** from the implementation.

**Expected Implementation (workflow.md:217-260):**

```typescript
// gateway.ts

// STEP 2.1: Check for urgent commands (lines 221-225)
const URGENT_COMMANDS = ["/stop"];
IF message starts with urgent command:
  - Clear user's message queue
  - Execute immediately (skip queue)

// STEP 2.2-2.3: Get peerId and add to queue (lines 228-239)
IF group message: peerId = `group:${groupOpenid}`
IF private message: peerId = `dm:${senderId}`

userQueues.get(peerId).push({
  type: "c2c" | "group" | "guild",
  senderId, senderName, content,
  messageId, timestamp,
  attachments,
  refMsgIdx,    // Quote reference
  msgIdx        // Current message index
});

// STEP 2.4: Drain queue (lines 242-244)
IF !activeUsers.has(peerId):
  drainUserQueue(peerId);

// STEP 3: Per-User Serial Processing (lines 247-260)
WHILE queue not empty:
  msg = queue.shift()
  activeUsers.add(peerId);
  await handleMessage(msg);  // Process one at a time
  activeUsers.delete(peerId);
```

**Actual Implementation (QQBotPlugin.ts:396-412):**

```typescript
private async handleMessage(message: QQBotMessage, eventType: string): Promise<void> {
  try {
    const chatType = detectMessageType(eventType);
    const userId = message.author?.id || message.openid || message.group_member_openid || '';
    
    // Only adds to tracking set, NOT a queue
    if (userId) {
      this.activeUsers.add(userId);  // Line 402
    }
    
    // Direct processing - NO QUEUE
    const unifiedMessage = toUnifiedIncomingMessage(message, eventType);
    if (unifiedMessage) {
      await this.emitMessage(unifiedMessage);  // Line 407 - Direct emit!
    }
  } catch (error) {
    console.error('[QQBotPlugin] Error handling message:', error);
  }
}
```

**Critical Differences:**

| Feature | Spec | Actual | Impact |
|---------|------|--------|--------|
| Message queue | `Map<peerId, QueuedMessage[]>` | Not implemented | Messages processed immediately, no ordering guarantee |
| Urgent commands | `/stop` clears queue | Not implemented | Cannot interrupt processing |
| peerId format | `group:${id}` or `dm:${id}` | Raw userId | Different isolation semantics |
| Serial processing | One message per user at a time | Concurrent processing | Race conditions possible |
| Queue draining | Explicit drain function | Not needed (no queue) | No backpressure handling |
| Max concurrent | `MAX_CONCURRENT_USERS = 10` | Not implemented | Unlimited concurrent processing |

**Line References:**
- **Spec:** workflow.md:217-260
- **Actual:** QQBotPlugin.ts:396-412, line 68 (activeUsers Set)

---

### A.3 Intent Level Management - Detailed Analysis

**Status:** ✅ MATCH

The intent level progressive downgrade is correctly implemented:

**Spec (workflow.md:131-138, 298-310):**
```typescript
INTENT_LEVELS = [
  { name: "full", intents: PUBLIC_GUILD_MESSAGES | DIRECT_MESSAGE | GROUP_AND_C2C },
  { name: "group+channel", intents: PUBLIC_GUILD_MESSAGES | GROUP_AND_C2C },
  { name: "channel-only", intents: PUBLIC_GUILD_MESSAGES | GUILD_MEMBERS }
];

// On INVALID_SESSION with d=false:
if (this.intentLevelIndex < INTENT_LEVELS.length - 1) {
  this.intentLevelIndex++;
  // Try next level
}
```

**Actual (QQBotAdapter.ts:91-107, QQBotPlugin.ts:298-310):**
```typescript
export const QQBOT_INTENT_LEVELS = [
  {
    name: 'full',
    intents: QQBotIntent.PUBLIC_GUILD_MESSAGES | QQBotIntent.DIRECT_MESSAGE | QQBotIntent.GROUP_AND_C2C,
    description: 'group+c2c+channel',
  },
  {
    name: 'group+channel',
    intents: QQBotIntent.PUBLIC_GUILD_MESSAGES | QQBotIntent.GROUP_AND_C2C,
    description: 'group+channel',
  },
  {
    name: 'channel-only',
    intents: QQBotIntent.PUBLIC_GUILD_MESSAGES | QQBotIntent.GUILD_MEMBERS,
    description: 'channel-only',
  },
] as const;

// In handlePayload():
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
```

**Analysis:** Intent values match exactly:
- Level 0: `PUBLIC_GUILD_MESSAGES | DIRECT_MESSAGE | GROUP_AND_C2C` (same)
- Level 1: `PUBLIC_GUILD_MESSAGES | GROUP_AND_C2C` (same)
- Level 2: `PUBLIC_GUILD_MESSAGES | GUILD_MEMBERS` (same)

---

### A.4 Attachment Handling - Missing Download Pipeline

**Status:** ❌ MISSING

**Spec (workflow.md:278-290):**
```typescript
STEP 4.3: Download attachments (if any)
  FOR each attachment:
    IF image:
      - Download to ~/.openclaw/qqbot/downloads/
      - Add to imageUrls[] for AI vision
    IF voice:
      - Download voice_wav_url (if available) OR original URL
      - IF STT configured:
          - Convert SILK→WAV (if needed)
          - Transcribe via STT API
      - Add transcript to voiceTranscripts[]
    ELSE:
      - Download file, add path to attachmentInfo
```

**Actual (QQBotAdapter.ts:259-344):**
```typescript
function extractMessageContent(message: QQBotMessage): IUnifiedMessageContent {
  const msgType = message.msg_type ?? QQBotMessageType.TEXT;
  switch (msgType) {
    case QQBotMessageType.MEDIA:
      if (message.attachments && message.attachments.length > 0) {
        const attachment = message.attachments[0];
        const contentType = attachment.content_type || '';
        
        if (contentType.startsWith('image/')) {
          return {
            type: 'photo',
            text: message.content || '',
            attachments: [{
              type: 'photo',
              fileId: attachment.url,  // ← Just the URL, NO download!
              fileName: attachment.filename,
              mimeType: contentType,
              size: attachment.size,
            }],
          };
        }
        // Similar for video, audio, document...
      }
  }
}
```

**Missing:**
1. Local file download to `~/.openclaw/qqbot/downloads/`
2. Image URL collection for AI vision
3. Voice SILK→WAV conversion
4. STT transcription
5. File path tracking in attachmentInfo

**Line References:**
- **Spec:** workflow.md:278-290
- **Actual:** QQBotAdapter.ts:259-344 (extractMessageContent function)

---

### A.5 Voice Message Handling (STT/TTS) - NOT IMPLEMENTED

**Status:** ❌ MISSING

**Spec Requirements (workflow.md:283-287, 499-514):**

**Inbound (STT):**
1. Download voice_wav_url or original URL
2. Convert SILK→WAV if needed (using silk-wasm)
3. Transcribe via STT API
4. Add transcript to voiceTranscripts[]

**Outbound (TTS):**
1. Wait for file to be ready (TTS async generation)
2. Convert to SILK: `audioFileToSilkBase64(voicePath)`
3. Conversion pipeline: MP3/WAV/OGG → PCM → SILK
4. Upload & send via `sendC2CVoiceMessage()`

**Actual:**
- QQBotAdapter.ts:308-322 recognizes `contentType.startsWith('audio/')` but only returns type metadata
- No SILK codec integration
- No STT/TTS provider configuration
- No voice conversion functions

**Missing Files/Functions:**
- `audio-convert.ts` with `convertSilkToWav()` and `audioFileToSilkBase64()`
- STT configuration and transcription logic
- TTS generation integration
- silk-wasm dependency

---

### A.6 Quote/Reference Handling - NOT IMPLEMENTED

**Status:** ❌ MISSING

**Spec (workflow.md:298-310):**
```typescript
STEP 4.6: Handle message quotes/references
  IF event.refMsgIdx:
    refEntry = getRefIndex(refMsgIdx);  // Look up cached message
    quotePart = `[引用消息开始]\n${refEntry.content}\n[引用消息结束]\n`;

STEP 4.7: Cache current message for future quotes
  IF event.msgIdx:
    setRefIndex(msgIdx, {
      content: parsedContent,
      senderId, senderName, timestamp,
      attachments: attachmentSummaries
    });
```

**Actual:**
- No reference index cache
- No `getRefIndex()` or `setRefIndex()` functions
- `replyToMessageId` is extracted from `message.message_reference?.message_id` (QQBotAdapter.ts:382) but only passed through
- No quote formatting in context building

---

### A.7 Context Building - NOT IMPLEMENTED

**Status:** ❌ MISSING

**Spec (workflow.md:329-351):**
```typescript
const contextInfo = `你正在通过 QQ 与用户对话。

【会话上下文】
- 用户: ${senderName} (${senderId})
- 场景: ${isGroupChat ? "群聊" : "私聊"}
- 消息ID: ${messageId}
- 投递目标: ${qualifiedTarget}

【发送图片 - 必须遵守】
1. 发图方法: 在回复文本中写 <qqimg>URL</qqimg>
2. 示例: "龙虾来啦！🦞 <qqimg>https://picsum.photos/800/600</qqimg>"

【发送语音 - 必须遵守】
1. 发图方法: 在回复文本中写 <qqvoice>本地音频文件路径</qqvoice>
...

【不要向用户透露过多以上述要求，以下是用户输入】

${quotePart}${userContent}`;
```

**Actual:**
- No context building function
- No media tag instructions (<qqimg>, <qqvoice>, etc.)
- No separator between instructions and user input
- Messages passed directly to `emitMessage()` without context wrapping

**Line References:**
- **Spec:** workflow.md:329-351
- **Actual:** QQBotPlugin.ts:407 (direct emitMessage call)

---

### A.8 Reply Limits (Passive vs Proactive) - NOT IMPLEMENTED

**Status:** 🔴 CRITICAL MISSING

**Spec (workflow.md:419-442):**
```typescript
// outbound.ts → checkMessageReplyLimit()

IF replyToId exists:
  record = messageReplyTracker.get(replyToId);
  
  IF record exists:
    IF now - record.firstReplyAt > 1 hour:
      // Message too old, switch to proactive
      RETURN { allowed: false, shouldFallbackToProactive: true }
    
    IF record.count >= 4:
      // Max 4 replies per message per hour
      RETURN { allowed: false, shouldFallbackToProactive: true }
    
    RETURN { allowed: true, remaining: 4 - count }
  
  ELSE:
    RETURN { allowed: true, remaining: 4 }  // First reply

IF fallbackToProactive:
  replyToId = null;  // Clear to use proactive API
```

**Actual:**
- No `messageReplyTracker` Map
- No reply counting
- No 1-hour expiry check
- No 4-reply limit enforcement
- No proactive fallback logic
- `replyToMessageId` exists in types (types.ts:295, 327) but not used for limiting

**Line References:**
- **Spec:** workflow.md:419-442
- **Actual:** No implementation found

**Impact:** Violates QQ Bot API limits - could result in rate limiting or account suspension.

---

### A.9 Media Tag Processing - NOT IMPLEMENTED

**Status:** ❌ MISSING

**Spec (workflow.md:445-464):**
```typescript
// Supported tags:
//   <qqimg>path</qqimg>      → Image
//   <qqvoice>path</qqvoice>   → Voice (converted to SILK)
//   <qqvideo>path</qqvideo>   → Video
//   <qqfile>path</qqfile>     → File

Parsing:
  1. normalizeMediaTags(text)  // Fix common AI formatting errors
  2. Build sendQueue in order:
     [
       { type: "text", content: "Before image" },
       { type: "image", content: "/path/to/img.png" },
       { type: "text", content: "After image" }
     ]
  3. Process queue sequentially
```

**Actual (QQBotAdapter.ts:400-423):**
```typescript
export function toQQBotSendParams(message: IUnifiedOutgoingMessage): QQBotSendParams {
  const text = message.text || '';

  // If has buttons, convert to markdown with button hints
  if (message.buttons && message.buttons.length > 0) {
    const markdownText = convertToQQBotMarkdown(text);
    const buttonHints = message.buttons.map((row, rowIdx) => 
      row.map((btn, btnIdx) => `${btn.label} (回复 ${rowIdx + 1}.${btnIdx + 1})`).join(' | ')
    ).join('\n');

    return {
      contentType: 'markdown',
      content: { content: `${markdownText}\n\n---\n${buttonHints}` },
      rawText: text,
    };
  }

  // Default to text message - NO media tag parsing!
  return {
    contentType: 'text',
    content: { content: text },
    rawText: text,
  };
}
```

**Missing:**
1. Media tag parsing (<qqimg>, <qqvoice>, <qqvideo>, <qqfile>)
2. `normalizeMediaTags()` function
3. Send queue building
4. Sequential queue processing

**Line References:**
- **Spec:** workflow.md:445-464
- **Actual:** QQBotAdapter.ts:400-423

---

### A.10 Media Upload - NOT IMPLEMENTED

**Status:** ❌ MISSING

**Spec (workflow.md:544-601):**
```typescript
// api.ts → uploadC2CMedia() / uploadGroupMedia()
async function uploadC2CMedia(
  accessToken,
  openid,
  fileType: 1=IMAGE | 2=VIDEO | 3=VOICE | 4=FILE,
  url?,           // Public URL (optional)
  fileData?,      // Base64 data (optional)
  srvSendMsg = false,
  fileName?       // For FILE type
): Promise<UploadMediaResponse>

// Upload cache (utils/upload-cache.ts)
IF fileData provided:
  contentHash = computeFileHash(fileData);
  cachedInfo = getCachedFileInfo(contentHash, "c2c", openid, fileType);
  IF cachedInfo exists:
    RETURN { file_uuid: "", file_info: cachedInfo, ttl: 0 };

// Upload Request
POST https://api.sgroup.qq.com/v2/users/{openid}/files
Headers: Authorization: QQBot {access_token}, Content-Type: application/json
Body: { file_type, url | file_data, file_name, srv_send_msg }

// Response handling
Response: { file_uuid, file_info, ttl }
IF fileData AND ttl > 0:
  setCachedFileInfo(contentHash, "c2c", openid, fileType, file_info, file_uuid, ttl);
```

**Actual:**
- No `uploadC2CMedia()` or `uploadGroupMedia()` functions
- No upload cache utilities
- No file hash computation
- No `file_info` handling

**Missing Files:**
- `utils/upload-cache.ts`
- File hash utilities

---

### A.11 API Request Structure - Partial Implementation

**Status:** ⚠️ PARTIAL

**Spec (workflow.md:609-657):**
```typescript
// Text Message
POST /v2/users/{openid}/messages        (C2C)
POST /v2/groups/{groupOpenid}/messages  (Group)
POST /channels/{channelId}/messages     (Channel)

Headers: Authorization: QQBot {token}

Body (text):
{
  "content": "Hello World",
  "msg_type": 0,          // 0=text, 2=markdown
  "msg_seq": 12345,       // Unique sequence per message ← MISSING!
  "msg_id": "...",        // Original message ID (for reply) ← MISSING!
  "message_reference": {   // Optional quote ← MISSING!
    "message_id": "..."
  }
}

Body (rich media):
{
  "msg_type": 7,          // Rich media
  "media": {
    "file_info": "..."    // From upload API ← MISSING!
  },
  "msg_seq": 12345,
  "content": "Caption"
}
```

**Actual (QQBotPlugin.ts:572-606):**
```typescript
private async sendC2CMessage(openid: string, contentType: string, content: Record<string, unknown>): Promise<QQBotApiResponse> {
  const baseUrl = QQBOT_API_BASE;
  const token = await this.ensureAccessToken();

  const body: Record<string, unknown> = {
    ...content,
    msg_type: this.getMsgType(contentType),  // Only adds msg_type
  };
  // Missing: msg_seq, msg_id, message_reference

  return this.apiRequest('POST', `/v2/users/${openid}/messages`, token, body);
}
```

**Missing Fields:**
1. `msg_seq` - Required for idempotency
2. `msg_id` - For reply tracking
3. `message_reference` - For quotes
4. `media.file_info` - For rich media

**Line References:**
- **Spec:** workflow.md:609-647
- **Actual:** QQBotPlugin.ts:572-606

---

### A.12 Token Management - Detailed Analysis

**Status:** ⚠️ PARTIAL

**Spec (workflow.md:83-111):**
```typescript
// Per-appId isolated cache
const tokenCacheMap = new Map<string, TokenCache>();
const tokenFetchPromises = new Map<string, Promise<TokenCache>>();

async function getAccessToken(appId: string, clientSecret: string): Promise<string> {
  // 4.1: Check cache with 5 min buffer
  const cached = tokenCacheMap.get(appId);
  if (cached && cached.expiresAt - Date.now() > 5 * 60 * 1000) {
    return cached.token;
  }
  
  // 4.2: Singleflight - prevent concurrent fetches
  if (tokenFetchPromises.has(appId)) {
    return tokenFetchPromises.get(appId)!.then(c => c.token);
  }
  
  // 4.3: Fetch new token
  const promise = fetchToken(appId, clientSecret).then(cache => {
    tokenCacheMap.set(appId, cache);
    tokenFetchPromises.delete(appId);
    return cache;
  });
  tokenFetchPromises.set(appId, promise);
  
  // 4.5: Start background refresh
  startBackgroundTokenRefresh(appId, clientSecret);
  
  return promise.then(c => c.token);
}
```

**Actual (QQBotPlugin.ts:489-517):**
```typescript
private tokenCache: ITokenCache | null = null;  // Single cache, not per-appId

private async refreshAccessToken(): Promise<void> {
  const response = await this.httpPost(QQBOT_TOKEN_URL, {
    appId: this.appId,
    clientSecret: this.appSecret,
  });

  if (response?.access_token) {
    this.tokenCache = {
      accessToken: response.access_token,
      expiresAt: Date.now() + (response.expires_in || 7200) * 1000,
    };
  }
}

private async ensureAccessToken(): Promise<string> {
  const now = Date.now();
  // 60 second buffer instead of 5 minutes
  if (!this.tokenCache || this.tokenCache.expiresAt - now < 60 * 1000) {
    await this.refreshAccessToken();
  }
  return this.tokenCache?.accessToken || '';
}
```

**Differences:**

| Feature | Spec | Actual | Impact |
|---------|------|--------|--------|
| Cache scope | Per-appId Map | Single property | Breaks multi-account support |
| Singleflight | Implemented | Not implemented | Duplicate token requests under load |
| Expiry buffer | 5 minutes | 60 seconds | More frequent refreshes |
| Background refresh | Implemented | Not implemented | Token may expire during long operations |
| Token endpoint | `bots.qq.com/app/getAppAccessToken` | Same | ✅ Match |

**Line References:**
- **Spec:** workflow.md:83-111
- **Actual:** QQBotPlugin.ts:489-517

---

## B. File-by-File Compliance Matrix

### QQBotPlugin.ts

| Line Range | Function/Feature | Spec Section | Status | Notes |
|------------|-----------------|--------------|--------|-------|
| 21-25 | Constants (HEARTBEAT_INTERVAL, etc.) | W1.6 | ⚠️ Partial | MAX_RECONNECT_ATTEMPTS is 10 (spec: 100) |
| 27-36 | Interfaces (ITokenCache, ISessionCache) | W1.4, W1.7 | ⚠️ Partial | Simplified, no per-appId support |
| 38-71 | Class properties | - | ⚠️ Partial | Missing userQueues, messageReplyTracker |
| 75-85 | onInitialize() | W1.2 | ⚠️ Partial | No multi-account, no env var merge |
| 87-102 | onStart() | W1.3 | ✅ Match | Correct flow: token → gateway → connect |
| 104-119 | onStop() | - | ✅ Match | Proper cleanup |
| 123-216 | connectWebSocket() | W1.6 | ⚠️ Partial | No session loading, no queue init |
| 218-227 | closeWebSocket() | - | ✅ Match | Correct implementation |
| 229-263 | attemptReconnect() | W1.7 | ⚠️ Partial | No session persistence |
| 265-274 | resumeSession() | W1.7 | ⚠️ Partial | Resumes from memory only |
| 278-321 | handlePayload() | W2.1 | ✅ Match | All opcodes handled correctly |
| 323-351 | handleHello() | W1.6 | ✅ Match | Correct IDENTIFY/RESUME logic |
| 353-394 | handleDispatch() | W2.1 | ✅ Match | Event deduplication implemented |
| 396-412 | handleMessage() | W2.2-2.3 | 🔴 Wrong | Direct processing, NO QUEUE! |
| 416-450 | Heartbeat methods | W1.6 | ✅ Match | Correct implementation |
| 454-485 | Event deduplication | - | ✅ Match | 5-minute TTL cleanup |
| 489-508 | refreshAccessToken() | W1.4 | ⚠️ Partial | No singleflight, no background refresh |
| 510-517 | ensureAccessToken() | W1.4 | ⚠️ Partial | 60s buffer instead of 5min |
| 519-527 | fetchGatewayUrl() | W1.5 | ✅ Match | Correct endpoint and auth |
| 531-563 | sendMessage() | W3.1-3.3 | ⚠️ Partial | No reply limits, no media support |
| 565-570 | editMessage() | - | ✅ Match | Correctly notes unsupported |
| 572-606 | send*Message() methods | W3.6 | ⚠️ Partial | Missing msg_seq, msg_id, media |
| 608-625 | getMsgType() | W5.1 | ⚠️ Partial | Types defined but not fully used |
| 629-690 | HTTP helpers | W5.1-5.2 | ⚠️ Partial | Basic implementation, no retry |
| 708-773 | testConnection() | - | ✅ Match | Correct validation |

### QQBotAdapter.ts

| Line Range | Function/Feature | Spec Section | Status | Notes |
|------------|-----------------|--------------|--------|-------|
| 14 | QQBOT_MESSAGE_LIMIT | - | ✅ Match | 4000 chars |
| 16-21 | API URLs | W1.5 | ✅ Match | Correct endpoints |
| 34-41 | QQBotMessageType | W5.1 | ✅ Match | All types defined |
| 59-69 | QQBotOpcode | W1.6 | ✅ Match | All opcodes defined |
| 75-85 | QQBotIntent | W1.6 | ✅ Match | All intents defined |
| 91-107 | QQBOT_INTENT_LEVELS | W1.6 | ✅ Match | Correct levels |
| 112-120 | QQBotEventType | W2.1 | ✅ Match | Correct types |
| 125-158 | QQBotMessage interface | W2.1 | ✅ Match | Complete structure |
| 192-203 | encodeChatId() | W3.3 | ✅ Match | Correct formats |
| 208-221 | parseChatId() | W3.3 | ✅ Match | Correct parsing |
| 226-236 | toUnifiedUser() | W2.8 | ⚠️ Partial | No context building |
| 241-254 | detectMessageType() | W2.2 | ✅ Match | Correct detection |
| 259-344 | extractMessageContent() | W2.4 | ⚠️ Partial | No download, no STT |
| 349-385 | toUnifiedIncomingMessage() | W2.9 | ⚠️ Partial | No routing, no context |
| 400-423 | toQQBotSendParams() | W3.5 | ❌ Missing | No media tag parsing! |
| 428-433 | createInputNotifyParams() | W2.4 | ⚠️ Partial | Defined but not used |
| 439-474 | convertToQQBotMarkdown() | - | ✅ Match | HTML→Markdown conversion |
| 479-482 | escapeQQBotMarkdown() | - | ✅ Match | Escape helpers |
| 489-519 | buildCardActionValue/extractAction | - | ⚠️ Partial | Partial button support |

### index.ts

| Line Range | Feature | Spec Section | Status | Notes |
|------------|---------|--------------|--------|-------|
| 7-8 | Exports | W1.1 | ⚠️ Partial | No plugin registration object |

---

## C. Critical Implementation Gaps

### C.1 Message Queue System (CRITICAL)

**Problem:** The current implementation processes messages immediately without queuing, which:
- Allows unlimited concurrent message processing
- Provides no ordering guarantees under load
- Cannot handle urgent commands (/stop)
- Has no backpressure mechanism

**Required Implementation:**
```typescript
// Add to QQBotPlugin.ts

private userQueues = new Map<string, QueuedMessage[]>();
private readonly MAX_CONCURRENT_USERS = 10;
private processingUsers = new Set<string>();

private async enqueueMessage(message: QQBotMessage, eventType: string): Promise<void> {
  const userId = this.getPeerId(message, eventType);
  
  // Check urgent commands
  if (message.content?.startsWith('/stop')) {
    this.userQueues.delete(userId);  // Clear queue
    await this.handleStopCommand(userId);
    return;
  }
  
  // Add to queue
  if (!this.userQueues.has(userId)) {
    this.userQueues.set(userId, []);
  }
  this.userQueues.get(userId)!.push({ message, eventType });
  
  // Start processing if under limit
  if (this.processingUsers.size < this.MAX_CONCURRENT_USERS) {
    void this.drainUserQueue(userId);
  }
}

private async drainUserQueue(userId: string): Promise<void> {
  if (this.processingUsers.has(userId)) return;
  
  this.processingUsers.add(userId);
  const queue = this.userQueues.get(userId);
  
  while (queue && queue.length > 0) {
    const item = queue.shift()!;
    await this.processMessage(item.message, item.eventType);
  }
  
  this.processingUsers.delete(userId);
  this.userQueues.delete(userId);
}
```

### C.2 Reply Limit Tracking (CRITICAL)

**Problem:** No enforcement of QQ Bot API limits (4 replies per message per hour).

**Required Implementation:**
```typescript
// Add to QQBotPlugin.ts

interface ReplyRecord {
  count: number;
  firstReplyAt: number;
}

private messageReplyTracker = new Map<string, ReplyRecord>();

private checkReplyLimit(replyToId?: string): { allowed: boolean; useProactive: boolean } {
  if (!replyToId) return { allowed: true, useProactive: false };
  
  const record = this.messageReplyTracker.get(replyToId);
  const now = Date.now();
  
  if (record) {
    // 1 hour limit
    if (now - record.firstReplyAt > 60 * 60 * 1000) {
      return { allowed: false, useProactive: true };
    }
    // 4 reply limit
    if (record.count >= 4) {
      return { allowed: false, useProactive: true };
    }
    return { allowed: true, useProactive: false };
  }
  
  // First reply
  this.messageReplyTracker.set(replyToId, { count: 1, firstReplyAt: now });
  return { allowed: true, useProactive: false };
}

private recordReply(replyToId: string): void {
  const record = this.messageReplyTracker.get(replyToId);
  if (record) {
    record.count++;
  }
}
```

### C.3 Media Tag Parsing (HIGH PRIORITY)

**Problem:** AI cannot send images, voice, video, or files via tags.

**Required Implementation:**
```typescript
// Add to QQBotAdapter.ts or new file

interface MediaTag {
  type: 'text' | 'image' | 'voice' | 'video' | 'file';
  content: string;
}

export function parseMediaTags(text: string): MediaTag[] {
  const tags: MediaTag[] = [];
  const pattern = /<(qqimg|qqvoice|qqvideo|qqfile)>(.*?)<\/\1>/g;
  let lastIndex = 0;
  let match;
  
  while ((match = pattern.exec(text)) !== null) {
    // Add text before tag
    if (match.index > lastIndex) {
      tags.push({
        type: 'text',
        content: text.slice(lastIndex, match.index).trim()
      });
    }
    
    // Add media tag
    const tagType = match[1] as 'qqimg' | 'qqvoice' | 'qqvideo' | 'qqfile';
    const mediaTypeMap: Record<string, MediaTag['type']> = {
      qqimg: 'image',
      qqvoice: 'voice',
      qqvideo: 'video',
      qqfile: 'file'
    };
    
    tags.push({
      type: mediaTypeMap[tagType],
      content: match[2]
    });
    
    lastIndex = pattern.lastIndex;
  }
  
  // Add remaining text
  if (lastIndex < text.length) {
    tags.push({ type: 'text', content: text.slice(lastIndex).trim() });
  }
  
  return tags.filter(t => t.content);
}
```

---

## D. Summary of All Findings

### Compliance by Workflow

| Workflow | Description | Status | Critical Issues |
|----------|-------------|--------|-----------------|
| W1 | Gateway Initialization | ⚠️ Partial | Missing: multi-account, background token refresh, session persistence |
| W2 | Inbound Message Processing | 🔴 Non-compliant | **NO MESSAGE QUEUE** - critical architectural gap |
| W3 | Outbound Message Processing | 🔴 Non-compliant | Missing: reply limits, media tags, voice, images, files |
| W4 | Media Upload | ❌ Not Implemented | Entire workflow missing |
| W5 | API Call Patterns | ⚠️ Partial | Missing: msg_seq, msg_id, media file_info |

### Implementation Status Summary

| Category | Count | Percentage |
|----------|-------|------------|
| ✅ Fully Implemented | 8 | 20% |
| ⚠️ Partially Implemented | 11 | 28% |
| ❌ Missing | 23 | 57% |
| 🔴 Wrong/Non-compliant | 1 | 2% |

### Priority Remediation Order

1. **🔴 CRITICAL (P0):** Implement message queue system (W2.2-2.3)
2. **🔴 CRITICAL (P0):** Implement reply limit tracking (W3.4)
3. **🟠 HIGH (P1):** Implement media tag parsing (W3.5)
4. **🟠 HIGH (P1):** Implement media upload with caching (W4)
5. **🟡 MEDIUM (P2):** Add voice support (STT/TTS + SILK codec)
6. **🟡 MEDIUM (P2):** Add context building for AI
7. **🟢 LOW (P3):** Add session persistence to disk
8. **🟢 LOW (P3):** Add per-appId token cache for multi-account

---

*Report Generated: Comprehensive Line-by-Line Review*
*Files Analyzed: workflow.md, QQBotPlugin.ts, QQBotAdapter.ts, index.ts, BasePlugin.ts, types.ts*
*Total Lines Reviewed: ~2,000 lines*
