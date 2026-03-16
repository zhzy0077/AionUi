/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { IChannelPairingRequest, IChannelPluginStatus, IChannelUser } from '@/channels/types';
import { acpConversation, channel } from '@/common/ipcBridge';
import { ConfigStorage } from '@/common/storage';
import GeminiModelSelector from '@/renderer/pages/conversation/gemini/GeminiModelSelector';
import type { GeminiModelSelection } from '@/renderer/pages/conversation/gemini/useGeminiModelSelection';
import type { AcpBackendAll } from '@/types/acpTypes';
import { Button, Dropdown, Empty, Input, Menu, Message, Spin, Switch, Tooltip } from '@arco-design/web-react';
import { CheckOne, CloseOne, Copy, Delete, Down, Refresh } from '@icon-park/react';
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * Preference row component
 */
const PreferenceRow: React.FC<{
  label: string;
  description?: React.ReactNode;
  extra?: React.ReactNode;
  required?: boolean;
  children: React.ReactNode;
}> = ({ label, description, extra, required, children }) => (
  <div className='flex items-center justify-between gap-24px py-12px'>
    <div className='flex-1'>
      <div className='flex items-center gap-8px'>
        <span className='text-14px text-t-primary'>
          {label}
          {required && <span className='text-red-500 ml-2px'>*</span>}
        </span>
        {extra}
      </div>
      {description && <div className='text-12px text-t-tertiary mt-2px'>{description}</div>}
    </div>
    <div className='flex items-center'>{children}</div>
  </div>
);

/**
 * Section header component
 */
const SectionHeader: React.FC<{ title: string; action?: React.ReactNode }> = ({ title, action }) => (
  <div className='flex items-center justify-between mb-12px'>
    <h3 className='text-14px font-500 text-t-primary m-0'>{title}</h3>
    {action}
  </div>
);

interface QQBotConfigFormProps {
  pluginStatus: IChannelPluginStatus | null;
  modelSelection: GeminiModelSelection;
  onStatusChange: (status: IChannelPluginStatus | null) => void;
}

