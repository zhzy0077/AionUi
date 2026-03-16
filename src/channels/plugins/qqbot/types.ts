/**
 * QQBot Channel Type Definitions
 * Type definitions for QQBot channel plugin configuration and events
 */

/**
 * QQBot basic configuration
 * Contains application credentials for connecting to QQ Bot API
 */
export interface QQBotConfig {
  /** Application ID from QQ Bot platform */
  appId: string;
  /** Client secret (inline) */
  clientSecret?: string;
  /** Client secret file path (alternative to inline) */
  clientSecretFile?: string;
}

/**
 * Resolved QQBot account with all fields parsed and defaults applied
 */
export interface ResolvedQQBotAccount {
  /** Account identifier */
  accountId: string;
  /** Account display name */
  name?: string;
  /** Whether this account is enabled */
  enabled: boolean;
  /** Application ID */
  appId: string;
  /** Resolved client secret */
  clientSecret: string;
  /** Source of the secret: config, file, env, or none */
  secretSource: 'config' | 'file' | 'env' | 'none';
  /** System prompt added before user messages */
  systemPrompt?: string;
  /** Public URL for image server (e.g., http://your-ip:18765) */
  imageServerBaseUrl?: string;
  /** Whether markdown messages are supported (default: true) */
  markdownSupport: boolean;
  /** Original account configuration */
  config: QQBotAccountConfig;
}

/**
 * Per-account configuration for QQBot
 */
export interface QQBotAccountConfig {
  /** Whether this account is enabled */
  enabled?: boolean;
  /** Account display name */
  name?: string;
  /** Application ID */
  appId?: string;
  /** Client secret (inline) */
  clientSecret?: string;
  /** Client secret file path */
  clientSecretFile?: string;
  /** Direct message policy: open (anyone), pairing (requires auth), allowlist (specific users) */
  dmPolicy?: 'open' | 'pairing' | 'allowlist';
  /** Allowed senders (user IDs or patterns). Default: ["*"] when not set */
  allowFrom?: string[];
  /** System prompt added before user messages */
  systemPrompt?: string;
  /** Public URL for image server (e.g., http://your-ip:18765) */
  imageServerBaseUrl?: string;
  /** Whether markdown messages are supported (default: true, set false to disable) */
  markdownSupport?: boolean;
  /**
   * @deprecated Use audioFormatPolicy.uploadDirectFormats instead
   * Audio formats that can be uploaded directly (skip SILK conversion)
   * Kept for backward compatibility
   */
  voiceDirectUploadFormats?: string[];
  /**
   * Audio format policy configuration
   * Unified management of inbound (STT) and outbound (upload) audio format conversion
   */
  audioFormatPolicy?: AudioFormatPolicy;
}

/**
 * Audio format policy: controls which formats skip conversion
 */
export interface AudioFormatPolicy {
  /**
   * Audio formats supported directly by STT model (inbound: skip SILK->WAV conversion)
   * If STT service supports certain formats directly (e.g., silk/amr), add to this list
   * Example: [".silk", ".amr", ".wav", ".mp3", ".ogg"]
   * Default: empty (all voice first converted to WAV then to STT)
   */
  sttDirectFormats?: string[];
  /**
   * Audio formats supported by QQ platform for direct upload (outbound: skip->SILK conversion)
   * Default: [".wav", ".mp3", ".silk"] (three formats natively supported by QQ Bot API)
   * Only configure this to override the default
   */
  uploadDirectFormats?: string[];
}

/**
 * Rich media attachment
 */
export interface MessageAttachment {
  /** MIME content type (e.g., "image/png") */
  content_type: string;
  /** File name */
  filename?: string;
  /** Image height */
  height?: number;
  /** Image width */
  width?: number;
  /** File size in bytes */
  size: string;
  /** File URL */
  url: string;
  /** QQ-provided WAV format voice direct URL (use this to avoid SILK->WAV conversion) */
  voice_wav_url?: string;
  /** Built-in ASR text from QQ event (limited accuracy, fallback when STT fails) */
  asr_refer_text?: string;
}

/**
 * C2C (private) message event
 */
export interface C2CMessageEvent {
  /** Author information */
  author: {
    /** User ID */
    id: string;
    /** Union OpenID */
    union_openid: string;
    /** User OpenID */
    user_openid: string;
  };
  /** Message content */
  content: string;
  /** Message ID */
  id: string;
  /** Timestamp */
  timestamp: string;
  /** Message scene info */
  message_scene?: {
    /** Message source */
    source: string;
    /** Ext array, may include ref_msg_idx=REFIDX_xxx (quoted message) and msg_idx=REFIDX_xxx (self index) */
    ext?: string[];
  };
  /** Attachments */
  attachments?: MessageAttachment[];
}

/**
 * Guild (channel) AT message event
 */
export interface GuildMessageEvent {
  /** Message ID */
  id: string;
  /** Channel ID */
  channel_id: string;
  /** Guild ID */
  guild_id: string;
  /** Message content */
  content: string;
  /** Timestamp */
  timestamp: string;
  /** Author information */
  author: {
    /** User ID */
    id: string;
    /** Username */
    username?: string;
    /** Whether bot */
    bot?: boolean;
  };
  /** Member info */
  member?: {
    /** Nickname */
    nick?: string;
    /** Join timestamp */
    joined_at?: string;
  };
  /** Attachments */
  attachments?: MessageAttachment[];
}

/**
 * Group message event
 */
export interface GroupMessageEvent {
  /** Author information */
  author: {
    /** User ID */
    id: string;
    /** Member OpenID */
    member_openid: string;
  };
  /** Message content */
  content: string;
  /** Message ID */
  id: string;
  /** Timestamp */
  timestamp: string;
  /** Group ID */
  group_id: string;
  /** Group OpenID */
  group_openid: string;
  /** Message scene info */
  message_scene?: {
    /** Message source */
    source: string;
    /** Ext array */
    ext?: string[];
  };
  /** Attachments */
  attachments?: MessageAttachment[];
}

/**
 * WebSocket payload structure
 */
export interface WSPayload {
  /** Opcode */
  op: number;
  /** Event data */
  d?: unknown;
  /** Sequence number */
  s?: number;
  /** Event type */
  t?: string;
}

/**
 * QQBot channel-specific configuration stored in database
 * Extends IChannelPluginConfig with QQBot-specific fields
 */
export interface QQBotChannelConfig extends QQBotAccountConfig {
  /** Multi-account support: named accounts */
  accounts?: Record<string, QQBotAccountConfig>;
}
