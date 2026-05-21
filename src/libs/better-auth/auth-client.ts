import {
  adminClient,
  genericOAuthClient,
  inferAdditionalFields,
  magicLinkClient,
} from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/react';

import { type auth } from '@/auth';

const getBaseURL = () => {
  if (typeof window !== 'undefined') {
    return `${window.location.origin}/chat/api/auth`;
  }
  return process.env.BETTER_AUTH_URL || process.env.APP_URL || 'https://arckep.ru/chat/api/auth';
};

export const {
  changeEmail,
  linkSocial,
  oauth2,
  accountInfo,
  listAccounts,
  requestPasswordReset,
  resetPassword,
  sendVerificationEmail,
  signIn,
  signOut,
  signUp,
  unlinkAccount,
  useSession,
} = createAuthClient({
  baseURL: getBaseURL(),
  plugins: [
    adminClient(),
    inferAdditionalFields<typeof auth>(),
    genericOAuthClient(),
    // Always include magicLinkClient - server will reject if not enabled
    magicLinkClient(),
  ],
});
