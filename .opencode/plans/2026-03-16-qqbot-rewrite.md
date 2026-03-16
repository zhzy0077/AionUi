# QQBot Channel Rewrite Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite AionUi's QQBot plugin to match the mature upstream reference implementation with full feature parity including message queues, media handling, voice support, and session persistence.

**Architecture:** Modular design with clear separation between gateway (WebSocket), outbound (send pipeline), API (HTTP), and utility layers. Maintains compatibility with existing BasePlugin system while adding sophisticated queuing and media capabilities.

**Tech Stack:** Electron main process (Node.js), TypeScript 5.8, WebSocket (`ws`), `silk-wasm` for audio, `crypto` for hashing, JSONL for append-only storage.

**Upstream Reference:** `/home/zhzy0077/Code/QQBot/src/`
**Target Location:** `/home/zhzy0077/Code/AionUi/src/channels/plugins/qqbot/`

---

## Overview

### Critical Missing Features

| Feature                          | Priority | Status  | Files Needed            |
| -------------------------------- | -------- | ------- | ----------------------- |
| Message Queue System             | CRITICAL | Missing | gateway.ts, queue.ts    |
| Reply Limits (passive/proactive) | CRITICAL | Missing | outbound.ts             |
| Media Upload Pipeline            | CRITICAL | Missing | api.ts, upload-cache.ts |
| Voice Handling (STT/TTS)         | HIGH     | Missing | audio-convert.ts        |
| Session Persistence              | MEDIUM   | Missing | session-store.ts        |
| Message Reference Caching        | MEDIUM   | Missing | ref-index-store.ts      |
| Media Tag Parsing                | MEDIUM   | Missing | media-tags.ts           |
| Context Building                 | MEDIUM   | Missing | outbound.ts             |
| Token Management (singleflight)  | LOW      | Partial | api.ts                  |

### Parallel Task Groups

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         PARALLEL EXECUTION GROUPS                           │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  GROUP A: Foundation (Independent)                                          │
│  ├── utils/platform.ts     - Platform utilities, paths, ffmpeg detection   │
│  ├── utils/file-utils.ts   - File operations, size checking                │
│  ├── utils/image-size.ts   - Image dimension parsing                       │
│  └── types.ts              - Extended type definitions                     │
│                                                                             │
│  GROUP B: Storage & Cache (Independent)                                     │
│  ├── session-store.ts      - Session persistence (JSON)                    │
│  ├── ref-index-store.ts    - Message reference cache (JSONL)               │
│  └── utils/upload-cache.ts - File upload cache (memory + hash)             │
│                                                                             │
│  GROUP C: Media Processing (Depends on A)                                   │
│  ├── utils/media-tags.ts   - Media tag parsing/normalization               │
│  └── utils/audio-convert.ts - Audio conversion (silk-wasm, ffmpeg)         │
│                                                                             │
│  GROUP D: Core API Layer (Depends on A, B)                                  │
│  ├── api.ts                - Upload functions, token management            │
│  └── config.ts             - Configuration resolution                      │
│                                                                             │
│  GROUP E: Message Pipeline (Depends on C, D)                                │
│  ├── outbound.ts           - Send with limits, context building            │
│  └── gateway.ts            - Queue handling, message processing            │
│                                                                             │
│  GROUP F: Integration (Depends on ALL)                                      │
│  ├── QQBotPlugin.ts        - Major rewrite with queue system               │
│  ├── QQBotAdapter.ts       - Add media tag support                         │
│  └── index.ts              - Barrel exports                                │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Chunk 1: Foundation Utilities (GROUP A)

### Task 1.1: Platform Utilities

**Files:**

- Create: `src/channels/plugins/qqbot/utils/platform.ts`
- Test: `tests/unit/channels/qqbot/utils/platform.test.ts`

**Dependencies:** None (independent)

**Implementation Notes:**

- Port from upstream: `getQQBotDataDir()`, `expandTilde()`, `detectFfmpeg()`
- AionUi-specific: Use `app.getPath('userData')` for data directory
- Cross-platform: Windows, macOS, Linux support

```typescript
// Key functions to implement:
export function getQQBotDataDir(subdir?: string): string;
export function expandTilde(filePath: string): string;
export function detectFfmpeg(): Promise<string | null>;
export function isWindows(): boolean;
export function isLocalPath(url: string): boolean;
export function looksLikeLocalPath(url: string): boolean;
export function normalizePath(filePath: string): string;
export function sanitizeFileName(name: string): string;
```

- [ ] **Step 1: Write failing tests for platform utilities**
  - Test `getQQBotDataDir()` returns correct path with subdirs
  - Test `expandTilde()` expands `~` on all platforms
  - Test `detectFfmpeg()` finds ffmpeg in PATH
  - Test Windows/macOS/Linux path handling

- [ ] **Step 2: Run tests to verify they fail**

  ```bash
  bun test tests/unit/channels/qqbot/utils/platform.test.ts
  ```

  Expected: FAIL - modules not found

- [ ] **Step 3: Implement platform utilities**
  - Copy and adapt from upstream `utils/platform.ts`
  - Adjust for AionUi's Electron environment
  - Use `process.platform` for OS detection

