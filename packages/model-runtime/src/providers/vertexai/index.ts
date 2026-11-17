import type { GoogleGenAIOptions } from '@google/genai';
import { GoogleGenAI } from '@google/genai';

import { DEFAULT_GOOGLE_TOTAL_STREAM_TIMEOUT_MS } from '../../const/timeout';
import { AgentRuntimeErrorType } from '../../types/error';
import { AgentRuntimeError } from '../../utils/createError';
import { LobeGoogleAI } from '../google';

const DEFAULT_VERTEXAI_LOCATION = 'global';

export class LobeVertexAI extends LobeGoogleAI {
  static initFromVertexAI(params?: GoogleGenAIOptions) {
    try {
      const client = new GoogleGenAI({
        ...params,
        httpOptions: {
          ...params?.httpOptions,
          timeout: params?.httpOptions?.timeout ?? DEFAULT_GOOGLE_TOTAL_STREAM_TIMEOUT_MS,
        },
        location: params?.location ?? DEFAULT_VERTEXAI_LOCATION, // @google/genai throws an error if location is not provided
        vertexai: true,
      });

      return new LobeGoogleAI({ apiKey: 'avoid-error', client, isVertexAi: true });
    } catch (e) {
      const err = e as Error;

      if (err.name === 'IllegalArgumentError') {
        throw AgentRuntimeError.createError(AgentRuntimeErrorType.InvalidVertexCredentials, {
          message: err.message,
        });
      }

      throw e;
    }
  }
}
