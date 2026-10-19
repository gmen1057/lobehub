import { builtinSkills } from '@lobechat/builtin-skills';
import { type CommandResult } from '@lobechat/builtin-tool-skills';
import {
  type ExportFileResult,
  type SkillRuntimeService,
} from '@lobechat/builtin-tool-skills/executionRuntime';
import { getMimeType } from '@lobechat/utils';
import debug from 'debug';
import { sha256 } from 'js-sha256';

import { fileEnv } from '@/envs/file';
import { filterBuiltinSkills } from '@/helpers/skillFilters';
import { type FileService } from '@/server/services/file';
import { type SkillResourceService } from '@/server/services/skill/resource';
import {
  safeRelativePath,
  SANDBOX_MAX_EXPORT_BYTES,
  type SandboxFile,
  skillFolderName,
  type SkillSandbox,
} from '@/server/services/skillSandbox';
import { nanoid } from '@/utils/uuid';

const log = debug('lobe-server:skills-runtime-headless');

const encoder = new TextEncoder();

const failure = (stderr: string): CommandResult => ({
  exitCode: 1,
  output: '',
  stderr,
  success: false,
});

/** Имя файла для ключа в хранилище и для человека: без путей и странных знаков. */
const safeFilename = (name: string): string => {
  const base = name.split(/[/\\]/).pop() || 'file';
  return base.replaceAll(/[^\w.-]/g, '_').slice(0, 120) || 'file';
};

interface ResolvedSkillFiles {
  files: SandboxFile[];
  identifier: string;
}

/**
 * arckep (19.10.2026): инструменты навыков для движка без интерфейса. Справочники и поиск навыков — как в
 * апстриме (делегируются базовой службе), а команды и файлы идут в песочницу человека (E2B) через шлюз
 * коннекторов. Подтверждений нет: песочница изолирована и платная для человека.
 */
export class HeadlessSkillRuntimeService implements SkillRuntimeService {
  constructor(
    private readonly deps: {
      base: Pick<SkillRuntimeService, 'findAll' | 'findById' | 'findByName' | 'readResource'>;
      fileService: Pick<FileService, 'createFileRecord' | 'uploadBuffer'>;
      resourceService: Pick<SkillResourceService, 'readResource'>;
      sandbox: Pick<SkillSandbox, 'readFile' | 'runCommand'>;
      topicId: string;
    },
  ) {}

  findAll: SkillRuntimeService['findAll'] = () => this.deps.base.findAll();

  findById: SkillRuntimeService['findById'] = (id) => this.deps.base.findById(id);

  findByName: SkillRuntimeService['findByName'] = (name) => this.deps.base.findByName(name);

  readResource: SkillRuntimeService['readResource'] = (id, path) =>
    this.deps.base.readResource(id, path);

  runCommand = async (options: { command: string }): Promise<CommandResult> =>
    this.deps.sandbox.runCommand(options.command);

  execScript = async (
    command: string,
    options: { activatedSkills?: Array<{ id: string; name: string }>; description: string },
  ): Promise<CommandResult> => {
    const names = [...new Set((options.activatedSkills ?? []).map((skill) => skill.name))];
    if (names.length === 0) {
      return failure('execScript needs the `skill` parameter: the name of the activated skill.');
    }

    const resolved = await Promise.all(names.map((name) => this.resolveSkillFiles(name)));
    const missing = names.filter((_, index) => !resolved[index]);
    if (missing.length > 0) {
      const { data } = await this.deps.base.findAll();
      const available = [
        ...filterBuiltinSkills(builtinSkills).map((skill) => skill.name),
        ...data.map((skill) => skill.name),
      ].join(', ');
      return failure(`Skill "${missing[0]}" not found. Available skills: ${available}`);
    }

    // Файлы всех названных навыков раскладываются рядом: ~/skills/<навык>/…; команда идёт из папки первого.
    const [first, ...rest] = resolved as ResolvedSkillFiles[];
    const firstFolder = `skills/${skillFolderName(first.identifier)}`;
    const files: SandboxFile[] = [
      ...first.files,
      ...rest.flatMap((skill) =>
        skill.files.map((file) => ({
          content: file.content,
          path: `../${skillFolderName(skill.identifier)}/${file.path}`,
        })),
      ),
    ];

    return this.deps.sandbox.runCommand(command, { cwd: firstFolder, files });
  };