- [ ] **Step 4: Run tests to verify they pass**

  ```bash
  bun test tests/unit/channels/qqbot/utils/platform.test.ts
  ```

  Expected: PASS

- [ ] **Step 5: Commit**
  ```bash
  git add src/channels/plugins/qqbot/utils/platform.ts tests/unit/channels/qqbot/utils/platform.test.ts
  git commit -m "feat(qqbot): add platform utilities for path handling and ffmpeg detection"
  ```

### Task 1.2: File Utilities

**Files:**

- Create: `src/channels/plugins/qqbot/utils/file-utils.ts`
- Test: `tests/unit/channels/qqbot/utils/file-utils.test.ts`

**Dependencies:** None

```typescript
// Key functions:
export function checkFileSize(filePath: string, maxSize: number): Promise<boolean>;
export function readFileAsync(filePath: string): Promise<Buffer>;
export function fileExistsAsync(filePath: string): Promise<boolean>;
export function isLargeFile(filePath: string, threshold?: number): Promise<boolean>;
export function formatFileSize(bytes: number): string;
export function waitForFile(filePath: string, timeoutMs?: number, pollMs?: number): Promise<number>;
```

- [ ] **Step 1-5:** (Same TDD pattern as Task 1.1)

### Task 1.3: Image Size Utilities

**Files:**

- Create: `src/channels/plugins/qqbot/utils/image-size.ts`
- Test: `tests/unit/channels/qqbot/utils/image-size.test.ts`

**Dependencies:** None

```typescript
// Key functions:
export interface ImageSize {
  width: number;
  height: number;
}
export function getImageSize(filePath: string): Promise<ImageSize | null>;
export function hasQQBotImageSize(url: string): Promise<boolean>;
export function formatQQBotMarkdownImage(url: string, size?: ImageSize): string;
export const DEFAULT_IMAGE_SIZE = { width: 400, height: 300 };
```

### Task 1.4: Extended Type Definitions

**Files:**

- Create: `src/channels/plugins/qqbot/types.ts`
- Modify: `src/channels/plugins/qqbot/QQBotAdapter.ts` (add exports)

**Dependencies:** None

**Implementation Notes:**

- Extend existing types rather than replace
- Keep compatibility with `IUnifiedIncomingMessage`/`IUnifiedOutgoingMessage`

```typescript
// Key types to add:
export interface QQBotConfig {
  appId: string;
  clientSecret?: string;
  clientSecretFile?: string;
}

export interface ResolvedQQBotAccount {
  accountId: string;
  name?: string;
  enabled: boolean;
  appId: string;
  clientSecret: string;
  secretSource: 'config' | 'file' | 'env' | 'none';
  systemPrompt?: string;
  imageServerBaseUrl?: string;
  markdownSupport: boolean;
}

export interface MessageAttachment {
  content_type: string;
  filename?: string;
  height?: number;
  width?: number;
  size?: number;
  url: string;
  voice_wav_url?: string;
  asr_refer_text?: string;
}

export interface QueuedMessage {
  type: 'c2c' | 'guild' | 'dm' | 'group';
  senderId: string;
  senderName?: string;
  content: string;
  messageId: string;
  timestamp: number;
  attachments?: MessageAttachment[];
  refMsgIdx?: string;
  msgIdx?: string;
}

export interface SessionState {
  sessionId: string | null;
  lastSeq: number | null;
  lastConnectedAt: number;
  intentLevelIndex: number;
  accountId: string;
  savedAt: number;
  appId?: string;
}

export interface RefIndexEntry {
  content: string;
  senderId: string;
  senderName?: string;
  timestamp: number;
  isBot?: boolean;
  attachments?: RefAttachmentSummary[];
}

export interface RefAttachmentSummary {
  type: 'image' | 'voice' | 'video' | 'file' | 'unknown';
  filename?: string;
  contentType?: string;
  transcript?: string;
  transcriptSource?: 'stt' | 'asr' | 'tts' | 'fallback';
  localPath?: string;
  url?: string;
}
```

---

## Chunk 2: Storage & Cache Layer (GROUP B)

### Task 2.1: Session Persistence Store

**Files:**

- Create: `src/channels/plugins/qqbot/session-store.ts`
- Test: `tests/unit/channels/qqbot/session-store.test.ts`

**Dependencies:** Task 1.1 (platform utilities), Task 1.4 (types)

**Implementation Notes:**

- Store: `~/.openclaw/qqbot/sessions/session-{accountId}.json`
- Features: 5-minute TTL, appId mismatch detection, throttled writes (1s)

```typescript
// Key functions:
export function loadSession(accountId: string, expectedAppId?: string): SessionState | null;
export function saveSession(state: SessionState): void;
export function clearSession(accountId: string): void;
export function updateLastSeq(accountId: string, lastSeq: number): void;
export function getAllSessions(): SessionState[];
export function cleanupExpiredSessions(): number;
```

- [ ] **Step 1: Write tests for session store**
  - Test load/save roundtrip
  - Test TTL expiration (mock time)
  - Test appId mismatch detection
  - Test throttling (multiple rapid saves)

- [ ] **Step 2-5:** TDD pattern with commits

### Task 2.2: Reference Index Store (JSONL)

**Files:**

