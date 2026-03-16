/**
 * Audio format conversion utilities for QQBot channel
 *
 * Provides:
 * - SILK audio format conversion (using silk-wasm library)
 * - TTS (Text-to-Speech) integration with OpenAI-compatible APIs
 * - Audio file format conversion pipeline
 * - FFmpeg integration for audio processing
 *
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { decode, encode, isSilk } from 'silk-wasm';
import { isWindows, detectFfmpeg } from './platform.js';

// ============ SILK Conversion ================

/**
 * Check if file is SILK format (common QQ/WeChat voice format)
 * QQ voice files often saved with .amr extension but actually SILK v3
 * SILK file header marker: 0x02 "#!SILK_V3"
 */
export function isSilkFile(filePath: string): boolean {
  try {
    const buf = fs.readFileSync(filePath);
    return isSilk(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
  } catch {
    return false;
  }
}

/**
 * Wrap PCM (s16le) data in WAV file format
 * WAV = 44 byte RIFF header + PCM raw data
 */
export function pcmToWav(pcmData: Uint8Array, sampleRate: number, channels: number = 1, bitsPerSample: number = 16): Buffer {
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  const dataSize = pcmData.length;
  const headerSize = 44;
  const fileSize = headerSize + dataSize;

  const buffer = Buffer.alloc(fileSize);

  // RIFF header
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(fileSize - 8, 4);
  buffer.write('WAVE', 8);

  // fmt sub-chunk
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16); // sub-chunk size
  buffer.writeUInt16LE(1, 20); // PCM format
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);

  // data sub-chunk
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);
  Buffer.from(pcmData.buffer, pcmData.byteOffset, pcmData.byteLength).copy(buffer, headerSize);

  return buffer;
}

/**
 * Remove AMR header from QQ voice file (if present)
 * QQ's .amr files may have "#!AMR\n" header (6 bytes) before SILK data
 * Need to remove this for silk-wasm to decode correctly
 */
export function stripAmrHeader(buf: Buffer): Buffer {
  const AMR_HEADER = Buffer.from('#!AMR\n');
  if (buf.length > 6 && buf.subarray(0, 6).equals(AMR_HEADER)) {
    return buf.subarray(6);
  }
  return buf;
}

/**
 * Convert SILK/AMR voice file to WAV format
 *
 * @param inputPath Input file path (.amr / .silk / .slk)
 * @param outputDir Output directory (default same as input file)
 * @returns Converted WAV file path, or null on failure
 */
export async function convertSilkToWav(inputPath: string, outputDir?: string): Promise<{ wavPath: string; duration: number } | null> {
  if (!fs.existsSync(inputPath)) {
    return null;
  }

  const fileBuf = fs.readFileSync(inputPath);

  // Remove possible AMR header
  const strippedBuf = stripAmrHeader(fileBuf);

  // Convert to Uint8Array for silk-wasm type compatibility
  const rawData = new Uint8Array(strippedBuf.buffer, strippedBuf.byteOffset, strippedBuf.byteLength);

  // Verify SILK format
  if (!isSilk(rawData)) {
    return null;
  }

  // SILK decode to PCM (s16le)
  // QQ voice typically uses 24000Hz sample rate
  const sampleRate = 24000;
  const result = await decode(rawData, sampleRate);

  // PCM → WAV
  const wavBuffer = pcmToWav(result.data, sampleRate);

  // Write WAV file
  const dir = outputDir || path.dirname(inputPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const baseName = path.basename(inputPath, path.extname(inputPath));
  const wavPath = path.join(dir, `${baseName}.wav`);
  fs.writeFileSync(wavPath, wavBuffer);

  return { wavPath, duration: result.duration };
}

// ============ Voice Detection ================

/**
 * Check if attachment is voice (by content_type or file extension)
 */
export function isVoiceAttachment(att: { content_type?: string; filename?: string }): boolean {
  if (att.content_type === 'voice' || att.content_type?.startsWith('audio/')) {
    return true;
  }
  const ext = att.filename ? path.extname(att.filename).toLowerCase() : '';
  return ['.amr', '.silk', '.slk', '.slac'].includes(ext);
}

/**
 * Format voice duration to readable Chinese string
 */
export function formatDuration(durationMs: number): string {
  const seconds = Math.round(durationMs / 1000);
  if (seconds < 60) {
    return `${seconds}秒`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainSeconds = seconds % 60;
  return remainSeconds > 0 ? `${minutes}分${remainSeconds}秒` : `${minutes}分钟`;
}

export function isAudioFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return ['.silk', '.slk', '.amr', '.wav', '.mp3', '.ogg', '.opus', '.aac', '.flac', '.m4a', '.wma', '.pcm'].includes(ext);
}

// ============ TTS (Text-to-Speech) =============

export interface TTSConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  voice: string;
  /** Azure OpenAI style: use api-key header instead of Bearer token */
  authStyle?: 'bearer' | 'api-key';
  /** Query params appended to URL, e.g. api-version for Azure */
  queryParams?: Record<string, string>;
  /** Custom speed (default not passed) */
  speed?: number;
}

