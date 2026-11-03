import type { LobeChatDatabase } from '../../../../../packages/database/src/type';
import { resolveArckepUser } from '../../../../../packages/openapi/src/helpers/arckepServiceAuth';
import { createArckepUserProvisioner } from '../../arckepProvisioning';
import { connectProvisioningDatabase, schema } from './provisioningDatabase';
import { provisioningOptions } from './provisioningOptions';

interface WorkerInput {
  failCredential?: boolean;
  holdCredential: boolean;
  socket: string;
  studioUserId: number;
}
process.once('message', async (input: WorkerInput) => {
  process.env.AUTH_SECRET = 'isolated-cross-process-auth-secret';
  const { db, pool } = connectProvisioningDatabase(input.socket);
  const provision = createArckepUserProvisioner(
    provisioningOptions({
      databaseHooks: {
        user: {
          create: {
            before: async (user) => {
              process.send?.({ type: 'attempting-user' });
              return { data: user };
            },
          },
        },
        account: {
          create: {
            before: async (account) => {
              if (input.holdCredential) {
                const released = new Promise<void>((resolve) =>
                  process.once('message', () => resolve()),
                );
                process.send?.({ type: 'before-credential' });
                await released;
              }
              if (input.failCredential) throw new Error('simulated credential failure');
              return { data: account };
            },
          },
        },
      },
    }),
    db,
    schema,
  );
  try {
    const userId = await resolveArckepUser(
      db as unknown as LobeChatDatabase,
      input.studioUserId,
      provision,
    );
    process.send?.({ type: 'result', userId });
  } catch (error) {
    process.send?.({
      type: 'failure',
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    await pool.end();
    process.disconnect();
  }
});
process.send?.({ type: 'ready' });
