import type { SkillItem, SkillListItem, SkillResourceMeta } from '@lobechat/types';
import { merge } from '@lobechat/utils';
import { and, desc, eq, ilike, inArray, or } from 'drizzle-orm';

import type { NewAgentSkill } from '../schemas';
import { agentSkills } from '../schemas';
import type { LobeChatDatabase } from '../type';

const skillItemColumns = {
  content: agentSkills.content,
  createdAt: agentSkills.createdAt,
  description: agentSkills.description,
  editorData: agentSkills.editorData,
  id: agentSkills.id,
  identifier: agentSkills.identifier,
  manifest: agentSkills.manifest,
  name: agentSkills.name,
  resources: agentSkills.resources,
  source: agentSkills.source,
  updatedAt: agentSkills.updatedAt,
  zipFileHash: agentSkills.zipFileHash,
};

const skillListColumns = {
  createdAt: agentSkills.createdAt,
  description: agentSkills.description,
  id: agentSkills.id,
  identifier: agentSkills.identifier,
  manifest: agentSkills.manifest,
  name: agentSkills.name,
  source: agentSkills.source,
  updatedAt: agentSkills.updatedAt,
  zipFileHash: agentSkills.zipFileHash,
};

export class AgentSkillModel {
  private userId: string;
  private db: LobeChatDatabase;

  constructor(db: LobeChatDatabase, userId: string) {
    this.db = db;
    this.userId = userId;
  }

  // ========== Create ==========

  create = async (data: Omit<NewAgentSkill, 'userId'>): Promise<SkillItem> => {
    const [result] = await this.db
      .insert(agentSkills)
      .values({ ...data, userId: this.userId })
      .returning(skillItemColumns);
    return result;
  };

  // ========== Read ==========

  findById = async (id: string): Promise<SkillItem | undefined> => {
    const [result] = await this.db
      .select(skillItemColumns)
      .from(agentSkills)
      .where(and(eq(agentSkills.id, id), eq(agentSkills.userId, this.userId)))
      .limit(1);
    return result;
  };

  findByIdentifier = async (identifier: string): Promise<SkillItem | undefined> => {
    const [result] = await this.db
      .select(skillItemColumns)
      .from(agentSkills)
      .where(and(eq(agentSkills.identifier, identifier), eq(agentSkills.userId, this.userId)))
      .limit(1);
    return result;
  };

  findByName = async (name: string): Promise<SkillItem | undefined> => {
    const [result] = await this.db
      .select(skillItemColumns)
      .from(agentSkills)
      .where(and(eq(agentSkills.name, name), eq(agentSkills.userId, this.userId)))
      .limit(1);
    return result;
  };

  findAll = async (): Promise<{ data: SkillListItem[]; total: number }> => {
    const data = await this.db
      .select(skillListColumns)
      .from(agentSkills)
      .where(eq(agentSkills.userId, this.userId))
      .orderBy(desc(agentSkills.updatedAt));

    return { data, total: data.length };
  };

  /**
   * arckep: список для экрана «Мои навыки» — те же колонки, что у findAll, плюс карта файлов
   * (по ней видно, есть ли у навыка справочники и скрипты).
   */
  findAllWithResources = async (): Promise<
    Array<SkillListItem & { resources?: Record<string, SkillResourceMeta> | null }>
  > => {
    return this.db
      .select({ ...skillListColumns, resources: agentSkills.resources })
      .from(agentSkills)
      .where(eq(agentSkills.userId, this.userId))
      .orderBy(desc(agentSkills.updatedAt));
  };

  findByIds = async (ids: string[]): Promise<SkillItem[]> => {
    if (ids.length === 0) return [];
    return this.db
      .select(skillItemColumns)
      .from(agentSkills)
      .where(and(inArray(agentSkills.id, ids), eq(agentSkills.userId, this.userId)));
  };

  listBySource = async (
    source: 'builtin' | 'market' | 'user',
  ): Promise<{ data: SkillListItem[]; total: number }> => {
    const data = await this.db
      .select(skillListColumns)
      .from(agentSkills)
      .where(and(eq(agentSkills.source, source), eq(agentSkills.userId, this.userId)))
      .orderBy(desc(agentSkills.updatedAt));

    return { data, total: data.length };
  };

  search = async (query: string): Promise<{ data: SkillListItem[]; total: number }> => {
    const data = await this.db
      .select(skillListColumns)
      .from(agentSkills)
      .where(
        and(
          eq(agentSkills.userId, this.userId),
          or(ilike(agentSkills.name, `%${query}%`), ilike(agentSkills.description, `%${query}%`)),
        ),
      )
      .orderBy(desc(agentSkills.updatedAt));

    return { data, total: data.length };
  };

  // ========== Update ==========

  update = async (id: string, data: Partial<NewAgentSkill>): Promise<SkillItem> => {
    const existing = await this.findById(id);

    const updateData = merge(existing || {}, { ...data, updatedAt: new Date() });

    const [result] = await this.db
      .update(agentSkills)
      .set(updateData)
      .where(and(eq(agentSkills.id, id), eq(agentSkills.userId, this.userId)))
      .returning(skillItemColumns);
    return result;
  };

  /**
   * arckep: полная замена полей навыка. `update` сливает объекты вглубь (lodash merge), и убранные файлы
   * остаются в `resources`; здесь значения заменяются как есть.
   */
  replace = async (
    id: string,
    data: Pick<NewAgentSkill, 'content' | 'description' | 'manifest' | 'resources'>,
  ): Promise<SkillItem | undefined> => {
    const [result] = await this.db
      .update(agentSkills)
      .set({ ...data, updatedAt: new Date() })
      .where(and(eq(agentSkills.id, id), eq(agentSkills.userId, this.userId)))
      .returning(skillItemColumns);
    return result;
  };

  // ========== Delete ==========

  delete = async (id: string): Promise<{ success: boolean }> => {
    const result = await this.db
      .delete(agentSkills)
      .where(and(eq(agentSkills.id, id), eq(agentSkills.userId, this.userId)));

    return { success: (result.rowCount ?? 0) > 0 };
  };
}