/**
 * Resolve TTS config from plugin configuration
 * Accepts TTSConfig directly or builds from plugin config structure
 */
export function resolveTTSConfig(cfg: Record<string, unknown>): TTSConfig | null {
  const c = cfg as Record<string, unknown>;

  // Try to find TTS config in the plugin config
  // Look for tts object with required fields
  const ttsConfig = c?.tts as Record<string, unknown> | undefined;

  if (ttsConfig) {
    const baseUrl = ttsConfig?.baseUrl as string | undefined;
    const apiKey = ttsConfig?.apiKey as string | undefined;
    const model = (ttsConfig?.model as string) || 'tts-1';
    const voice = (ttsConfig?.voice as string) || 'alloy';

    if (!baseUrl || !apiKey) {
      return null;
    }

    const authStyle = (ttsConfig?.authStyle as string) === 'api-key' ? ('api-key' as const) : ('bearer' as const);

    const queryParams = ttsConfig?.queryParams as Record<string, string> | undefined;
    const speed = ttsConfig?.speed as number | undefined;

    return {
      baseUrl: baseUrl.replace(/\/+$/, ''),
      apiKey,
      model,
      voice,
      authStyle,
      ...(queryParams && Object.keys(queryParams).length > 0 ? { queryParams } : {}),
      ...(speed !== undefined ? { speed } : {}),
    };
  }

  return null;
}

/**
 * Build TTS request URL and Headers
 * Supports both OpenAI standard and Azure OpenAI styles
 */
function buildTTSRequest(ttsCfg: TTSConfig): { url: string; headers: Record<string, string> } {
  // Build URL: baseUrl + /audio/speech + optional queryParams
  let url = `${ttsCfg.baseUrl}/audio/speech`;
  if (ttsCfg.queryParams && Object.keys(ttsCfg.queryParams).length > 0) {
    const qs = new URLSearchParams(ttsCfg.queryParams).toString();
    url += `?${qs}`;
  }

  // Build auth Header
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (ttsCfg.authStyle === 'api-key') {
    headers['api-key'] = ttsCfg.apiKey;
  } else {
    headers['Authorization'] = `Bearer ${ttsCfg.apiKey}`;
  }

  return { url, headers };
}

