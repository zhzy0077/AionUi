/**
 * Cross-platform utilities for QQBot channel
 *
 * Provides cross-platform support for:
 * - User home directory detection
 * - Temporary directory handling
 * - Local path detection
 * - FFmpeg/ffprobe executable path detection
 * - Startup diagnostics
 */

import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { execFile } from 'node:child_process';
import { getDataPath } from '@/process/utils';

// ============ Basic Platform Info ============

export type PlatformType = 'darwin' | 'linux' | 'win32' | 'other';

export function getPlatform(): PlatformType {
  const p = process.platform;
  if (p === 'darwin' || p === 'linux' || p === 'win32') return p;
  return 'other';
}

export function isWindows(): boolean {
  return process.platform === 'win32';
}

// ============ User Home Directory ============

/**
 * Safely get user home directory
 *
 * Priority:
 * 1. os.homedir() (Node native, all platforms)
 * 2. $HOME (Mac/Linux) or %USERPROFILE% (Windows)
 * 3. Fallback to /tmp (Linux/Mac) or os.tmpdir() (Windows)
 */
export function getHomeDir(): string {
  try {
    const home = os.homedir();
    if (home && fs.existsSync(home)) return home;
  } catch {}

  // fallback env var
  const envHome = process.env.HOME || process.env.USERPROFILE;
  if (envHome && fs.existsSync(envHome)) return envHome;

  // last fallback
  return os.tmpdir();
}

/**
 * Get QQBot data directory under AionUi's app data directory
 * Uses AionUi's getDataPath() which points to ~/.aionui
 */
export function getQQBotDataDir(...subPaths: string[]): string {
  const baseDir = path.join(getDataPath(), 'qqbot');
  const dir = path.join(baseDir, ...subPaths);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

// ============ Temporary Directory ============

/**
 * Get system temporary directory (cross-platform safe)
 * Mac: /var/folders/... or /tmp
 * Linux: /tmp
 * Windows: %TEMP% or C:\Users\xxx\AppData\Local\Temp
 */
export function getTempDir(): string {
  return os.tmpdir();
}

// ============ Tilde Path Expansion ============

/**
 * Expand tilde (~) in path to user home directory
 *
 * Supports:
 * - ~/xxx → /Users/you/xxx (Mac) or /home/you/xxx (Linux)
 * - ~ → /Users/you
 * - Non-~ paths returned as-is
 *
 * Note: Does not support ~otheruser/xxx syntax
 */
export function expandTilde(p: string): string {
  if (!p) return p;
  if (p === '~') return getHomeDir();
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return path.join(getHomeDir(), p.slice(2));
  }
  return p;
}

/**
 * Normalize path: strip file:// prefix + expand tilde + trim whitespace
 * All file operations should process user input paths through this function
 */
export function normalizePath(p: string): string {
  let result = p.trim();
  // Strip file:// protocol prefix: file:///Users/... → /Users/...
  if (result.startsWith('file://')) {
    result = result.slice('file://'.length);
    // Handle URL encoding (spaces in file:// paths may be encoded)
    try {
      result = decodeURIComponent(result);
    } catch {
      // Keep original if decode fails
    }
  }
  return expandTilde(result);
}

// ============ File Name UTF-8 Normalization ============

/**
 * Normalize file name to UTF-8 encoding required by QQ Bot API
 *
 * Problem scenarios:
 * - macOS HFS+/APFS filesystem uses NFD (Unicode decomposition) for file names
 * - File names may contain special control characters not accepted by API
 * - URL paths may contain percent-encoded file names that need decoding
 *
 * Processing:
 * 1. Unicode NFC normalization (merge NFD to NFC)
 * 2. Remove ASCII control characters (0x00-0x1F, 0x7F)
 * 3. Trim whitespace
 * 4. Try URI decode for percent-encoded file names
 */
