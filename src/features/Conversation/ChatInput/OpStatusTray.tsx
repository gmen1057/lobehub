'use client';

import { Flexbox } from '@lobehub/ui';
import { createStaticStyles } from 'antd-style';
import { memo, useEffect, useMemo, useState } from 'react';
import useSWR from 'swr';

import { useChatStore } from '@/store/chat';
import { operationSelectors } from '@/store/chat/selectors';
import { useSessionStore } from '@/store/session';

import { useConversationStore } from '../store';

const styles = createStaticStyles(({ css, cssVar }) => ({
  container: css`
    padding-block: 8px;
    padding-inline: 14px;
    border: 1px solid ${cssVar.colorFillSecondary};
    border-block-end: none;
    border-start-start-radius: 12px;
    border-start-end-radius: 12px;

    font-size: 12px;
    color: ${cssVar.colorTextSecondary};

    background: ${cssVar.colorBgElevated};
  `,
  metric: css`
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  `,
}));

const formatElapsed = (ms: number) => {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${String(sec).padStart(2, '0')}`;
};

const fetchSpend = async (url: string) => {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`topic-spend ${res.status}`);
  return (await res.json()) as { cost_rub: number | null; labeled: boolean };
};

const LINGER_MS = 8000;

const OpStatusTray = memo(() => {
  const context = useConversationStore((s) => s.context);
  const sessionId = useSessionStore((s) => s.activeId);
  const isGenerating = useChatStore((s) =>
    operationSelectors.isAgentRuntimeRunningByContext(context)(s),
  );
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [linger, setLinger] = useState(false);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (isGenerating) {
      setStartedAt((prev) => prev ?? Date.now());
      setLinger(false);
      return;
    }
    if (!startedAt) return;
    setLinger(true);
    const t = window.setTimeout(() => {
      setLinger(false);
      setStartedAt(null);
    }, LINGER_MS);
    return () => window.clearTimeout(t);
  }, [isGenerating, startedAt]);

  const visible = isGenerating || linger;

  useEffect(() => {
    if (!visible) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [visible]);

  const spendKey =
    visible && sessionId && context.topicId
      ? `/chat/api/arckep/topic-spend?session_id=${encodeURIComponent(sessionId)}&topic_id=${encodeURIComponent(context.topicId)}`
      : null;

  const { data, error } = useSWR(spendKey, fetchSpend, {
    refreshInterval: 3000,
    revalidateOnFocus: false,
    shouldRetryOnError: false,
  });

  const elapsed = useMemo(
    () => (startedAt ? formatElapsed(now - startedAt) : '0:00'),
    [now, startedAt],
  );

  if (!visible) return null;

  let costLabel = 'считаем ₽…';
  if (error) costLabel = 'не удалось получить сумму';
  else if (data && data.labeled === false) costLabel = 'нет данных по списаниям';
  else if (data?.labeled && typeof data.cost_rub === 'number') {
    costLabel = `${data.cost_rub.toFixed(2)} ₽ уже списано`;
  }

  return (
    <Flexbox horizontal align="center" className={styles.container} gap={12}>
      <span className={styles.metric}>{elapsed}</span>
      <span className={styles.metric}>{costLabel}</span>
    </Flexbox>
  );
});

OpStatusTray.displayName = 'OpStatusTray';

export default OpStatusTray;
