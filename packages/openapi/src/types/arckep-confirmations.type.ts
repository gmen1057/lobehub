import { z } from 'zod';

/**
 * arckep (19.10.2026, этап 3, п. 3.Д): тело и параметры `POST /api/v1/arckep/topics/:topicId/confirmations/:id`.
 * Номер запроса — `cfm_` + 20 знаков hex (детерминирован движком, см. toolExecution/topicTrust.ts).
 */
export const ConfirmationParamSchema = z.object({
  id: z.string().regex(/^cfm_[\da-f]{20}$/),
  topicId: z.string().regex(/^[\w-]{1,100}$/),
});

export const ConfirmationDecisionSchema = z
  .object({
    action: z.enum(['approve', 'reject']),
  })
  .strict();

export type ConfirmationDecisionRequest = z.infer<typeof ConfirmationDecisionSchema>;