export async function textToSpeechPCM(text: string, ttsCfg: TTSConfig): Promise<{ pcmBuffer: Buffer; sampleRate: number }> {
  const sampleRate = 24000;
  const { url, headers } = buildTTSRequest(ttsCfg);

  console.log(`[tts] Request: model=${ttsCfg.model}, voice=${ttsCfg.voice}, authStyle=${ttsCfg.authStyle ?? 'bearer'}, url=${url}`);
  console.log(`[tts] Input text (${text.length} chars): "${text.slice(0, 80)}${text.length > 80 ? '...' : ''}"`);

  // Try PCM format first (highest quality, no re-encoding needed)
  const formats: Array<{ format: string; needsDecode: boolean }> = [
    { format: 'pcm', needsDecode: false },
    { format: 'mp3', needsDecode: true },
  ];

  let lastError: Error | null = null;
  const startTime = Date.now();

  for (const { format, needsDecode } of formats) {
    const controller = new AbortController();
    const ttsTimeout = setTimeout(() => controller.abort(), 120000);

    try {
      const body: Record<string, unknown> = {
        model: ttsCfg.model,
        input: text,
        voice: ttsCfg.voice,
        response_format: format,
        ...(format === 'pcm' ? { sample_rate: sampleRate } : {}),
        ...(ttsCfg.speed !== undefined ? { speed: ttsCfg.speed } : {}),
      };

      console.log(`[tts] Trying format=${format}...`);
      const fetchStart = Date.now();
      const resp = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      }).finally(() => clearTimeout(ttsTimeout));

      const fetchMs = Date.now() - fetchStart;

      if (!resp.ok) {
        const detail = await resp.text().catch(() => '');
        console.log(`[tts] HTTP ${resp.status} for format=${format} (${fetchMs}ms): ${detail.slice(0, 200)}`);
        // If PCM not supported (Azure etc.), fallback to mp3
        if (format === 'pcm' && (resp.status === 400 || resp.status === 422)) {
          console.log(`[tts] PCM format not supported, falling back to mp3`);
          lastError = new Error(`TTS PCM not supported: ${detail.slice(0, 200)}`);
          continue;
        }
        throw new Error(`TTS failed (HTTP ${resp.status}): ${detail.slice(0, 300)}`);
      }

      const arrayBuffer = await resp.arrayBuffer();
      const rawBuffer = Buffer.from(arrayBuffer);
      console.log(`[tts] Response OK: format=${format}, size=${rawBuffer.length} bytes, latency=${fetchMs}ms`);

      if (!needsDecode) {
        console.log(`[tts] Done: PCM direct, ${rawBuffer.length} bytes, total=${Date.now() - startTime}ms`);
        return { pcmBuffer: rawBuffer, sampleRate };
      }

      // mp3 needs to be decoded to PCM
      console.log(`[tts] Decoding mp3 response (${rawBuffer.length} bytes) to PCM...`);
      const tmpDir = path.join(fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'tts-')));
      const tmpMp3 = path.join(tmpDir, 'tts.mp3');
      fs.writeFileSync(tmpMp3, rawBuffer);

      try {
        // Prefer ffmpeg
        const ffmpegCmd = await detectFfmpeg();
        if (ffmpegCmd) {
          const pcmBuf = await ffmpegToPCM(ffmpegCmd, tmpMp3, sampleRate);
          console.log(`[tts] Done: mp3→PCM (ffmpeg), ${pcmBuf.length} bytes, total=${Date.now() - startTime}ms`);
          return { pcmBuffer: pcmBuf, sampleRate };
        }
        // WASM fallback
        const pcmBuf = await wasmDecodeMp3ToPCM(rawBuffer, sampleRate);
        if (pcmBuf) {
          console.log(`[tts] Done: mp3→PCM (wasm), ${pcmBuf.length} bytes, total=${Date.now() - startTime}ms`);
          return { pcmBuffer: pcmBuf, sampleRate };
        }
        throw new Error('No decoder available for mp3 (install ffmpeg for best compatibility)');
      } finally {
        try {
          fs.unlinkSync(tmpMp3);
          fs.rmdirSync(tmpDir);
        } catch {}
      }
    } catch (err) {
      clearTimeout(ttsTimeout);
      lastError = err instanceof Error ? err : new Error(String(err));
      console.log(`[tts] Error for format=${format}: ${lastError.message.slice(0, 200)}`);
      if (format === 'pcm') {
        // Don't throw immediately on PCM failure, try mp3
        continue;
      }
      throw lastError;
    }
  }

  console.log(`[tts] All formats exhausted after ${Date.now() - startTime}ms`);
  throw lastError ?? new Error('TTS failed: all formats exhausted');
}

