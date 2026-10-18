import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';

import { BaseController } from '../common/base.controller';
import { ResponsesService } from '../services/responses.service';
import type { CreateResponseRequest, ResponseStreamEvent } from '../types/responses.type';

/** Период SSE-комментария, пока событий нет (клиент студии ждёт чтение не дольше 120 с). */
const HEARTBEAT_MS = 15_000;

/**
 * Responses Controller
 * Handles OpenResponses API requests
 */
export class ResponsesController extends BaseController {
  /**
   * POST /api/v1/responses
   * Create a model response (streaming or non-streaming)
   */
  async createResponse(c: Context): Promise<Response> {
    try {
      const body = await this.getBody<CreateResponseRequest>(c);
      const userId = this.getUserId(c);
      const db = await this.getDatabase();
      const service = new ResponsesService(db, userId);

      if (body.stream) {
        return this.handleStreamingResponse(c, service, body);
      }

      const response = await service.createResponse(body);
      return c.json(response);
    } catch (error) {
      return this.handleError(c, error);
    }
  }

  /** POST /api/v1/responses/:id/cancel — arckep: остановить ответ (chat-next-redesign, E2). */
  async cancelResponse(c: Context): Promise<Response> {
    try {
      const { id } = this.getParams<{ id: string }>(c);
      const userId = this.getUserId(c);
      const db = await this.getDatabase();
      const service = new ResponsesService(db, userId);
      return c.json(await service.cancelResponse(id));
    } catch (error) {
      return this.handleError(c, error);
    }
  }

  /** GET /api/v1/responses/running — arckep (F8): темы, в которых ответ ещё идёт. */
  async listRunning(c: Context): Promise<Response> {
    try {
      const userId = this.getUserId(c);
      const db = await this.getDatabase();
      const service = new ResponsesService(db, userId);
      return c.json({ topics: service.listRunningTopics() });
    } catch (error) {
      return this.handleError(c, error);
    }
  }

  /** GET /api/v1/responses/:id — arckep (F8): состояние ответа темы (идёт, завершён, упал). */
  async getResponse(c: Context): Promise<Response> {
    try {
      const { id } = this.getParams<{ id: string }>(c);
      const userId = this.getUserId(c);
      const db = await this.getDatabase();
      const service = new ResponsesService(db, userId);
      const status = service.getResponseStatus(id);
      if (!status) return this.error(c, `No response for ${id}`, 404);
      return c.json(status);
    } catch (error) {
      return this.handleError(c, error);
    }
  }

  /**
   * GET /api/v1/responses/:id/stream — arckep (F8): переподключиться к ответу темы — события
   * с начала и живой хвост. Нет ответа — 404 до открытия потока.
   */
  async streamResponse(c: Context): Promise<Response> {
    try {
      const { id } = this.getParams<{ id: string }>(c);
      const userId = this.getUserId(c);
      const db = await this.getDatabase();
      const service = new ResponsesService(db, userId);
      const status = service.getResponseStatus(id);
      if (!status || !status.resumable) return this.error(c, `No response for ${id}`, 404);
      return this.streamEvents(c, (signal) => service.resumeStreamingResponse(id, signal));
    } catch (error) {
      return this.handleError(c, error);
    }
  }

  private handleStreamingResponse(
    c: Context,
    service: ResponsesService,
    params: CreateResponseRequest,
  ): Response {
    return this.streamEvents(c, (signal) => service.createStreamingResponse(params, signal));
  }

  /**
   * arckep (F8): общий SSE-поток для отправки и переподключения. Обрыв соединения клиента
   * отменяет только чтение (`signal`), сам ответ движок считает дальше. Пока модель молчит,
   * раз в HEARTBEAT_MS уходит SSE-комментарий, чтобы соединение студии не засыпало по таймауту.
   */
  private streamEvents(
    c: Context,
    run: (signal: AbortSignal) => AsyncGenerator<ResponseStreamEvent>,
  ): Response {
    return streamSSE(c, async (stream) => {
      const controller = new AbortController();
      stream.onAbort(() => controller.abort());
      const heartbeat = setInterval(() => {
        if (controller.signal.aborted) return;
        stream.write(': keepalive\n\n').catch(() => undefined);
      }, HEARTBEAT_MS);
      try {
        for await (const event of run(controller.signal)) {
          if (controller.signal.aborted) break;
          await stream.writeSSE({
            data: JSON.stringify(event),
            event: event.type,
          });
        }
      } finally {
        clearInterval(heartbeat);
      }
    });
  }
}
