import { builtinSkills } from '@lobechat/builtin-skills';
import { type LobeChatDatabase } from '@lobechat/database';
import {
  type SkillImportResult,
  type SkillItem,
  type SkillListItem,
  type SkillResourceMeta,
  type SkillSource,
} from '@lobechat/types';
import { nanoid } from '@lobechat/utils';
import debug from 'debug';
import { sha256 } from 'js-sha256';

import { AgentSkillModel } from '@/database/models/agentSkill';
import { FileModel } from '@/database/models/file';
import { filterBuiltinSkills } from '@/helpers/skillFilters';
import { FileService } from '@/server/services/file';

import { SkillImportError, SkillManifestError, SkillParseError } from './errors';
import { SkillImporter } from './importer';
import { SkillParser } from './parser';
import { SkillResourceService } from './resource';
import { MAX_SKILL_DOWNLOAD_BYTES, skillSafeFetch } from './safeFetch';

const log = debug('lobe-server:user-skills');

/**
 * arckep (19.10.2026): «Мои навыки» — один сервис на два входа: инструмент помощника «сохранить навык»
 * (`arckep-skills`) и REST для экрана студии (`/api/v1/skills`). Сообщения ошибок написаны по-русски:
 * экран показывает их человеку, а модель их пересказывает.
 */

export const MAX_USER_SKILLS = 100;
/**
 * Сколько навыков помощник может добавить или заменить за час. Он сохраняет без подтверждения (решение
 * владельца 19.10.2026), а текст из чужого документа или страницы мог бы подсунуть ему «сохрани навык»:
 * предел и метка `savedVia` в шапке навыка ограничивают ущерб и показывают на экране, что добавил не человек.
 */
export const MAX_ASSISTANT_SAVES_PER_HOUR = 10;
export const MAX_SKILL_NAME_LENGTH = 100;
export const MAX_SKILL_DESCRIPTION_LENGTH = 1024;
export const MAX_SKILL_CONTENT_LENGTH = 200_000;
export const MAX_SKILL_FILES = 20;
export const MAX_SKILL_FILE_LENGTH = 200_000;
export const MAX_SKILL_FILES_TOTAL_LENGTH = 1_000_000;
const SKILL_MD = 'SKILL.md';

export type UserSkillErrorCode =
  'CONFLICT' | 'DOWNLOAD_FAILED' | 'FORBIDDEN' | 'INVALID' | 'LIMIT' | 'NOT_FOUND' | 'TOO_LARGE';

const HTTP_STATUS: Record<UserSkillErrorCode, number> = {
  CONFLICT: 409,
  DOWNLOAD_FAILED: 502,
  FORBIDDEN: 403,
  INVALID: 400,
  LIMIT: 409,
  NOT_FOUND: 404,
  TOO_LARGE: 413,
};

export class UserSkillError extends Error {
  readonly status: number;

  constructor(
    message: string,
    readonly code: UserSkillErrorCode,
  ) {
    super(message);
    this.name = 'UserSkillError';
    this.status = HTTP_STATUS[code];
  }
}

export type SkillSaveStatus = 'created' | 'unchanged' | 'updated';

/** Кто сохранил: помощник по просьбе в чате или человек на экране «Мои навыки». */
export type SkillSavedVia = 'assistant' | 'screen';

export interface SkillSaveOptions {
  via?: SkillSavedVia;
}

/** Карточка сохранённого навыка: то, что нужно экрану для «Навык добавлен». */
export interface SkillCard {
  description: string;
  id: string;
  identifier: string;
  name: string;
  source: SkillSource;
}

export interface SkillSaveResult {
  skill: SkillCard;
  status: SkillSaveStatus;
}

