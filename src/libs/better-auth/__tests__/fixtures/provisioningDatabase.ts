import { execFile } from 'node:child_process';
import { chown, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { drizzle } from 'drizzle-orm/node-postgres';
import { boolean, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { Pool } from 'pg';

const exec = promisify(execFile);
const timestamps = {
  createdAt: timestamp('created_at').notNull(),
  updatedAt: timestamp('updated_at').notNull(),
};
export const users = pgTable('users', {
  id: text('id').primaryKey(),
  email: text('email').unique().notNull(),
  fullName: text('full_name').notNull(),
  emailVerified: boolean('email_verified').notNull(),
  avatar: text('avatar'),
  normalizedEmail: text('normalized_email').unique(),
  role: text('role'),
  banned: boolean('banned'),
  banReason: text('ban_reason'),
  banExpires: timestamp('ban_expires'),
  ...timestamps,
});
export const account = pgTable('accounts', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  password: text('password'),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  scope: text('scope'),
  accessTokenExpiresAt: timestamp('access_token_expires_at'),
  refreshTokenExpiresAt: timestamp('refresh_token_expires_at'),
  ...timestamps,
});
export const session = pgTable('auth_sessions', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id),
  token: text('token').unique().notNull(),
  expiresAt: timestamp('expires_at').notNull(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  ...timestamps,
});
export const schema = { users, account, session };

export const connectProvisioningDatabase = (socket: string) => {
  const pool = new Pool({
    host: socket,
    port: 5432,
    user: 'postgres',
    database: 'postgres',
    max: 3,
  });
  return { db: drizzle(pool, { schema }), pool };
};

/** Fresh PostgreSQL cluster, UNIX socket only. Never reads a DATABASE_URL. */
export const isolatedProvisioningDatabase = async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'chat-provisioning-test-'));
  const bin = (await exec('pg_config', ['--bindir'])).stdout.trim();
  const asPostgres = process.getuid?.() === 0;
  if (asPostgres) {
    const uid = Number((await exec('id', ['-u', 'postgres'])).stdout.trim());
    const gid = Number((await exec('id', ['-g', 'postgres'])).stdout.trim());
    await chown(directory, uid, gid);
  }
  const run = (name: string, args: string[]) =>
    asPostgres
      ? exec('runuser', ['-u', 'postgres', '--', path.join(bin, name), ...args])
      : exec(path.join(bin, name), args);
  const data = path.join(directory, 'data');
  await run('initdb', ['-D', data, '-U', 'postgres', '-A', 'trust', '--no-locale']);
  await run('pg_ctl', [
    '-D',
    data,
    '-l',
    path.join(directory, 'postgres.log'),
    '-w',
    'start',
    '-o',
    `-F -h '' -k ${directory} -p 5432 -c max_connections=12 -c shared_buffers=16MB`,
  ]);
  const { db, pool } = connectProvisioningDatabase(directory);
  await pool.query(`
    CREATE TABLE users (id text PRIMARY KEY, email text NOT NULL UNIQUE, full_name text NOT NULL,
      email_verified boolean NOT NULL, avatar text, normalized_email text UNIQUE, role text,
      banned boolean, ban_reason text, ban_expires timestamp, created_at timestamp NOT NULL, updated_at timestamp NOT NULL);
    CREATE TABLE accounts (id text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id),
      account_id text NOT NULL, provider_id text NOT NULL, password text, access_token text,
      refresh_token text, id_token text, scope text, access_token_expires_at timestamp,
      refresh_token_expires_at timestamp, created_at timestamp NOT NULL, updated_at timestamp NOT NULL);
    CREATE TABLE auth_sessions (id text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id),
      token text NOT NULL UNIQUE, expires_at timestamp NOT NULL, ip_address text, user_agent text,
      created_at timestamp NOT NULL, updated_at timestamp NOT NULL);
    CREATE TABLE rbac_user_roles (user_id text NOT NULL REFERENCES users(id), role_id text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz, PRIMARY KEY (user_id, role_id));
  `);
  return {
    db,
    pool,
    socket: directory,
    close: async () => {
      await pool.end();
      await run('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop']);
      await rm(directory, { recursive: true, force: true });
    },
  };
};