- Create: `src/channels/plugins/qqbot/ref-index-store.ts`
- Test: `tests/unit/channels/qqbot/ref-index-store.test.ts`

**Dependencies:** Task 1.1, Task 1.4

**Implementation Notes:**

- Store: `~/.openclaw/qqbot/data/ref-index.jsonl`
- Format: `{"k":"REFIDX_xxx","v":{...},"t":1709000000}`
- Features: 7-day TTL, 50K entry limit, auto-compact when ratio > 2

```typescript
// Key functions:
export function setRefIndex(refIdx: string, entry: RefIndexEntry): void;
export function getRefIndex(refIdx: string): RefIndexEntry | null;
export function formatRefEntryForAgent(entry: RefIndexEntry): string;
export function flushRefIndex(): void;
export function getRefIndexStats(): { size: number; maxEntries: number; totalLinesOnDisk: number; filePath: string };
```

### Task 2.3: Upload Cache

**Files:**

- Create: `src/channels/plugins/qqbot/utils/upload-cache.ts`
- Test: `tests/unit/channels/qqbot/utils/upload-cache.test.ts`

**Dependencies:** None (pure utility)

**Implementation Notes:**

- In-memory cache only (no disk persistence needed)
- Key format: `${contentHash}:${scope}:${targetId}:${fileType}`
- Max 500 entries, LRU eviction

```typescript
// Key functions:
export function computeFileHash(data: string | Buffer): string;
export function getCachedFileInfo(contentHash: string, scope: 'c2c' | 'group', targetId: string, fileType: number): string | null;
export function setCachedFileInfo(contentHash: string, scope: 'c2c' | 'group', targetId: string, fileType: number, fileInfo: string, fileUuid: string, ttl: number): void;
export function getUploadCacheStats(): { size: number; maxSize: number };
export function clearUploadCache(): void;
```

---

## Chunk 3: Media Processing (GROUP C)

### Task 3.1: Media Tag Parser

**Files:**

- Create: `src/channels/plugins/qqbot/utils/media-tags.ts`
- Test: `tests/unit/channels/qqbot/utils/media-tags.test.ts`

**Dependencies:** Task 1.1

**Implementation Notes:**

- Parse tags: `<qqimg>`, `<qqvoice>`, `<qqvideo>`, `<qqfile>`
- Handle common AI errors: misspellings, whitespace, malformed tags
- Support aliases: `img`, `image`, `voice`, `audio`, etc.

```typescript
// Key functions:
export function normalizeMediaTags(text: string): string;

// Aliases handled:
// qqimg: qq_img, qqimage, qq_image, qqpic, qq_pic, qqpicture, qq_picture,
//        qqphoto, qq_photo, img, image, pic, picture, photo
// qqvoice: qq_voice, qqaudio, qq_audio, voice, audio
// qqvideo: qq_video, video
// qqfile: qq_file, qqdoc, qq_doc, file, doc, document
```

- [ ] **Step 1: Write comprehensive tests**
  - Test standard tag parsing
  - Test all aliases
  - Test malformed tags (extra spaces, wrong brackets, etc.)
  - Test multiline tags
  - Test markdown code block escaping

### Task 3.2: Audio Conversion (STT/TTS)

**Files:**

- Create: `src/channels/plugins/qqbot/utils/audio-convert.ts`
- Test: `tests/unit/channels/qqbot/utils/audio-convert.test.ts`
- Add dependency: `silk-wasm` (already in AionUi)

**Dependencies:** Task 1.1

**Implementation Notes:**

- SILK codec using `silk-wasm` (already available in AionUi)
- FFmpeg detection and fallback to WASM
- PCM 24kHz mono as internal format
- TTS integration with OpenAI-compatible API

```typescript
// Key functions:
export function isSilkFile(filePath: string): boolean;
export function convertSilkToWav(inputPath: string, outputDir?: string): Promise<{ wavPath: string; duration: number } | null>;
export function isVoiceAttachment(att: { content_type?: string; filename?: string }): boolean;
export function formatDuration(durationMs: number): string;
export function isAudioFile(filePath: string): boolean;

// TTS:
export interface TTSConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  voice: string;
  authStyle?: 'bearer' | 'api-key';
  queryParams?: Record<string, string>;
  speed?: number;
}
export function resolveTTSConfig(cfg: Record<string, unknown>): TTSConfig | null;
export async function textToSpeechPCM(text: string, ttsCfg: TTSConfig): Promise<{ pcmBuffer: Buffer; sampleRate: number }>;
export async function pcmToSilk(pcmBuffer: Buffer, sampleRate: number): Promise<{ silkBuffer: Buffer; duration: number }>;
export async function textToSilk(text: string, ttsCfg: TTSConfig, outputDir: string): Promise<{ silkPath: string; silkBase64: string; duration: number }>;
export async function audioFileToSilkBase64(filePath: string, directUploadFormats?: string[]): Promise<string | null>;
export async function waitForFile(filePath: string, timeoutMs?: number, pollMs?: number): Promise<number>;
```

**Dependencies to check:**

- `silk-wasm` - already in AionUi dependencies
- `mpg123-decoder` - may need to add for MP3 WASM fallback
- FFmpeg - external dependency, detect at runtime

---

