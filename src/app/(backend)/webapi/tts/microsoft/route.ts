import { type MicrosoftSpeechPayload } from '@lobehub/tts';
import { MicrosoftSpeechTTS } from '@lobehub/tts';

import { checkAuth } from '@/app/(backend)/middleware/auth';
import { createSpeechResponse } from '@/server/utils/createSpeechResponse';

export const POST = checkAuth(async (req: Request) => {
  const payload = (await req.json()) as MicrosoftSpeechPayload;

  return createSpeechResponse(() => MicrosoftSpeechTTS.createRequest({ payload }), {
    logTag: 'webapi/tts/microsoft',
    messages: {
      failure: 'Failed to synthesize speech',
      invalid: 'Unexpected payload from Microsoft speech API',
    },
  });
});
