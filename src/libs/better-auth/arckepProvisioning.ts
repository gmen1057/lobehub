import { type DB, drizzleAdapter, type DrizzleAdapterConfig } from 'better-auth/adapters/drizzle';
import { betterAuth, type BetterAuthOptions } from 'better-auth/minimal';

interface ProvisioningInput {
  email: string;
  name: string;
  password: string;
}

/** Internal only: callers must first authenticate the Studio user or service. */
export const createArckepUserProvisioner =
  (options: BetterAuthOptions, db: DB, schema: DrizzleAdapterConfig['schema']) =>
  async (input: ProvisioningInput): Promise<void> => {
    const afterCommit: Array<() => Promise<void>> = [];
    const afterUserCreated = options.databaseHooks?.user?.create?.after;
    const sendVerificationEmail = options.emailVerification?.sendVerificationEmail;
    // Use Better Auth's validators, plugin hooks, password hashing and ID mapping.
    // This private signup does not create a session: the browser signs in afterwards,
    // and REST verifies the credential directly.
    const provisioningAuth = betterAuth({
      ...options,
      // Unlike the public signup flow, this transaction contains only user and
      // credential creation. Both become visible together to another process.
      database: drizzleAdapter(db, { provider: 'pg', schema, transaction: true }),
      databaseHooks: {
        ...options.databaseHooks,
        user: {
          ...options.databaseHooks?.user,
          create: {
            ...options.databaseHooks?.user?.create,
            after: afterUserCreated
              ? async (user, context) => {
                  afterCommit.push(() => afterUserCreated(user, context));
                }
              : undefined,
          },
        },
      },
      emailAndPassword: {
        ...options.emailAndPassword,
        enabled: options.emailAndPassword?.enabled ?? false,
        autoSignIn: false,
      },
      emailVerification: {
        ...options.emailVerification,
        sendVerificationEmail: sendVerificationEmail
          ? async (data, request) => {
              afterCommit.push(() => sendVerificationEmail(data, request));
            }
          : undefined,
      },
      secondaryStorage: undefined,
    });
    await provisioningAuth.api.signUpEmail({ body: input });
    // Signup resolved only after the adapter committed. Rolled-back attempts never
    // reach external business/analytics/email actions. These are not an outbox:
    // a process crash can lose delivery, but cannot leave a user without a password.
    const failures: unknown[] = [];
    for (const effect of afterCommit) {
      try {
        await effect();
      } catch (error) {
        console.error('[ArckepProvisioning] Post-commit action failed', error);
        failures.push(error);
      }
    }
    if (failures.length)
      throw new AggregateError(failures, 'Account committed; post-commit action failed');
  };