## Chunk 4: API Layer (GROUP D)

### Task 4.1: Enhanced API with Upload Support

**Files:**

- Create: `src/channels/plugins/qqbot/api.ts`
- Test: `tests/unit/channels/qqbot/api.test.ts`

**Dependencies:** Task 1.4 (types), Task 2.3 (upload cache)

**Implementation Notes:**

- Token management with singleflight pattern (prevent concurrent fetches)
- Per-appId token cache isolation
- Background proactive refresh
- Media upload functions

```typescript
// Key functions:

// Token Management (with singleflight)
export async function getAccessToken(appId: string, clientSecret: string): Promise<string>
export function clearTokenCache(appId?: string): void
export function startBackgroundTokenRefresh(appId: string, clientSecret: string): void
export function stopBackgroundTokenRefresh(): void

// Upload Functions
export async function uploadC2CMedia(
  accessToken: string,
  openid: string,
  fileType: number, // 1=IMAGE, 2=VIDEO, 3=VOICE, 4=FILE
  url?: string,
  fileData?: string, // base64
  srvSendMsg?: boolean,
  fileName?: string
): Promise<{ file_uuid: string; file_info: string; ttl: number }>

export async function uploadGroupMedia(
  accessToken: string,
  groupOpenid: string,
  fileType: number,
  url?: string,
  fileData?: string,
  srvSendMsg?: boolean,
  fileName?: string
): Promise<{ file_uuid: string; file_info: string; ttl: number }>

// Send Functions (with media support)
export async function sendC2CMessage(
  accessToken: string,
  openid: string,
  content: string,
  msgType?: number,
  msgId?: string,
  msgSeq?: number
): Promise<{ id: string; timestamp: string | number }>

export async function sendC2CImageMessage(
  accessToken: string,
  openid: string,
  imageUrl: string,
  msgId?: string,
  msgSeq?: number
): Promise<{ id: string; timestamp: string | number }>

export async function sendC2CVoiceMessage(
  accessToken: string,
  openid: string,
  silkBase64: string,
  msgId?: string,
  msgSeq?: number
): Promise<{ id: string; timestamp: string | number }>

export async function sendC2CVideoMessage(...)
export async function sendC2CFileMessage(...)
export async function sendGroupMessage(...)
export async function sendGroupImageMessage(...)
export async function sendGroupVoiceMessage(...)
export async function sendGroupVideoMessage(...)
export async function sendGroupFileMessage(...)
export async function sendChannelMessage(...)

// Proactive versions (no msg_id)
export async function sendProactiveC2CMessage(accessToken: string, openid: string, content: string): Promise<{ id: string; timestamp: string | number }>
export async function sendProactiveGroupMessage(accessToken: string, groupOpenid: string, content: string): Promise<{ id: string; timestamp: string | number }>

// Typing indicator
export async function sendC2CInputNotify(accessToken: string, openid: string): Promise<void>

// Gateway
export async function getGatewayUrl(accessToken: string): Promise<string>

// Event callback
export function onMessageSent(callback: (messageId: string, chatId: string) => void): void
```

### Task 4.2: Configuration Resolution

**Files:**

- Create: `src/channels/plugins/qqbot/config.ts`
- Test: `tests/unit/channels/qqbot/config.test.ts`

**Dependencies:** Task 1.4 (types)

**Implementation Notes:**

- Support multi-account configuration
- Environment variable merging (`QQBOT_APP_ID`, `QQBOT_CLIENT_SECRET`)
- File-based secret loading

```typescript
// Key functions:
export function resolveQQBotAccount(cfg: IChannelPluginConfig, accountId?: string): ResolvedQQBotAccount;

export function resolveAllQQBotAccounts(cfg: IChannelPluginConfig): ResolvedQQBotAccount[];

// Environment variable support
export function loadCredentialsFromEnv(): { appId?: string; clientSecret?: string };
```

---

## Chunk 5: Message Pipeline (GROUP E)

### Task 5.1: Outbound Message Handler with Limits

**Files:**

- Create: `src/channels/plugins/qqbot/outbound.ts`
- Test: `tests/unit/channels/qqbot/outbound.test.ts`

**Dependencies:** Task 3.1 (media tags), Task 4.1 (API), Task 2.2 (ref index)

**Implementation Notes:**

- Reply limit tracking (4 replies per message per hour)
- Media tag parsing and queue building
- Context building for AI
- Sequential send processing

```typescript
// Key types:
export interface SendQueueItem {
  type: 'text' | 'image' | 'voice' | 'video' | 'file';
  content: string;
  mimeType?: string;
  fileName?: string;
}

export interface OutboundContext {
  account: ResolvedQQBotAccount;
  chatId: string;
  chatType: 'c2c' | 'group' | 'guild';
  targetId: string;
  replyToMessageId?: string;
  accessToken: string;
}

// Key functions:

// Reply limit tracking
export function checkMessageReplyLimit(messageId: string): { allowed: boolean; remaining: number; shouldFallbackToProactive: boolean };
export function recordMessageReply(messageId: string): void;
export function cleanupReplyTracker(): void;

// Media tag processing
export function parseMediaTags(text: string): { queue: SendQueueItem[]; remainingText: string };
export function buildSendQueue(text: string): SendQueueItem[];

// Context building
export function buildContextInfo(message: QueuedMessage, isGroupChat: boolean, qualifiedTarget: string): string;

// Main send function
export async function sendOutboundMessage(
  context: OutboundContext,
  message: IUnifiedOutgoingMessage,
  options?: {
    sttConfig?: STTConfig;
    ttsConfig?: TTSConfig;
  }
): Promise<{ messageId: string; timestamp: number }>;

// Sequential queue processing
export async function processSendQueue(context: OutboundContext, queue: SendQueueItem[], onProgress?: (item: SendQueueItem, index: number, total: number) => void): Promise<Array<{ success: boolean; messageId?: string; error?: string }>>;
```

