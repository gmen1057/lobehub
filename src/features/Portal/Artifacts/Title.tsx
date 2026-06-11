import { ArtifactType } from '@lobechat/types';
import { ActionIcon, Flexbox, Icon, Segmented, Text } from '@lobehub/ui';
import { App, ConfigProvider } from 'antd';
import { cx } from 'antd-style';
import { ArrowLeft, CodeIcon, EyeIcon, FileText, Globe, ImageIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useChatStore } from '@/store/chat';
import { chatPortalSelectors, messageStateSelectors } from '@/store/chat/selectors';
import { ArtifactDisplayMode } from '@/store/chat/slices/portal/initialState';
import { oneLineEllipsis } from '@/styles';

const SVG_MIME = 'image/svg+xml';
const HTML_MIME = 'text/html';
const REACT_MIME = 'application/lobe.artifacts.react';

const wrapAsHtml = (code: string, type: string | undefined): string => {
  if (type === HTML_MIME) return code;
  if (type === SVG_MIME) {
    return `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:#fff}svg{display:block;margin:auto;max-width:100%;max-height:100vh}</style></head><body>${code}</body></html>`;
  }
  if (type === REACT_MIME) {
    // Render React component via the existing UMD pipeline. Best-effort:
    // wrap in HTML doc + React + ReactDOM CDN. JS execution happens inside
    // the render-v1 sandbox Chromium (trusted, model-generated).
    return `<!doctype html><html><head><meta charset="utf-8"><script crossorigin src="https://unpkg.com/react@18/umd/react.production.min.js"></script><script crossorigin src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script><script src="https://unpkg.com/@babel/standalone/babel.min.js"></script><style>html,body{margin:0;padding:16px;background:#fff;font-family:system-ui,sans-serif}</style></head><body><div id="root"></div><script type="text/babel">${code}\n;ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(typeof App!=='undefined'?App:typeof Component!=='undefined'?Component:()=>'No default export'));</script></body></html>`;
  }
  // Fallback: plaintext wrapped in <pre>
  return `<!doctype html><html><body><pre>${code.replaceAll('<', '&lt;')}</pre></body></html>`;
};

// Republish the same artifact → new version of the same site (not a new site).
// The site_id returned by the first publish is remembered per message id.
const siteIdKey = (messageId: string) => `arckep-site:${messageId}`;

interface PublishResponse {
  site_id: number;
  slug: string;
  url: string;
  version: number;
}

