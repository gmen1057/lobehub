import { ArtifactType } from '@lobechat/types';
import { ActionIcon, Flexbox, Icon, Segmented, Text } from '@lobehub/ui';
import { App, Button, ConfigProvider, Input, Modal } from 'antd';
import { cx } from 'antd-style';
import { ArrowLeft, CodeIcon, EyeIcon, FileText, Globe, ImageIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useChatStore } from '@/store/chat';
import { chatPortalSelectors, messageStateSelectors } from '@/store/chat/selectors';
import { ArtifactDisplayMode } from '@/store/chat/slices/portal/initialState';
import { useSessionStore } from '@/store/session';
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
// The site_id of the first publish is remembered per CONVERSATION (session +
// topic), so any later edit the agent produces — a new message — still
// republishes to the same address/domain instead of asking again.
const siteIdKey = (conversationId: string) => `arckep-site:${conversationId}`;
// Legacy per-message key (pre-2026-06-13): read as a fallback so sites
// published mid-conversation before the upgrade stay linked.
const legacyMessageKey = (messageId: string) => `arckep-site:${messageId}`;

// «Править с агентом» on arckep.ru opens the chat with the site's slug stashed
// here by src/initialize.ts. Used to bind the publish to the existing site.
const DEEPLINK_KEY = 'arckep-site-deeplink';

interface PublishResponse {
  site_id: number;
  slug: string;
  url: string;
  version: number;
}

