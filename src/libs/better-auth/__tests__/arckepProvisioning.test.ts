// @vitest-environment node
import { verifyPassword } from 'better-auth/crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { LobeChatDatabase } from '@/database/type';

import {
  clearArckepUserCache,
  resolveArckepUser,
} from '../../../../packages/openapi/src/helpers/arckepServiceAuth';
import { createArckepUserProvisioner } from '../arckepProvisioning';
import { isolatedProvisioningDatabase, schema } from './fixtures/provisioningDatabase';
import { provisioningOptions } from './fixtures/provisioningOptions';
import { provisioningProcess } from './fixtures/provisioningProcess';

let database: Awaited<ReturnType<typeof isolatedProvisioningDatabase>>;
const input = {
  email: 'user726@arckep.ru',
  name: 'User 726',
  password: 'arckep_bridge_726_isolated',
};

describe.skipIf(process.env.TEST_AUTH_POSTGRES !== '1')(
  'atomic Studio provisioning with the real Better Auth Drizzle adapter',
  () => {
    beforeAll(async () => {
      database = await isolatedProvisioningDatabase();
    }, 15000);
    afterAll(async () => {
      await database?.close();
    });
    beforeEach(async () => {
      vi.stubEnv('AUTH_SECRET', 'isolated-auth-test-secret');
      clearArckepUserCache();
      await database.pool.query('TRUNCATE rbac_user_roles, auth_sessions, accounts, users');
    });
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it.each([false, true])(
      'concurrent independent processes resolve one complete identity, first writer rollback=%s',
      async (failCredential) => {
        const first = provisioningProcess({
          socket: database.socket,
          studioUserId: 726,
          holdCredential: true,
          failCredential,
        });
        let second: ReturnType<typeof provisioningProcess> | undefined;
        try {
          await first.waitFor('before-credential');
          const visibleDuringInsert = (await database.pool.query('SELECT * FROM users')).rowCount;
          second = provisioningProcess({
            socket: database.socket,
            studioUserId: 726,
            holdCredential: false,
          });
          // The second process must be able to attempt signup while the first user
          // is uncommitted; an existing orphan must not be considered its identity.
          const secondResult = second.waitFor('result');
          if (visibleDuringInsert === 0) await second.waitFor('attempting-user');
          first.release();
          const [a, b] = await Promise.all([first.waitFor('result'), secondResult]);
          expect(visibleDuringInsert).toBe(0);
          expect(b.userId).toBeTruthy();
          if (!failCredential) expect(a.userId).toBe(b.userId);
          expect((await database.pool.query('SELECT * FROM users')).rowCount).toBe(1);
          expect((await database.pool.query('SELECT * FROM accounts')).rowCount).toBe(1);
        } finally {
          first.close();
          second?.close();
        }
      },
      15000,
    );
    it('publishes the user and credential together before running external initialization', async () => {
      const bootstrap = vi.fn(async (user: { id: string }) => {
        // A separate pooled connection cannot see uncommitted writes.
        const rows = await database.pool.query(
          'SELECT a.password FROM users u JOIN accounts a ON a.user_id=u.id WHERE u.id=$1',
          [user.id],
        );
        expect(rows.rowCount).toBe(1);
        expect(
          await verifyPassword({ hash: rows.rows[0].password, password: input.password }),
        ).toBe(true);
      });
      const provision = createArckepUserProvisioner(
        provisioningOptions({
          databaseHooks: { user: { create: { after: bootstrap } } },
        }),
        database.db,
        schema,
      );
      await provision(input);
      expect(bootstrap).toHaveBeenCalledOnce();
      expect((await database.pool.query('SELECT normalized_email, role FROM users')).rows).toEqual([
        { normalized_email: input.email, role: 'user' },
      ]);
      expect((await database.pool.query('SELECT * FROM auth_sessions')).rowCount).toBe(0);
    });

    it('rolls back the user when the credential insert fails and never runs external effects', async () => {
      const bootstrap = vi.fn();
      const provision = createArckepUserProvisioner(
        provisioningOptions({
          databaseHooks: { user: { create: { after: bootstrap } } },
        }),
        database.db,
        schema,
      );
      await database.pool
        .query(`CREATE FUNCTION reject_credential() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'credential insert failed'; END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER reject_credential BEFORE INSERT ON accounts FOR EACH ROW EXECUTE FUNCTION reject_credential();`);
      try {
        await expect(provision(input)).rejects.toThrow();
        expect((await database.pool.query('SELECT * FROM users')).rowCount).toBe(0);
        expect((await database.pool.query('SELECT * FROM accounts')).rowCount).toBe(0);
        expect(bootstrap).not.toHaveBeenCalled();
      } finally {
        await database.pool.query(
          'DROP TRIGGER reject_credential ON accounts; DROP FUNCTION reject_credential();',
        );
      }
    });

    it('runs verification mail after commit and makes no secondary-storage/session writes', async () => {
      const secondaryStorage = { get: vi.fn(async () => null), set: vi.fn(), delete: vi.fn() };
      const sendVerificationEmail = vi.fn(async () => {
        expect((await database.pool.query('SELECT * FROM accounts')).rowCount).toBe(1);
      });
      await createArckepUserProvisioner(
        provisioningOptions({
          emailAndPassword: { enabled: true, autoSignIn: true, requireEmailVerification: true },
          emailVerification: { sendVerificationEmail },
          secondaryStorage,
        }),
        database.db,
        schema,
      )(input);
      expect(sendVerificationEmail).toHaveBeenCalledOnce();
      expect(secondaryStorage.set).not.toHaveBeenCalled();
      expect((await database.pool.query('SELECT * FROM auth_sessions')).rowCount).toBe(0);
    });

    it('keeps the committed credential when a post-commit external action fails', async () => {
      const bootstrap = vi.fn(async () => {
        throw new Error('analytics unavailable');
      });
      const provision = createArckepUserProvisioner(
        provisioningOptions({
          databaseHooks: { user: { create: { after: bootstrap } } },
        }),
        database.db,
        schema,
      );
      await expect(provision(input)).rejects.toThrow();
      const rows = await database.pool.query('SELECT password FROM accounts');
      expect(rows.rowCount).toBe(1);
      expect(await verifyPassword({ hash: rows.rows[0].password, password: input.password })).toBe(
        true,
      );
      const retrySignup = vi.fn(provision);
      expect(
        await resolveArckepUser(database.db as unknown as LobeChatDatabase, 726, retrySignup),
      ).toBeTruthy();
      expect(retrySignup).not.toHaveBeenCalled();
      expect(bootstrap).toHaveBeenCalledOnce();
      expect((await database.pool.query('SELECT * FROM accounts')).rowCount).toBe(1);
    });

    it.each([false, true])(
      'never repairs or takes over an existing account with credential=%s',
      async (hasCredential) => {
        if (hasCredential)
          await createArckepUserProvisioner(
            provisioningOptions(),
            database.db,
            schema,
          )({ ...input, password: 'someone-else-password' });
        else
          await database.pool.query(
            'INSERT INTO users (id,email,full_name,email_verified,created_at,updated_at) VALUES ($1,$2,$3,false,now(),now())',
            ['orphan', input.email, input.name],
          );
        const signup = vi.fn();
        expect(
          await resolveArckepUser(database.db as unknown as LobeChatDatabase, 726, signup),
        ).toBeNull();
        expect(signup).not.toHaveBeenCalled();
        expect((await database.pool.query('SELECT * FROM rbac_user_roles')).rowCount).toBe(0);
        expect((await database.pool.query('SELECT * FROM accounts')).rowCount).toBe(
          hasCredential ? 1 : 0,
        );
      },
    );
  },
);