### Task 5.2: Gateway with Message Queue

**Files:**

- Create: `src/channels/plugins/qqbot/gateway.ts`
- Test: `tests/unit/channels/qqbot/gateway.test.ts`

**Dependencies:** Task 2.1 (session store), Task 5.1 (outbound), Task 3.2 (audio)

**Implementation Notes:**

- Per-user message queues
- Concurrent user limiting (MAX_CONCURRENT_USERS = 10)
- Urgent command handling (/stop)
- STT integration for voice messages
- Reference message handling

```typescript
// Key types:
export interface GatewayOptions {
  account: ResolvedQQBotAccount;
  onMessage: (message: QueuedMessage) => Promise<void>;
  onReady?: () => void;
  onError?: (error: Error) => void;
  onReconnect?: () => void;
}

export interface GatewayContext {
  ws: WebSocket | null;
  isConnected: boolean;
  isReconnecting: boolean;
  sessionId: string | null;
  lastSeq: number | null;
  intentLevelIndex: number;
  userQueues: Map<string, QueuedMessage[]>;
  activeUsers: Set<string>;
}

// Constants
export const MAX_CONCURRENT_USERS = 10;
export const PER_USER_QUEUE_SIZE = 20;
export const MESSAGE_QUEUE_SIZE = 1000;

// Key functions:

// Queue management
export function enqueueMessage(context: GatewayContext, message: QueuedMessage, options?: { urgent?: boolean }): boolean;

export async function drainUserQueue(context: GatewayContext, peerId: string, handler: (message: QueuedMessage) => Promise<void>): Promise<void>;

export function calculatePeerId(message: QueuedMessage): string;

// Urgent commands
export const URGENT_COMMANDS = ['/stop', '/quit', '/exit'];
export function isUrgentCommand(content: string): boolean;
export function clearUserQueue(context: GatewayContext, peerId: string): void;

// Message processing
export async function processInboundMessage(
  event: C2CMessageEvent | GroupMessageEvent | GuildMessageEvent,
  options: {
    account: ResolvedQQBotAccount;
    sttConfig?: STTConfig;
    onMessage: (message: QueuedMessage) => Promise<void>;
  }
): Promise<void>;

// Reference handling
export function extractRefMsgIdx(event: { message_scene?: { ext?: string[] } }): string | undefined;
export function extractMsgIdx(event: { message_scene?: { ext?: string[] } }): string | undefined;
export function formatQuoteMessage(refEntry: RefIndexEntry): string;

// Attachment handling
export async function downloadAndProcessAttachments(
  attachments: MessageAttachment[],
  options: {
    downloadDir: string;
    sttConfig?: STTConfig;
    accountConfig: ResolvedQQBotAccount;
  }
): Promise<{
  imageUrls: string[];
  voiceTranscripts: string[];
  attachmentInfo: string[];
  refAttachments: RefAttachmentSummary[];
}>;
```

---

## Chunk 6: Integration (GROUP F)

### Task 6.1: QQBotPlugin Rewrite

**Files:**

- Modify: `src/channels/plugins/qqbot/QQBotPlugin.ts` (major rewrite)
- Test: `tests/unit/channels/qqbot/QQBotPlugin.test.ts` (new)

**Dependencies:** ALL previous tasks

**Implementation Notes:**

- Integrate message queue system
- Use session persistence
- Add voice message handling
- Maintain backward compatibility with BasePlugin

**Key Changes:**

```typescript
export class QQBotPlugin extends BasePlugin {
  readonly type: PluginType = 'qqbot';

  // WebSocket
  private ws: WebSocket | null = null;
  private isConnected = false;
  private isReconnecting = false;
  private reconnectAttempts = 0;

  // Session
  private sessionId: string | null = null;
  private sequenceNumber: number | null = null;
  private intentLevelIndex = 0;

  // Queue system (NEW)
  private userQueues: Map<string, QueuedMessage[]> = new Map();
  private activeUsers: Set<string> = new Set();
  private maxConcurrentUsers = 10;

  // Token management (ENHANCED)
  private tokenCache: Map<string, ITokenCache> = new Map(); // per-appId
  private tokenFetchPromises: Map<string, Promise<string>> = new Map(); // singleflight

  // Credentials
  private appId = '';
  private appSecret = '';
  private accountId = 'default';

  // Configuration
  private resolvedAccount: ResolvedQQBotAccount | null = null;

  // Lifecycle
  protected async onInitialize(config: IChannelPluginConfig): Promise<void>;
  protected async onStart(): Promise<void>;
  protected async onStop(): Promise<void>;

  // Message handling (REWRITTEN)
  private async handlePayload(payload: QQBotGatewayPayload): Promise<void>;
  private async handleDispatch(payload: QQBotGatewayPayload): Promise<void>;
  private async enqueueAndProcess(message: QueuedMessage): Promise<void>;
  private async drainQueue(peerId: string): Promise<void>;

  // Send message (ENHANCED)
  async sendMessage(chatId: string, message: IUnifiedOutgoingMessage): Promise<string>;

  // Voice handling (NEW)
  private async handleVoiceMessage(attachment: MessageAttachment): Promise<string | null>;

  // Session persistence (NEW)
  private loadPersistedSession(): void;
  private persistSession(): void;
}
```

