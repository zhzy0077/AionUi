/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { app } from 'electron';
import { ipcBridge } from '../../common';
import { getSystemDir, ProcessEnv } from '../initStorage';
import { copyDirectoryRecursively } from '../utils';
import WorkerManage from '../WorkerManage';
import { getZoomFactor, setZoomFactor } from '../utils/zoom';
import { getCdpStatus, updateCdpConfig, verifyCdpReady } from '../../utils/configureChromium';

const STAR_OFFICE_SCAN_RADIUS = 24;
const STAR_OFFICE_SCAN_CONCURRENCY = 6;

const toLocalPort = (rawUrl?: string): number | null => {
  if (!rawUrl?.trim()) return null;
  try {
    const parsed = new URL(rawUrl.trim());
    const host = parsed.hostname.toLowerCase();
    if (!['127.0.0.1', 'localhost'].includes(host)) return null;
    if (parsed.port) {
      const port = Number(parsed.port);
      return Number.isFinite(port) && port > 0 ? port : null;
    }
    return parsed.protocol === 'https:' ? 443 : 80;
  } catch {
    return null;
  }
};

const toLocalUrl = (port: number) => `http://127.0.0.1:${port}`;

const buildCandidates = (preferredUrl?: string): string[] => {
  const knownPorts = [toLocalPort(preferredUrl), 19000, 18791]
    .filter((port): port is number => port != null)
    .filter((port, index, arr) => arr.indexOf(port) === index);

  const rangedPorts: number[] = [];
  for (const basePort of knownPorts) {
    for (let offset = 1; offset <= STAR_OFFICE_SCAN_RADIUS; offset += 1) {
      const up = basePort + offset;
      const down = basePort - offset;
      if (up <= 65535) rangedPorts.push(up);
      if (down >= 1024) rangedPorts.push(down);
    }
  }

  return [...knownPorts, ...rangedPorts]
    .filter((port, index, arr) => arr.indexOf(port) === index)
    .map(toLocalUrl);
};

const checkHealthFromMain = async (baseUrl: string, timeoutMs = 1000): Promise<boolean> => {
  const normalizedBase = (baseUrl || '').trim().replace(/\/+$/, '');
  if (!normalizedBase) return false;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${normalizedBase}/health`, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
      },
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
};

const detectStarOfficeUrlFromMain = async (preferredUrl?: string, timeoutMs = 1000): Promise<string | null> => {
  const candidates = buildCandidates(preferredUrl);
  if (!candidates.length) return null;

  let cursor = 0;
  let found: string | null = null;
  const workers = Array.from({ length: Math.min(STAR_OFFICE_SCAN_CONCURRENCY, candidates.length) }, async () => {
    while (!found) {
      const current = cursor;
      cursor += 1;
      if (current >= candidates.length) return;
      const target = candidates[current];
      // eslint-disable-next-line no-await-in-loop
      const ok = await checkHealthFromMain(target, timeoutMs);
      if (ok && !found) {
        found = target;
      }
    }
  });

  await Promise.all(workers);
  return found;
};

export function initApplicationBridge(): void {
  ipcBridge.application.restart.provider(() => {
    // 清理所有工作进程
    WorkerManage.clear();
    // 重启应用 - 使用标准的 Electron 重启方式
    app.relaunch();
    app.exit(0);
    return Promise.resolve();
  });

  ipcBridge.application.updateSystemInfo.provider(async ({ cacheDir, workDir }) => {
    try {
      const oldDir = getSystemDir();
      if (oldDir.cacheDir !== cacheDir) {
        await copyDirectoryRecursively(oldDir.cacheDir, cacheDir);
      }
      await ProcessEnv.set('aionui.dir', { cacheDir, workDir });
      return { success: true };
    } catch (e) {
      return { success: false, msg: e.message || e.toString() };
    }
  });

  ipcBridge.application.systemInfo.provider(() => {
    return Promise.resolve(getSystemDir());
  });

  ipcBridge.application.getPath.provider(({ name }) => {
    return Promise.resolve(app.getPath(name));
  });

  ipcBridge.application.openDevTools.provider(() => {
    // This will be handled by the main window when needed
    return Promise.resolve(false);
  });

  ipcBridge.application.getZoomFactor.provider(() => Promise.resolve(getZoomFactor()));

  ipcBridge.application.setZoomFactor.provider(({ factor }) => {
    return Promise.resolve(setZoomFactor(factor));
  });

  // CDP status and configuration
  ipcBridge.application.getCdpStatus.provider(async () => {
    try {
      const status = getCdpStatus();
      // If port is set, CDP is considered enabled (verification is optional)
      return { success: true, data: status };
    } catch (e) {
      return { success: false, msg: e.message || e.toString() };
    }
  });

  ipcBridge.application.updateCdpConfig.provider(async (config) => {
    try {
      const updatedConfig = updateCdpConfig(config);
      return { success: true, data: updatedConfig };
    } catch (e) {
      return { success: false, msg: e.message || e.toString() };
    }
  });

  ipcBridge.application.detectStarOfficeUrl.provider(async ({ preferredUrl, timeoutMs }) => {
    try {
      const url = await detectStarOfficeUrlFromMain(preferredUrl, timeoutMs ?? 1000);
      return { success: true, data: { url } };
    } catch (e) {
      return { success: false, msg: e.message || e.toString() };
    }
  });
}
