'use client';

import { Flexbox, Typography } from '@lobehub/ui';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { List } from '@/features/LibraryModal/AssignKnowledgeBase/List';

const AgentKnowledge = memo(() => {
  const { t } = useTranslation('setting');

  return (
    <Flexbox gap={16}>
      <div>
        <Typography.Title level={4} style={{ marginBottom: 4, marginTop: 0 }}>
          {t('agentKnowledge.title')}
        </Typography.Title>
        <Typography.Text type={'secondary'}>{t('agentKnowledge.desc')}</Typography.Text>
      </div>
      <div style={{ minHeight: 400 }}>
        <List />
      </div>
    </Flexbox>
  );
});

export default AgentKnowledge;