export async function pcmToSilk(pcmBuffer: Buffer, sampleRate: number): Promise<{ silkBuffer: Buffer; duration: number }> {
  const pcmData = new Uint8Array(pcmBuffer.buffer, pcmBuffer.byteOffset, pcmBuffer.byteLength);
  const result = await encode(pcmData, sampleRate);
  return {
    silkBuffer: Buffer.from(result.data.buffer, result.data.byteOffset, result.data.byteLength),
    duration: result.duration,
  };
}

export async function textToSilk(text: string, ttsCfg: TTSConfig, outputDir: string): Promise<{ silkPath: string; silkBase64: string; duration: number }> {
  const { pcmBuffer, sampleRate } = await textToSpeechPCM(text, ttsCfg);
  const { silkBuffer, duration } = await pcmToSilk(pcmBuffer, sampleRate);

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  const silkPath = path.join(outputDir, `tts-${Date.now()}.silk`);
  fs.writeFileSync(silkPath, silkBuffer);

  return { silkPath, silkBase64: silkBuffer.toString('base64'), duration };
}

// ============ Core: Any Audio → SILK Base64 =============

/** Native upload formats supported by QQ Bot API (no conversion needed) */
const QQ_NATIVE_UPLOAD_FORMATS = ['.wav', '.mp3', '.silk'];

/**
 * Convert local audio file to QQ Bot uploadable Base64
 *
 * QQ Bot API supports direct upload of WAV, MP3, SILK formats, others need conversion.
 * Conversion strategy:
 *
 * 1. WAV / MP3 / SILK → direct upload (skip conversion)
 * 2. Has ffmpeg → ffmpeg universal decode to PCM → silk-wasm encode
 *    Supports: ogg, opus, aac, flac, wma, m4a, pcm etc.
 * 3. No ffmpeg → WASM fallback (only supports pcm, wav)
 *
 * @param directUploadFormats - Custom direct upload formats, undefined uses QQ_NATIVE_UPLOAD_FORMATS
 */
