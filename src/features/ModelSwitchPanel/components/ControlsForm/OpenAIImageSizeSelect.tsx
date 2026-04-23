import { Select } from 'antd';
import { memo, useMemo } from 'react';

import { useAgentId } from '@/features/ChatInput/hooks/useAgentId';
import { useUpdateAgentConfig } from '@/features/ChatInput/hooks/useUpdateAgentConfig';
import { useAgentStore } from '@/store/agent';
import { chatConfigByIdSelectors } from '@/store/agent/selectors';

const OPENAI_IMAGE_SIZES = ['auto', '1024x1024', '1024x1536', '1536x1024'] as const;

type OpenAIImageSize = (typeof OPENAI_IMAGE_SIZES)[number];

export interface OpenAIImageSizeSelectProps {
  defaultValue?: OpenAIImageSize;
  onChange?: (value: OpenAIImageSize) => void;
  value?: OpenAIImageSize;
}

const OpenAIImageSizeSelectInner = memo<{
  onChange: (_value: OpenAIImageSize) => void;
  value: OpenAIImageSize;
}>(({ value, onChange }) => {
  const options = useMemo(
    () =>
      OPENAI_IMAGE_SIZES.map((size) => ({
        label: size,
        value: size,
      })),
    [],
  );

  return (
    <Select
      options={options}
      style={{ height: 32, marginRight: 10, minWidth: 120 }}
      value={value}
      onChange={(v: string) => onChange(v as OpenAIImageSize)}
    />
  );
});

const OpenAIImageSizeSelectWithStore = memo<{ defaultValue: OpenAIImageSize }>(
  ({ defaultValue }) => {
    const agentId = useAgentId();
    const { updateAgentChatConfig } = useUpdateAgentConfig();
    const config = useAgentStore((s) => chatConfigByIdSelectors.getChatConfigById(agentId)(s));

    const storeValue = (config.openaiImageSize as OpenAIImageSize) || defaultValue;

    const handleChange = (size: OpenAIImageSize) => {
      updateAgentChatConfig({ openaiImageSize: size });
    };

    return <OpenAIImageSizeSelectInner value={storeValue} onChange={handleChange} />;
  },
);

const OpenAIImageSizeSelect = memo<OpenAIImageSizeSelectProps>(
  ({ value: controlledValue, onChange: controlledOnChange, defaultValue = 'auto' }) => {
    const isControlled = controlledValue !== undefined || controlledOnChange !== undefined;

    if (isControlled) {
      return (
        <OpenAIImageSizeSelectInner
          value={controlledValue ?? defaultValue}
          onChange={controlledOnChange ?? (() => {})}
        />
      );
    }

    return <OpenAIImageSizeSelectWithStore defaultValue={defaultValue} />;
  },
);

export default OpenAIImageSizeSelect;
