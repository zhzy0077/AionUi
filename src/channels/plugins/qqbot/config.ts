/**
 * QQBot Channel Configuration Utilities
 * Configuration resolution and management for QQBot channel plugin
 */

import type { IChannelPluginConfig } from '../../types.js';
import type { ResolvedQQBotAccount, QQBotAccountConfig, QQBotChannelConfig } from './types.js';

/** Default account ID when using single-account configuration */
export const DEFAULT_ACCOUNT_ID = 'default';

/**
 * Normalize appId to string (trim whitespace)
 */
function normalizeAppId(raw: unknown): string {
  if (raw === null || raw === undefined) return '';
  return String(raw).trim();
}

/**
 * Get QQBot-specific config from IChannelPluginConfig
 */
function getQQBotConfig(cfg: IChannelPluginConfig): QQBotChannelConfig | undefined {
  return cfg.config as QQBotChannelConfig | undefined;
}

/**
 * List all configured QQBot account IDs
 * Returns both default account (if configured) and named accounts
 *
 * @param cfg - Channel plugin configuration
 * @returns Array of account IDs
 */
export function listQQBotAccountIds(cfg: IChannelPluginConfig): string[] {
  const ids = new Set<string>();
  const qqbot = getQQBotConfig(cfg);

  // Check default account (top-level config)
  if (qqbot?.appId) {
    ids.add(DEFAULT_ACCOUNT_ID);
  }

  // Check named accounts
  if (qqbot?.accounts) {
    for (const accountId of Object.keys(qqbot.accounts)) {
      if (qqbot.accounts[accountId]?.appId) {
        ids.add(accountId);
      }
    }
  }

  return Array.from(ids);
}

/**
 * Get default account ID
 * Returns "default" if top-level config exists, otherwise first named account
 *
 * @param cfg - Channel plugin configuration
 * @returns Default account ID
 */
export function resolveDefaultQQBotAccountId(cfg: IChannelPluginConfig): string {
  const qqbot = getQQBotConfig(cfg);

  // If default account config exists, return "default"
  if (qqbot?.appId) {
    return DEFAULT_ACCOUNT_ID;
  }

  // Otherwise return first configured named account
  if (qqbot?.accounts) {
    const ids = Object.keys(qqbot.accounts);
    if (ids.length > 0) {
      return ids[0];
    }
  }

  return DEFAULT_ACCOUNT_ID;
}

/**
 * Resolve QQBot account configuration
 * Parses account config and applies defaults
 *
 * @param cfg - Channel plugin configuration
 * @param accountId - Account ID to resolve (null/undefined uses default)
 * @returns Resolved account with all fields populated
 */
