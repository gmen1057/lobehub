'use client';

import { Flexbox, Icon, Text } from '@lobehub/ui';
import { cssVar } from 'antd-style';
import { Blocks } from 'lucide-react';
import { memo, useCallback } from 'react';

import { useChatStore } from '@/store/chat';

import AlsoCan from './AlsoCan';
import { ARCKEP_CAPABILITY_CUBES } from './catalog';
import CapabilityCubes from './Cubes';

const HomePanel = memo(() => {
  const mainInputEditor = useChatStore((s) => s.mainInputEditor);

  const handleSelect = useCallback(
    (prompt: string) => {
      mainInputEditor?.instance?.setDocument('markdown', prompt);
      mainInputEditor?.focus();
    },
    [mainInputEditor],
  );

  return (
    <Flexbox gap={16}>
      <Flexbox horizontal align={'center'} gap={8}>
        <Icon color={cssVar.colorTextDescription} icon={Blocks} size={18} />
        <Text color={cssVar.colorTextSecondary}>Что умею</Text>
      </Flexbox>
      <CapabilityCubes cubes={ARCKEP_CAPABILITY_CUBES} onSelect={handleSelect} />
      <AlsoCan />
    </Flexbox>
  );
});

HomePanel.displayName = 'ArckepHomeCapabilities';

export default HomePanel;
