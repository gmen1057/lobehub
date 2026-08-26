import { API_ENDPOINTS } from '@/services/_url';
import { type TraceEventBasePayload, type TraceEventPayloads } from '@/types/trace';

class TraceService {
  private request = async <T>(data: T) => {
    try {
      return fetch(API_ENDPOINTS.trace, {
        body: JSON.stringify(data),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      });
    } catch (e) {
      console.error(e);
    }
  };

  traceEvent = async (data: TraceEventPayloads & TraceEventBasePayload) => {
    // Arckep: always POST; TraceClient no-ops when ENABLE_LANGFUSE is off.
    return this.request(data);
  };
}

export const traceService = new TraceService();
