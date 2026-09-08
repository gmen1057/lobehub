import { AgentRuntimeError } from '@lobechat/model-runtime';
import { ChatErrorType } from '@lobechat/types';

interface CheckAuthParams {
  betterAuthAuthorized?: boolean;
}

/**
 * Check if authentication is valid.
 * Only a verified server-side Better Auth session counts (GHSA-5mwj-v5jw-5c97).
 */
export const checkAuthMethod = (params: CheckAuthParams) => {
  const { betterAuthAuthorized } = params;

  if (betterAuthAuthorized) return;

  throw AgentRuntimeError.createError(ChatErrorType.Unauthorized);
};
