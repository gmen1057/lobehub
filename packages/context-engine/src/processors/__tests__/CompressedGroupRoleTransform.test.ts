import { describe, expect, it } from 'vitest';

import type { PipelineContext } from '../../types';
import { CompressedGroupRoleTransformProcessor } from '../CompressedGroupRoleTransform';

const FILE_ID = '849f7fc2-dd0e-4b18-9aa8-aab327c49b30';

describe('CompressedGroupRoleTransformProcessor', () => {
  const createContext = (messages: any[]): PipelineContext => ({
    initialState: {
      messages: [],
      model: 'deepseek-flash',
      provider: 'deepseek',
    },
    isAborted: false,
    messages,
    metadata: {
      maxTokens: 128_000,
      model: 'deepseek-flash',
    },
  });

  it('rewrites saved code-artifact tags inside existing compressedGroup summaries before wrapping for LLM', async () => {
    const processor = new CompressedGroupRoleTransformProcessor();
    const rawSummary = `Earlier assistant delivered Part 1:\n<lobeArtifact type="application/lobe.artifacts.code" identifier="code-vb-1" title="Module1.bas" language="vb" src="/chat/code-artifact/${FILE_ID}/"></lobeArtifact>`;
    const originalMsg = {
      content: rawSummary,
      id: 'grp-1',
      role: 'compressedGroup',
      topicId: 'tpc-1',
    };

    const result = await processor.process(createContext([originalMsg]));

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe('user');
    expect(result.messages[0].content).toContain('<compressed_history_summary>');
    expect(result.messages[0].content).toContain(
      `[Saved "Module1.bas" (vb), fileId=${FILE_ID} — previous code block stored by server. Use getTopicContext(mode="code_artifacts", fileId="${FILE_ID}") if you need to inspect it.]`,
    );
    expect(result.messages[0].content).not.toContain('<lobeArtifact');
    expect(result.messages[0].content).not.toContain('/chat/code-artifact/');
    // Original message object is untouched
    expect(originalMsg.content).toBe(rawSummary);
  });

  it('keeps HTML artifact tags inside summaries intact', async () => {
    const processor = new CompressedGroupRoleTransformProcessor();
    const htmlTag =
      '<lobeArtifact identifier="calc" type="text/html" title="Calc" src="/chat/f/file_1/"></lobeArtifact>';

    const result = await processor.process(
      createContext([{ content: `Built ${htmlTag}`, id: 'grp-2', role: 'compressedGroup' }]),
    );

    expect(result.messages[0].content).toContain(htmlTag);
  });
});