export async function audioFileToSilkBase64(filePath: string, directUploadFormats?: string[]): Promise<string | null> {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  const buf = fs.readFileSync(filePath);
  if (buf.length === 0) {
    console.error(`[audio-convert] file is empty: ${filePath}`);
    return null;
  }

  const ext = path.extname(filePath).toLowerCase();

  // 0. Direct upload check: QQ Bot API natively supports WAV/MP3/SILK
  const uploadFormats = directUploadFormats ? normalizeFormats(directUploadFormats) : QQ_NATIVE_UPLOAD_FORMATS;
  if (uploadFormats.includes(ext)) {
    console.log(`[audio-convert] direct upload (QQ native format): ${ext} (${buf.length} bytes)`);
    return buf.toString('base64');
  }

  // 1. .slk / .amr extension → check SILK magic number, if SILK then direct upload
  if (['.slk', '.slac'].includes(ext)) {
    const stripped = stripAmrHeader(buf);
    const raw = new Uint8Array(stripped.buffer, stripped.byteOffset, stripped.byteLength);
    if (isSilk(raw)) {
      console.log(`[audio-convert] SILK file, direct use: ${filePath} (${buf.length} bytes)`);
      return buf.toString('base64');
    }
  }

  // Check SILK by file header (not relying on extension)
  const rawCheck = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  const strippedCheck = stripAmrHeader(buf);
  const strippedRaw = new Uint8Array(strippedCheck.buffer, strippedCheck.byteOffset, strippedCheck.byteLength);
  if (isSilk(rawCheck) || isSilk(strippedRaw)) {
    console.log(`[audio-convert] SILK detected by header: ${filePath} (${buf.length} bytes)`);
    return buf.toString('base64');
  }

  const targetRate = 24000;

  // 2. Prefer ffmpeg (standard approach, cross-platform detection)
  const ffmpegCmd = await detectFfmpeg();
  if (ffmpegCmd) {
    try {
      console.log(`[audio-convert] ffmpeg (${ffmpegCmd}): converting ${ext} (${buf.length} bytes) → PCM s16le ${targetRate}Hz`);
      const pcmBuf = await ffmpegToPCM(ffmpegCmd, filePath, targetRate);
      if (pcmBuf.length === 0) {
        console.error(`[audio-convert] ffmpeg produced empty PCM output`);
        return null;
      }
      const { silkBuffer } = await pcmToSilk(pcmBuf, targetRate);
      console.log(`[audio-convert] ffmpeg: ${ext} → SILK done (${silkBuffer.length} bytes)`);
      return silkBuffer.toString('base64');
    } catch (err) {
      console.error(`[audio-convert] ffmpeg conversion failed: ${err instanceof Error ? err.message : String(err)}`);
      // Don't return, continue to WASM fallback
    }
  }

  // 3. WASM fallback (degraded solution when no ffmpeg)
  console.log(`[audio-convert] fallback: trying WASM decoders for ${ext}`);

  // 3a. PCM: treat as s16le 24000Hz mono
  if (ext === '.pcm') {
    const pcmBuf = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
    const { silkBuffer } = await pcmToSilk(pcmBuf, targetRate);
    return silkBuffer.toString('base64');
  }

  // 3b. WAV: manual parse (only supports standard PCM WAV)
  if (ext === '.wav' || (buf.length >= 4 && buf.toString('ascii', 0, 4) === 'RIFF')) {
    const wavInfo = parseWavFallback(buf);
    if (wavInfo) {
      const { silkBuffer } = await pcmToSilk(wavInfo, targetRate);
      return silkBuffer.toString('base64');
    }
  }

  // 3c. MP3: WASM decode
  if (ext === '.mp3' || ext === '.mpeg') {
    const pcmBuf = await wasmDecodeMp3ToPCM(buf, targetRate);
    if (pcmBuf) {
      const { silkBuffer } = await pcmToSilk(pcmBuf, targetRate);
      console.log(`[audio-convert] WASM: MP3 → SILK done (${silkBuffer.length} bytes)`);
      return silkBuffer.toString('base64');
    }
  }

  const installHint = isWindows() ? 'Install: choco install ffmpeg or scoop install ffmpeg or download from https://ffmpeg.org' : process.platform === 'darwin' ? 'Install: brew install ffmpeg' : 'Install: sudo apt install ffmpeg or sudo yum install ffmpeg';
  console.error(`[audio-convert] unsupported format: ${ext} (no ffmpeg available). ${installHint}`);
  return null;
}

/**
 * Wait for file to be ready (poll until file appears and size stabilizes)
 * Used after TTS generation to wait for file write completion
 *
 * @param filePath File path
 * @param timeoutMs Max wait time (default 2 minutes)
 * @param pollMs Poll interval (default 500ms)
 * @returns File size in bytes, returns 0 on timeout or file always empty
 */
