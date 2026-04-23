import { type CreatedLevelSliderProps } from './createLevelSlider';
import { createLevelSliderComponent } from './createLevelSlider';

const OPENAI_IMAGE_QUALITY_LEVELS = ['auto', 'low', 'medium', 'high'] as const;

type OpenAIImageQuality = (typeof OPENAI_IMAGE_QUALITY_LEVELS)[number];

export type OpenAIImageQualitySliderProps = CreatedLevelSliderProps<OpenAIImageQuality>;

const OpenAIImageQualitySlider = createLevelSliderComponent<OpenAIImageQuality>({
  configKey: 'openaiImageQuality',
  defaultValue: 'auto',
  levels: OPENAI_IMAGE_QUALITY_LEVELS,
  style: { minWidth: 220 },
});

export default OpenAIImageQualitySlider;
