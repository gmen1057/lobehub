#!/usr/bin/env bun
/**
 * Block G of sandbox-async-runner.
 *
 * One-shot backfill for the 94 historical silent-fail records identified
 * before durable runner deployment. For each assistant message that has
 * tools[]=cloud-sandbox and no child tool message, writes an explicit
 * error message so the UI surfaces something meaningful instead of an
 * empty hanging turn.
 *
 * Usage:
 *   bun run scripts/backfillSandboxSilentFails.ts             # dry-run
 *   bun run scripts/backfillSandboxSilentFails.ts --apply     # actually insert
 */

import * as dotenv from 'dotenv';
import dotenvExpand from 'dotenv-expand';
import { customAlphabet } from 'nanoid/non-secure';

dotenvExpand.expand(dotenv.config());

const env = process.env.NODE_ENV || 'development';
dotenvExpand.expand(dotenv.config({ override: true, path: `.env.${env}` }));
dotenvExpand.expand(dotenv.config({ override: true, path: `.env.${env}.local` }));

const BACKFILL_CONTENT =
  'Execution interrupted prior to durable runner deployment. Please retry this request.';
const BACKFILL_ERROR_TYPE = 'historical_silent_fail';

interface ChatToolPayload {
  apiName?: string;
  arguments?: string;
  id: string;
  identifier?: string;
  type?: string;
}

interface SilentFailRow {
  id: string;
  tools: ChatToolPayload[] | null;
  topic_id: string | null;
  user_id: string;
}

const generateMessageId = (() => {
  const nano = customAlphabet('1234567890abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ', 12);
  return () => `msg_${nano()}`;
})();

const main = async () => {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');

  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL not set — load .env or set explicitly');
    process.exit(1);
  }

  const { serverDB } = await import('../packages/database/src/server');
  const { messages, messagePlugins } = await import('../packages/database/src/schemas');
  const { and, eq, sql } = await import('drizzle-orm');

  console.log(`mode=${apply ? 'APPLY' : 'dry-run'}`);

  // Match the spec query — assistant messages with cloud-sandbox tools[]
  // committed but no child tool message and empty content. Cutoff at 1 hour
  // ago so we don't accidentally backfill in-flight new jobs from the durable
  // runner that's currently rolling out.
  const candidates = (await serverDB.execute(sql`
    SELECT id, topic_id, user_id, tools
    FROM messages m
    WHERE role = 'assistant'
      AND created_at < NOW() - INTERVAL '1 hour'
      AND tools::text LIKE '%lobe-cloud-sandbox%'
      AND LENGTH(content) = 0
      AND NOT EXISTS (SELECT 1 FROM message_plugins mp WHERE mp.id = m.id)
  `)) as unknown as SilentFailRow[];

  console.log(`candidates=${candidates.length}`);

  let inserted = 0;
  let skipped = 0;

  for (const row of candidates) {
    if (!row.tools) {
      skipped += 1;
      continue;
    }

    const sandboxTools = row.tools.filter((t) => t?.identifier === 'lobe-cloud-sandbox');
    if (sandboxTools.length === 0) {
      skipped += 1;
      continue;
    }

    if (!row.topic_id) {
      // Without a topic_id we can't render the child message; skip and report.
      console.warn(`skipping row id=${row.id} — topic_id missing`);
      skipped += 1;
      continue;
    }

    for (const tool of sandboxTools) {
      // Idempotency guard: skip if a message_plugins row already exists for
      // this tool_call_id (worker may have written one already on the
      // post-deploy path before backfill ran).
      const [existingPlugin] = await serverDB
        .select({ id: messagePlugins.id })
        .from(messagePlugins)
        .where(and(eq(messagePlugins.toolCallId, tool.id), eq(messagePlugins.userId, row.user_id)))
        .limit(1);

      if (existingPlugin) {
        console.log(`existing plugin row for tool_call_id=${tool.id} parent=${row.id} — skipping`);
        continue;
      }

      const childId = generateMessageId();

      if (apply) {
        await serverDB.transaction(async (trx) => {
          await trx.insert(messages).values({
            id: childId,
            content: BACKFILL_CONTENT,
            parentId: row.id,
            role: 'tool',
            tool_call_id: tool.id,
            topicId: row.topic_id!,
            userId: row.user_id,
          } as any);

          await trx.insert(messagePlugins).values({
            id: childId,
            apiName: tool.apiName,
            arguments: tool.arguments,
            error: {
              message: BACKFILL_CONTENT,
              type: BACKFILL_ERROR_TYPE,
            } as any,
            identifier: tool.identifier,
            toolCallId: tool.id,
            type: (tool.type ?? 'builtin') as any,
            userId: row.user_id,
          });
        });
      }

      inserted += 1;
      console.log(
        `${apply ? 'INSERT' : 'WOULD INSERT'} child_id=${childId} parent=${row.id} tool_call_id=${tool.id} user=${row.user_id}`,
      );
    }
  }

  console.log(`done — ${apply ? 'inserted' : 'would insert'}=${inserted} skipped=${skipped}`);
  process.exit(0);
};

main().catch((err) => {
  console.error('backfill failed:', err);
  process.exit(1);
});
