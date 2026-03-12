/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AcpConnection } from '../../src/agent/acp/AcpConnection';
import { AcpAgent } from '../../src/agent/acp/index';
import type { AcpSessionConfigOption, AcpSessionModels } from '../../src/types/acpTypes';

// ─── helpers ────────────────────────────────────────────────────────────────

function makeConnection(backend: string = 'codex'): AcpConnection {
  const conn = new AcpConnection();
  (conn as any).backend = backend;
  return conn;
}

function makeAgent(backend: string, acpSessionId?: string): AcpAgent {
  return new AcpAgent({
    id: 'test-agent',
    backend: backend as any,
    workingDir: '/tmp',
    extra: {
      backend: backend as any,
      workspace: '/tmp',
      acpSessionId,
    },
    onStreamEvent: vi.fn(),
  });
}

const CONFIG_OPTIONS: AcpSessionConfigOption[] = [{ id: 'model', category: 'model', type: 'select', currentValue: 'gpt-4o', options: [] }];
const MODELS: AcpSessionModels = {
  currentModelId: 'gpt-4o',
  availableModels: [{ id: 'gpt-4o' }, { id: 'o3' }],
};

/** Helper: inject a mock clientConnection.loadSession that returns the given value. */
function mockClientLoadSession(conn: AcpConnection, returnValue: unknown): ReturnType<typeof vi.fn> {
  const fn = vi.fn().mockResolvedValue(returnValue);
  (conn as any).clientConnection = { loadSession: fn };
  return fn;
}

// ─── AcpConnection.loadSession ───────────────────────────────────────────────

describe('AcpConnection.loadSession', () => {
  let conn: AcpConnection;

  beforeEach(() => {
    conn = makeConnection('codex');
  });

  it('sets sessionId from response when present', async () => {
    mockClientLoadSession(conn, { sessionId: 'new-session-456' });

    await conn.loadSession('original-123', '/tmp');

    expect(conn.currentSessionId).toBe('new-session-456');
  });

  it('falls back to the passed sessionId when response omits it', async () => {
    mockClientLoadSession(conn, {});

    await conn.loadSession('original-123', '/tmp');

    expect(conn.currentSessionId).toBe('original-123');
  });

  it('calls clientConnection.loadSession with correct params', async () => {
    const loadSessionMock = mockClientLoadSession(conn, { sessionId: 's1' });
    // normalizeCwdForAgent returns the absolute path for codex
    await conn.loadSession('s1', '/tmp');

    expect(loadSessionMock).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 's1' }));
  });

  it('returns the response cast to AcpResponse', async () => {
    const mockResponse = { sessionId: 's1', extra: 'data' };
    mockClientLoadSession(conn, mockResponse);

    const result = await conn.loadSession('s1', '/tmp');

    expect((result as any).sessionId).toBe('s1');
    expect((result as any).extra).toBe('data');
  });
});

// ─── parseSessionCapabilities (via loadSession) ──────────────────────────────

describe('AcpConnection.parseSessionCapabilities (via loadSession)', () => {
  let conn: AcpConnection;

  beforeEach(() => {
    conn = makeConnection('codex');
  });

  it('parses configOptions from response', async () => {
    mockClientLoadSession(conn, { configOptions: CONFIG_OPTIONS });

    await conn.loadSession('s1', '/tmp');

    expect((conn as any).configOptions).toEqual(CONFIG_OPTIONS);
  });

  it('parses top-level models from response', async () => {
    mockClientLoadSession(conn, { models: MODELS });

    await conn.loadSession('s1', '/tmp');

    expect((conn as any).models).toEqual(MODELS);
  });

  it('falls back to _meta.models when top-level models is absent', async () => {
    mockClientLoadSession(conn, { _meta: { models: MODELS } });

    await conn.loadSession('s1', '/tmp');

    expect((conn as any).models).toEqual(MODELS);
  });

  it('ignores configOptions when response value is not an array', async () => {
    mockClientLoadSession(conn, { configOptions: 'bad-value' });

    await conn.loadSession('s1', '/tmp');

    expect((conn as any).configOptions).toBeNull();
  });

  it('does not overwrite models when response has no models field', async () => {
    mockClientLoadSession(conn, {});

    await conn.loadSession('s1', '/tmp');

    expect((conn as any).models).toBeNull();
  });
});

// ─── AcpAgent.createOrResumeSession routing ──────────────────────────────────

describe('AcpAgent.createOrResumeSession — Codex routing', () => {
  it('routes Codex to loadSession instead of newSession', async () => {
    const agent = makeAgent('codex', 'session-codex-1');
    const conn: AcpConnection = (agent as any).connection;

    const loadSession = vi.spyOn(conn, 'loadSession').mockResolvedValue({ sessionId: 'session-codex-1' } as any);
    const newSession = vi.spyOn(conn, 'newSession').mockResolvedValue({ sessionId: 'fresh' } as any);

    await (agent as any).createOrResumeSession();

    expect(loadSession).toHaveBeenCalledWith('session-codex-1', expect.any(String));
    expect(newSession).not.toHaveBeenCalled();
  });

  it('routes non-Codex backends to newSession', async () => {
    const agent = makeAgent('claude', 'session-claude-1');
    const conn: AcpConnection = (agent as any).connection;

    const loadSession = vi.spyOn(conn, 'loadSession').mockResolvedValue({} as any);
    const newSession = vi.spyOn(conn, 'newSession').mockResolvedValue({ sessionId: 'session-claude-1' } as any);

    await (agent as any).createOrResumeSession();

    expect(newSession).toHaveBeenCalled();
    expect(loadSession).not.toHaveBeenCalled();
  });

  it('falls back to newSession when loadSession throws', async () => {
    const agent = makeAgent('codex', 'session-expired');
    const conn: AcpConnection = (agent as any).connection;

    vi.spyOn(conn, 'loadSession').mockRejectedValue(new Error('rollout expired'));
    const newSession = vi.spyOn(conn, 'newSession').mockResolvedValue({ sessionId: 'fresh-session' } as any);

    await (agent as any).createOrResumeSession();

    expect(newSession).toHaveBeenCalledWith(expect.any(String));
  });

  it('creates a fresh session when no acpSessionId is stored', async () => {
    const agent = makeAgent('codex'); // no acpSessionId
    const conn: AcpConnection = (agent as any).connection;

    const loadSession = vi.spyOn(conn, 'loadSession').mockResolvedValue({} as any);
    const newSession = vi.spyOn(conn, 'newSession').mockResolvedValue({ sessionId: 'brand-new' } as any);

    await (agent as any).createOrResumeSession();

    expect(loadSession).not.toHaveBeenCalled();
    expect(newSession).toHaveBeenCalledWith(expect.any(String));
  });

  it('updates acpSessionId when resume returns a new session ID', async () => {
    const agent = makeAgent('codex', 'old-session');
    const conn: AcpConnection = (agent as any).connection;
    const onSessionIdUpdate = vi.fn();
    (agent as any).onSessionIdUpdate = onSessionIdUpdate;

    vi.spyOn(conn, 'loadSession').mockResolvedValue({ sessionId: 'rotated-session' } as any);

    await (agent as any).createOrResumeSession();

    expect((agent as any).extra.acpSessionId).toBe('rotated-session');
    expect(onSessionIdUpdate).toHaveBeenCalledWith('rotated-session');
  });
});