const Title = () => {
  const { t } = useTranslation('portal');
  const { message, modal } = App.useApp();
  const [exporting, setExporting] = useState<'idle' | 'pdf' | 'png'>('idle');
  const [publishing, setPublishing] = useState(false);

  const [
    displayMode,
    artifactType,
    artifactTitle,
    isArtifactTagClosed,
    closeArtifact,
    artifactCode,
    isMessageGenerating,
    messageId,
    topicId,
  ] = useChatStore((s) => {
    const mid = chatPortalSelectors.artifactMessageId(s) || '';
    const identifier = chatPortalSelectors.artifactIdentifier(s);

    return [
      s.portalArtifactDisplayMode,
      chatPortalSelectors.artifactType(s),
      chatPortalSelectors.artifactTitle(s),
      chatPortalSelectors.isArtifactTagClosed(mid, identifier)(s),
      s.closeArtifact,
      chatPortalSelectors.artifactCode(mid, identifier)(s),
      messageStateSelectors.isMessageGenerating(mid)(s),
      mid,
      s.activeTopicId,
    ];
  });

  // show switch only when artifact is closed and the type is not code
  const showSwitch = isArtifactTagClosed && artifactType !== ArtifactType.Code;

  // Export only fully-renderable artifacts (HTML/SVG) after generation finished.
  // React artifacts use UMD <script src=...> wrappers that the render-v1
  // sandbox strips for safety, so PDF/PNG come out blank — hide buttons until
  // a local React compile path lands. Code-mode is also non-visual.
  const exportable =
    isArtifactTagClosed &&
    !isMessageGenerating &&
    artifactType !== ArtifactType.Code &&
    artifactType !== ArtifactType.React &&
    !!artifactCode &&
    artifactCode.length > 0 &&
    artifactCode.length <= 500_000;

  // Publish makes sense only for full HTML documents (landing pages),
  // not SVG/React/code artifacts.
  const publishable = exportable && artifactType === HTML_MIME;

  const requestPublish = async (siteId: number | undefined) =>
    fetch('/chat/api/site-publish', {
      body: JSON.stringify({
        html: artifactCode,
        site_id: siteId,
        title: artifactTitle || undefined,
      }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });

  const handlePublish = async () => {
    if (publishing || !artifactCode || !messageId) return;
    setPublishing(true);
    try {
      const storedId = Number(localStorage.getItem(siteIdKey(messageId))) || undefined;
      let res = await requestPublish(storedId);
      if (res.status === 404 && storedId) {
        // Site was deleted or belongs to another account — publish as a new one.
        localStorage.removeItem(siteIdKey(messageId));
        res = await requestPublish(undefined);
      }
      if (!res.ok) {
        const err = await res.text();
        throw new Error(err || `HTTP ${res.status}`);
      }
      const data = (await res.json()) as PublishResponse;
      localStorage.setItem(siteIdKey(messageId), String(data.site_id));
      modal.success({
        content: (
          <div>
            <a href={data.url} rel="noopener noreferrer" target="_blank">
              {data.url}
            </a>
            {data.version > 1 && (
              <div style={{ marginTop: 8, opacity: 0.65 }}>
                Обновлена версия {data.version} существующего сайта.
              </div>
            )}
            <div style={{ marginTop: 8, opacity: 0.65 }}>
              Сайт открывается через ~30 секунд после первой публикации (выпускается сертификат).
            </div>
          </div>
        ),
        okText: 'Скопировать ссылку',
        onOk: () => {
          navigator.clipboard?.writeText(data.url);
          message.success('Ссылка скопирована');
        },
        title: 'Сайт опубликован',
      });
    } catch (error) {
      message.error(
        `Не удалось опубликовать: ${error instanceof Error ? error.message : 'unknown'}`,
      );
    } finally {
      setPublishing(false);
    }
  };

  const handleExport = async (format: 'pdf' | 'png') => {
    if (exporting !== 'idle' || !artifactCode) return;
    setExporting(format);
    try {
      const html = wrapAsHtml(artifactCode, artifactType);
      const res = await fetch('/chat/api/artifact-export', {
        body: JSON.stringify({ format, html, message_id: messageId, topic_id: topicId }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      });
      if (!res.ok) {
        const err = await res.text();
        throw new Error(err || `HTTP ${res.status}`);
      }
      const data = (await res.json()) as { url: string };
      window.open(data.url, '_blank', 'noopener,noreferrer');
    } catch (error) {
      message.error(`Export failed: ${error instanceof Error ? error.message : 'unknown'}`);
    } finally {
      setExporting('idle');
    }
  };

  return (
    <Flexbox horizontal align={'center'} flex={1} gap={12} justify={'space-between'} width={'100%'}>
      <Flexbox horizontal align={'center'} gap={4}>
        <ActionIcon icon={ArrowLeft} size={'small'} onClick={() => closeArtifact()} />
        <Text className={cx(oneLineEllipsis)} type={'secondary'}>
          {artifactTitle}
        </Text>
      </Flexbox>
      <Flexbox horizontal align={'center'} gap={4}>
        {publishable && (
          <ActionIcon
            icon={Globe}
            loading={publishing}
            size={'small'}
            title={'Опубликовать сайт'}
            onClick={handlePublish}
          />
        )}
        {exportable && (
          <>
            <ActionIcon
              icon={FileText}
              loading={exporting === 'pdf'}
              size={'small'}
              title={'Скачать PDF'}
              onClick={() => handleExport('pdf')}
            />
            <ActionIcon
              icon={ImageIcon}
              loading={exporting === 'png'}
              size={'small'}
              title={'Скачать PNG'}
              onClick={() => handleExport('png')}
            />
          </>
        )}
      </Flexbox>
      <ConfigProvider
        theme={{
          token: {
            borderRadiusSM: 16,
            borderRadiusXS: 16,
            fontSize: 12,
          },
        }}
      >
        {showSwitch && (
          <Segmented
            size={'small'}
            value={displayMode}
            options={[
              {
                icon: <Icon icon={EyeIcon} />,
                label: t('artifacts.display.preview'),
                value: ArtifactDisplayMode.Preview,
              },
              {
                icon: <Icon icon={CodeIcon} />,
                label: t('artifacts.display.code'),
                value: ArtifactDisplayMode.Code,
              },
            ]}
            onChange={(value) => {
              useChatStore.setState({ portalArtifactDisplayMode: value as ArtifactDisplayMode });
            }}
          />
        )}
      </ConfigProvider>
    </Flexbox>
  );
};

export default Title;
