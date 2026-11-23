import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import { createdAt, timestamptz, updatedAt } from './_helpers';
import { agents } from './agent';
import { documents, files } from './file';
import { topics } from './topic';
import { users } from './user';

export const projectWorkspaceFiles = pgTable(
  'project_workspace_files',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: text('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    agentId: text('agent_id')
      .references(() => agents.id, { onDelete: 'cascade' })
      .notNull(),
    path: text('path').notNull(),
    kind: varchar('kind', { length: 20 }).notNull(),
    mimeType: varchar('mime_type', { length: 255 }).notNull(),
    encoding: varchar('encoding', { length: 20 }),
    lineEnding: varchar('line_ending', { length: 4 }),
    loadMode: varchar('load_mode', { length: 20 }).default('on_demand').notNull(),
    loadPriority: integer('load_priority').default(100).notNull(),
    isProtected: boolean('is_protected').default(false).notNull(),
    userSummary: varchar('user_summary', { length: 120 }),
    currentRevision: integer('current_revision').default(1).notNull(),
    currentFileId: text('current_file_id')
      .references(() => files.id)
      .notNull(),
    currentDocumentId: varchar('current_document_id', { length: 255 }).references(
      () => documents.id,
      { onDelete: 'set null' },
    ),
    contentSha256: varchar('content_sha256', { length: 64 }).notNull(),
    byteSize: integer('byte_size').notNull(),
    charCount: integer('char_count'),
    lineCount: integer('line_count'),
    ragEnabled: boolean('rag_enabled').default(false).notNull(),
    dataGuardStatus: varchar('data_guard_status', { length: 20 }).default('unmasked').notNull(),
    createdBy: varchar('created_by', { length: 20 }).notNull(),
    updatedBy: varchar('updated_by', { length: 20 }).notNull(),
    lastTopicId: text('last_topic_id').references(() => topics.id, { onDelete: 'set null' }),
    deletedAt: timestamptz('deleted_at'),
    deletedBy: varchar('deleted_by', { length: 20 }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('uq_pwf_agent_path').on(t.agentId, sql`lower(${t.path})`),
    index('idx_pwf_user_agent_active')
      .on(t.userId, t.agentId, t.loadMode, t.updatedAt.desc())
      .where(sql`${t.deletedAt} IS NULL`),
    index('idx_pwf_current_file_id').on(t.currentFileId),
  ],
);

export type ProjectWorkspaceFileItem = typeof projectWorkspaceFiles.$inferSelect;
export type NewProjectWorkspaceFile = typeof projectWorkspaceFiles.$inferInsert;

export const projectFileRevisions = pgTable(
  'project_file_revisions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    workspaceFileId: uuid('workspace_file_id')
      .references(() => projectWorkspaceFiles.id, { onDelete: 'cascade' })
      .notNull(),
    userId: text('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    agentId: text('agent_id')
      .references(() => agents.id, { onDelete: 'cascade' })
      .notNull(),
    revision: integer('revision').notNull(),
    fileId: text('file_id')
      .references(() => files.id)
      .notNull(),
    documentId: varchar('document_id', { length: 255 }).references(() => documents.id, {
      onDelete: 'set null',
    }),
    contentSha256: varchar('content_sha256', { length: 64 }).notNull(),
    byteSize: integer('byte_size').notNull(),
    charCount: integer('char_count'),
    lineCount: integer('line_count'),
    encoding: varchar('encoding', { length: 20 }),
    lineEnding: varchar('line_ending', { length: 4 }),
    authorType: varchar('author_type', { length: 20 }).notNull(),
    topicId: text('topic_id').references(() => topics.id, { onDelete: 'set null' }),
    messageId: text('message_id'),
    changeNote: varchar('change_note', { length: 240 }),
    diffStats: jsonb('diff_stats').$type<{ addedLines: number; removedLines: number } | null>(),
    createdAt: timestamptz('created_at').defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('uq_pfr_file_revision').on(t.workspaceFileId, t.revision),
    index('idx_pfr_file_id').on(t.fileId),
    index('idx_pfr_agent_id').on(t.agentId),
  ],
);

export type ProjectFileRevisionItem = typeof projectFileRevisions.$inferSelect;
export type NewProjectFileRevision = typeof projectFileRevisions.$inferInsert;

export const projectFileProposals = pgTable(
  'project_file_proposals',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: text('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    agentId: text('agent_id')
      .references(() => agents.id, { onDelete: 'cascade' })
      .notNull(),
    workspaceFileId: uuid('workspace_file_id').references(() => projectWorkspaceFiles.id, {
      onDelete: 'cascade',
    }),
    targetPath: text('target_path').notNull(),
    proposalType: varchar('proposal_type', { length: 20 }).notNull(),
    baseRevision: integer('base_revision'),
    proposedFileId: text('proposed_file_id').references(() => files.id),
    reason: varchar('reason', { length: 500 }),
    diffStats: jsonb('diff_stats').$type<{ addedLines: number; removedLines: number } | null>(),
    diffPreview: text('diff_preview'),
    topicId: text('topic_id').references(() => topics.id, { onDelete: 'set null' }),
    messageId: text('message_id'),
    status: varchar('status', { length: 20 }).default('pending').notNull(),
    resolvedAt: timestamptz('resolved_at'),
    createdAt: timestamptz('created_at').defaultNow().notNull(),
  },
  (t) => [
    index('idx_pfp_agent_status').on(t.agentId, t.status, t.createdAt.desc()),
    index('idx_pfp_proposed_file_id').on(t.proposedFileId),
  ],
);

export type ProjectFileProposalItem = typeof projectFileProposals.$inferSelect;
export type NewProjectFileProposal = typeof projectFileProposals.$inferInsert;