  exportFile = async (path: string, filename: string): Promise<ExportFileResult> => {
    const read = await this.deps.sandbox.readFile(path);
    if (!read.ok) return { error: read.message, filename, success: false };

    const buffer = Buffer.from(read.base64, 'base64');
    if (buffer.length > SANDBOX_MAX_EXPORT_BYTES) {
      return {
        error: `The file is too large (${buffer.length} bytes, limit ${SANDBOX_MAX_EXPORT_BYTES}).`,
        filename,
        success: false,
      };
    }

    try {
      const name = safeFilename(filename);
      const mimeType = getMimeType(name);
      const today = new Date().toISOString().split('T')[0];
      const key = `${fileEnv.NEXT_PUBLIC_S3_FILE_PATH}/skills/exports/${today}/${this.deps.topicId}/${nanoid()}-${name}`;

      await this.deps.fileService.uploadBuffer(key, buffer, mimeType);
      const { fileId } = await this.deps.fileService.createFileRecord({
        fileHash: sha256(buffer),
        fileType: mimeType,
        name,
        size: buffer.length,
        url: key,
      });

      log('exported %s -> file %s (%d bytes)', path, fileId, buffer.length);

      // Ссылка `${APP_URL}/f/<id>` людям недоступна (nginx не отдаёт её движку), поэтому модели её не
      // показываем: экран студии берёт файл по fileId у бэкенда (GET /files/<id>/url).
      return {
        fileId,
        filename: name,
        mimeType,
        note: [
          `File saved: ${name} (${buffer.length} bytes, ${mimeType}). The chat shows it to the person as a file card — do not paste any link or path.`,
          `ARCKEP_FILE ${JSON.stringify({ fileId, filename: name, mimeType, size: buffer.length })}`,
        ].join('\n'),
        size: buffer.length,
        success: true,
      };
    } catch (error) {
      log('export upload failed: %O', error);
      return {
        error: `Could not save the file: ${(error as Error).message}`,
        filename,
        success: false,
      };
    }
  };

  /** Файлы навыка для песочницы: SKILL.md и справочники. Встроенные берутся из пакета, остальные — из хранилища. */
  private async resolveSkillFiles(name: string): Promise<ResolvedSkillFiles | null> {
    const builtin = filterBuiltinSkills(builtinSkills).find((skill) => skill.name === name);
    if (builtin) {
      const files: SandboxFile[] = [
        { content: encoder.encode(builtin.content), path: 'SKILL.md' },
        ...Object.entries(builtin.resources ?? {}).flatMap(([path, meta]) => {
          const safe = safeRelativePath(path);
          return safe && meta.content !== undefined
            ? [{ content: encoder.encode(meta.content), path: safe }]
            : [];
        }),
      ];
      return { files, identifier: builtin.identifier };
    }

    const skill = await this.deps.base.findByName(name);
    if (!skill) return null;

    const files: SandboxFile[] = [
      { content: encoder.encode(skill.content ?? ''), path: 'SKILL.md' },
    ];
    const resources = skill.resources ?? {};
    for (const path of Object.keys(resources)) {
      const safe = safeRelativePath(path);
      if (!safe) {
        log('skipping unsafe resource path %j of skill %s', path, skill.identifier);
        continue;
      }
      const resource = await this.deps.resourceService.readResource(resources, path);
      files.push({
        content:
          resource.encoding === 'base64'
            ? Buffer.from(resource.content, 'base64')
            : encoder.encode(resource.content),
        path: safe,
      });
    }

    return { files, identifier: skill.identifier };
  }
}
