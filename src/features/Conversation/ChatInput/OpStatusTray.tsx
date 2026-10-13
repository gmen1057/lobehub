'use client';

import { Flexbox } from '@lobehub/ui';
import { createStaticStyles } from 'antd-style';
import { memo, useEffect, useMemo, useState } from 'react';

import { useChatStore } from '@/store/chat';
import { operationSelectors } from '@/store/chat/selectors';

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

const LINGER_MS = 8000;

// arckep: the tray used to also show "N ₽ уже списано" (live topic spend); the owner asked to remove
// the cost from the chat window on 2026-10-13. Spend stays in Image Studio billing and the
// site auto-continue budget check (sitesAutoContinue.ts) still reads /api/arckep/topic-spend.

const OpStatusTray = memo(() => {
  const context = useConversationStore((s) => s.context);
  const isGenerating = useChatStore((s) =>
    operationSelectors.isAgentRuntimeRunningByContext(context)(s),
  );
  const trayHint = useChatStore((s) => {
    const hit = operationSelectors
      .getCurrentContextOperations(s)
      .find((op) => op.status === 'running' && typeof op.metadata?.trayHint === 'string');
    return hit?.metadata.trayHint as string | undefined;
  });
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

  const visible = isGenerating || linger || Boolean(trayHint);

  useEffect(() => {
    if (!visible) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [visible]);

  const elapsed = useMemo(
    () => (startedAt ? formatElapsed(now - startedAt) : '0:00'),
    [now, startedAt],
  );

  if (!visible) return null;

  return (
    <Flexbox horizontal align="center" className={styles.container} gap={12}>
      <span className={styles.metric}>{elapsed}</span>
      {trayHint ? <span className={styles.metric}>{trayHint}</span> : null}
    </Flexbox>
  );
});

OpStatusTray.displayName = 'OpStatusTray';

export default OpStatusTray;
