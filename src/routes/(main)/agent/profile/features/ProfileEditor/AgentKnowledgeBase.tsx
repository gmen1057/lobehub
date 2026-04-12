'use client';

import { Button, Flexbox, Icon, Tag } from '@lobehub/ui';
import { createStaticStyles, cssVar } from 'antd-style';
import isEqual from 'fast-deep-equal';
import { LibraryBig, X } from 'lucide-react';
import { memo, Suspense, useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { AttachKnowledgeModal } from '@/features/LibraryModal';
import { useIsDark } from '@/hooks/useIsDark';
import { useAgentStore } from '@/store/agent';
import { agentSelectors } from '@/store/agent/selectors';

const styles = createStaticStyles(({ css, cssVar }) => ({
  tag: css`
    height: 28px !important;
    border-radius: ${cssVar.borderRadiusSM} !important;
  `,
}));

/**
 * Knowledge Base section for Agent Profile editor.
 * Matches AgentTool visual style: inline tags with + button.
 */
const AgentKnowledgeBase = memo(() => {
  const { t } = useTranslation('setting');
  const isDarkMode = useIsDark();
  const [modalOpen, setModalOpen] = useState(false);

  const knowledgeBases = useAgentStore(
    (s) => agentSelectors.currentAgentConfig(s)?.knowledgeBases || [],
    isEqual,
  );
  const removeKnowledgeBaseFromAgent = useAgentStore((s) => s.removeKnowledgeBaseFromAgent);

  const handleRemove = useCallback(
    async (id: string, e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      await removeKnowledgeBaseFromAgent(id);
    },
    [removeKnowledgeBaseFromAgent],
  );

  const enabledKBs = knowledgeBases.filter((kb) => kb.enabled !== false);

  // Don't render anything if no KBs attached and user hasn't opened the modal yet
  // This keeps the profile clean when KB is not used
  return (
    <>
      <Flexbox horizontal align="center" gap={8} style={{ marginTop: 8 }} wrap={'wrap'}>
        <Button
          icon={LibraryBig}
          size={'small'}
          style={{ color: cssVar.colorTextSecondary }}
          type={'text'}
          onClick={() => setModalOpen(true)}
        >
          {t('agentKnowledge.title')}
        </Button>
        {enabledKBs.map((kb) => (
          <Tag
            closable
            className={styles.tag}
            closeIcon={<X size={12} />}
            icon={<Icon icon={LibraryBig} size={14} />}
            key={kb.id}
            variant={isDarkMode ? 'filled' : 'outlined'}
            onClose={(e) => handleRemove(kb.id, e)}
          >
            {kb.name || kb.id}
          </Tag>
        ))}
      </Flexbox>
      <Suspense fallback={null}>
        <AttachKnowledgeModal open={modalOpen} setOpen={setModalOpen} />
      </Suspense>
    </>
  );
});

export default AgentKnowledgeBase;