### Task 6.2: QQBotAdapter Enhancements

**Files:**

- Modify: `src/channels/plugins/qqbot/QQBotAdapter.ts`

**Dependencies:** Task 3.1 (media tags)

**Implementation Notes:**

- Add media tag parsing support
- Enhance `toQQBotSendParams` to handle media tags
- Add voice message type detection

```typescript
// Enhance existing toQQBotSendParams:
export function toQQBotSendParams(message: IUnifiedOutgoingMessage): QQBotSendParams {
  const text = message.text || '';

  // NEW: Parse media tags first
  const normalizedText = normalizeMediaTags(text);
  const hasMediaTags = /<(qqimg|qqvoice|qqvideo|qqfile)>/.test(normalizedText);

  if (hasMediaTags) {
    // Return special contentType that triggers media pipeline
    return {
      contentType: 'media_queue',
      content: { text: normalizedText },
      rawText: text,
    };
  }

  // Existing button handling...
  if (message.buttons && message.buttons.length > 0) {
    // ... existing code
  }

  // Default text
  return {
    contentType: 'text',
    content: { content: text },
    rawText: text,
  };
}

// NEW: Extract media from parsed text
export function extractMediaFromText(text: string): {
  items: Array<{ type: 'image' | 'voice' | 'video' | 'file'; path: string }>;
  cleanText: string;
} {
  const items: Array<{ type: 'image' | 'voice' | 'video' | 'file'; path: string }> = [];
  let cleanText = text;

  // Extract <qqimg>path</qqimg>
  cleanText = cleanText.replace(/<qqimg>([^<]+)<\/qqimg>/gi, (_, path) => {
    items.push({ type: 'image', path: path.trim() });
    return '';
  });

  // Extract <qqvoice>path</qqvoice>
  cleanText = cleanText.replace(/<qqvoice>([^<]+)<\/qqvoice>/gi, (_, path) => {
    items.push({ type: 'voice', path: path.trim() });
    return '';
  });

  // Extract <qqvideo>path</qqvideo>
  cleanText = cleanText.replace(/<qqvideo>([^<]+)<\/qqvideo>/gi, (_, path) => {
    items.push({ type: 'video', path: path.trim() });
    return '';
  });

  // Extract <qqfile>path</qqfile>
  cleanText = cleanText.replace(/<qqfile>([^<]+)<\/qqfile>/gi, (_, path) => {
    items.push({ type: 'file', path: path.trim() });
    return '';
  });

  return { items, cleanText: cleanText.trim() };
}
```

### Task 6.3: Index Updates

**Files:**

- Modify: `src/channels/plugins/qqbot/index.ts`

**Implementation Notes:**

- Export new utilities for external use
- Maintain backward compatibility

```typescript
// Existing exports
export { QQBotPlugin } from './QQBotPlugin';
export * from './QQBotAdapter';

// NEW exports
export * from './types';
export { loadSession, saveSession } from './session-store';
export { setRefIndex, getRefIndex } from './ref-index-store';
export { normalizeMediaTags } from './utils/media-tags';
export { computeFileHash, getCachedFileInfo, setCachedFileInfo } from './utils/upload-cache';
```

---

## Integration Points with AionUi

### 1. BasePlugin Compatibility

The rewritten plugin must maintain full compatibility with `BasePlugin`:

```typescript
// Must implement:
abstract readonly type: PluginType;
protected abstract onInitialize(config: IChannelPluginConfig): Promise<void>;
protected abstract onStart(): Promise<void>;
protected abstract onStop(): Promise<void>;
abstract sendMessage(chatId: string, message: IUnifiedOutgoingMessage): Promise<string>;
abstract editMessage(chatId: string, messageId: string, message: IUnifiedOutgoingMessage): Promise<void>;
abstract getActiveUserCount(): number;
abstract getBotInfo(): BotInfo | null;

// Inherited methods to use:
protected emitMessage(message: IUnifiedIncomingMessage): Promise<void>;
protected setStatus(status: PluginStatus, error?: string): void;
protected setError(error: string): void;
```

### 2. Unified Message Interfaces

**Incoming (Platform → AionUi):**

```typescript
IUnifiedIncomingMessage {
  id: string;
  platform: 'qqbot';
  chatId: string;  // Format: c2c:xxx, group:xxx, guild:xxx:xxx
  user: IUnifiedUser;
  content: IUnifiedMessageContent;
  timestamp: number;
  replyToMessageId?: string;
  raw?: unknown;  // Original QQBotMessage
}
```

