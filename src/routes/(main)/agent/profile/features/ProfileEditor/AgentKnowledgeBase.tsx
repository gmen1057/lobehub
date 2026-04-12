'use client';

import { Button, Flexbox, Icon, Text } from '@lobehub/ui';
import { Tag } from 'antd';
import { cssVar } from 'antd-style';
import isEqual from 'fast-deep-equal';
import { LibraryBig, PlusIcon, X } from 'lucide-react';
import { memo, Suspense, useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { AttachKnowledgeModal } from '@/features/LibraryModal';
import { useAgentStore } from '@/store/agent';
import { agentSelectors } from '@/store/agent/selectors';

/**
 * Knowledge Base section for Agent Profile editor.
 * Shows currently attached KBs as tags with remove button,
 * plus an "Add" button that opens the AssignKnowledgeBase modal.
 */
const AgentKnowledgeBase = memo(() => {
  const { t } = useTranslation('setting');
  const [modalOpen, setModalOpen] = useState(false);

  const knowledgeBases = useAgentStore(
    (s) => agentSelectors.currentAgentConfig(s)?.knowledgeBases || [],
    isEqual,
  );
  const removeKnowledgeBaseFromAgent = useAgentStore((s) => s.removeKnowledgeBaseFromAgent);

  const handleRemove = useCallback(
    async (id: string) => {
      await removeKnowledgeBaseFromAgent(id);
    },
    [removeKnowledgeBaseFromAgent],
  );

  return (
    <>
      <Flexbox gap={8}>
        <Text size={12} type={'secondary'}>
          <Icon icon={LibraryBig} size={14} style={{ marginRight: 4 }} />
          {t('agentKnowledge.title')}
        </Text>
        <Flexbox horizontal align="center" gap={8} wrap={'wrap'}>
          <Button
            icon={PlusIcon}
            size={'small'}
            style={{ color: cssVar.colorTextSecondary }}
            type={'text'}
            onClick={() => setModalOpen(true)}
          >
            {t('tools.add', { defaultValue: 'Добавить' })}
          </Button>
          {knowledgeBases
            .filter((kb) => kb.enabled !== false)
            .map((kb) => (
              <Tag
                closable
                closeIcon={<Icon icon={X} size={12} />}
                key={kb.id}
                style={{ cursor: 'default' }}
                onClose={(e) => {
                  e.preventDefault();
                  handleRemove(kb.id);
                }}
              >
                <Flexbox horizontal align={'center'} gap={4}>
                  <Icon icon={LibraryBig} size={12} />
                  {kb.name || kb.id}
                </Flexbox>
              </Tag>
            ))}
        </Flexbox>
      </Flexbox>
      <Suspense fallback={null}>
        <AttachKnowledgeModal open={modalOpen} setOpen={setModalOpen} />
      </Suspense>
    </>
  );
});

export default AgentKnowledgeBase;
