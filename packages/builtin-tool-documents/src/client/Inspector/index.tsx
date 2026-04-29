'use client';

import type { BuiltinInspectorProps } from '@lobechat/types';
import { createStaticStyles, cssVar, cx } from 'antd-style';
import { Check, FileText, X } from 'lucide-react';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { highlightTextStyles, inspectorTextStyles, shinyTextStyles } from '@/styles';

import type { GenerateDocumentInput, GenerateDocumentState } from '../../types';

const documentsApiNameKey = 'builtins.lobe-documents.apiName.generateDocument';

const styles = createStaticStyles(({ css }) => ({
  icon: css`
    margin-block-end: -2px;
    margin-inline-end: 4px;
  `,
  statusIcon: css`
    margin-block-end: -2px;
    margin-inline-start: 4px;
  `,
}));

export const GenerateDocumentInspector = memo<
  BuiltinInspectorProps<GenerateDocumentInput, GenerateDocumentState>
>(({ args, partialArgs, isArgumentsStreaming, pluginState, isLoading }) => {
  const { t } = useTranslation('plugin');
  const format = args?.format ?? partialArgs?.format;
  const filename = args?.filename ?? partialArgs?.filename;
  // The locale JSON is added manually; typegen is handled later by CI.
  const label = t(documentsApiNameKey as any) as string;

  return (
    <div
      className={cx(
        inspectorTextStyles.root,
        (isArgumentsStreaming || isLoading) && shinyTextStyles.shinyText,
      )}
    >
      <FileText className={styles.icon} size={14} />
      <span>{label}</span>
      {format && <span className={highlightTextStyles.gold}> {format.toUpperCase()}</span>}
      {filename && <span className={highlightTextStyles.primary}>: {filename}</span>}
      {!isArgumentsStreaming && !isLoading && pluginState?.status ? (
        pluginState.status === 'success' ? (
          <Check className={styles.statusIcon} color={cssVar.colorSuccess} size={14} />
        ) : (
          <X className={styles.statusIcon} color={cssVar.colorError} size={14} />
        )
      ) : null}
    </div>
  );
});

GenerateDocumentInspector.displayName = 'GenerateDocumentInspector';

export const DocumentsInspectors = {
  generateDocument: GenerateDocumentInspector,
};
