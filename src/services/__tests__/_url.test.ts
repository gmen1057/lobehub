import { describe, expect, it } from 'vitest';

import { API_ENDPOINTS } from '../_url';

describe('API_ENDPOINTS', () => {
  it('should return correct basePath URLs', () => {
    expect(API_ENDPOINTS.oauth).toBe('/chat/api/auth');
    expect(API_ENDPOINTS.proxy).toBe('/chat/webapi/proxy');
    expect(API_ENDPOINTS.trace).toBe('/chat/webapi/trace');
    expect(API_ENDPOINTS.stt).toBe('/chat/webapi/stt/openai');
    expect(API_ENDPOINTS.edge).toBe('/chat/webapi/tts/edge');
    expect(API_ENDPOINTS.microsoft).toBe('/chat/webapi/tts/microsoft');
  });

  it('should return correct dynamic URLs', () => {
    expect(API_ENDPOINTS.chat('openai')).toBe('/chat/webapi/chat/openai');
    expect(API_ENDPOINTS.models('anthropic')).toBe('/chat/webapi/models/anthropic');
    expect(API_ENDPOINTS.modelPull('azure')).toBe('/chat/webapi/models/azure/pull');
    expect(API_ENDPOINTS.tts('openai')).toBe('/chat/webapi/tts/openai');
  });
});