**Outgoing (AionUi → Platform):**

```typescript
IUnifiedOutgoingMessage {
  type: 'text' | 'image' | 'file' | 'buttons';
  text?: string;  // May contain <qqimg>, <qqvoice>, etc.
  parseMode?: 'HTML' | 'MarkdownV2' | 'Markdown';
  buttons?: IActionButton[][];
  replyToMessageId?: string;  // Maps to QQ msg_id for passive reply
  // ... other fields
}
```

### 3. Configuration Schema

AionUi stores plugin config in database. The QQBot config shape:

```typescript
interface IChannelPluginConfig {
  id: string;
  type: 'qqbot';
  name: string;
  enabled: boolean;
  credentials?: {
    appId?: string;
    appSecret?: string;
  };
  config?: {
    // Plugin-specific options
    markdownSupport?: boolean;
    imageServerBaseUrl?: string;
    stt?: {
      enabled?: boolean;
      provider?: string;
      model?: string;
    };
    tts?: {
      enabled?: boolean;
      provider?: string;
      model?: string;
      voice?: string;
    };
    audioFormatPolicy?: {
      sttDirectFormats?: string[];
      uploadDirectFormats?: string[];
    };
  };
}
```

### 4. File Storage Locations

Use AionUi's app data directory:

```typescript
import { app } from 'electron';

const BASE_DIR = path.join(app.getPath('userData'), 'qqbot');
const SESSIONS_DIR = path.join(BASE_DIR, 'sessions');
const DATA_DIR = path.join(BASE_DIR, 'data');
const DOWNLOADS_DIR = path.join(BASE_DIR, 'downloads');
const IMAGES_DIR = path.join(BASE_DIR, 'images');
const TEMP_DIR = path.join(BASE_DIR, 'temp');
```

### 5. Error Handling Integration

Use AionUi's error patterns:

```typescript
// Non-fatal errors (don't stop the plugin)
this.setError('Failed to process voice message');

// Fatal errors (transition to error state)
throw new Error('WebSocket connection failed');
```

---

## Testing Strategy

### Unit Tests (Per File)

Each task includes unit tests following TDD:

```typescript
// Example: session-store.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { loadSession, saveSession, clearSession } from '../session-store';

describe('session-store', () => {
  beforeEach(() => {
    // Setup temp directory
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    // Cleanup temp files
  });

  it('should save and load session', () => {
    const state = {
      /* ... */
    };
    saveSession(state);
    const loaded = loadSession('test-account');
    expect(loaded).toEqual(
      expect.objectContaining({
        sessionId: state.sessionId,
        lastSeq: state.lastSeq,
      })
    );
  });

  it('should return null for expired session', () => {
    vi.setSystemTime(Date.now() + 6 * 60 * 1000); // 6 minutes later
    const loaded = loadSession('test-account');
    expect(loaded).toBeNull();
  });
});
```

### Integration Tests

```typescript
// Example: qqbot-integration.test.ts
describe('QQBot Plugin Integration', () => {
  it('should process message through queue', async () => {
    const plugin = new QQBotPlugin();
    await plugin.initialize(mockConfig);
    await plugin.start();

    // Simulate incoming message
    const message = createMockMessage();
    // ... assertions

    await plugin.stop();
  });

  it('should enforce reply limits', async () => {
    // Send 5 replies to same message
    // 5th should fallback to proactive
  });

  it('should convert and send voice message', async () => {
    // Mock TTS config
    // Call sendMessage with <qqvoice> tag
    // Verify audio conversion and upload
  });
});
```

### E2E Tests (Manual/Playwright)

- WebSocket connection and reconnection
- Message sending/receiving
- Media upload and display
- Voice message flow

---

## Atomic Commit Strategy

### Commit Granularity

1. **One feature per commit** (e.g., "Add session persistence")
2. **Tests with implementation** (never separate)
3. **Refactoring separate from features**
4. **No mixing of chunks** (finish Group A before Group B)

### Commit Message Format

```
feat(qqbot): add platform utilities for path handling

- Implement getQQBotDataDir() using Electron app paths
- Add ffmpeg detection with cross-platform support
- Add expandTilde() for home directory expansion

Tests included.
```

### Branch Strategy

```
main
  └── feature/qqbot-rewrite
      ├── task/1.1-platform-utils
      ├── task/1.2-file-utils
      ├── task/1.3-image-size
      ├── task/1.4-types
      ├── task/2.1-session-store
      ├── task/2.2-ref-index-store
      ├── task/2.3-upload-cache
      ├── task/3.1-media-tags
      ├── task/3.2-audio-convert
      ├── task/4.1-api
      ├── task/4.2-config
      ├── task/5.1-outbound
      ├── task/5.2-gateway
      ├── task/6.1-plugin-rewrite
      ├── task/6.2-adapter-enhancements
      └── task/6.3-index-updates
```

---

## Execution Order

### Phase 1: Foundation (Week 1)

- [ ] Task 1.1: Platform utilities
- [ ] Task 1.2: File utilities
- [ ] Task 1.3: Image size utilities
- [ ] Task 1.4: Extended types

### Phase 2: Storage (Week 1-2)

- [ ] Task 2.1: Session store
- [ ] Task 2.2: Reference index store
- [ ] Task 2.3: Upload cache

