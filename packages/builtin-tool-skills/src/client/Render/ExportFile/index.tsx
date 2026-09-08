'use client';

import { CheckCircleFilled, CloseCircleFilled, DownloadOutlined } from '@ant-design/icons';
import type { BuiltinRenderProps } from '@lobechat/types';
import { ActionIcon, Flexbox, Text } from '@lobehub/ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { memo, useCallback } from 'react';

import type { ExportFileState } from '../../../types';

const styles = createStaticStyles(({ css }) => ({
  container: css`
    overflow: hidden;
    padding-inline: 8px 0;
  `,
  statusIcon: css`
    font-size: 12px;
  `,
}));

interface ExportFileParams {
  filename: string;
  path: string;
}

const ExportFile = memo<BuiltinRenderProps<ExportFileParams, ExportFileState>>(
  ({ args, pluginState }) => {
    const downloadUrl = pluginState?.url;
    const filename = pluginState?.filename || args.filename;
    const isSuccess = Boolean(downloadUrl);

    const handleDownload = useCallback(async () => {
      if (!downloadUrl || !filename) return;

      try {
        const response = await fetch(downloadUrl);
        const blob = await response.blob();
        const blobUrl = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = blobUrl;
        link.download = filename;
        document.body.append(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(blobUrl);
      } catch {
        window.open(downloadUrl, '_blank', 'noopener,noreferrer');
      }
    }, [downloadUrl, filename]);

    return (
      <Flexbox className={styles.container} gap={8}>
        <Flexbox horizontal align={'center'} gap={8}>
          {pluginState === undefined ? null : isSuccess ? (
            <CheckCircleFilled
              className={styles.statusIcon}
              style={{ color: cssVar.colorSuccess }}
            />
          ) : (
            <CloseCircleFilled className={styles.statusIcon} style={{ color: cssVar.colorError }} />
          )}
          <Text code as={'span'} fontSize={12}>
            {isSuccess ? `Exported: ${filename || args.path}` : `Failed to export ${args.path}`}
          </Text>
          {isSuccess && downloadUrl && (
            <ActionIcon
              icon={DownloadOutlined}
              size={'small'}
              title="Download"
              onClick={handleDownload}
            />
          )}
        </Flexbox>
      </Flexbox>
    );
  },
);

ExportFile.displayName = 'SkillsExportFile';

export default ExportFile;
