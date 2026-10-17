import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { z } from 'zod';

import { ResponsesController } from '../controllers/responses.controller';
import { requireAuth } from '../middleware/auth';
import { CreateResponseRequestSchema } from '../types/responses.type';

const ResponsesRoutes = new Hono();

/**
 * POST /api/v1/responses
 * Create a model response (OpenResponses protocol)
 */
ResponsesRoutes.post(
  '/',
  requireAuth,
  zValidator('json', CreateResponseRequestSchema),
  async (c) => {
    const controller = new ResponsesController();
    return await controller.createResponse(c);
  },
);

// arckep (chat-next-redesign, E2): остановка ответа
ResponsesRoutes.post(
  '/:id/cancel',
  requireAuth,
  zValidator('param', z.object({ id: z.string().regex(/^[\w-]{1,160}$/) })),
  async (c) => {
    const controller = new ResponsesController();
    return await controller.cancelResponse(c);
  },
);

export default ResponsesRoutes;