const QQBotConfigForm: React.FC<QQBotConfigFormProps> = ({ pluginStatus, modelSelection, onStatusChange }) => {
  const { t } = useTranslation();

  // QQ Bot credentials
  const [appId, setAppId] = useState('');
  const [appSecret, setAppSecret] = useState('');

  const [testLoading, setTestLoading] = useState(false);
  const [touched, setTouched] = useState({ appId: false, appSecret: false });
  const [pairingLoading, setPairingLoading] = useState(false);
  const [usersLoading, setUsersLoading] = useState(false);
  const [pendingPairings, setPendingPairings] = useState<IChannelPairingRequest[]>([]);
  const [authorizedUsers, setAuthorizedUsers] = useState<IChannelUser[]>([]);

  // Agent selection
  const [availableAgents, setAvailableAgents] = useState<Array<{ backend: AcpBackendAll; name: string; customAgentId?: string; isPreset?: boolean }>>([]);
  const [selectedAgent, setSelectedAgent] = useState<{ backend: AcpBackendAll; name?: string; customAgentId?: string }>({ backend: 'gemini' });

  // Load pending pairings
  const loadPendingPairings = useCallback(async () => {
    setPairingLoading(true);
    try {
      const result = await channel.getPendingPairings.invoke();
      if (result.success && result.data) {
        setPendingPairings(result.data.filter((p) => p.platformType === 'qqbot'));
      }
    } catch (error) {
      console.error('[QQBotConfig] Failed to load pending pairings:', error);
    } finally {
      setPairingLoading(false);
    }
  }, []);

  // Load authorized users
  const loadAuthorizedUsers = useCallback(async () => {
    setUsersLoading(true);
    try {
      const result = await channel.getAuthorizedUsers.invoke();
      if (result.success && result.data) {
        setAuthorizedUsers(result.data.filter((u) => u.platformType === 'qqbot'));
      }
    } catch (error) {
      console.error('[QQBotConfig] Failed to load authorized users:', error);
    } finally {
      setUsersLoading(false);
    }
  }, []);

  // Initial load
  useEffect(() => {
    void loadPendingPairings();
    void loadAuthorizedUsers();
  }, [loadPendingPairings, loadAuthorizedUsers]);

  // Load available agents + saved selection
  useEffect(() => {
    const loadAgentsAndSelection = async () => {
      try {
        const [agentsResp, saved] = await Promise.all([acpConversation.getAvailableAgents.invoke(), ConfigStorage.get('assistant.qqbot.agent')]);

        if (agentsResp.success && agentsResp.data) {
          const list = agentsResp.data.filter((a) => !a.isPreset).map((a) => ({ backend: a.backend, name: a.name, customAgentId: a.customAgentId, isPreset: a.isPreset, isExtension: a.isExtension }));
          setAvailableAgents(list);
        }

        if (saved && typeof saved === 'object' && 'backend' in saved && typeof (saved as any).backend === 'string') {
          setSelectedAgent({
            backend: (saved as any).backend as AcpBackendAll,
            customAgentId: (saved as any).customAgentId,
            name: (saved as any).name,
          });
        } else if (typeof saved === 'string') {
          setSelectedAgent({ backend: saved as AcpBackendAll });
        }
      } catch (error) {
        console.error('[QQBotConfig] Failed to load agents:', error);
      }
    };

    void loadAgentsAndSelection();
  }, []);

  const persistSelectedAgent = async (agent: { backend: AcpBackendAll; customAgentId?: string; name?: string }) => {
    try {
      await ConfigStorage.set('assistant.qqbot.agent', agent);
      await channel.syncChannelSettings.invoke({ platform: 'qqbot', agent }).catch((err) => console.warn('[QQBotConfig] syncChannelSettings failed:', err));
      Message.success(t('settings.assistant.agentSwitched', 'Agent switched successfully'));
    } catch (error) {
      console.error('[QQBotConfig] Failed to persist agent:', error);
    }
  };

  // Handle test connection
  const handleTest = async () => {
    if (!appId.trim() || !appSecret.trim()) {
      Message.error(t('settings.qqbot.credentialsRequired', 'Please enter App ID and App Secret'));
      return;
    }

    setTestLoading(true);
    try {
      const result = await channel.testPlugin.invoke({
        pluginId: 'qqbot_default',
        token: '',
        extraConfig: { appId: appId.trim(), appSecret: appSecret.trim() },
      });
      if (result.success) {
        Message.success(t('settings.qqbot.connectionSuccess', 'Connected to QQ Bot API!'));
      } else {
        Message.error(result.msg || t('settings.qqbot.connectionFailed', 'Connection failed'));
      }
    } catch (error) {
      Message.error(t('settings.qqbot.connectionFailed', 'Connection failed'));
    } finally {
      setTestLoading(false);
    }
  };

  // Handle approve pairing
  const handleApprovePairing = async (code: string) => {
    try {
      const result = await channel.approvePairing.invoke({ code });
      if (result.success) {
        Message.success(t('settings.assistant.pairingApproved', 'Pairing approved'));
        void loadPendingPairings();
        void loadAuthorizedUsers();
      } else {
        Message.error(result.msg || t('settings.assistant.approveFailed', 'Failed to approve pairing'));
      }
    } catch (error) {
      Message.error(t('settings.assistant.approveFailed', 'Failed to approve pairing'));
    }
  };

  // Handle reject pairing
  const handleRejectPairing = async (code: string) => {
    try {
      const result = await channel.rejectPairing.invoke({ code });
      if (result.success) {
        Message.success(t('settings.assistant.pairingRejected', 'Pairing rejected'));
        void loadPendingPairings();
      } else {
        Message.error(result.msg || t('settings.assistant.rejectFailed', 'Failed to reject pairing'));
      }
    } catch (error) {
      Message.error(t('settings.assistant.rejectFailed', 'Failed to reject pairing'));
    }
  };

  // Handle revoke user
  const handleRevokeUser = async (userId: string) => {
    try {
      const result = await channel.revokeUser.invoke({ userId });
      if (result.success) {
        Message.success(t('settings.assistant.userRevoked', 'User access revoked'));
        void loadAuthorizedUsers();
      } else {
        Message.error(result.msg || t('settings.assistant.revokeFailed', 'Failed to revoke user'));
      }
    } catch (error) {
      Message.error(t('settings.assistant.revokeFailed', 'Failed to revoke user'));
    }
  };

  // Format relative time
  const formatRelativeTime = (timestamp: number) => {
    const diff = Math.floor((Date.now() - timestamp) / 1000);
    if (diff < 60) return `${diff}s ago`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
  };

  const isConnected = pluginStatus?.connected ?? false;
  const hasCredentials = pluginStatus?.hasToken ?? false;

  return (
    <div className='flex flex-col gap-16px'>
      {/* Credentials Section */}
      <div>
        <SectionHeader title={t('settings.channels.qqbotTitle', 'QQ Bot Configuration')} action={hasCredentials && <span className='text-12px text-t-secondary'>{t('settings.qqbot.credentialsSaved', 'Credentials already configured. Enter new values to update.')}</span>} />

        <div className='bg-bg-tertiary rounded-8px px-16px'>
          <PreferenceRow label={t('settings.qqbot.appId', 'App ID')} required>
            <Input
              value={appId}
              onChange={(v) => {
                setAppId(v);
                setTouched((t) => ({ ...t, appId: true }));
              }}
              placeholder='Enter App ID'
              className='w-280px'
              disabled={isConnected}
            />
          </PreferenceRow>

          <PreferenceRow label={t('settings.qqbot.appSecret', 'App Secret')} required>
            <Input
              value={appSecret}
              onChange={(v) => {
                setAppSecret(v);
                setTouched((t) => ({ ...t, appSecret: true }));
              }}
              placeholder='Enter App Secret'
              type='password'
              className='w-280px'
              disabled={isConnected}
            />
          </PreferenceRow>

        </div>

        {/* Test Connection Button */}
        <div className='mt-16px flex justify-end gap-12px'>
          <Button type='primary' loading={testLoading} onClick={handleTest} disabled={!appId.trim() || !appSecret.trim() || isConnected}>
            {t('settings.qqbot.testAndConnect', 'Test & Connect')}
          </Button>
        </div>
      </div>

      {/* Model Selection */}
      <div>
        <SectionHeader title={t('settings.assistant.defaultModel', 'Default Model')} />
        <div className='bg-bg-tertiary rounded-8px px-16px py-12px'>
          <GeminiModelSelector selection={modelSelection} variant='settings' label={t('settings.qqbot.defaultModelDesc', 'Model used for QQ Bot conversations')} />
        </div>
      </div>

      {/* Agent Selection */}
      <div>
        <SectionHeader title={t('settings.qqbot.agent', 'Agent')} />
        <div className='bg-bg-tertiary rounded-8px px-16px py-12px'>
          <div className='flex items-center justify-between gap-24px'>
            <div className='flex-1'>
              <div className='text-14px text-t-primary'>{t('settings.qqbot.agentDesc', 'Used for QQ Bot conversations')}</div>
              <div className='text-12px text-t-tertiary mt-2px'>
                {selectedAgent.name || selectedAgent.backend}
                {selectedAgent.customAgentId && ` (${selectedAgent.customAgentId})`}
              </div>
            </div>
            <Dropdown
              droplist={
                <Menu>
                  {availableAgents.map((agent) => (
                    <Menu.Item
                      key={agent.customAgentId || agent.backend}
                      onClick={() => {
                        const newAgent = { backend: agent.backend, name: agent.name, customAgentId: agent.customAgentId };
                        setSelectedAgent(newAgent);
                        void persistSelectedAgent(newAgent);
                      }}
                    >
                      <div className='flex items-center gap-8px'>
                        <span>{agent.name}</span>
                        <span className='text-t-secondary text-12px'>({agent.backend})</span>
                      </div>
                    </Menu.Item>
                  ))}
                </Menu>
              }
            >
              <Button type='secondary' size='small'>
                <div className='flex items-center gap-4px'>
                  <span>{t('settings.assistant.selectModel', 'Select Model')}</span>
                  <Down className='w-14px h-14px' />
                </div>
              </Button>
            </Dropdown>
          </div>
        </div>
      </div>

      {/* Next Steps */}
      <div>
        <SectionHeader title={t('settings.assistant.nextSteps', 'Next Steps')} />
        <div className='bg-bg-tertiary rounded-8px px-16px py-12px'>
          <ol className='text-14px text-t-secondary m-0 pl-20px space-y-8px'>
            <li>{t('settings.qqbot.step1', 'Open QQ and find your bot')}</li>
            <li>{t('settings.qqbot.step2', 'Send any message to initiate pairing')}</li>
            <li>{t('settings.qqbot.step3', 'A pairing request will appear below. Click "Approve" to authorize the user.')}</li>
            <li>{t('settings.qqbot.step4', 'Once approved, you can start chatting with the AI assistant through QQ!')}</li>
          </ol>
        </div>
      </div>

      {/* Pending Pairings */}
      <div>
        <SectionHeader
          title={t('settings.assistant.pendingPairings', 'Pending Pairing Requests')}
          action={
            <Button type='text' size='small' onClick={() => void loadPendingPairings()} loading={pairingLoading} icon={<Refresh className='w-14px h-14px' />}>
              {t('common.refresh', 'Refresh')}
            </Button>
          }
        />
        <div className='bg-bg-tertiary rounded-8px px-16px py-12px'>
          {pendingPairings.length === 0 ? (
            <Empty description={t('settings.assistant.noPendingPairings', 'No pending pairing requests')} />
          ) : (
            <div className='space-y-12px'>
              {pendingPairings.map((pairing) => (
                <div key={pairing.code} className='flex items-center justify-between py-8px border-b border-t-tertiary last:border-0'>
                  <div className='flex flex-col'>
                    <span className='text-14px text-t-primary font-500'>{pairing.displayName || pairing.platformUserId}</span>
                    <span className='text-12px text-t-secondary'>
                      {t('settings.assistant.pairingCode', 'Code')}: {pairing.code} • {formatRelativeTime(pairing.requestedAt)}
                    </span>
                  </div>
                  <div className='flex gap-8px'>
                    <Button type='primary' size='small' onClick={() => void handleApprovePairing(pairing.code)}>
                      {t('settings.assistant.approve', 'Approve')}
                    </Button>
                    <Button type='secondary' size='small' status='danger' onClick={() => void handleRejectPairing(pairing.code)}>
                      {t('settings.assistant.reject', 'Reject')}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Authorized Users */}
      <div>
        <SectionHeader
          title={t('settings.assistant.authorizedUsers', 'Authorized Users')}
          action={
            <Button type='text' size='small' onClick={() => void loadAuthorizedUsers()} loading={usersLoading} icon={<Refresh className='w-14px h-14px' />}>
              {t('common.refresh', 'Refresh')}
            </Button>
          }
        />
        <div className='bg-bg-tertiary rounded-8px px-16px py-12px'>
          {authorizedUsers.length === 0 ? (
            <Empty description={t('settings.assistant.noAuthorizedUsers', 'No authorized users yet')} />
          ) : (
            <div className='space-y-12px'>
              {authorizedUsers.map((user) => (
                <div key={user.id} className='flex items-center justify-between py-8px border-b border-t-tertiary last:border-0'>
                  <div className='flex flex-col'>
                    <span className='text-14px text-t-primary font-500'>{user.displayName || user.platformUserId}</span>
                    <span className='text-12px text-t-secondary'>
                      {t('settings.assistant.platform', 'Platform')}: {user.platformType} • {t('settings.assistant.authorizedAt', 'Authorized')}: {formatRelativeTime(user.authorizedAt)}
                    </span>
                  </div>
                  <Tooltip content={t('settings.assistant.revokeAccess', 'Revoke access')}>
                    <Button type='text' size='small' status='danger' onClick={() => void handleRevokeUser(user.id)} icon={<Delete className='w-16px h-16px' />} />
                  </Tooltip>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default QQBotConfigForm;
