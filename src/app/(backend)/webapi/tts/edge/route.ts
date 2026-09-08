import { type EdgeSpeechPayload } from '@lobehub/tts';
import { EdgeSpeechTTS } from '@lobehub/tts';

import { checkAuth } from '@/app/(backend)/middleware/auth';
import { createSpeechResponse } from '@/server/utils/createSpeechResponse';

export const POST = checkAuth(async (req: Request) => {
  const payload = (await req.json()) as EdgeSpeechPayload;

  return createSpeechResponse(() => EdgeSpeechTTS.createRequest({ payload }), {
    logTag: 'webapi/tts/edge',
    messages: {
      failure: 'Failed to synthesize speech',
      invalid: 'Unexpected payload from Edge speech API',
    },
  });
});
