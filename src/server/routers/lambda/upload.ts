import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { authedProcedure, router } from '@/libs/trpc/lambda';
import { FileS3 } from '@/server/modules/S3';

const CHAT_DATE_UPLOAD_RE = /^uploads\/\d{4}(?:-\d{2}-\d{2}|\/\d{2})\/[^/]+$/;
const ALLOWED_CHAT_KEY_PREFIXES = ['files/', 'skills/', 'import_config/'] as const;

export const assertValidChatUploadKey = (rawKey: string, userId?: string): string => {
  const key = (rawKey || '').trim();
  if (!key || key.startsWith('/')) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Invalid storage key' });
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(key);
  } catch {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Invalid storage key encoding' });
  }

  for (const candidate of [key, decoded]) {
    if (/[\0\r\n#:\\?]/.test(candidate) || candidate.split('/').includes('..')) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'Invalid storage key' });
    }
  }

  if (CHAT_DATE_UPLOAD_RE.test(key)) {
    return key;
  }

  if (!ALLOWED_CHAT_KEY_PREFIXES.some((prefix) => key.startsWith(prefix))) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Invalid storage key prefix' });
  }

  if (key.startsWith('files/')) {
    const parts = key.split('/');
    if (parts.length < 2 || parts.some((part) => !part)) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'Invalid storage key' });
    }
    if (parts[1].startsWith('user_') && userId && parts[1] !== userId) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'Cannot access another user storage prefix',
      });
    }
  }

  return key;
};

export const uploadRouter = router({
  createS3PreSignedUrl: authedProcedure
    .input(z.object({ pathname: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const pathname = assertValidChatUploadKey(input.pathname, ctx.userId);
      const s3 = new FileS3();

      return await s3.createPreSignedUrl(pathname);
    }),
});

export type FileRouter = typeof uploadRouter;
