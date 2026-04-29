'use client';

import type { BuiltinRenderProps } from '@lobechat/types';
import { ActionIcon, Block, Flexbox, Text } from '@lobehub/ui';
import { createStaticStyles } from 'antd-style';
import { Download, FileText } from 'lucide-react';
import { memo } from 'react';

import type { GenerateDocumentInput, GenerateDocumentState } from '../../types';

const styles = createStaticStyles(({ css, cssVar }) => ({
  card: css`
    overflow: hidden;
    padding-block: 10px;
    padding-inline: 12px;
  `,
  icon: css`
    flex-shrink: 0;
    color: ${cssVar.colorTextSecondary};
  `,
}));

const formatSize = (size?: number) => {
  if (!size) return '';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
};

const GenerateDocumentRender = memo<
  BuiltinRenderProps<GenerateDocumentInput, GenerateDocumentState>
>(({ args, pluginState }) => {
  if (!pluginState || pluginState.status !== 'success') return null;

  const filename = pluginState.filename ?? `${args.filename}.${args.format}`;

  return (
    <Block className={styles.card} variant={'outlined'}>
      <Flexbox horizontal align={'center'} gap={10} justify={'space-between'}>
        <Flexbox horizontal align={'center'} gap={8} style={{ minWidth: 0 }}>
          <FileText className={styles.icon} size={18} />
          <Flexbox gap={2} style={{ minWidth: 0 }}>
            <Text ellipsis strong as={'span'} fontSize={13}>
              {filename}
            </Text>
            <Text as={'span'} fontSize={12} type={'secondary'}>
              {args.format.toUpperCase()} {formatSize(pluginState.size)}
            </Text>
          </Flexbox>
        </Flexbox>
        {pluginState.url ? (
          <ActionIcon
            icon={Download}
            size={'small'}
            title={'Download'}
            onClick={() => window.open(pluginState.url, '_blank', 'noopener,noreferrer')}
          />
        ) : null}
      </Flexbox>
    </Block>
  );
});

GenerateDocumentRender.displayName = 'GenerateDocumentRender';

export const DocumentsRenders = {
  generateDocument: GenerateDocumentRender,
};