export async function waitForFile(filePath: string, timeoutMs: number = 120000, pollMs: number = 500): Promise<number> {
  const start = Date.now();
  let lastSize = -1;
  let stableCount = 0;
  let fileExists = false;
  let pollCount = 0;

  while (Date.now() - start < timeoutMs) {
    pollCount++;
    try {
      const stat = fs.statSync(filePath);
      if (!fileExists) {
        fileExists = true;
        console.log(`[audio-convert] waitForFile: file appeared (${stat.size} bytes, after ${Date.now() - start}ms): ${path.basename(filePath)}`);
      }
      if (stat.size > 0) {
        if (stat.size === lastSize) {
          stableCount++;
          if (stableCount >= 2) {
            console.log(`[audio-convert] waitForFile: ready (${stat.size} bytes, waited ${Date.now() - start}ms, polls=${pollCount})`);
            return stat.size;
          }
        } else {
          stableCount = 0;
        }
        lastSize = stat.size;
      }
    } catch {
      // File may not exist yet, continue waiting
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }

  // Final check on timeout
  try {
    const finalStat = fs.statSync(filePath);
    if (finalStat.size > 0) {
      console.warn(`[audio-convert] waitForFile: timeout but file has data (${finalStat.size} bytes), using it`);
      return finalStat.size;
    }
    console.error(`[audio-convert] waitForFile: timeout after ${timeoutMs}ms, file exists but empty (0 bytes): ${path.basename(filePath)}`);
  } catch {
    console.error(`[audio-convert] waitForFile: timeout after ${timeoutMs}ms, file never appeared: ${path.basename(filePath)}`);
  }
  return 0;
}

// ============ FFmpeg Cross-Platform =============

/**
 * Detect if ffmpeg is available (delegated to platform.ts)
 * @returns ffmpeg executable path or null
 */
async function checkFfmpeg(): Promise<string | null> {
  return detectFfmpeg();
}

/**
 * Use ffmpeg to convert any audio to PCM s16le mono 24kHz
 *
 * Cross-platform note:
 * - On Windows pipe:1 needs encoding: "buffer" to prevent BOM issues
 * - Use detectFfmpeg() returned full path, compatible with non-PATH installs
 */
function ffmpegToPCM(ffmpegCmd: string, inputPath: string, sampleRate: number = 24000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const args = ['-i', inputPath, '-f', 's16le', '-ar', String(sampleRate), '-ac', '1', '-acodec', 'pcm_s16le', '-v', 'error', 'pipe:1'];
    execFile(
      ffmpegCmd,
      args,
      {
        maxBuffer: 50 * 1024 * 1024,
        encoding: 'buffer',
        // Windows: hide popup cmd window
        ...(isWindows() ? { windowsHide: true } : {}),
      },
      (err, stdout) => {
        if (err) {
          reject(new Error(`ffmpeg failed: ${err.message}`));
          return;
        }
        resolve(stdout as unknown as Buffer);
      }
    );
  });
}

// ============ WASM fallback: MP3 Decode =============

/**
 * Use mpg123-decoder (WASM) to decode MP3 to PCM
 * Only used as fallback when ffmpeg is unavailable
 */