// Map a known slug → the user's owned site_id via the «Мои сайты» list tool.
// Lets the first publish after an agent edit hit the existing site instead of
// trying to mint a new one on an already-taken address.
const resolveSiteIdBySlug = async (slug: string): Promise<number | undefined> => {
  try {
    const res = await fetch('/chat/api/sites-tool', {
      body: JSON.stringify({ action: 'list' }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });
    if (!res.ok) return undefined;
    const data = (await res.json()) as { sites?: Array<{ id: number; slug: string }> };
    return data.sites?.find((s) => s.slug === slug)?.id;
  } catch {
    return undefined;
  }
};

// Client-side preview of the address the backend would auto-generate from the
// title. The backend re-normalizes whatever we send — this is UX prefill only.
const TRANSLIT: Record<string, string> = {
  а: 'a',
  б: 'b',
  в: 'v',
  г: 'g',
  д: 'd',
  е: 'e',
  ё: 'e',
  ж: 'zh',
  з: 'z',
  и: 'i',
  й: 'y',
  к: 'k',
  л: 'l',
  м: 'm',
  н: 'n',
  о: 'o',
  п: 'p',
  р: 'r',
  с: 's',
  т: 't',
  у: 'u',
  ф: 'f',
  х: 'h',
  ц: 'ts',
  ч: 'ch',
  ш: 'sh',
  щ: 'sch',
  ъ: '',
  ы: 'y',
  ь: '',
  э: 'e',
  ю: 'yu',
  я: 'ya',
};

const slugifyPreview = (title: string): string =>
  title
    .toLowerCase()
    .split('')
    .map((ch) => TRANSLIT[ch] ?? ch)
    .join('')
    .replaceAll(/[^\da-z-]+/g, '-')
    .replaceAll(/-{2,}/g, '-')
    .replaceAll(/^-+|-+$/g, '')
    .slice(0, 40);

// Backend validation messages are English (project standard) — map the known
// slug errors to user-facing Russian.
const slugErrorRu = (raw: string): string | null => {
  if (raw.includes('already taken')) return 'Этот адрес уже занят — выберите другой.';
  if (raw.includes('reserved')) return 'Этот адрес зарезервирован — выберите другой.';
  if (raw.includes('at least 3'))
    return 'Адрес должен содержать минимум 3 символа: латинские буквы, цифры или дефис.';
  return null;
};

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

  const sessionId = useSessionStore((s) => s.activeId);
  // Stable per-conversation id: survives across the many messages an editing
  // session produces, unlike messageId. Falls back to a sane default for the
  // inbox/default-topic case.
  const conversationId = `${sessionId || 'inbox'}:${topicId || 'default'}`;

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

  const [addressModalOpen, setAddressModalOpen] = useState(false);
  const [address, setAddress] = useState('');
  const [addressError, setAddressError] = useState<string | null>(null);

  const requestPublish = async (siteId: number | undefined, slug: string | undefined) =>
    fetch('/chat/api/site-publish', {
      body: JSON.stringify({
        html: artifactCode,
        site_id: siteId,
        slug,
        title: artifactTitle || undefined,
      }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });

  const showPublished = (data: PublishResponse) => {
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
          <div style={{ marginTop: 8, opacity: 0.65 }}>
            Управлять сайтом (версии, откат, правки через агента) можно на странице{' '}
            <a href="https://arckep.ru/sites" rel="noopener noreferrer" target="_blank">
              «Мои сайты»
            </a>
            .
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
  };

  // First publish in a conversation opens the address dialog; every later edit
  // republishes the same site (address fixed at creation) without asking again.
  const handlePublishClick = async () => {
    if (publishing || !artifactCode || !messageId) return;
    const storedId =
      Number(localStorage.getItem(siteIdKey(conversationId))) ||
      Number(localStorage.getItem(legacyMessageKey(messageId))) ||
      undefined;
    if (storedId) {
      localStorage.setItem(siteIdKey(conversationId), String(storedId));
      void handlePublish(storedId, undefined);
      return;
    }
    // Entered via «Править с агентом» — bind to that existing site so the
    // republish keeps its address and any custom domain, no dialog.
    const deepLinkSlug = sessionStorage.getItem(DEEPLINK_KEY);
    if (deepLinkSlug) {
      setPublishing(true);
      const siteId = await resolveSiteIdBySlug(deepLinkSlug);
      setPublishing(false);
      if (siteId) {
        localStorage.setItem(siteIdKey(conversationId), String(siteId));
        void handlePublish(siteId, undefined);
        return;
      }
    }
    setAddress(slugifyPreview(artifactTitle || ''));
    setAddressError(null);
    setAddressModalOpen(true);
  };

  const handlePublish = async (siteId: number | undefined, slug: string | undefined) => {
    if (publishing || !artifactCode || !messageId) return;
    setPublishing(true);
    try {
      let res = await requestPublish(siteId, slug);
      if (res.status === 404 && siteId) {
        // Site was deleted or belongs to another account — publish as a new one.
        localStorage.removeItem(siteIdKey(conversationId));
        res = await requestPublish(undefined, slug);
      }
      if (!res.ok) {
        const raw = await res.text();
        let msg = raw || `HTTP ${res.status}`;
        try {
          msg = (JSON.parse(raw) as { message?: string }).message || msg;
        } catch {
          /* not JSON — keep raw */
        }
        const ru = slugErrorRu(msg);
        if (ru && addressModalOpen) {
          // Address problem — keep the dialog open so the user can fix it.
          setAddressError(ru);
          return;
        }
        throw new Error(ru || msg);
      }
      const data = (await res.json()) as PublishResponse;
      localStorage.setItem(siteIdKey(conversationId), String(data.site_id));
      setAddressModalOpen(false);
      showPublished(data);
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
      <Flexbox horizontal align={'center'} gap={6}>
        {publishable && (
          <Button
            icon={<Icon icon={Globe} />}
            loading={publishing}
            size={'small'}
            type={'primary'}
            onClick={() => void handlePublishClick()}
          >
            Опубликовать сайт
          </Button>
        )}
        {exportable && (
          <>
            <Button
              icon={<Icon icon={FileText} />}
              loading={exporting === 'pdf'}
              size={'small'}
              title={'Скачать как PDF-документ'}
              onClick={() => handleExport('pdf')}
            >
              PDF
            </Button>
            <Button
              icon={<Icon icon={ImageIcon} />}
              loading={exporting === 'png'}
              size={'small'}
              title={'Скачать как картинку PNG'}
              onClick={() => handleExport('png')}
            >
              PNG
            </Button>
          </>
        )}
      </Flexbox>
      <Modal
        cancelText={'Отмена'}
        confirmLoading={publishing}
        okText={'Опубликовать'}
        open={addressModalOpen}
        title={'Публикация сайта'}
        onCancel={() => setAddressModalOpen(false)}
        onOk={() => void handlePublish(undefined, address.trim() || undefined)}
      >
        <div style={{ marginBottom: 8 }}>
          Адрес, по которому откроется сайт. Можно оставить как есть или вписать свой (латинские
          буквы, цифры, дефис):
        </div>
        <Input
          autoFocus
          addonAfter={'.jhunterpro.ru'}
          placeholder={'адрес-сайта'}
          status={addressError ? 'error' : undefined}
          value={address}
          onPressEnter={() => void handlePublish(undefined, address.trim() || undefined)}
          onChange={(e) => {
            setAddress(e.target.value);
            setAddressError(null);
          }}
        />
        {addressError && <div style={{ color: '#ff4d4f', marginTop: 8 }}>{addressError}</div>}
        <div style={{ marginTop: 8, opacity: 0.65 }}>
          Если оставить поле пустым — адрес сгенерируется из названия автоматически. Изменить адрес
          после публикации нельзя.
        </div>
      </Modal>
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
