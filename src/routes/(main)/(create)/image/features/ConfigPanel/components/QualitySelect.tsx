import { Select } from '@lobehub/ui';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { useGenerationConfigParam } from '@/store/image/slices/generationConfig/hooks';

const qualityOptionLabelKeys = {
  auto: 'config.quality.options.auto',
  hd: 'config.quality.options.hd',
  high: 'config.quality.options.high',
  low: 'config.quality.options.low',
  medium: 'config.quality.options.medium',
  standard: 'config.quality.options.standard',
} as const;

const QualitySelect = memo(() => {
  const { t } = useTranslation('image');
  const { value, setValue, enumValues } = useGenerationConfigParam('quality');

  const options =
    enumValues?.map((quality) => ({
      label: qualityOptionLabelKeys[quality as keyof typeof qualityOptionLabelKeys]
        ? t(qualityOptionLabelKeys[quality as keyof typeof qualityOptionLabelKeys])
        : quality,
      value: quality,
    })) ?? [];

  return <Select options={options} style={{ width: '100%' }} value={value} onChange={setValue} />;
});

export default QualitySelect;