export interface SkillSummary extends SkillCard {
  /** Значок встроенного навыка (эмодзи); у остальных и у навыков с картинкой — null */
  avatar: string | null;
  createdAt: string | null;
  /** Удалить можно только навыки человека */
  deletable: boolean;
  hasResources: boolean;
  /** Кто сохранил последним; null — навык добавлен до появления метки или встроенный */
  savedVia: SkillSavedVia | null;
  sourceUrl: string | null;
  updatedAt: string | null;
  version: string | null;
}

export interface SkillDetail extends SkillSummary {
  content: string;
  files: Array<{ path: string; size: number }>;
  license: string | null;
}

export interface SkillTextFile {
  content: string;
  path: string;
}

export interface SkillTextInput {
  content: string;
  description: string;
  files?: SkillTextFile[];
  name: string;
}

export interface UserSkillServiceDeps {
  fileModel?: Pick<FileModel, 'findById'>;
  fileService?: Pick<FileService, 'getFileContent'>;
  importer?: Pick<SkillImporter, 'importFromUrl' | 'importFromZip'>;
  parser?: Pick<SkillParser, 'parseSkillMd'>;
  resourceService?: Pick<SkillResourceService, 'storeResources'>;
  skillModel?: Pick<
    AgentSkillModel,
    | 'create'
    | 'delete'
    | 'findAll'
    | 'findAllWithResources'
    | 'findById'
    | 'findByName'
    | 'replace'
    | 'update'
  >;
}

const encoder = new TextEncoder();

