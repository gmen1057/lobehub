import { type UIChatMessage } from '@lobechat/types';
import { describe, expect, it, vi } from 'vitest';

import { scheduleSavedAnswerPull } from './pullSavedAnswer';

const message = (content: string): UIChatMessage =>
  ({ content, id: 'msg_1', role: 'assistant' }) as UIChatMessage;

describe('scheduleSavedAnswerPull', () => {
  it('shows the server answer when the screen is still empty', async () => {
    const applied: string[] = [];
    let local = '...';

    scheduleSavedAnswerPull({
      apply: (item) => {
        applied.push(item.content);
        local = item.content;
      },
      delaysMs: [0],
      load: async () => [message('Готовый ответ')],
      localContent: () => local,
      messageId: 'msg_1',
      sleep: () => Promise.resolve(),
    });

    await vi.waitFor(() => {
      expect(applied).toEqual(['Готовый ответ']);
    });
  });

  it('asks once more if the first read is still three dots', async () => {
    const loads = [[message('...')], [message('Готово')]];
    const applied: string[] = [];
    let local = '...';

    scheduleSavedAnswerPull({
      apply: (item) => {
        applied.push(item.content);
        local = item.content;
      },
      delaysMs: [0, 0],
      load: async () => loads.shift() ?? [],
      localContent: () => local,
      messageId: 'msg_1',
      sleep: () => Promise.resolve(),
    });

    await vi.waitFor(() => {
      expect(applied).toEqual(['Готово']);
    });
    expect(loads).toHaveLength(0);
  });

  it('does not replace text the screen already shows', async () => {
    const load = vi.fn(async () => [message('с сервера')]);

    scheduleSavedAnswerPull({
      apply: () => {
        throw new Error('should not apply');
      },
      delaysMs: [0],
      load,
      localContent: () => 'уже на экране',
      messageId: 'msg_1',
      sleep: () => Promise.resolve(),
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(load).not.toHaveBeenCalled();
  });
});