### Phase 3: Media (Week 2)

- [ ] Task 3.1: Media tags
- [ ] Task 3.2: Audio conversion

### Phase 4: API Layer (Week 2-3)

- [ ] Task 4.1: Enhanced API
- [ ] Task 4.2: Configuration

### Phase 5: Pipeline (Week 3)

- [ ] Task 5.1: Outbound handler
- [ ] Task 5.2: Gateway queue

### Phase 6: Integration (Week 3-4)

- [ ] Task 6.1: Plugin rewrite
- [ ] Task 6.2: Adapter enhancements
- [ ] Task 6.3: Index updates
- [ ] Integration testing
- [ ] Documentation

---

## Skill Recommendations

| Task                    | Category           | Skills                           |
| ----------------------- | ------------------ | -------------------------------- |
| Platform/File utilities | Node.js/Electron   | filesystem, path handling        |
| Session/Ref stores      | Data persistence   | JSONL, file I/O, caching         |
| Media tags              | Text processing    | regex, parsing                   |
| Audio conversion        | Media processing   | silk-wasm, ffmpeg, audio codecs  |
| API layer               | HTTP/WebSocket     | token management, rate limiting  |
| Outbound/Gateway        | Message processing | queuing, async patterns          |
| Plugin rewrite          | Integration        | BasePlugin, lifecycle management |

---

## Risk Mitigation

### Technical Risks

1. **silk-wasm compatibility**
   - Mitigation: Test early in Task 3.2
   - Fallback: Skip voice features if unavailable

2. **FFmpeg availability**
   - Mitigation: Implement WASM fallback for MP3
   - Graceful degradation for other formats

3. **WebSocket reconnection edge cases**
   - Mitigation: Extensive testing of reconnect logic
   - Session persistence for resume capability

4. **Memory leaks in caches**
   - Mitigation: TTL on all caches, max size limits
   - Periodic cleanup tasks

### Schedule Risks

1. **Audio conversion complexity**
   - Contingency: Scope to WAV/MP3/SILK only
   - Defer other formats to Phase 2

2. **Multi-account support**
   - Contingency: Implement single account first
   - Add multi-account in follow-up PR

---

## Success Criteria

✅ All upstream features ported:

- Message queue with per-user serial processing
- Reply limits (4 per hour)
- Media upload with caching
- Voice STT/TTS
- Session persistence
- Reference caching
- Media tag parsing

✅ All tests passing:

- Unit tests > 80% coverage
- Integration tests for critical paths
- No regressions in existing AionUi tests

✅ Integration complete:

- Works with existing BasePlugin system
- Uses AionUi's unified message interfaces
- Follows AionUi patterns (DingTalk, Telegram examples)
- No breaking changes to existing QQBot configs

✅ Performance acceptable:

- Message processing < 100ms for text
- Voice conversion < 5s for 30s audio
- Memory usage stable over 24h runtime

---

## Appendix: File Inventory

### New Files (12)

1. `src/channels/plugins/qqbot/types.ts`
2. `src/channels/plugins/qqbot/session-store.ts`
3. `src/channels/plugins/qqbot/ref-index-store.ts`
4. `src/channels/plugins/qqbot/utils/platform.ts`
5. `src/channels/plugins/qqbot/utils/file-utils.ts`
6. `src/channels/plugins/qqbot/utils/image-size.ts`
7. `src/channels/plugins/qqbot/utils/upload-cache.ts`
8. `src/channels/plugins/qqbot/utils/media-tags.ts`
9. `src/channels/plugins/qqbot/utils/audio-convert.ts`
10. `src/channels/plugins/qqbot/api.ts`
11. `src/channels/plugins/qqbot/config.ts`
12. `src/channels/plugins/qqbot/outbound.ts`
13. `src/channels/plugins/qqbot/gateway.ts`

### Modified Files (3)

1. `src/channels/plugins/qqbot/QQBotPlugin.ts` (major rewrite)
2. `src/channels/plugins/qqbot/QQBotAdapter.ts` (add media support)
3. `src/channels/plugins/qqbot/index.ts` (add exports)

### New Test Files (13)

- `tests/unit/channels/qqbot/utils/platform.test.ts`
- `tests/unit/channels/qqbot/utils/file-utils.test.ts`
- `tests/unit/channels/qqbot/utils/image-size.test.ts`
- `tests/unit/channels/qqbot/utils/upload-cache.test.ts`
- `tests/unit/channels/qqbot/utils/media-tags.test.ts`
- `tests/unit/channels/qqbot/utils/audio-convert.test.ts`
- `tests/unit/channels/qqbot/session-store.test.ts`
- `tests/unit/channels/qqbot/ref-index-store.test.ts`
- `tests/unit/channels/qqbot/api.test.ts`
- `tests/unit/channels/qqbot/config.test.ts`
- `tests/unit/channels/qqbot/outbound.test.ts`
- `tests/unit/channels/qqbot/gateway.test.ts`
- `tests/unit/channels/qqbot/QQBotPlugin.test.ts`

---

**Plan complete. Ready for execution.**

**Next step:** Confirm plan and begin with Chunk 1, Task 1.1 (Platform utilities).