export function sanitizeFileName(name: string): string {
  if (!name) return name;

  let result = name.trim();

  // Try URI decode (handle percent-encoded Chinese file names in URLs)
  // e.g. %E4%B8%AD%E6%96%87.txt → 中文.txt
  if (result.includes('%')) {
    try {
      result = decodeURIComponent(result);
    } catch {
      // Keep original if decode fails
    }
  }

  // Unicode NFC normalization: merge macOS NFD to standard NFC
  result = result.normalize('NFC');

  // Remove ASCII control characters (keep all printable and non-ASCII)
  result = result.replace(/[\x00-\x1F\x7F]/g, '');

  return result;
}

// ============ Local Path Detection ============

/**
 * Determine if string is a local file path (not URL)
 *
 * Covers:
 * - Unix absolute path: /Users/..., /home/..., /tmp/...
 * - Windows absolute path: C:\..., D:/..., \\server\share
 * - Relative path: ./file, ../file
 * - Tilde path: ~/Desktop/file.png
 * - file:// protocol: file:///Users/..., file:///home/...
 *
 * Does not match:
 * - http:// / https:// URL
 * - data: URL
 */
export function isLocalPath(p: string): boolean {
  if (!p) return false;
  // file:// protocol
  if (p.startsWith('file://')) return true;
  // tilde path
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) return true;
  // Unix absolute path
  if (p.startsWith('/')) return true;
  // Windows drive letter: C:\ or C:/
  if (/^[a-zA-Z]:[\\/]/.test(p)) return true;
  // Windows UNC: \\server\share
  if (p.startsWith('\\\\')) return true;
  // Relative path
  if (p.startsWith('./') || p.startsWith('../')) return true;
  // Windows relative path
  if (p.startsWith('.\\') || p.startsWith('..\\')) return true;
  return false;
}

/**
 * Check if path extracted from markdown looks like local path
 * More relaxed than isLocalPath, used to detect misuse from markdown ![](path)
 */
export function looksLikeLocalPath(p: string): boolean {
  if (isLocalPath(p)) return true;
  // Common system directory prefixes
  return /^(?:Users|home|tmp|var|private|[A-Z]:)/i.test(p);
}

// ============ FFmpeg Cross-Platform Detection ============

let _ffmpegPath: string | null | undefined; // undefined = not detected, null = unavailable
let _ffmpegCheckPromise: Promise<string | null> | null = null;

/**
 * Detect if ffmpeg is available, return executable path
 *
 * On Windows detects ffmpeg.exe, on Mac/Linux detects ffmpeg
 * Supports custom path via FFMPEG_PATH environment variable
 *
 * @returns ffmpeg executable path, or null if unavailable
 */
export function detectFfmpeg(): Promise<string | null> {
  if (_ffmpegPath !== undefined) return Promise.resolve(_ffmpegPath);
  if (_ffmpegCheckPromise) return _ffmpegCheckPromise;

  _ffmpegCheckPromise = (async () => {
    // 1. Custom path from environment variable
    const envPath = process.env.FFMPEG_PATH;
    if (envPath) {
      const ok = await testExecutable(envPath, ['-version']);
      if (ok) {
        _ffmpegPath = envPath;
        console.log(`[platform] ffmpeg found via FFMPEG_PATH: ${envPath}`);
        return _ffmpegPath;
      }
      console.warn(`[platform] FFMPEG_PATH set but not working: ${envPath}`);
    }

    // 2. Detect in system PATH
    const cmd = isWindows() ? 'ffmpeg.exe' : 'ffmpeg';
    const ok = await testExecutable(cmd, ['-version']);
    if (ok) {
      _ffmpegPath = cmd;
      console.log(`[platform] ffmpeg detected in PATH`);
      return _ffmpegPath;
    }

    // 3. Common installation locations (Mac brew, Windows choco/scoop)
    const commonPaths = isWindows()
      ? ['C:\\ffmpeg\\bin\\ffmpeg.exe', path.join(process.env.LOCALAPPDATA || '', 'Programs', 'ffmpeg', 'bin', 'ffmpeg.exe'), path.join(process.env.ProgramFiles || '', 'ffmpeg', 'bin', 'ffmpeg.exe')]
      : [
          '/usr/local/bin/ffmpeg', // Mac brew
          '/opt/homebrew/bin/ffmpeg', // Mac ARM brew
          '/usr/bin/ffmpeg', // Linux apt
          '/snap/bin/ffmpeg', // Linux snap
        ];

    for (const p of commonPaths) {
      if (p && fs.existsSync(p)) {
        const works = await testExecutable(p, ['-version']);
        if (works) {
          _ffmpegPath = p;
          console.log(`[platform] ffmpeg found at: ${p}`);
          return _ffmpegPath;
        }
      }
    }

    _ffmpegPath = null;
    return null;
  })().finally(() => {
    _ffmpegCheckPromise = null;
  });

  return _ffmpegCheckPromise;
}