export function resolveQQBotAccount(cfg: IChannelPluginConfig, accountId?: string | null): ResolvedQQBotAccount {
  const resolvedAccountId = accountId ?? DEFAULT_ACCOUNT_ID;
  const qqbot = getQQBotConfig(cfg);

  // Base configuration
  let accountConfig: QQBotAccountConfig = {};
  let appId = '';
  let clientSecret = '';
  let secretSource: 'config' | 'file' | 'env' | 'none' = 'none';

  if (resolvedAccountId === DEFAULT_ACCOUNT_ID) {
    // Default account: read from top-level config
    accountConfig = {
      enabled: qqbot?.enabled,
      name: qqbot?.name,
      appId: qqbot?.appId,
      clientSecret: qqbot?.clientSecret,
      clientSecretFile: qqbot?.clientSecretFile,
      dmPolicy: qqbot?.dmPolicy,
      allowFrom: qqbot?.allowFrom,
      systemPrompt: qqbot?.systemPrompt,
      imageServerBaseUrl: qqbot?.imageServerBaseUrl,
      markdownSupport: qqbot?.markdownSupport ?? true,
    };
    appId = normalizeAppId(qqbot?.appId);
  } else {
    // Named account: read from accounts object
    const account = qqbot?.accounts?.[resolvedAccountId];
    accountConfig = account ?? {};
    appId = normalizeAppId(account?.appId);
  }

  // Resolve clientSecret
  if (accountConfig.clientSecret) {
    clientSecret = accountConfig.clientSecret;
    secretSource = 'config';
  } else if (accountConfig.clientSecretFile) {
    // Read from file at runtime
    secretSource = 'file';
  } else if (process.env.QQBOT_CLIENT_SECRET && resolvedAccountId === DEFAULT_ACCOUNT_ID) {
    clientSecret = process.env.QQBOT_CLIENT_SECRET;
    secretSource = 'env';
  }

  // AppId can also be read from environment variable
  if (!appId && process.env.QQBOT_APP_ID && resolvedAccountId === DEFAULT_ACCOUNT_ID) {
    appId = normalizeAppId(process.env.QQBOT_APP_ID);
  }

  return {
    accountId: resolvedAccountId,
    name: accountConfig.name,
    enabled: accountConfig.enabled !== false,
    appId,
    clientSecret,
    secretSource,
    systemPrompt: accountConfig.systemPrompt,
    imageServerBaseUrl: accountConfig.imageServerBaseUrl || process.env.QQBOT_IMAGE_SERVER_BASE_URL,
    markdownSupport: accountConfig.markdownSupport !== false,
    config: accountConfig,
  };
}

/**
 * Apply QQBot account configuration
 * Updates the plugin config with new account settings
 *
 * @param cfg - Original channel plugin configuration
 * @param accountId - Account ID to update
 * @param input - Configuration input
 * @returns Updated configuration
 */
export function applyQQBotAccountConfig(
  cfg: IChannelPluginConfig,
  accountId: string,
  input: {
    appId?: string;
    clientSecret?: string;
    clientSecretFile?: string;
    name?: string;
    imageServerBaseUrl?: string;
  }
): IChannelPluginConfig {
  const next = { ...cfg };

  if (accountId === DEFAULT_ACCOUNT_ID) {
    // Default account: update top-level config
    // If allowFrom not set, default to ["*"]
    const existingConfig = getQQBotConfig(next) || {};
    const allowFrom = existingConfig.allowFrom ?? ['*'];

    (next as unknown as { config: QQBotChannelConfig }).config = {
      ...(existingConfig as Record<string, unknown>),
      enabled: true,
      allowFrom,
      ...(input.appId ? { appId: input.appId } : {}),
      ...(input.clientSecret ? { clientSecret: input.clientSecret } : input.clientSecretFile ? { clientSecretFile: input.clientSecretFile } : {}),
      ...(input.name ? { name: input.name } : {}),
      ...(input.imageServerBaseUrl ? { imageServerBaseUrl: input.imageServerBaseUrl } : {}),
    } as QQBotChannelConfig;
  } else {
    // Named account: update in accounts object
    const existingAccountConfig = getQQBotConfig(next)?.accounts?.[accountId] || {};
    const allowFrom = existingAccountConfig.allowFrom ?? ['*'];

    const existingAccounts = getQQBotConfig(next)?.accounts || {};

    (next as unknown as { config: QQBotChannelConfig }).config = {
      ...(getQQBotConfig(next) as Record<string, unknown>),
      enabled: true,
      accounts: {
        ...existingAccounts,
        [accountId]: {
          ...existingAccountConfig,
          enabled: true,
          allowFrom,
          ...(input.appId ? { appId: input.appId } : {}),
          ...(input.clientSecret ? { clientSecret: input.clientSecret } : input.clientSecretFile ? { clientSecretFile: input.clientSecretFile } : {}),
          ...(input.name ? { name: input.name } : {}),
          ...(input.imageServerBaseUrl ? { imageServerBaseUrl: input.imageServerBaseUrl } : {}),
        },
      },
    } as QQBotChannelConfig;
  }

  return next;
}
