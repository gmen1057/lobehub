import { type BuiltinToolManifest } from '@lobechat/types';

import { systemPrompt } from './systemRole';
import { ArckepStudioApiName, ArckepStudioIdentifier } from './types';

const imageOptionProperties = {
  aspect_ratio: {
    description:
      "Aspect ratio like '1:1', '16:9', '9:16', '3:4'. Omit unless the user asked: the model's default is used. Unsupported values are rejected.",
    type: 'string',
  },
  model: {
    description:
      'Image model id from listImageModels. Omit to use the cheapest model of the catalog (the default).',
    type: 'string',
  },
  num_images: {
    description: 'How many pictures to make (1-4, default 1). Each one is paid.',
    maximum: 4,
    minimum: 1,
    type: 'number',
  },
  quality: {
    description: 'Quality level when the model has several (see listImageModels). Omit by default.',
    type: 'string',
  },
  resolution: {
    description: "Resolution like '1K', '2K', '4K' when the model offers it. Bigger costs more.",
    type: 'string',
  },
  thinking: {
    description: 'Let the model think before drawing, only for models that support it. Costs more.',
    type: 'boolean',
  },
};

export const ArckepStudioManifest: BuiltinToolManifest = {
  api: [
    {
      description:
        "Create a picture from a text prompt in the ArcKep studio, paid from the user's balance (the price is held at once; a failed job is refunded). Waits up to ~75 s: returns status 'completed' with the image url, or 'processing' with a generation_id to poll via getImage. Call it ONCE per request — never again while the first job is processing. Saved in the user's studio history. Use this when the user asks to draw / generate an image.",
      name: ArckepStudioApiName.createImage,
      parameters: {
        additionalProperties: false,
        properties: {
          ...imageOptionProperties,
          max_cost_rub: {
            description:
              'Refuse (402-style error) when the price is higher than this, in ₽. Set when the user named a limit.',
            type: 'number',
          },
          prompt: {
            description:
              'Detailed picture description: subject, setting, light, style, composition, any text to render. English usually works best.',
            type: 'string',
          },
        },
        required: ['prompt'],
        type: 'object',
      },
    },
    {
      description:
        'Free price quote for a picture for THIS user (their discount included) plus their balance and whether it covers the price. Call before createImage when the user asks the price, picks an expensive model / 4K / several pictures, or the price may be above ~30 ₽. Same parameters as createImage without the prompt.',
      name: ArckepStudioApiName.estimateImage,
      parameters: {
        additionalProperties: false,
        properties: imageOptionProperties,
        type: 'object',
      },
    },
    {
      description:
        "Read the state and result of a picture by generation_id (from createImage; also works for pictures made earlier in the studio). Returns status queued/processing/completed/failed, the image url when completed, the price and the error text when failed. Use it to follow a 'processing' job — do not create the picture again.",
      name: ArckepStudioApiName.getImage,
      parameters: {
        additionalProperties: false,
        properties: {
          generation_id: {
            description: 'generation_id returned by createImage (never invented)',
            type: 'number',
          },
        },
        required: ['generation_id'],
        type: 'object',
      },
    },
    {
      description:
        'List the image models the chat may use (id, name, list price for one image, supported aspect ratios / resolutions / quality levels), cheapest first; the default one is flagged. Call only when the user wants to choose a model or asks what is available.',
      name: ArckepStudioApiName.listImageModels,
      parameters: {
        additionalProperties: false,
        properties: {},
        type: 'object',
      },
    },
    {
      description:
        "Voice a text with a prebuilt voice (Gemini speech) and return a link to a WAV file; paid from the user's balance (cents of a ruble per short text). Synchronous, can take up to a minute. Saved in the studio history. Read the text exactly as given.",
      name: ArckepStudioApiName.createSpeech,
      parameters: {
        additionalProperties: false,
        properties: {
          style: {
            description: "How to read: tone, pace, mood, e.g. 'спокойно и тепло'. Optional.",
            type: 'string',
          },
          text: {
            description: 'The text to voice, 1-6000 characters, exactly as it should be read.',
            type: 'string',
          },
          voice_id: {
            description:
              'Prebuilt voice name (default Kore). Female: Kore, Zephyr, Leda, Aoede, Sulafat, Vindemiatrix, Gacrux, Achernar. Male: Puck, Charon, Fenrir, Orus, Achird, Sadaltager, Algieba, Alnilam.',
            type: 'string',
          },
        },
        required: ['text'],
        type: 'object',
      },
    },
    {
      description:
        "The user's balance in ₽ (the organisation's balance for a corporate member). Call only when the user asks about their balance or after an insufficient-balance error.",
      name: ArckepStudioApiName.getBalance,
      parameters: {
        additionalProperties: false,
        properties: {},
        type: 'object',
      },
    },
  ],
  identifier: ArckepStudioIdentifier,
  meta: {
    avatar: '🎨',
    description:
      'Студия Arckep: нарисовать картинку, посчитать цену, озвучить текст, узнать баланс. Платно с баланса пользователя, результат сохраняется в «Истории».',
    title: 'Студия Arckep',
  },
  systemRole: systemPrompt,
  type: 'builtin',
};
