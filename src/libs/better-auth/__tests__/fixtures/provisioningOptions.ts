import { type BetterAuthOptions } from 'better-auth/minimal';
import { admin } from 'better-auth/plugins';
import { emailHarmony } from 'better-auth-harmony';

export const provisioningOptions = (extra: BetterAuthOptions = {}): BetterAuthOptions => ({
  baseURL: 'http://localhost:3402/chat/api/auth',
  secret: 'isolated-auth-tests-not-a-production-secret',
  emailAndPassword: { enabled: true, autoSignIn: true },
  experimental: { joins: true },
  user: { modelName: 'users', fields: { name: 'fullName', image: 'avatar' } },
  plugins: [admin(), emailHarmony({ validator: async () => true })],
  ...extra,
});
