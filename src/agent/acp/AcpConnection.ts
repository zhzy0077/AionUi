/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import * as acp from '@agentclientprotocol/sdk';
import type { AcpBackend, AcpPermissionRequest, AcpResponse, AcpSessionConfigOption, AcpSessionModels, AcpSessionUpdate } from '@/types/acpTypes';
import { CLAUDE_ACP_NPX_PACKAGE, CODEX_ACP_BRIDGE_VERSION, CODEX_ACP_NPX_PACKAGE } from '@/types/acpTypes';
import type { ChildProcess, SpawnOptions } from 'child_process';
import { execFile as execFileCb, execFileSync, spawn } from 'child_process';
import { Readable, Writable } from 'stream';
import { promisify } from 'util';
import { buildAcpModelInfo, summarizeAcpModelInfo } from './modelInfo';
import { mainLog, mainWarn } from '@process/utils/mainLogger';

const execFile = promisify(execFileCb);
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { findSuitableNodeBin, getEnhancedEnv, resolveNpxPath } from '@process/utils/shellEnv';

/** Enable ACP performance diagnostics via ACP_PERF=1 */
const ACP_PERF_LOG = process.env.ACP_PERF === '1';

/**
 * Creates spawn configuration for ACP CLI commands.
 * Exported for unit testing.
 *
 * @param cliPath - CLI command path (e.g., 'goose', 'npx @pkg/cli')
 * @param workingDir - Working directory for the spawned process
 * @param acpArgs - Arguments to enable ACP mode (e.g., ['acp'] for goose, ['--acp'] for auggie, ['exec','--output-format','acp'] for droid)
 * @param customEnv - Custom environment variables
 */
export function createGenericSpawnConfig(cliPath: string, workingDir: string, acpArgs?: string[], customEnv?: Record<string, string>) {
  const isWindows = process.platform === 'win32';
  // Use enhanced env that includes shell environment variables (PATH, SSL certs, etc.)
  const env = getEnhancedEnv(customEnv);

  // Default to --experimental-acp only if acpArgs is strictly undefined.
  // This allows passing an empty array [] to bypass default flags.
  const effectiveAcpArgs = acpArgs === undefined ? ['--experimental-acp'] : acpArgs;

  let spawnCommand: string;
  let spawnArgs: string[];

  if (cliPath.startsWith('npx ')) {
    // For "npx @package/name [extra-args]", split into command and arguments
    const parts = cliPath.split(' ').filter(Boolean);
    spawnCommand = resolveNpxPath(env);
    spawnArgs = [...parts.slice(1), ...effectiveAcpArgs];
  } else if (isWindows) {
    // On Windows with shell: true, let cmd.exe handle the full command string.
    // This correctly supports paths with spaces (e.g., "C:\Program Files\agent.exe")
    // and commands with inline args (e.g., "goose acp" or "node path/to/file.js").
    //
    // chcp 65001: switch console to UTF-8 so stderr/stdout doesn't get garbled
    // (Chinese Windows defaults to CP936/GBK).
    spawnCommand = `chcp 65001 >nul && ${cliPath}`;
    spawnArgs = effectiveAcpArgs;
  } else {
    // Unix: simple command or path. If cliPath contains spaces (e.g., "goose acp"),
    // parse into command + inline args.
    const parts = cliPath.split(/\s+/);
    spawnCommand = parts[0];
    spawnArgs = [...parts.slice(1), ...effectiveAcpArgs];
  }

  const options: SpawnOptions = {
    cwd: workingDir,
    stdio: ['pipe', 'pipe', 'pipe'],
    env,
    shell: isWindows,
  };

  return {
    command: spawnCommand,
    args: spawnArgs,
    options,
  };
}

export class AcpConnection {
  private child: ChildProcess | null = null;
  private clientConnection: acp.ClientSideConnection | null = null;
  private promptTimeoutId: NodeJS.Timeout | null = null;
  private promptTimeoutReject: ((e: Error) => void) | null = null;
  private promptResetFn: (() => void) | null = null;
  private sessionId: string | null = null;
  private isInitialized = false;
  private backend: AcpBackend | null = null;
  private initializeResponse: AcpResponse | null = null;
  private workingDir: string = process.cwd();

  // Cached model information from session/new response
  private configOptions: AcpSessionConfigOption[] | null = null;
  private models: AcpSessionModels | null = null;

  // Performance tracking: timestamp when last prompt was sent
  private lastPromptSentAt: number = 0;
  private firstChunkReceived: boolean = true;

  public onSessionUpdate: (data: AcpSessionUpdate) => void = () => {};
  public onPermissionRequest: (data: AcpPermissionRequest) => Promise<{
    optionId: string;
  }> = () => Promise.resolve({ optionId: 'allow' }); // Returns a resolved Promise for interface consistency
  public onEndTurn: () => void = () => {}; // Handler for end_turn messages
  public onFileOperation: (operation: { method: string; path: string; content?: string; sessionId: string }) => void = () => {};
  // Disconnect callback - called when child process exits unexpectedly during runtime
  public onDisconnect: (error: { code: number | null; signal: NodeJS.Signals | null }) => void = () => {};

  // Track if initial setup is complete (to distinguish startup errors from runtime exits)
  private isSetupComplete = false;