/** Test if executable runs successfully */
function testExecutable(cmd: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 5000 }, (err) => {
      resolve(!err);
    });
  });
}

/** Reset ffmpeg cache (for testing) */
export function resetFfmpegCache(): void {
  _ffmpegPath = undefined;
  _ffmpegCheckPromise = null;
}

// ============ Startup Environment Diagnostics ============

export interface DiagnosticReport {
  platform: string;
  arch: string;
  nodeVersion: string;
  homeDir: string;
  tempDir: string;
  dataDir: string;
  ffmpeg: string | null;
  warnings: string[];
}

/**
 * Run startup diagnostics and return environment report
 * Called during gateway startup to print environment info and warnings
 */
export async function runDiagnostics(): Promise<DiagnosticReport> {
  const warnings: string[] = [];

  const platform = `${process.platform} (${os.release()})`;
  const arch = process.arch;
  const nodeVersion = process.version;
  const homeDir = getHomeDir();
  const tempDir = getTempDir();
  const dataDir = getQQBotDataDir();

  // Detect ffmpeg
  const ffmpegPath = await detectFfmpeg();
  if (!ffmpegPath) {
    warnings.push(isWindows() ? '⚠️ ffmpeg not installed. Voice/video format conversion will be limited. Install: choco install ffmpeg or scoop install ffmpeg or download from https://ffmpeg.org' : getPlatform() === 'darwin' ? '⚠️ ffmpeg not installed. Voice/video format conversion will be limited. Install: brew install ffmpeg' : '⚠️ ffmpeg not installed. Voice/video format conversion will be limited. Install: sudo apt install ffmpeg or sudo yum install ffmpeg');
  }

  // Check data directory writability
  try {
    const testFile = path.join(dataDir, '.write-test');
    fs.writeFileSync(testFile, 'test');
    fs.unlinkSync(testFile);
  } catch {
    warnings.push(`⚠️ Data directory not writable: ${dataDir}. Please check permissions`);
  }

  // Windows specific reminder
  if (isWindows()) {
    // Check if path contains Chinese or spaces
    if (/[\u4e00-\u9fa5]/.test(homeDir) || homeDir.includes(' ')) {
      warnings.push(`⚠️ User directory contains Chinese or spaces: ${homeDir}. Some tools may not work properly, consider setting QQBOT_DATA_DIR environment variable to specify a pure English path`);
    }
  }

  const report: DiagnosticReport = {
    platform,
    arch,
    nodeVersion,
    homeDir,
    tempDir,
    dataDir,
    ffmpeg: ffmpegPath,
    warnings,
  };

  // Print diagnostic report
  console.log('=== QQBot Environment Diagnostics ===');
  console.log(`  Platform: ${platform} (${arch})`);
  console.log(`  Node: ${nodeVersion}`);
  console.log(`  Home: ${homeDir}`);
  console.log(`  Data: ${dataDir}`);
  console.log(`  ffmpeg: ${ffmpegPath ?? 'not installed'}`);
  if (warnings.length > 0) {
    console.log('  --- Warnings ---');
    for (const w of warnings) {
      console.log(`  ${w}`);
    }
  }
  console.log('======================');

  return report;
}
