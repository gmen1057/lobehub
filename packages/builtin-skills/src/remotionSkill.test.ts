import { describe, expect, it } from 'vitest';

import { builtinSkills, RemotionVideoIdentifier } from './index';

describe('Remotion Video встроенный навык (arckep)', () => {
  const skill = builtinSkills.find((s) => s.identifier === RemotionVideoIdentifier)!;

  it('присутствует в списке встроенных навыков с описанием на русском', () => {
    expect(skill).toBeDefined();
    expect(skill.name).toBe('Remotion Video');
    expect(skill.source).toBe('builtin');
    expect(skill.description.length).toBeLessThanOrEqual(200);
    expect(skill.description).toMatch(/\p{Script=Cyrillic}/u);
  });

  it('содержит корневые справочники разделов Remotion и все упомянутые в инструкции руководства', () => {
    const required = [
      'remotion-create/REFERENCE.md',
      'remotion-create/video-layout.md',
      'remotion-markup/REFERENCE.md',
      'remotion-markup/timing.md',
      'remotion-markup/transitions.md',
      'remotion-markup/text-highlights.md',
      'remotion-markup/embedding-videos.md',
      'remotion-captions/REFERENCE.md',
      'remotion-captions/display-captions.md',
      'remotion-maps/REFERENCE.md',
      'remotion-multimedia/REFERENCE.md',
      'remotion-interactivity/REFERENCE.md',
      'remotion-render/REFERENCE.md',
    ];
    for (const path of required) {
      expect(skill.resources?.[path]?.content, path).toBeTruthy();
      expect(skill.resources?.[path]?.size).toBeGreaterThan(100);
    }

    const mentionedRefs = [...skill.content.matchAll(/`(remotion-[a-z-]+\/[^`]+\.md)`/g)].map(
      (m) => m[1],
    );
    expect(mentionedRefs.length).toBeGreaterThan(10);
    for (const refPath of mentionedRefs) {
      expect(skill.resources?.[refPath]?.content, `Упомянутый путь ${refPath}`).toBeTruthy();
    }
  });

  it('инструкция описывает /workspace/project, preview.mjs, render.mjs и артефакт предпросмотра', () => {
    expect(skill.content).toContain('/workspace/project');
    expect(skill.content).toContain('node /opt/remotion/runtime/preview.mjs');
    expect(skill.content).toContain('node /opt/remotion/runtime/render.mjs');
    expect(skill.content).toContain('<lobeArtifact identifier="remotion-preview"');
    expect(skill.content).toContain('exportFile');
  });
});