/** Относительный путь файла-приложения: без `..`, абсолютных путей и управляющих знаков. */
const normalizeFilePath = (path: string): string | null => {
  const normalized = path.replaceAll('\\', '/').replace(/^\.\//, '');
  // eslint-disable-next-line no-control-regex
  if (!normalized || normalized.startsWith('/') || /[\u0000-\u001F]/.test(normalized)) return null;
  if (normalized.split('/').some((part) => part === '' || part === '..')) return null;
  return normalized;
};

const isEmoji = (avatar?: string) => !!avatar && !avatar.startsWith('data:') && avatar.length <= 16;

const toIso = (date?: Date | string | null) => (date ? new Date(date).toISOString() : null);

const isUniqueViolation = (error: unknown) =>
  (error as { code?: string; cause?: { code?: string } })?.code === '23505' ||
  (error as { cause?: { code?: string } })?.cause?.code === '23505';

export class UserSkillService {
  private readonly fileModel: Pick<FileModel, 'findById'>;
  private readonly fileService: Pick<FileService, 'getFileContent'>;
  private readonly importer: Pick<SkillImporter, 'importFromUrl' | 'importFromZip'>;
  private readonly parser: Pick<SkillParser, 'parseSkillMd'>;
  private readonly resourceService: Pick<SkillResourceService, 'storeResources'>;
  private readonly skillModel: NonNullable<UserSkillServiceDeps['skillModel']>;

  constructor(db: LobeChatDatabase, userId: string, deps: UserSkillServiceDeps = {}) {
    this.skillModel = deps.skillModel ?? new AgentSkillModel(db, userId);
    this.fileModel = deps.fileModel ?? new FileModel(db, userId);
    this.fileService = deps.fileService ?? new FileService(db, userId);
    this.resourceService = deps.resourceService ?? new SkillResourceService(db, userId);
    this.parser = deps.parser ?? new SkillParser();
    this.importer = deps.importer ?? new SkillImporter(db, userId, { fetchImpl: skillSafeFetch });
  }

  // ---------------------------------------------------------------- чтение

  /** Навыки человека и встроенные (те, что виден помощнику в этом движке), с источником. */
  async list(): Promise<{ skills: SkillSummary[]; total: number }> {
    const rows = await this.skillModel.findAllWithResources();
    const mine = rows.map((row) => this.toSummary(row, row.resources));
    const builtin = filterBuiltinSkills(builtinSkills).map((skill): SkillSummary => ({
      avatar: isEmoji(skill.avatar) ? skill.avatar! : null,
      createdAt: null,
      deletable: false,
      description: skill.description,
      hasResources: Object.keys(skill.resources ?? {}).length > 0,
      id: skill.identifier,
      identifier: skill.identifier,
      name: skill.name,
      savedVia: null,
      source: 'builtin',
      sourceUrl: null,
      updatedAt: null,
      version: null,
    }));

    const skills = [...mine, ...builtin];
    return { skills, total: skills.length };
  }

  /** Один навык: по номеру записи или по идентификатору встроенного. */
  async get(id: string): Promise<SkillDetail | null> {
    const builtin = filterBuiltinSkills(builtinSkills).find((skill) => skill.identifier === id);
    if (builtin) {
      const summary = (await this.list()).skills.find((skill) => skill.id === builtin.identifier)!;
      return {
        ...summary,
        content: builtin.content,
        files: Object.entries(builtin.resources ?? {}).map(([path, meta]) => ({
          path,
          size: meta.size,
        })),
        license: null,
      };
    }

    const skill = await this.skillModel.findById(id);
    if (!skill) return null;

    return {
      ...this.toSummary(skill, skill.resources),
      content: skill.content ?? '',
      files: Object.entries(skill.resources ?? {}).map(([path, meta]) => ({
        path,
        size: meta.size,
      })),
      license: typeof skill.manifest?.license === 'string' ? skill.manifest.license : null,
    };
  }

  // ---------------------------------------------------------------- запись

  /**
   * Навык из текста: имя, описание, тело SKILL.md и (по желанию) файлы-приложения.
   * Имя занято: без `replace` — ошибка CONFLICT; с `replace` обновляется только навык, который человек
   * создал сам (источник user), импортированный по ссылке заменить нельзя.
   */
  async createFromText(
    input: SkillTextInput,
    options: { replace?: boolean } & SkillSaveOptions = {},
  ): Promise<SkillSaveResult> {
    const { content, description, files, name } = this.validateText(input);

    const clash = this.builtinNameClash(name);
    if (clash) {
      throw new UserSkillError(
        `Имя «${name}» занято встроенным навыком. Выберите другое название.`,
        'CONFLICT',
      );
    }

    const existing = await this.skillModel.findByName(name);
    if (existing && !options.replace) {
      throw new UserSkillError(
        `Навык «${name}» уже есть. Чтобы заменить его новым текстом, повторите с replace=true; иначе выберите другое название.`,
        'CONFLICT',
      );
    }
    if (existing && existing.source !== 'user') {
      throw new UserSkillError(
        `Навык «${name}» добавлен по ссылке или из каталога, заменить его текстом нельзя. Выберите другое название или удалите его в «Мои навыки».`,
        'CONFLICT',
      );
    }
    await this.ensureRoom(options.via, { replacing: !!existing });

    const resources = await this.storeFiles(files);
    const manifest = { description, name, ...(options.via ? { savedVia: options.via } : {}) };

    try {
      if (existing) {
        const updated = await this.skillModel.replace(existing.id, {
          content,
          description,
          manifest,
          resources,
        });
        return { skill: this.toCard(updated ?? existing), status: 'updated' };
      }

      const created = await this.skillModel.create({
        content,
        description,
        identifier: `user.${nanoid(12)}`,
        manifest,
        name,
        resources,
        source: 'user',
      });
      return { skill: this.toCard(created), status: 'created' };
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new UserSkillError(`Навык «${name}» уже есть.`, 'CONFLICT');
      }
      throw error;
    }
  }

  /** Навык по ссылке: SKILL.md, репозиторий или папка GitHub, zip. Только https. */
  async importFromUrl(url: string, options: SkillSaveOptions = {}): Promise<SkillSaveResult> {
    let parsed: URL;
    try {
      parsed = new URL(url.trim());
    } catch {
      throw new UserSkillError('Это не ссылка. Нужен адрес вида https://…', 'INVALID');
    }
    if (parsed.protocol !== 'https:') {
      throw new UserSkillError('Принимаются только ссылки https://', 'INVALID');
    }

    await this.ensureRoom(options.via);
    return this.runImport(() => this.importer.importFromUrl({ url: parsed.href }), options.via);
  }

  /** Навык из файла, который человек приложил в чат: zip с SKILL.md или сам SKILL.md. */
  async importFromFile(fileId: string, options: SkillSaveOptions = {}): Promise<SkillSaveResult> {
    // findById ищет среди файлов этого человека: чужой номер вернёт пусто
    const file = await this.fileModel.findById(fileId);
    if (!file)
      throw new UserSkillError('Файл не найден. Приложите его в чат ещё раз.', 'NOT_FOUND');

    if ((file.size ?? 0) > MAX_SKILL_DOWNLOAD_BYTES) {
      throw new UserSkillError(
        `Файл слишком большой (лимит ${MAX_SKILL_DOWNLOAD_BYTES / 1024 / 1024} МБ).`,
        'TOO_LARGE',
      );
    }

    const name = (file.name ?? '').toLowerCase();
    const type = (file.fileType ?? '').toLowerCase();

    await this.ensureRoom(options.via);

    if (name.endsWith('.zip') || type.includes('zip')) {
      return this.runImport(() => this.importer.importFromZip({ zipFileId: fileId }), options.via);
    }

    if (/\.(?:md|markdown|txt)$/.test(name) || type.startsWith('text/')) {
      const text = await this.fileService.getFileContent(file.url ?? '');
      let parsed;
      try {
        parsed = this.parser.parseSkillMd(text);
      } catch (error) {
        const translated = this.translateImportError(error);
        // В простом тексте без шапки имени и описания нет: пусть помощник придумает их и сохранит текстом.
        throw translated instanceof UserSkillError && translated.code === 'INVALID'
          ? new UserSkillError(
              `${translated.message} Если в файле просто текст навыка, придумайте название и описание и сохраните его как текст.`,
              'INVALID',
            )
          : translated;
      }
      return this.createFromText(
        {
          content: parsed.content,
          description: parsed.manifest.description,
          name: parsed.manifest.name,
        },
        { via: options.via },
      );
    }

    throw new UserSkillError('Нужен zip-архив с файлом SKILL.md или сам файл SKILL.md.', 'INVALID');
  }

  async remove(id: string): Promise<{ id: string }> {
    if (filterBuiltinSkills(builtinSkills).some((skill) => skill.identifier === id)) {
      throw new UserSkillError('Встроенный навык удалить нельзя.', 'FORBIDDEN');
    }

    const skill = await this.skillModel.findById(id);
    if (!skill) throw new UserSkillError('Навык не найден.', 'NOT_FOUND');

    // Существование проверено выше; счётчик затронутых строк у разных драйверов базы разный, на него не
    // полагаемся: повторное удаление безвредно.
    await this.skillModel.delete(id);
    return { id };
  }

  // ---------------------------------------------------------------- внутреннее

  private toCard(skill: Pick<SkillItem, 'description' | 'id' | 'identifier' | 'name' | 'source'>) {
    return {
      description: skill.description ?? '',
      id: skill.id,
      identifier: skill.identifier,
      name: skill.name,
      source: skill.source,
    } satisfies SkillCard;
  }

  private toSummary(
    skill: SkillListItem,
    resources?: Record<string, SkillResourceMeta> | null,
  ): SkillSummary {
    const manifest = (skill.manifest ?? {}) as {
      savedVia?: unknown;
      sourceUrl?: unknown;
      version?: unknown;
    };
    return {
      ...this.toCard(skill),
      avatar: null,
      createdAt: toIso(skill.createdAt),
      deletable: true,
      hasResources: Object.keys(resources ?? {}).length > 0 || !!skill.zipFileHash,
      savedVia:
        manifest.savedVia === 'assistant' || manifest.savedVia === 'screen'
          ? manifest.savedVia
          : null,
      sourceUrl: typeof manifest.sourceUrl === 'string' ? manifest.sourceUrl : null,
      updatedAt: toIso(skill.updatedAt),
      version: typeof manifest.version === 'string' ? manifest.version : null,
    };
  }

  private builtinNameClash(name: string): boolean {
    const lower = name.toLowerCase();
    return builtinSkills.some(
      (skill) => skill.name.toLowerCase() === lower || skill.identifier.toLowerCase() === lower,
    );
  }

  /**
   * Место под навык: общий предел числа навыков (новый навык, не замена) и предел «за час» для помощника.
   */
  private async ensureRoom(via?: SkillSavedVia, options: { replacing?: boolean } = {}) {
    const { data, total } = await this.skillModel.findAll();

    if (!options.replacing && total >= MAX_USER_SKILLS) {
      throw new UserSkillError(
        `У вас уже ${MAX_USER_SKILLS} навыков — это предел. Удалите ненужные в «Мои навыки».`,
        'LIMIT',
      );
    }

    if (via === 'assistant') {
      const hourAgo = Date.now() - 60 * 60 * 1000;
      const recent = data.filter(
        (skill) =>
          (skill.manifest as { savedVia?: unknown } | undefined)?.savedVia === 'assistant' &&
          new Date(skill.updatedAt).getTime() > hourAgo,
      ).length;
      if (recent >= MAX_ASSISTANT_SAVES_PER_HOUR) {
        throw new UserSkillError(
          `Помощник уже сохранил ${MAX_ASSISTANT_SAVES_PER_HOUR} навыков за последний час — это предел. Подождите или добавьте навык сами на экране «Мои навыки».`,
          'LIMIT',
        );
      }
    }
  }

  private validateText(input: SkillTextInput): Required<SkillTextInput> {
    const name = (input.name ?? '').trim();
    // Имя попадает в разметку списка навыков в запросе: кавычки и скобки там ломали бы теги.
    // eslint-disable-next-line no-control-regex
    if (!name || name.length > MAX_SKILL_NAME_LENGTH || /["<>\u0000-\u001F]/.test(name)) {
      throw new UserSkillError(
        `Название навыка: от 1 до ${MAX_SKILL_NAME_LENGTH} знаков, без кавычек, угловых скобок и переводов строк.`,
        'INVALID',
      );
    }

    const description = (input.description ?? '').trim();
    if (!description || description.length > MAX_SKILL_DESCRIPTION_LENGTH) {
      throw new UserSkillError(
        `Описание навыка: от 1 до ${MAX_SKILL_DESCRIPTION_LENGTH} знаков — что он делает и когда его включать.`,
        'INVALID',
      );
    }

    let content = (input.content ?? '').trim();
    // Тело SKILL.md целиком, с шапкой: шапку убираем, чтобы она не дублировалась при включении навыка.
    if (content.startsWith('---')) {
      try {
        content = this.parser.parseSkillMd(content).content;
      } catch {
        // шапка не разобралась — оставляем текст как есть
      }
    }
    if (!content || content.length > MAX_SKILL_CONTENT_LENGTH) {
      throw new UserSkillError(
        `Текст навыка: от 1 до ${MAX_SKILL_CONTENT_LENGTH} знаков.`,
        content ? 'TOO_LARGE' : 'INVALID',
      );
    }

    const files = input.files ?? [];
    if (files.length > MAX_SKILL_FILES) {
      throw new UserSkillError(`Файлов-приложений не больше ${MAX_SKILL_FILES}.`, 'TOO_LARGE');
    }
    const seen = new Set<string>();
    let total = 0;
    const normalized: SkillTextFile[] = [];
    for (const file of files) {
      const path = normalizeFilePath(file.path ?? '');
      if (!path || path === SKILL_MD) {
        throw new UserSkillError(
          `Недопустимый путь файла «${file.path}»: нужен относительный путь вроде scripts/run.py (SKILL.md занят).`,
          'INVALID',
        );
      }
      if (seen.has(path)) {
        throw new UserSkillError(`Файл «${path}» указан дважды.`, 'INVALID');
      }
      seen.add(path);
      const text = typeof file.content === 'string' ? file.content : '';
      if (text.length > MAX_SKILL_FILE_LENGTH) {
        throw new UserSkillError(`Файл «${path}» слишком большой.`, 'TOO_LARGE');
      }
      total += text.length;
      if (total > MAX_SKILL_FILES_TOTAL_LENGTH) {
        throw new UserSkillError('Файлы-приложения вместе слишком большие.', 'TOO_LARGE');
      }
      normalized.push({ content: text, path });
    }

    return { content, description, files: normalized, name };
  }

  /** Файлы-приложения → хранилище; ключ — хеш набора, одинаковые наборы не дублируются. */
  private async storeFiles(files: SkillTextFile[]): Promise<Record<string, SkillResourceMeta>> {
    if (files.length === 0) return {};

    const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
    const hash = sha256(JSON.stringify(sorted.map((file) => [file.path, file.content])));
    const buffers = new Map(
      sorted.map((file) => [file.path, Buffer.from(encoder.encode(file.content))]),
    );
    return this.resourceService.storeResources(hash, buffers);
  }

  /** Импорт с переводом ошибок импортёра в понятные человеку. */
  private async runImport(
    run: () => Promise<SkillImportResult>,
    via?: SkillSavedVia,
  ): Promise<SkillSaveResult> {
    try {
      const result = await run();
      // Метка «кто сохранил» — в шапке навыка (update сливает manifest вглубь, остальное не трогает).
      if (via && result.status !== 'unchanged') {
        await this.skillModel.update(result.skill.id, {
          manifest: { savedVia: via } as unknown as SkillItem['manifest'],
        });
      }
      return { skill: this.toCard(result.skill), status: result.status };
    } catch (error) {
      throw this.translateImportError(error);
    }
  }

  private translateImportError(error: unknown): Error {
    if (error instanceof UserSkillError) return error;

    if (error instanceof SkillImportError) {
      const map: Record<SkillImportError['code'], [string, UserSkillErrorCode]> = {
        CONFLICT: [
          `${error.message}. Удалите старый навык в «Мои навыки» или выберите другое название.`,
          'CONFLICT',
        ],
        DOWNLOAD_FAILED: [`Не удалось скачать: ${error.message}`, 'DOWNLOAD_FAILED'],
        FILE_NOT_FOUND: ['Файл не найден. Приложите его в чат ещё раз.', 'NOT_FOUND'],
        INVALID_URL: [`Ссылка не подходит: ${error.message}`, 'INVALID'],
        NOT_FOUND: [`Не найдено по ссылке: ${error.message}`, 'NOT_FOUND'],
      };
      const [message, code] = map[error.code];
      return new UserSkillError(message, code);
    }

    if (error instanceof SkillManifestError) {
      return new UserSkillError(
        `В шапке SKILL.md должны быть поля name и description. ${error.message}`,
        'INVALID',
      );
    }
    if (error instanceof SkillParseError) {
      return new UserSkillError(`Не удалось разобрать навык: ${error.message}`, 'INVALID');
    }

    const message = (error as Error)?.message ?? String(error);
    log('import failed: %O', error);
    // Ошибки защищённой загрузки (внутренний адрес, не https, слишком большой ответ)
    if (/SSRF blocked|Only https|not allowed|over limit|Invalid URL/i.test(message)) {
      return new UserSkillError(
        'Эта ссылка недоступна для загрузки: нужен публичный адрес https и файл до 10 МБ.',
        'INVALID',
      );
    }
    return error as Error;
  }
}
