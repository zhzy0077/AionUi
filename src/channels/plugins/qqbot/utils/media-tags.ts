/**
 * Media tag preprocessing and correction
 *
 * Normalizes common AI-generated malformed media tags to standard format.
 * Supports: <qqimg>, <qqvoice>, <qqvideo>, <qqfile>
 */

import { expandTilde } from './platform';

// Standard tag names
const VALID_TAGS = ['qqimg', 'qqvoice', 'qqvideo', 'qqfile'] as const;

// Tag alias mapping (keys all lowercase)
const TAG_ALIASES: Record<string, (typeof VALID_TAGS)[number]> = {
  // ---- qqimg variants ----
  qq_img: 'qqimg',
  qqimage: 'qqimg',
  qq_image: 'qqimg',
  qqpic: 'qqimg',
  qq_pic: 'qqimg',
  qqpicture: 'qqimg',
  qq_picture: 'qqimg',
  qqphoto: 'qqimg',
  qq_photo: 'qqimg',
  img: 'qqimg',
  image: 'qqimg',
  pic: 'qqimg',
  picture: 'qqimg',
  photo: 'qqimg',
  // ---- qqvoice variants ----
  qq_voice: 'qqvoice',
  qqaudio: 'qqvoice',
  qq_audio: 'qqvoice',
  voice: 'qqvoice',
  audio: 'qqvoice',
  // ---- qqvideo variants ----
  qq_video: 'qqvideo',
  video: 'qqvideo',
  // ---- qqfile variants ----
  qq_file: 'qqfile',
  qqdoc: 'qqfile',
  qq_doc: 'qqfile',
  file: 'qqfile',
  doc: 'qqfile',
  document: 'qqfile',
};

// Build all recognizable tag names (standard + aliases)
const ALL_TAG_NAMES = [...VALID_TAGS, ...Object.keys(TAG_ALIASES)];
// Sort by length descending, prioritize longer names (prevent "img" from matching before "qqimg")
ALL_TAG_NAMES.sort((a, b) => b.length - a.length);

const TAG_NAME_PATTERN = ALL_TAG_NAMES.join('|');

/**
 * Fuzzy regex to match various malformed tag patterns:
 *
 * Common error patterns:
 *  1. Misspelled tag names: <qq_img>, <qqimage>, <image>, <img>, <pic> ...
 *  2. Extra spaces inside tags: <qqimg >, < qqimg>, <qqimg >
 *  3. Mismatched closing tags: <qqimg>url</qqvoice>, <qqimg>url</img>
 *  4. Missing slash in closing tag: <qqimg>url<qqimg> (use opening tag as closing tag)
 *  5. Missing angle brackets in closing tag: <qqimg>url/qqimg>
 *  6. Chinese angle brackets: ＜qqimg＞url＜/qqimg＞ or <qqimg>url</qqimg>
 *  7. Extra quotes around path: <qqimg>"path"</qqimg>
 *  8. Markdown inline code wrapping: `<qqimg>path</qqimg>`
 */
export const FUZZY_MEDIA_TAG_REGEX = new RegExp(
  // Optional Markdown inline code backticks
  '`?' +
    // Opening tag: allow Chinese/English angle brackets, spaces before/after tag name
    '[<＜<]\\s*(' +
    TAG_NAME_PATTERN +
    ')\\s*[>＞>]' +
    // Content: non-greedy, allow quoted paths
    '["\']?\\s*' +
    '([^<＜<＞>"\'`]+?)' +
    '\\s*["\']?' +
    // Closing tag: allow various non-standard forms
    '[<＜<]\\s*/?\\s*(?:' +
    TAG_NAME_PATTERN +
    ')\\s*[>＞>]' +
    // Optional trailing backticks
    '`?',
  'gi'
);

/**
 * Map tag name to standard name
 */
function resolveTagName(raw: string): (typeof VALID_TAGS)[number] {
  const lower = raw.toLowerCase();
  if ((VALID_TAGS as readonly string[]).includes(lower)) {
    return lower as (typeof VALID_TAGS)[number];
  }
  return TAG_ALIASES[lower] ?? 'qqimg';
}

/**
 * Pre-cleanup: compress newlines/carriage returns/tabs inside media tags to single space.
 *
 * Some models insert \n \r \t whitespace inside tags, e.g.:
 *   <qqimg>\n  /path/to/file.png\n</qqimg>
 *   <qqimg>/path/to/\nfile.png</qqimg>
 *
 * This regex matches content between opening and closing tags (allows cross-line),
 * replacing all [\r\n\t] with space, then compress consecutive spaces.
 */
const MULTILINE_TAG_CLEANUP = new RegExp('([<＜<]\\s*(?:' + TAG_NAME_PATTERN + ')\\s*[>＞>])' + '([\\s\\S]*?)' + '([<＜<]\\s*/?\\s*(?:' + TAG_NAME_PATTERN + ')\\s*[>＞>])', 'gi');

/**
 * Preprocess LLM output text, correcting malformed media tags to standard format.
 *
 * Standard format: <qqimg>/path/to/file</qqimg>
 *
 * @param text - Raw LLM output
 * @returns Corrected text (returned as-is if no tags matched)
 */
export function normalizeMediaTags(text: string): string {
  // First compress newlines/carriage returns/tabs inside tags to spaces
  const cleaned = text.replace(MULTILINE_TAG_CLEANUP, (_m, open: string, body: string, close: string) => {
    const flat = body.replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ');
    return open + flat + close;
  });

  return cleaned.replace(FUZZY_MEDIA_TAG_REGEX, (_match, rawTag: string, content: string) => {
    const tag = resolveTagName(rawTag);
    const trimmed = content.trim();
    if (!trimmed) return _match; // Skip empty content
    // Expand tilde paths: ~/Desktop/file.png → /Users/xxx/Desktop/file.png
    const expanded = expandTilde(trimmed);
    return `<${tag}>${expanded}</${tag}>`;
  });
}

/**
 * Tag name aliases mapping for common misspellings
 */
export { TAG_ALIASES };
