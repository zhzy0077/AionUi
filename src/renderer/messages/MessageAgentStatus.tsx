/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { IMessageAgentStatus } from '@/common/chatLib';
import { Badge, Typography } from '@arco-design/web-react';
import React from 'react';
import { useTranslation } from 'react-i18next';

const { Text } = Typography;

interface MessageAgentStatusProps {
  message: IMessageAgentStatus;
}

/**
 * Unified agent status message component for all ACP-based agents (Claude, Qwen, Codex, etc.)
 */
const MessageAgentStatus: React.FC<MessageAgentStatusProps> = ({ message }) => {
  const { t } = useTranslation();
  const { backend, status } = message.content;

  const getStatusBadge = () => {
    switch (status) {
      case 'connecting':
        return <Badge status='processing' text={t('acp.status.connecting', { agent: backend })} />;
      case 'connected':
        return <Badge status='success' text={t('acp.status.connected', { agent: backend })} />;
      case 'authenticated':
        return <Badge status='success' text={t('acp.status.authenticated', { agent: backend })} />;
      case 'session_active':
        return <Badge status='success' text={t('acp.status.session_active', { agent: backend })} />;
      case 'pairing_required':
        return <Badge status='warning' text={t('acp.status.pairing_required', { agent: backend })} />;
      case 'disconnected':
        return <Badge status='default' text={t('acp.status.disconnected', { agent: backend })} />;
      case 'error':
        return <Badge status='error' text={t('acp.status.error')} />;
      default:
        return <Badge status='default' text={t('acp.status.unknown')} />;
    }
  };

  const isError = status === 'error';
  const isSuccess = status === 'connected' || status === 'authenticated' || status === 'session_active';
  const isWarning = status === 'pairing_required';

  const resolveColor = (level: string) => {
    if (isError) return `var(--color-danger-${level})`;
    if (isWarning) return `var(--color-warning-${level})`;
    if (isSuccess) return `var(--color-success-${level})`;
    return `var(--color-primary-${level})`;
  };
  const resolveRgb = (level: string) => {
    if (isError) return `rgb(var(--danger-${level}))`;
    if (isWarning) return `rgb(var(--warning-${level}))`;
    if (isSuccess) return `rgb(var(--success-${level}))`;
    return `rgb(var(--primary-${level}))`;
  };

  return (
    <div
      className='agent-status-message flex items-center gap-3 p-3 rounded-lg border'
      style={{
        backgroundColor: resolveColor('light-1'),
        borderColor: resolveRgb('3'),
        color: resolveRgb('6'),
      }}
    >
      <div className='flex items-center gap-2'>
        <Text style={{ fontWeight: 'bold' }} className='capitalize'>
          {backend.charAt(0).toUpperCase() + backend.slice(1)}
        </Text>
      </div>

      <div className='flex-1'>{getStatusBadge()}</div>
    </div>
  );
};

export default MessageAgentStatus;