async function wasmDecodeMp3ToPCM(buf: Buffer, targetRate: number): Promise<Buffer | null> {
  try {
    const { MPEGDecoder } = await import('mpg123-decoder');
    console.log(`[audio-convert] WASM MP3 decode: size=${buf.length} bytes`);
    const decoder = new MPEGDecoder();
    await decoder.ready;

    const decoded = decoder.decode(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
    decoder.free();

    if (decoded.samplesDecoded === 0 || decoded.channelData.length === 0) {
      console.error(`[audio-convert] WASM MP3 decode: no samples (samplesDecoded=${decoded.samplesDecoded})`);
      return null;
    }

    console.log(`[audio-convert] WASM MP3 decode: samples=${decoded.samplesDecoded}, sampleRate=${decoded.sampleRate}, channels=${decoded.channelData.length}`);

    // Float32 multi-channel downmix to mono
    let floatMono: Float32Array;
    if (decoded.channelData.length === 1) {
      floatMono = decoded.channelData[0];
    } else {
      floatMono = new Float32Array(decoded.samplesDecoded);
      const channels = decoded.channelData.length;
      for (let i = 0; i < decoded.samplesDecoded; i++) {
        let sum = 0;
        for (let ch = 0; ch < channels; ch++) {
          sum += decoded.channelData[ch][i];
        }
        floatMono[i] = sum / channels;
      }
    }

    // Float32 → s16le
    const s16 = new Uint8Array(floatMono.length * 2);
    const view = new DataView(s16.buffer);
    for (let i = 0; i < floatMono.length; i++) {
      const clamped = Math.max(-1, Math.min(1, floatMono[i]));
      const val = clamped < 0 ? clamped * 32768 : clamped * 32767;
      view.setInt16(i * 2, Math.round(val), true);
    }

    // Simple linear interpolation resampling
    let pcm: Uint8Array = s16;
    if (decoded.sampleRate !== targetRate) {
      const inputSamples = s16.length / 2;
      const outputSamples = Math.round((inputSamples * targetRate) / decoded.sampleRate);
      const output = new Uint8Array(outputSamples * 2);
      const inView = new DataView(s16.buffer, s16.byteOffset, s16.byteLength);
      const outView = new DataView(output.buffer, output.byteOffset, output.byteLength);
      for (let i = 0; i < outputSamples; i++) {
        const srcIdx = (i * decoded.sampleRate) / targetRate;
        const idx0 = Math.floor(srcIdx);
        const idx1 = Math.min(idx0 + 1, inputSamples - 1);
        const frac = srcIdx - idx0;
        const s0 = inView.getInt16(idx0 * 2, true);
        const s1 = inView.getInt16(idx1 * 2, true);
        const sample = Math.round(s0 + (s1 - s0) * frac);
        outView.setInt16(i * 2, Math.max(-32768, Math.min(32767, sample)), true);
      }
      pcm = output;
    }

    return Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  } catch (err) {
    console.error(`[audio-convert] WASM MP3 decode failed: ${err instanceof Error ? err.message : String(err)}`);
    if (err instanceof Error && err.stack) {
      console.error(`[audio-convert] stack: ${err.stack}`);
    }
    return null;
  }
}

/**
 * Normalize format list (ensure starts with . and lowercase)
 */
function normalizeFormats(formats: string[]): string[] {
  return formats.map((f) => {
    const lower = f.toLowerCase().trim();
    return lower.startsWith('.') ? lower : `.${lower}`;
  });
}

/**
 * WAV fallback parse (used when ffmpeg unavailable)
 * Only supports standard PCM WAV (format=1, 16bit)
 */
function parseWavFallback(buf: Buffer): Buffer | null {
  if (buf.length < 44) return null;
  if (buf.toString('ascii', 0, 4) !== 'RIFF') return null;
  if (buf.toString('ascii', 8, 12) !== 'WAVE') return null;
  if (buf.toString('ascii', 12, 16) !== 'fmt ') return null;

  const audioFormat = buf.readUInt16LE(20);
  if (audioFormat !== 1) return null;

  const channels = buf.readUInt16LE(22);
  const sampleRate = buf.readUInt32LE(24);
  const bitsPerSample = buf.readUInt16LE(34);
  if (bitsPerSample !== 16) return null;

  // Find data chunk
  let offset = 36;
  while (offset < buf.length - 8) {
    const chunkId = buf.toString('ascii', offset, offset + 4);
    const chunkSize = buf.readUInt32LE(offset + 4);
    if (chunkId === 'data') {
      const dataStart = offset + 8;
      const dataEnd = Math.min(dataStart + chunkSize, buf.length);
      let pcm = new Uint8Array(buf.buffer, buf.byteOffset + dataStart, dataEnd - dataStart);

      // Multi-channel downmix
      if (channels > 1) {
        const samplesPerCh = pcm.length / (2 * channels);
        const mono = new Uint8Array(samplesPerCh * 2);
        const inV = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
        const outV = new DataView(mono.buffer, mono.byteOffset, mono.byteLength);
        for (let i = 0; i < samplesPerCh; i++) {
          let sum = 0;
          for (let ch = 0; ch < channels; ch++) {
            sum += inV.getInt16((i * channels + ch) * 2, true);
          }
          outV.setInt16(i * 2, Math.max(-32768, Math.min(32767, Math.round(sum / channels))), true);
        }
        pcm = mono;
      }

      // Simple linear interpolation resampling
      const targetRate = 24000;
      if (sampleRate !== targetRate) {
        const inSamples = pcm.length / 2;
        const outSamples = Math.round((inSamples * targetRate) / sampleRate);
        const out = new Uint8Array(outSamples * 2);
        const inV = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
        const outV = new DataView(out.buffer, out.byteOffset, out.byteLength);
        for (let i = 0; i < outSamples; i++) {
          const src = (i * sampleRate) / targetRate;
          const i0 = Math.floor(src);
          const i1 = Math.min(i0 + 1, inSamples - 1);
          const f = src - i0;
          const s0 = inV.getInt16(i0 * 2, true);
          const s1 = inV.getInt16(i1 * 2, true);
          outV.setInt16(i * 2, Math.max(-32768, Math.min(32767, Math.round(s0 + (s1 - s0) * f))), true);
        }
        pcm = out;
      }

      return Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    }
    offset += 8 + chunkSize;
  }

  return null;
}
