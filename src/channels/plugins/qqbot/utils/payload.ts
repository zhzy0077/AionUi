/**
 * QQBot structured message payload utilities
 *
 * Used to handle structured message payloads from AI output, including:
 * - Cron reminder payload (cron_reminder)
 * - Media message payload (media)
 */

// ============================================
// Type Definitions
// ============================================

/**
 * Cron reminder payload
 */
export interface CronReminderPayload {
  type: 'cron_reminder';
  /** Reminder content */
  content: string;
  /** Target type: c2c (private) or group */
  targetType: 'c2c' | 'group';
  /** Target address: user_openid or group_openid */
  targetAddress: string;
  /** Original message ID (optional) */
  originalMessageId?: string;
}

/**
 * Media message payload
 */
export interface MediaPayload {
  type: 'media';
  /** Media type: image, audio, video, file */
  mediaType: 'image' | 'audio' | 'video' | 'file';
  /** Source type: url or file */
  source: 'url' | 'file';
  /** Media path or URL */
  path: string;
  /** Media description (optional) */
  caption?: string;
}

/**
 * QQBot payload union type
 */
export type QQBotPayload = CronReminderPayload | MediaPayload;

/**
 * Parse result
 */
export interface ParseResult {
  /** Whether it's a structured payload */
  isPayload: boolean;
  /** Parsed payload object (if structured payload) */
  payload?: QQBotPayload;
  /** Raw text (if not structured payload) */
  text?: string;
  /** Parse error message (if parsing failed) */
  error?: string;
}

// ============================================
// Constants
// ============================================

/** Structured payload prefix for AI output */
const PAYLOAD_PREFIX = 'QQBOT_PAYLOAD:';

/** Prefix for cron message storage */
const CRON_PREFIX = 'QQBOT_CRON:';

// ============================================
// Parse Functions
// ============================================

/**
 * Parse structured payload from AI output
 *
 * Checks if message starts with QQBOT_PAYLOAD: prefix, if so extracts and parses JSON
 *
 * @param text - Raw text from AI output
 * @returns Parse result
 *
 * @example
 * const result = parseQQBotPayload('QQBOT_PAYLOAD:\n{"type": "media", "mediaType": "image", ...}');
 * if (result.isPayload && result.payload) {
 *   // Handle structured payload
 * }
 */
export function parseQQBotPayload(text: string): ParseResult {
  const trimmedText = text.trim();

  // Check if starts with QQBOT_PAYLOAD:
  if (!trimmedText.startsWith(PAYLOAD_PREFIX)) {
    return {
      isPayload: false,
      text: text,
    };
  }

  // Extract JSON content (remove prefix)
  const jsonContent = trimmedText.slice(PAYLOAD_PREFIX.length).trim();

  if (!jsonContent) {
    return {
      isPayload: true,
      error: 'Payload content is empty',
    };
  }

  try {
    const payload = JSON.parse(jsonContent) as QQBotPayload;

    // Validate required fields
    if (!payload.type) {
      return {
        isPayload: true,
        error: 'Payload missing type field',
      };
    }

    // Additional validation based on type
    if (payload.type === 'cron_reminder') {
      if (!payload.content || !payload.targetType || !payload.targetAddress) {
        return {
          isPayload: true,
          error: 'cron_reminder payload missing required fields (content, targetType, targetAddress)',
        };
      }
    } else if (payload.type === 'media') {
      if (!payload.mediaType || !payload.source || !payload.path) {
        return {
          isPayload: true,
          error: 'media payload missing required fields (mediaType, source, path)',
        };
      }
    }

    return {
      isPayload: true,
      payload,
    };
  } catch (e) {
    return {
      isPayload: true,
      error: `JSON parse failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

// ============================================
// Cron Encode/Decode Functions
// ============================================

/**
 * Encode cron reminder payload to cron message format
 *
 * Encodes JSON to Base64 and adds QQBOT_CRON: prefix
 *
 * @param payload - Cron reminder payload
 * @returns Encoded message string, format: QQBOT_CRON:{base64}
 *
 * @example
 * const message = encodePayloadForCron({
 *   type: 'cron_reminder',
 *   content: 'Time to drink water!',
 *   targetType: 'c2c',
 *   targetAddress: 'user_openid_xxx'
 * });
 * // Returns: QQBOT_CRON:eyJ0eXBlIjoiY3Jvbl9yZW1pbmRlciIs...
 */
export function encodePayloadForCron(payload: CronReminderPayload): string {
  const jsonString = JSON.stringify(payload);
  const base64 = Buffer.from(jsonString, 'utf-8').toString('base64');
  return `${CRON_PREFIX}${base64}`;
}

/**
 * Decode payload from cron message
 *
 * Detects QQBOT_CRON: prefix, decodes Base64 and parses JSON
 *
 * @param message - Message received when cron triggers
 * @returns Decode result, including whether it's a cron payload, parsed payload object, or error
 *
 * @example
 * const result = decodeCronPayload('QQBOT_CRON:eyJ0eXBlIjoiY3Jvbl9yZW1pbmRlciIs...');
 * if (result.isCronPayload && result.payload) {
 *   // Handle scheduled reminder
 * }
 */
export function decodeCronPayload(message: string): {
  isCronPayload: boolean;
  payload?: CronReminderPayload;
  error?: string;
} {
  const trimmedMessage = message.trim();

  // Check if starts with QQBOT_CRON:
  if (!trimmedMessage.startsWith(CRON_PREFIX)) {
    return {
      isCronPayload: false,
    };
  }

  // Extract Base64 content
  const base64Content = trimmedMessage.slice(CRON_PREFIX.length);

  if (!base64Content) {
    return {
      isCronPayload: true,
      error: 'Cron payload content is empty',
    };
  }

  try {
    // Base64 decode
    const jsonString = Buffer.from(base64Content, 'base64').toString('utf-8');
    const payload = JSON.parse(jsonString) as CronReminderPayload;

    // Validate type
    if (payload.type !== 'cron_reminder') {
      return {
        isCronPayload: true,
        error: `Expected type to be cron_reminder, got ${payload.type}`,
      };
    }

    // Validate required fields
    if (!payload.content || !payload.targetType || !payload.targetAddress) {
      return {
        isCronPayload: true,
        error: 'Cron payload missing required fields',
      };
    }

    return {
      isCronPayload: true,
      payload,
    };
  } catch (e) {
    return {
      isCronPayload: true,
      error: `Cron payload decode failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

// ============================================
// Helper Functions
// ============================================

/**
 * Check if payload is a cron reminder type
 */
export function isCronReminderPayload(payload: QQBotPayload): payload is CronReminderPayload {
  return payload.type === 'cron_reminder';
}

/**
 * Check if payload is a media message type
 */
export function isMediaPayload(payload: QQBotPayload): payload is MediaPayload {
  return payload.type === 'media';
}