  // Track if child process was spawned with detached: true (needs process group kill)
  private isDetached = false;

  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  private async waitForProcessExit(pid: number, timeoutMs: number): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (!this.isProcessAlive(pid)) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  /**
   * Kill the current child process (if any) and clear process-related state.
   * Handles platform differences: Windows taskkill tree kill, POSIX detached
   * process group kill, and standard SIGTERM.
   *
   * Used by both disconnect() and retry paths. Does NOT reset session-level
   * state (sessionId, backend, etc.) — that is disconnect()'s responsibility.
   */
  private async terminateChild(): Promise<void> {
    if (!this.child) {
      this.isDetached = false;
      return;
    }

    const pid = this.child.pid;
    if (process.platform === 'win32' && pid) {
      // Windows: shell:true spawns cmd.exe as parent; use /T /F directly to kill
      // the entire process tree forcefully and avoid delayed exit events.
      try {
        await execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 5000 });
      } catch (forceError) {
        console.warn(`[ACP] taskkill /T /F failed for PID ${pid}:`, forceError);
      }
    } else if (this.isDetached && pid) {
      // POSIX detached: negative PID kills the entire process group (setsid).
      try {
        process.kill(-pid, 'SIGTERM');
      } catch {
        this.child.kill('SIGTERM');
      }
    } else {
      this.child.kill('SIGTERM');
    }

    if (pid) {
      await this.waitForProcessExit(pid, 3000);
    }

    this.child = null;
    this.isDetached = false;
  }

  /**
   * Prepare a clean environment for npx-based ACP backends.
   * Removes Node.js debugging vars and npm lifecycle vars that can interfere
   * with child npx processes.
   */
  private prepareNpxEnv(): Record<string, string | undefined> {
    const cleanEnv = getEnhancedEnv();
    delete cleanEnv.NODE_OPTIONS;
    delete cleanEnv.NODE_INSPECT;
    delete cleanEnv.NODE_DEBUG;
    // Remove CLAUDECODE env var to prevent claude-agent-sdk from detecting
    // a nested session when AionUi itself is launched from Claude Code.
    delete cleanEnv.CLAUDECODE;
    // Strip npm lifecycle vars inherited from parent `npm start` process.
    // These (npm_config_*, npm_lifecycle_*, npm_package_*) can cause npx to
    // behave as if running inside an npm script, interfering with package
    // resolution and child process startup.
    for (const key of Object.keys(cleanEnv)) {
      if (key.startsWith('npm_')) {
        delete cleanEnv[key];
      }
    }
    return cleanEnv;
  }

  /**
   * Pre-check Node.js version and auto-correct PATH if too old.
   * Requires Node >= minMajor.minMinor for npx-based ACP backends.
   * Mutates cleanEnv.PATH when auto-correction is needed.
   */
  private ensureMinNodeVersion(cleanEnv: Record<string, string | undefined>, minMajor: number, minMinor: number, backendLabel: string): void {
    const isWindows = process.platform === 'win32';
    let versionTooOld = false;
    let detectedVersion = '';

    try {
      detectedVersion = execFileSync(isWindows ? 'node.exe' : 'node', ['--version'], { env: cleanEnv, encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();

      const match = detectedVersion.match(/^v(\d+)\.(\d+)\./);
      if (match) {
        const major = parseInt(match[1], 10);
        const minor = parseInt(match[2], 10);
        if (major < minMajor || (major === minMajor && minor < minMinor)) {
          versionTooOld = true;
        }
      }
    } catch {
      // node not found — let spawn attempt handle it
      console.warn('[ACP] Node.js version check skipped: node not found in PATH');
    }

    if (versionTooOld) {
      const suitableBinDir = findSuitableNodeBin(minMajor, minMinor);
      if (suitableBinDir) {
        const sep = isWindows ? ';' : ':';
        cleanEnv.PATH = suitableBinDir + sep + (cleanEnv.PATH || '');

        // Verify the corrected PATH actually resolves to a good node (npx uses the same PATH)
        try {
          const correctedVersion = execFileSync(isWindows ? 'node.exe' : 'node', ['--version'], { env: cleanEnv, encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
          console.log(`[ACP] Node.js ${detectedVersion} is below v${minMajor}.${minMinor}.0 — auto-corrected to ${correctedVersion} from: ${suitableBinDir}`);
        } catch {
          console.warn(`[ACP] PATH corrected with ${suitableBinDir} but node verification failed — proceeding anyway`);
        }
      } else {
        throw new Error(`Node.js ${detectedVersion} is too old for ${backendLabel}. ` + `Minimum required: v${minMajor}.${minMinor}.0. ` + `Please upgrade Node.js: https://nodejs.org/`);
      }
    }
  }

  // 通用的后端连接方法
  private async connectGenericBackend(backend: Exclude<AcpBackend, 'claude' | 'codebuddy' | 'codex'>, cliPath: string, workingDir: string, acpArgs?: string[], customEnv?: Record<string, string>): Promise<void> {
    // Ensure cwd exists before spawning — on Windows cmd.exe gives a cryptic
    // "The filename, directory name, or volume label syntax is incorrect" error
    // when cwd is missing, which is hard to diagnose.
    try {
      await fs.mkdir(workingDir, { recursive: true });
    } catch {
      // best-effort: if mkdir fails, let spawn report the actual error
    }

    const spawnStart = Date.now();
    const config = createGenericSpawnConfig(cliPath, workingDir, acpArgs, customEnv);
    this.child = spawn(config.command, config.args, config.options);
    if (ACP_PERF_LOG) console.log(`[ACP-PERF] connect: ${backend} process spawned ${Date.now() - spawnStart}ms`);
    await this.setupChildProcessHandlers(backend);
  }

  /** Npx-based backends that may need npm cache recovery on version mismatch */
  private static readonly NPX_BACKENDS: ReadonlySet<string> = new Set(['claude', 'codex', 'codebuddy']);

  async connect(backend: AcpBackend, cliPath?: string, workingDir: string = process.cwd(), acpArgs?: string[], customEnv?: Record<string, string>): Promise<void> {
    const connectStart = Date.now();
    if (ACP_PERF_LOG) console.log(`[ACP-PERF] connect: start backend=${backend}`);

    try {
      await this.doConnect(backend, cliPath, workingDir, acpArgs, customEnv);
    } catch (error) {
      // For npx-based backends, detect stale npm cache errors and auto-recover.
      // When we upgrade a bridge package version (e.g., claude-agent-acp 0.17→0.18),
      // users with the old version cached hit "notarget" because --prefer-offline
      // serves stale metadata. Cleaning the cache and retrying fixes this.
      const errMsg = error instanceof Error ? error.message : String(error);
      if (AcpConnection.NPX_BACKENDS.has(backend) && /notarget|no matching version/i.test(errMsg)) {
        console.warn(`[ACP] Detected stale npm cache for ${backend}, cleaning and retrying...`);
        try {
          const cleanEnv = this.prepareNpxEnv();
          const npmPath = resolveNpxPath(cleanEnv)
            .replace(/npx$/, 'npm')
            .replace(/npx\.cmd$/, 'npm.cmd');
          await execFile(npmPath, ['cache', 'clean', '--force'], { env: cleanEnv, timeout: 30000 });
          console.warn('[ACP] npm cache cleaned, retrying connection...');
        } catch (cleanError) {
          console.warn('[ACP] Failed to clean npm cache:', cleanError);
          throw error; // Throw original error if cache clean fails
        }
        await this.doConnect(backend, cliPath, workingDir, acpArgs, customEnv);
      } else if (AcpConnection.NPX_BACKENDS.has(backend) && errMsg.includes('_npx') && /ENOENT|ERR_MODULE_NOT_FOUND|Cannot find package/i.test(errMsg)) {
        // Corrupted npx cache: the _npx/<hash> directory exists but has missing
        // or incomplete files (e.g. package.json deleted, transitive deps like zod
        // not installed). Phase 1/2 retries don't help because npx reuses the
        // existing directory. Fix: delete the _npx cache and retry from scratch.
        console.warn(`[ACP] Detected corrupted npx cache for ${backend}, cleaning _npx and retrying...`);
        try {
          const npmCacheBase = process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'npm-cache') : path.join(os.homedir(), '.npm');
          const npxCacheDir = path.join(npmCacheBase, '_npx');
          await fs.rm(npxCacheDir, { recursive: true, force: true });
          console.warn(`[ACP] Cleaned corrupted npx cache: ${npxCacheDir}`);
        } catch (cleanError) {
          console.warn('[ACP] Failed to clean npx cache:', cleanError);
          throw error;
        }
        await this.doConnect(backend, cliPath, workingDir, acpArgs, customEnv);
      } else {
        throw error;
      }
    }

    if (ACP_PERF_LOG) console.log(`[ACP-PERF] connect: total ${Date.now() - connectStart}ms`);
  }

  private async doConnect(backend: AcpBackend, cliPath?: string, workingDir: string = process.cwd(), acpArgs?: string[], customEnv?: Record<string, string>): Promise<void> {
    if (this.child) {
      await this.disconnect();
    }

    this.backend = backend;
    if (workingDir) {
      this.workingDir = workingDir;
    }

    switch (backend) {
      case 'claude':
        await this.connectClaude(workingDir);
        break;

      case 'codebuddy':
        await this.connectCodebuddy(workingDir);
        break;

      case 'codex':
        await this.connectCodex(workingDir);
        break;

      case 'gemini':
      case 'qwen':
      case 'iflow':
      case 'droid':
      case 'goose':
      case 'auggie':
      case 'kimi':
      case 'opencode':
      case 'copilot':
      case 'qoder':
      case 'vibe':
        if (!cliPath) {
          throw new Error(`CLI path is required for ${backend} backend`);
        }
        await this.connectGenericBackend(backend, cliPath, workingDir, acpArgs, customEnv);
        break;

      case 'custom':
        if (!cliPath) {
          throw new Error('Custom agent CLI path/command is required');
        }
        await this.connectGenericBackend('custom', cliPath, workingDir, acpArgs, customEnv);
        break;

      default:
        throw new Error(`Unsupported backend: ${backend}`);
    }
  }

  private async connectClaude(workingDir: string = process.cwd()): Promise<void> {
    // Use NPX to run Claude Code ACP bridge directly from npm registry
    // This eliminates dependency packaging issues and simplifies deployment
    console.error('[ACP] Using NPX approach for Claude ACP bridge');

    const envStart = Date.now();
    const cleanEnv = this.prepareNpxEnv();
    if (ACP_PERF_LOG) console.log(`[ACP-PERF] connect: env prepared ${Date.now() - envStart}ms`);

    this.ensureMinNodeVersion(cleanEnv, 20, 10, 'Claude ACP bridge');

    const isWindows = process.platform === 'win32';
    const spawnCommand = resolveNpxPath(cleanEnv);

    // Phase 1: Try with --prefer-offline for fast startup (~1-2s)
    try {
      await this.spawnAndSetupNpxBackend('claude', CLAUDE_ACP_NPX_PACKAGE, spawnCommand, cleanEnv, workingDir, isWindows, true);
    } catch (firstError) {
      // Phase 2: Retry without --prefer-offline to refresh stale cache (~3-5s)
      // This handles upgrades where cached registry metadata is outdated
      console.warn('[ACP] --prefer-offline failed, retrying with fresh registry lookup:', firstError instanceof Error ? firstError.message : String(firstError));

      // Terminate the first child (may still be running if initialize() timed out)
      // to prevent orphaned processes and stale exit handlers interfering with retry
      await this.terminateChild();
      this.isSetupComplete = false;

      await this.spawnAndSetupNpxBackend('claude', CLAUDE_ACP_NPX_PACKAGE, spawnCommand, cleanEnv, workingDir, isWindows, false);
    }
  }

  private async spawnAndSetupNpxBackend(backend: string, npxPackage: string, spawnCommand: string, cleanEnv: Record<string, string | undefined>, workingDir: string, isWindows: boolean, preferOffline: boolean, { extraArgs = [], detached = false }: { extraArgs?: string[]; detached?: boolean } = {}): Promise<void> {
    const spawnArgs = ['--yes', ...(preferOffline ? ['--prefer-offline'] : []), npxPackage, ...extraArgs];

    const spawnStart = Date.now();
    // detached: true creates a new session (setsid) so the child has no controlling terminal.
    // Required for backends (e.g. CodeBuddy) that write to /dev/tty — without it, SIGTTOU
    // would suspend the entire Electron process group and freeze the UI.
    this.isDetached = detached;
    this.child = spawn(spawnCommand, spawnArgs, {
      cwd: workingDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: cleanEnv,
      shell: isWindows,
      detached: this.isDetached,
    });
    // Prevent the detached child from keeping the parent alive when the parent wants to exit normally.
    if (this.isDetached) {
      this.child.unref();
    }
    if (ACP_PERF_LOG) {
      console.log(`[ACP-PERF] ${backend}: process spawned ${Date.now() - spawnStart}ms (preferOffline=${preferOffline})`);
    }

    await this.setupChildProcessHandlers(backend);
  }

  private async connectCodex(workingDir: string = process.cwd()): Promise<void> {
    // Use NPX to run codex-acp bridge (Zed's ACP adapter for Codex)
    console.error(`[ACP] Using NPX approach for Codex ACP bridge (${CODEX_ACP_NPX_PACKAGE})`);

    const envStart = Date.now();
    const cleanEnv = this.prepareNpxEnv();
    if (ACP_PERF_LOG) console.log(`[ACP-PERF] codex: env prepared ${Date.now() - envStart}ms`);

    this.ensureMinNodeVersion(cleanEnv, 20, 10, 'Codex ACP bridge');
    await this.logCodexRuntimeDiagnostics(cleanEnv);

    const isWindows = process.platform === 'win32';
    const spawnCommand = resolveNpxPath(cleanEnv);

    // Phase 1: Try with --prefer-offline for fast startup
    try {
      await this.spawnAndSetupNpxBackend('codex', CODEX_ACP_NPX_PACKAGE, spawnCommand, cleanEnv, workingDir, isWindows, true);
    } catch (firstError) {
      // Phase 2: Retry without --prefer-offline to fetch from registry
      // This handles first-time installs or missing cache (common on Windows after upgrade)
      console.warn('[ACP] Codex --prefer-offline failed, retrying with fresh registry lookup:', firstError instanceof Error ? firstError.message : String(firstError));

      // Terminate the first child to prevent orphaned processes and stale exit handlers
      await this.terminateChild();
      this.isSetupComplete = false;

      await this.spawnAndSetupNpxBackend('codex', CODEX_ACP_NPX_PACKAGE, spawnCommand, cleanEnv, workingDir, isWindows, false);
    }
  }

  private async logCodexRuntimeDiagnostics(cleanEnv: Record<string, string | undefined>): Promise<void> {
    const codexCommand = process.platform === 'win32' ? 'codex.cmd' : 'codex';
    const diagnostics: {
      bridgeVersion: string;
      bridgePackage: string;
      codexCliVersion: string;
      loginStatus: string;
      hasCodexApiKey: boolean;
      hasOpenAiApiKey: boolean;
      hasChatGptSession: boolean;
    } = {
      bridgeVersion: CODEX_ACP_BRIDGE_VERSION,
      bridgePackage: CODEX_ACP_NPX_PACKAGE,
      codexCliVersion: 'unknown',
      loginStatus: 'unknown',
      hasCodexApiKey: Boolean(cleanEnv.CODEX_API_KEY),
      hasOpenAiApiKey: Boolean(cleanEnv.OPENAI_API_KEY),
      hasChatGptSession: false,
    };

    try {
      const { stdout } = await execFile(codexCommand, ['--version'], {
        env: cleanEnv,
        timeout: 5000,
        windowsHide: true,
      });
      diagnostics.codexCliVersion = stdout.trim() || diagnostics.codexCliVersion;
    } catch (error) {
      mainWarn('[ACP codex]', 'Failed to read codex CLI version', error);
    }

    try {
      const { stdout } = await execFile(codexCommand, ['login', 'status'], {
        env: cleanEnv,
        timeout: 5000,
        windowsHide: true,
      });
      diagnostics.loginStatus = stdout.trim() || diagnostics.loginStatus;
      diagnostics.hasChatGptSession = /chatgpt/i.test(diagnostics.loginStatus);
    } catch (error) {
      mainWarn('[ACP codex]', 'Failed to read codex login status', error);
    }

    mainLog('[ACP codex]', 'Runtime diagnostics', diagnostics);
  }

  private async connectCodebuddy(workingDir: string = process.cwd()): Promise<void> {
    // Use NPX to run CodeBuddy Code CLI directly from npm registry (same pattern as Claude)
    console.error('[ACP] Using NPX approach for CodeBuddy ACP');

    const envStart = Date.now();
    const cleanEnv = this.prepareNpxEnv();
    if (ACP_PERF_LOG) console.log(`[ACP-PERF] codebuddy: env prepared ${Date.now() - envStart}ms`);

    this.ensureMinNodeVersion(cleanEnv, 20, 10, 'CodeBuddy ACP');

    const isWindows = process.platform === 'win32';
    const spawnCommand = resolveNpxPath(cleanEnv);

    // Load user's MCP config if available (~/.codebuddy/mcp.json)
    // CodeBuddy CLI in --acp mode does not auto-load mcp.json, so we pass it explicitly
    const mcpConfigPath = path.join(os.homedir(), '.codebuddy', 'mcp.json');
    const extraArgs: string[] = [];
    try {
      await fs.access(mcpConfigPath);
      extraArgs.push('--mcp-config', mcpConfigPath);
      console.error(`[ACP] Loading CodeBuddy MCP config from ${mcpConfigPath}`);
    } catch {
      console.error('[ACP] No CodeBuddy MCP config found, starting without MCP servers');
    }

    const spawnOptions = { extraArgs: ['--acp', ...extraArgs], detached: !isWindows };

    // Phase 1: Try with --prefer-offline for fast startup
    try {
      await this.spawnAndSetupNpxBackend('codebuddy', '@tencent-ai/codebuddy-code', spawnCommand, cleanEnv, workingDir, isWindows, true, spawnOptions);
    } catch (firstError) {
      // Phase 2: Retry without --prefer-offline to refresh stale cache
      console.warn('[ACP] CodeBuddy --prefer-offline failed, retrying with fresh registry lookup:', firstError instanceof Error ? firstError.message : String(firstError));

      // Terminate the first child (may still be running if initialize() timed out)
      // to prevent orphaned processes and stale exit handlers interfering with retry
      await this.terminateChild();
      this.isSetupComplete = false;

      await this.spawnAndSetupNpxBackend('codebuddy', '@tencent-ai/codebuddy-code', spawnCommand, cleanEnv, workingDir, isWindows, false, spawnOptions);
    }
  }

  private async setupChildProcessHandlers(backend: string): Promise<void> {
    // Capture non-null reference; fail fast if child process is not initialized
    const child = this.child;
    if (!child) {
      throw new Error(`[ACP ${backend}] Child process not initialized`);
    }

    let spawnError: Error | null = null;

    // Collect stderr output (capped at 2KB) for diagnostics on early crash
    const STDERR_MAX = 2048;
    let stderrOutput = '';
    child.stderr?.on('data', (data: Buffer) => {
      const chunk = data.toString();
      console.error(`[ACP ${backend} STDERR]:`, chunk);
      if (stderrOutput.length < STDERR_MAX) {
        stderrOutput += chunk;
        if (stderrOutput.length > STDERR_MAX) {
          stderrOutput = stderrOutput.slice(0, STDERR_MAX);
        }
      }
    });

    child.on('error', (error) => {
      // Provide a friendlier message when the CLI binary is not found (ENOENT)
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        const cliHint = this.backend ?? backend;
        spawnError = new Error(`'${cliHint}' CLI not found. Please install it or update the CLI path in Settings.`);
      } else {
        spawnError = error;
      }
    });

    // Promise that rejects when the child process exits during setup.
    // Used in Promise.race to detect early crashes without waiting for the 60s timeout.
    let processExitReject: ((err: Error) => void) | null = null;
    const processExitPromise = new Promise<never>((_resolve, reject) => {
      processExitReject = reject;
    });

    // Exit handler for both startup and runtime phases
    child.on('exit', (code, signal) => {
      console.error(`[ACP ${backend}] Process exited with code: ${code}, signal: ${signal}`);

      if (!this.isSetupComplete) {
        // Startup phase - set error for initial check.
        // Include stderr in spawnError so callers can detect specific failures
        // (e.g., npm "notarget" for stale cache recovery).
        let errMsg: string;
        if (stderrOutput) {
          errMsg = `${backend} ACP process exited during startup (code: ${code}):\n${stderrOutput}`;
        } else {
          errMsg = `${backend} ACP process exited during startup (code: ${code}, signal: ${signal})`;
        }
        // Detect "command not found" patterns across platforms and provide a clear hint
        if (code !== 0 && /not recognized|not found|No such file|command not found|ENOENT/i.test(stderrOutput + (spawnError?.message ?? ''))) {
          const cliHint = this.backend ?? backend;
          errMsg = `'${cliHint}' CLI not found. Please install it or update the CLI path in Settings.\n${stderrOutput}`;
        }
        if (code !== 0 && !spawnError) {
          spawnError = new Error(errMsg);
        }
        // Reject processExitPromise so Promise.race returns immediately
        processExitReject?.(new Error(errMsg));
      } else {
        // Runtime phase - handle unexpected exit
        this.handleProcessExit(code, signal);
      }
    });

    // Yield to event loop so spawn error/exit events can fire
    await new Promise((resolve) => setImmediate(resolve));

    // Check if process spawn failed
    if (spawnError) {
      throw spawnError;
    }

    // Check if process is still running
    if (child.killed) {
      throw new Error(`${backend} ACP process failed to start or exited immediately`);
    }

    // Create SDK stream connection over child process stdio
    const output = Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>;
    const input = Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>;
    const stream = acp.ndJsonStream(output, input);
    const client = this.buildProtocolClient();
    this.clientConnection = new acp.ClientSideConnection((_agent) => client, stream);

    // Initialize protocol with timeout, also racing against early process exit
    const initStart = Date.now();
    try {
      await Promise.race([
        this.initialize(),
        new Promise((_, reject) =>
          setTimeout(() => {
            reject(new Error('Initialize timeout after 60 seconds'));
          }, 60000)
        ),
        processExitPromise,
      ]);
    } finally {
      // Neutralize processExitReject so later exits won't call a stale reject.
      // Attach .catch only now — prevents unhandled rejection if the process exits
      // after setup completed (or after another racer won).
      processExitReject = null;
      processExitPromise.catch(() => {});
    }
    if (ACP_PERF_LOG) console.log(`[ACP-PERF] connect: protocol initialized ${Date.now() - initStart}ms`);

    // Mark setup as complete - future exits will be handled as runtime disconnects
    this.isSetupComplete = true;
  }

  /**
   * Handle unexpected process exit during runtime.
   */
  private handleProcessExit(code: number | null, signal: NodeJS.Signals | null): void {
    // Reject any pending prompt request
    if (this.promptTimeoutReject) {
      this.promptTimeoutReject(new Error(`ACP process exited unexpectedly (code: ${code}, signal: ${signal})`));
      this.promptTimeoutReject = null;
    }
    if (this.promptTimeoutId) {
      clearTimeout(this.promptTimeoutId);
      this.promptTimeoutId = null;
    }
    this.promptResetFn = null;

    // Clear connection state
    this.clientConnection = null;
    this.sessionId = null;
    this.isInitialized = false;
    this.isSetupComplete = false;
    this.isDetached = false;
    this.backend = null;
    this.initializeResponse = null;
    this.configOptions = null;
    this.models = null;
    this.child = null;

    // Notify AcpAgent about disconnect
    this.onDisconnect({ code, signal });
  }

  /**
   * Build the ACP Client interface that delegates to this connection's callbacks.
   * Passed to ClientSideConnection so the SDK can call our handlers for incoming
   * agent requests (sessionUpdate, requestPermission, readTextFile, writeTextFile).
   */
  private buildProtocolClient(): acp.Client {
    return {
      sessionUpdate: async (params: acp.SessionNotification) => {
        // Reset prompt timeout on every streaming update — LLM is still active
        this.promptResetFn?.();
        // Track first chunk latency since prompt was sent
        if (!this.firstChunkReceived && this.lastPromptSentAt > 0) {
          this.firstChunkReceived = true;
          if (ACP_PERF_LOG) console.log(`[ACP-PERF] stream: first chunk received ${Date.now() - this.lastPromptSentAt}ms (since prompt sent)`);
        }
        // Update cached configOptions when config_option_update arrives
        if (params.update && (params.update as Record<string, unknown>).sessionUpdate === 'config_option_update') {
          const updatePayload = params.update as { configOptions?: AcpSessionConfigOption[] };
          if (Array.isArray(updatePayload.configOptions)) {
            this.configOptions = updatePayload.configOptions;
          }
        }
        this.onSessionUpdate(params as unknown as AcpSessionUpdate);
      },

      requestPermission: async (params: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> => {
        // Pause prompt timeout while waiting for user input
        this.pauseCurrentPromptTimeout();
        try {
          const { optionId } = await this.onPermissionRequest(params as unknown as AcpPermissionRequest);
          return { outcome: { outcome: 'selected', optionId } };
        } catch {
          return { outcome: { outcome: 'cancelled' } };
        } finally {
          // Resume prompt timeout after user responds
          this.resumeCurrentPromptTimeout();
        }
      },

      readTextFile: async (params: acp.ReadTextFileRequest): Promise<acp.ReadTextFileResponse> => {
        return await this.handleReadOperation({ path: params.path, sessionId: params.sessionId });
      },

      writeTextFile: async (params: acp.WriteTextFileRequest): Promise<acp.WriteTextFileResponse> => {
        await this.handleWriteOperation({ path: params.path, content: params.content, sessionId: params.sessionId });
        return {};
      },
    };
  }

  private pauseCurrentPromptTimeout(): void {
    if (this.promptTimeoutId) {
      clearTimeout(this.promptTimeoutId);
      this.promptTimeoutId = null;
    }
  }

  private resumeCurrentPromptTimeout(): void {
    // Restart with full duration (conservative: permission wait doesn't consume LLM timeout)
    this.promptResetFn?.();
  }

  private async handleReadTextFile(params: { path: string }): Promise<{ content: string }> {
    try {
      const content = await fs.readFile(params.path, 'utf-8');
      return { content };
    } catch (error) {
      throw new Error(`Failed to read file: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async handleWriteTextFile(params: { path: string; content: string }): Promise<null> {
    try {
      await fs.mkdir(path.dirname(params.path), { recursive: true });
      await fs.writeFile(params.path, params.content, 'utf-8');

      // 发送流式内容更新事件到预览面板（用于实时更新）
      // Send streaming content update to preview panel (for real-time updates)
      try {
        const { ipcBridge } = await import('@/common');
        const pathSegments = params.path.split(path.sep);
        const fileName = pathSegments[pathSegments.length - 1];
        const workspace = pathSegments.slice(0, -1).join(path.sep);

        const eventData = {
          filePath: params.path,
          content: params.content,
          workspace: workspace,
          relativePath: fileName,
          operation: 'write' as const,
        };
        ipcBridge.fileStream.contentUpdate.emit(eventData);
      } catch (emitError) {
        console.error('[AcpConnection] ❌ Failed to emit file stream update:', emitError);
      }

      return null;
    } catch (error) {
      throw new Error(`Failed to write file: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private resolveWorkspacePath(targetPath: string): string {
    // Absolute paths are used as-is; relative paths are anchored to the conversation workspace
    // 绝对路径保持不变， 相对路径锚定到当前会话的工作区
    if (!targetPath) return this.workingDir;
    if (path.isAbsolute(targetPath)) {
      return targetPath;
    }
    return path.join(this.workingDir, targetPath);
  }

  private async initialize(): Promise<void> {
    const result = await this.clientConnection!.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
      },
    });
    this.isInitialized = true;
    this.initializeResponse = result as unknown as AcpResponse;
  }

  async authenticate(methodId?: string): Promise<AcpResponse> {
    const result = await this.clientConnection!.authenticate({
      methodId: methodId ?? '',
    });
    return result as unknown as AcpResponse;
  }

  /**
   * Create a new session or resume an existing one.
   * 创建新会话或恢复现有会话。
   *
   * @param cwd - Working directory for the session
   * @param options - Optional resume parameters
   * @param options.resumeSessionId - Session ID to resume (if supported by backend)
   * @param options.forkSession - When true, creates a new session ID while preserving conversation context.
   *                              When false (default), reuses the original session ID.
   *                              为 true 时创建新 session ID 但保留对话上下文；为 false（默认）时复用原 session ID。
   */
  async newSession(cwd: string = process.cwd(), options?: { resumeSessionId?: string; forkSession?: boolean }): Promise<AcpResponse & { sessionId?: string }> {
    // Normalize workspace-relative paths:
    // Agents such as qwen already run with `workingDir` as their process cwd.
    // Sending the absolute path again makes some CLIs treat it as a nested relative path.
    const normalizedCwd = this.normalizeCwdForAgent(cwd);

    // Build _meta for Claude/CodeBuddy ACP resume support
    // claude-agent-acp and codebuddy use _meta.claudeCode.options.resume for session resume
    const useMetaResume = (this.backend === 'claude' || this.backend === 'codebuddy') && options?.resumeSessionId;
    const meta = useMetaResume
      ? {
          claudeCode: {
            options: {
              resume: options.resumeSessionId,
            },
          },
        }
      : undefined;

    // Non-standard extension fields are passed via type assertion; the SDK serializes all fields as-is
    const params = {
      cwd: normalizedCwd,
      mcpServers: [],
      // Claude/CodeBuddy ACP uses _meta for resume
      ...(meta && { _meta: meta }),
      // Generic resume parameters for other ACP backends
      ...(this.backend !== 'claude' && this.backend !== 'codebuddy' && options?.resumeSessionId && { resumeSessionId: options.resumeSessionId }),
      ...(options?.forkSession && { forkSession: options.forkSession }),
    } as acp.NewSessionRequest;

    const result = await this.clientConnection!.newSession(params);

    this.sessionId = result.sessionId ?? null;

    this.parseSessionCapabilities(result);

    // Debug: log full session/new response only when ACP_PERF=1
    if (ACP_PERF_LOG) {
      console.log(`[ACP ${this.backend}] session/new response:`, JSON.stringify(result, null, 2));
    }

    return result as unknown as AcpResponse & { sessionId?: string };
  }

  /**
   * Load/resume an existing session using the ACP session/load method.
   * Codex ACP bridge implements `load_session()` which internally calls
   * `resume_thread_from_rollout` to restore full conversation history from disk.
   *
   * @param sessionId - The session ID to load/resume
   * @param cwd - Working directory for the session
   */
  async loadSession(sessionId: string, cwd: string = process.cwd()): Promise<AcpResponse & { sessionId?: string }> {
    const normalizedCwd = this.normalizeCwdForAgent(cwd);

    const result = await this.clientConnection!.loadSession({
      sessionId,
      cwd: normalizedCwd,
      mcpServers: [],
    });

    // session/load returns modes/models/configOptions but not sessionId — keep the one we sent
    this.sessionId = (result as unknown as { sessionId?: string }).sessionId ?? sessionId;

    mainLog(`[ACP ${this.backend}]`, 'session/load completed', { sessionId: this.sessionId });

    this.parseSessionCapabilities(result);

    return result as unknown as AcpResponse & { sessionId?: string };
  }

  /**
   * Parse configOptions and models from a session response (session/new or session/load).
   * Logs model info for Codex backend.
   */
  private parseSessionCapabilities(response: unknown): void {
    const result = response as Record<string, unknown>;
    if (Array.isArray(result.configOptions)) {
      this.configOptions = result.configOptions as AcpSessionConfigOption[];
    }
    // Check top-level models first, then fall back to _meta.models (used by iFlow)
    const modelsSource = result.models || (result._meta as Record<string, unknown> | undefined)?.models;
    if (modelsSource && typeof modelsSource === 'object') {
      this.models = modelsSource as AcpSessionModels;
    }
    if (this.backend === 'codex') {
      const unifiedModelInfo = buildAcpModelInfo(this.configOptions, this.models);
      const modelOption = this.configOptions?.find((opt) => opt.category === 'model');
      mainLog('[ACP codex]', 'session capabilities parsed', {
        rawCurrentModelId: this.models?.currentModelId || null,
        rawAvailableModelCount: this.models?.availableModels?.length || 0,
        configOptionModelCount: modelOption && modelOption.type === 'select' && modelOption.options ? modelOption.options.length : 0,
        unified: summarizeAcpModelInfo(unifiedModelInfo),
      });
    }
  }

  /**
   * Ensure the cwd we send to ACP agents is relative to the actual working directory.
   * 某些 CLI 会对绝对路径进行再次拼接，导致“套娃”路径，因此需要转换为相对路径。
   */
  private normalizeCwdForAgent(cwd?: string): string {
    const defaultPath = '.';
    if (!cwd) return defaultPath;

    // Some CLIs require absolute paths for cwd
    // - Copilot: "Directory path must be absolute: ."
    // - Codex (via codex-acp): "cwd is not absolute: ."
    if (this.backend === 'copilot' || this.backend === 'codex') {
      return path.resolve(cwd);
    }

    try {
      const workspaceRoot = path.resolve(this.workingDir);
      const requested = path.resolve(cwd);

      const relative = path.relative(workspaceRoot, requested);
      const isInsideWorkspace = relative && !relative.startsWith('..') && !path.isAbsolute(relative);

      if (isInsideWorkspace) {
        return relative.length === 0 ? defaultPath : relative;
      }
    } catch (error) {
      console.warn('[ACP] Failed to normalize cwd for agent, using default "."', error);
    }

    return defaultPath;
  }

  async sendPrompt(prompt: string): Promise<AcpResponse> {
    if (!this.sessionId) {
      throw new Error('No active ACP session');
    }

    this.lastPromptSentAt = Date.now();
    this.firstChunkReceived = false;
    if (ACP_PERF_LOG) console.log(`[ACP-PERF] send: prompt sent to ${this.backend}`);

    const TIMEOUT_MS = 300_000;

    const timeoutPromise = new Promise<never>((_, reject) => {
      this.promptTimeoutReject = reject;
      const reset = () => {
        if (this.promptTimeoutId) clearTimeout(this.promptTimeoutId);
        this.promptTimeoutId = setTimeout(() => reject(new Error(`LLM request timed out after ${TIMEOUT_MS / 1000} seconds`)), TIMEOUT_MS);
      };
      this.promptResetFn = reset;
      reset();
    });

    try {
      const result = await Promise.race([
        this.clientConnection!.prompt({
          sessionId: this.sessionId as acp.SessionId,
          prompt: [{ type: 'text', text: prompt }],
        }),
        timeoutPromise,
      ]);
      if (result.stopReason === 'end_turn') this.onEndTurn();
      return result as unknown as AcpResponse;
    } finally {
      if (this.promptTimeoutId) clearTimeout(this.promptTimeoutId);
      this.promptTimeoutId = null;
      this.promptTimeoutReject = null;
      this.promptResetFn = null;
    }
  }

  async setSessionMode(modeId: string): Promise<AcpResponse> {
    if (!this.sessionId) {
      throw new Error('No active ACP session');
    }

    const result = await this.clientConnection!.setSessionMode({
      sessionId: this.sessionId as acp.SessionId,
      modeId,
    });
    return result as unknown as AcpResponse;
  }

  async setModel(modelId: string): Promise<AcpResponse> {
    if (!this.sessionId) {
      throw new Error('No active ACP session');
    }

    const result = await this.clientConnection!.unstable_setSessionModel({
      sessionId: this.sessionId as acp.SessionId,
      modelId,
    });

    // Update local models cache with the new model ID
    if (this.models) {
      this.models = { ...this.models, currentModelId: modelId };
    }

    // Also update configOptions cache so getModelInfo() returns consistent data.
    // The unstable_setSessionModel handler in claude-agent-acp will also send a
    // config_option_update notification, but we update eagerly for immediate reads.
    if (this.configOptions) {
      this.configOptions = this.configOptions.map((opt) => (opt.category === 'model' ? { ...opt, currentValue: modelId, selectedValue: modelId } : opt));
    }

    return result as unknown as AcpResponse;
  }

  async setConfigOption(configId: string, value: string): Promise<AcpResponse> {
    if (!this.sessionId) {
      throw new Error('No active ACP session');
    }

    const result = await this.clientConnection!.setSessionConfigOption({
      sessionId: this.sessionId as acp.SessionId,
      configId,
      value,
    } as acp.SetSessionConfigOptionRequest);

    // The response contains the updated configOptions
    if (Array.isArray(result.configOptions)) {
      this.configOptions = result.configOptions as unknown as AcpSessionConfigOption[];
    } else if (this.configOptions) {
      // Optimistically update the cached currentValue so getModelInfo() reflects
      // the switch immediately, even if the agent responds without configOptions.
      // A subsequent config_option_update notification will overwrite this if needed.
      this.configOptions = this.configOptions.map((opt) => (opt.id === configId ? { ...opt, currentValue: value, selectedValue: value } : opt));
    }

    return result as unknown as AcpResponse;
  }

  getConfigOptions(): AcpSessionConfigOption[] | null {
    return this.configOptions;
  }

  getModels(): AcpSessionModels | null {
    return this.models;
  }

  async disconnect(): Promise<void> {
    await this.terminateChild();

    // Reset session-level state
    this.clientConnection = null;
    this.sessionId = null;
    this.isInitialized = false;
    this.isSetupComplete = false;
    this.backend = null;
    this.initializeResponse = null;
    this.configOptions = null;
    this.models = null;
  }

  get isConnected(): boolean {
    const connected = this.child !== null && !this.child.killed;
    return connected;
  }

  get hasActiveSession(): boolean {
    const hasSession = this.sessionId !== null;
    return hasSession;
  }

  /**
   * Get the current session ID (for session resume support).
   * 获取当前 session ID（用于会话恢复支持）。
   */
  get currentSessionId(): string | null {
    return this.sessionId;
  }

  get currentBackend(): AcpBackend | null {
    return this.backend;
  }

  getInitializeResponse(): AcpResponse | null {
    return this.initializeResponse;
  }

  // Normalize read operations to the conversation workspace before touching the filesystem
  // 访问文件前先把读取操作映射到会话工作区
  private async handleReadOperation(params: { path: string; sessionId?: string }): Promise<{ content: string }> {
    const resolvedReadPath = this.resolveWorkspacePath(params.path);
    this.onFileOperation({
      method: 'fs/read_text_file',
      path: resolvedReadPath,
      sessionId: params.sessionId || '',
    });
    return await this.handleReadTextFile({ ...params, path: resolvedReadPath });
  }

  // Normalize write operations and emit UI events so the workspace view stays in sync
  // 将写入操作归一化并通知 UI，保持工作区视图同步
  private async handleWriteOperation(params: { path: string; content: string; sessionId?: string }): Promise<null> {
    const resolvedWritePath = this.resolveWorkspacePath(params.path);
    this.onFileOperation({
      method: 'fs/write_text_file',
      path: resolvedWritePath,
      content: params.content,
      sessionId: params.sessionId || '',
    });
    return await this.handleWriteTextFile({ ...params, path: resolvedWritePath });
  }
}
