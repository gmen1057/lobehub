import { type UIChatMessage } from '@lobechat/types';
import { Button, copyToClipboard, Flexbox } from '@lobehub/ui';
import { App } from 'antd';
import isEqual from 'fast-deep-equal';
import { CopyIcon } from 'lucide-react';
import { memo, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useIsMobile } from '@/hooks/useIsMobile';
import { messageService } from '@/services/message';
import { useChatStore } from '@/store/chat';
import { topicSelectors } from '@/store/chat/selectors';
import { exportFile } from '@/utils/client';

import { useConversationStore } from '../../../store';
import { styles } from '../style';
import Preview from './Preview';
import { downloadXlsxFile, extractSpreadsheetRows } from './spreadsheet';
import { generateMarkdown } from './template';

interface ShareTextProps {
  item: UIChatMessage;
}

const ShareText = memo<ShareTextProps>(({ item }) => {
  const { t } = useTranslation(['chat', 'common']);
  const { message } = App.useApp();
  const [attachingSpreadsheet, setAttachingSpreadsheet] = useState(false);

  const messages = [item];
  const topic = useChatStore(topicSelectors.currentActiveTopic, isEqual);
  const context = useConversationStore((s) => s.context);
  const replaceMessages = useConversationStore((s) => s.replaceMessages);

  const title = topic?.title || t('shareModal.exportTitle');
  const content = generateMarkdown({
    messages,
  }).replaceAll('\n\n\n', '\n');
  const spreadsheetTarget = useMemo(() => {
    if (item.role !== 'assistantGroup') {
      return {
        content: item.content,
        id: item.id,
      };
    }

    const lastContentBlock = [...(item.children || [])]
      .reverse()
      .find((child) => !!child.content?.trim() && (!child.tools || child.tools.length === 0));

    return {
      content: lastContentBlock?.content ?? item.content,
      id: lastContentBlock?.id ?? item.id,
    };
  }, [item]);
  const spreadsheetRows = extractSpreadsheetRows(spreadsheetTarget.content ?? '');

  const isMobile = useIsMobile();

  const button = (
    <>
      <Button
        block
        icon={CopyIcon}
        size={isMobile ? undefined : 'large'}
        type={'primary'}
        onClick={async () => {
          await copyToClipboard(content);
          message.success(t('copySuccess', { ns: 'common' }));
        }}
      >
        {t('copy', { ns: 'common' })}
      </Button>
      <Button
        block
        size={isMobile ? undefined : 'large'}
        onClick={() => {
          exportFile(content, `${title}.md`);
        }}
      >
        {t('shareModal.downloadFile')}
      </Button>
      {spreadsheetRows && (
        <Button
          block
          size={isMobile ? undefined : 'large'}
          onClick={() => {
            downloadXlsxFile(spreadsheetRows, `${title}.xlsx`, title);
            message.success(t('shareModal.downloadSuccess'));
          }}
        >
          XLSX
        </Button>
      )}
      {spreadsheetRows && (
        <Button
          block
          loading={attachingSpreadsheet}
          size={isMobile ? undefined : 'large'}
          onClick={async () => {
            setAttachingSpreadsheet(true);

            try {
              const result = await messageService.createSpreadsheetFile(spreadsheetTarget.id, {
                ...context,
                filename: title,
              });

              if (result.messages) {
                (replaceMessages as any)(result.messages, { context });
              }

              message.success(t('shareModal.attachSpreadsheetSuccess'));
            } catch {
              message.error(t('shareModal.attachSpreadsheetError'));
            } finally {
              setAttachingSpreadsheet(false);
            }
          }}
        >
          {t('shareModal.attachSpreadsheet')}
        </Button>
      )}
    </>
  );

  return (
    <>
      <Flexbox className={styles.body} gap={16} horizontal={!isMobile}>
        <Preview content={content} />
        <Flexbox className={styles.sidebar} gap={12}>
          {!isMobile && button}
        </Flexbox>
      </Flexbox>
      {isMobile && (
        <Flexbox horizontal className={styles.footer} gap={8}>
          {button}
        </Flexbox>
      )}
    </>
  );
});

export default ShareText;
