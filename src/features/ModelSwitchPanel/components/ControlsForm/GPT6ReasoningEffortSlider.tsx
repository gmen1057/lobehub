import { type CreatedLevelSliderProps } from './createLevelSlider';
import { createLevelSliderComponent } from './createLevelSlider';

// OpenAI GPT-6 Astra: low | medium | high | xhigh | max. No `none`.
const GPT6_REASONING_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
type GPT6ReasoningEffort = (typeof GPT6_REASONING_EFFORT_LEVELS)[number];

export type GPT6ReasoningEffortSliderProps = CreatedLevelSliderProps<GPT6ReasoningEffort>;

const GPT6ReasoningEffortSlider = createLevelSliderComponent<GPT6ReasoningEffort>({
  configKey: 'gpt6ReasoningEffort',
  defaultValue: 'medium',
  levels: GPT6_REASONING_EFFORT_LEVELS,
  style: { minWidth: 230 },
});

export default GPT6ReasoningEffortSlider;
