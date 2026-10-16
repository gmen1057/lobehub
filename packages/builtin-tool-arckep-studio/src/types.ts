export const ArckepStudioIdentifier = 'arckep-studio';

export enum ArckepStudioApiName {
  createImage = 'createImage',
  createSpeech = 'createSpeech',
  estimateImage = 'estimateImage',
  getBalance = 'getBalance',
  getImage = 'getImage',
  listImageModels = 'listImageModels',
}

/** What the model may choose for a picture; everything else is the studio default of the model. */
export interface ImageOptions {
  aspect_ratio?: string;
  model?: string;
  num_images?: number;
  quality?: string;
  resolution?: string;
  thinking?: boolean;
}

export type EstimateImageParams = ImageOptions;

export interface CreateImageParams extends ImageOptions {
  /** Refuse when the price is higher (the user named a limit), ₽. */
  max_cost_rub?: number;
  prompt: string;
}

export interface GetImageParams {
  generation_id: number;
}

export interface ListImageModelsParams {}

export interface GetBalanceParams {}

export interface CreateSpeechParams {
  /** How to read: tone, pace, mood (free text). */
  style?: string;
  text: string;
  /** Prebuilt voice name (default Kore). */
  voice_id?: string;
}

export type StudioJobStatus = 'queued' | 'processing' | 'completed' | 'failed';

export interface EstimateImageResult {
  allowed: boolean;
  balance_rub: number;
  discount_pct: number;
  enough_balance: boolean;
  is_upper_bound: boolean;
  issues: string[];
  list_price_rub: number | null;
  model: string;
  params: Record<string, unknown>;
  price_rub: number;
}

export interface ImageJobResult {
  error: string | null;
  generation_id: number;
  model: string;
  /** Held/charged price of the job; 0 when it failed (the hold is refunded). */
  price_rub: number;
  status: StudioJobStatus;
  url: string | null;
  urls: string[];
}

export interface ImageModelItem {
  aspect_ratios: string[] | null;
  id: string;
  is_default: boolean;
  max_images: number | null;
  name: string;
  price_rub: number;
  quality_levels: string[] | null;
  resolutions: string[] | null;
  supports_thinking: boolean | null;
}

export interface ListImageModelsResult {
  default_model: string;
  models: ImageModelItem[];
}

export interface BalanceResult {
  balance_rub: number;
  corporate_name: string | null;
  is_corporate: boolean;
}

export interface SpeechResult {
  audio_url: string;
  charged_from: string;
  model: string;
  price_rub: number;
  speech_id: number;
  status: 'completed';
  voice_id: string;
}
