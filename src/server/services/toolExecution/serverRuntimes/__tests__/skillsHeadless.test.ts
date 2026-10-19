// @vitest-environment node
import { builtinSkills } from '@lobechat/builtin-skills';
import { SkillsExecutionRuntime } from '@lobechat/builtin-tool-skills/executionRuntime';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { filterBuiltinSkills } from '@/helpers/skillFilters';

import { HeadlessSkillRuntimeService } from '../skillsHeadless';

// arckep (19.10.2026): команды и файлы навыков в движке без интерфейса идут в песочницу, а не в облако LobeHub.

beforeEach(() => {
  vi.stubEnv('ARCKEP_HEADLESS_TOOLS', '1');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const dbSkill = {
  content: '# PDF\nrun scripts/fill.py',
  description: 'Fill PDF forms',
  id: 'skill_1',
  identifier: 'github.anthropics.skills.pdf',
  name: 'pdf-forms',
  resources: {
    'forms.md': { fileHash: 'h1', size: 5 },
    'scripts/fill.py': { fileHash: 'h2', size: 20 },
    'assets/blank.pdf': { fileHash: 'h3', size: 4 },
    '../evil.sh': { fileHash: 'h4', size: 1 },
  },
  source: 'market',
};

const make = (overrides: Record<string, unknown> = {}) => {
  const sandbox = {
    readFile: vi.fn(async () => ({
      base64: Buffer.from('%PDF-1.4 hello').toString('base64'),
      filename: 'report.pdf',
      ok: true as const,
      size: 14,
    })),
    runCommand: vi.fn(async (_command: string, _options?: unknown) => ({
      exitCode: 0,
      output: 'ok',
      stderr: '',
      success: true,
    })),
  };
  const fileService = {
    createFileRecord: vi.fn(async () => ({
      fileId: 'file_9',
      url: 'https://arckep.ru/chat/f/file_9',
    })),
    uploadBuffer: vi.fn(async () => ({ key: 'k' })),
  };
  const resourceService = {
    readResource: vi.fn(async (_resources: unknown, path: string) => ({
      content: path.endsWith('.pdf') ? Buffer.from('%PDF').toString('base64') : `text of ${path}`,
      encoding: path.endsWith('.pdf') ? ('base64' as const) : ('utf8' as const),
      fileHash: 'x',
      fileType: 'text/plain',
      path,
      size: 1,
    })),
  };
  const base = {
    findAll: vi.fn(async () => ({ data: [{ name: 'pdf-forms' }] as any, total: 1 })),
    findById: vi.fn(async () => dbSkill as any),
    findByName: vi.fn(async (name: string) =>
      name === 'pdf-forms' ? (dbSkill as any) : undefined,
    ),
    readResource: vi.fn(),
  };
  const service = new HeadlessSkillRuntimeService({
    base,
    fileService,
    resourceService,
    sandbox,
    topicId: 'tpc_77',
    ...overrides,
  } as any);
  return { base, fileService, resourceService, sandbox, service };
};

describe('HeadlessSkillRuntimeService.runCommand', () => {
  it('отдаёт команду песочнице как есть', async () => {
    const { sandbox, service } = make();
    const result = await service.runCommand({ command: 'ls -la' });
    expect(result.success).toBe(true);
    expect(sandbox.runCommand).toHaveBeenCalledWith('ls -la');
  });
});

describe('HeadlessSkillRuntimeService.execScript', () => {
  it('без имени навыка — понятная ошибка, песочница не трогается', async () => {
    const { sandbox, service } = make();
    const result = await service.execScript('python x.py', { description: 'run' });
    expect(result.success).toBe(false);
    expect(result.stderr).toContain('`skill`');
    expect(sandbox.runCommand).not.toHaveBeenCalled();
  });

  it('навык человека: SKILL.md и справочники раскладываются в ~/skills/<identifier>, небезопасные пути пропускаются', async () => {
    const { resourceService, sandbox, service } = make();

    await service.execScript('python scripts/fill.py', {
      activatedSkills: [{ id: 'pdf-forms', name: 'pdf-forms' }],
      description: 'fill',
    });

    expect(sandbox.runCommand).toHaveBeenCalledTimes(1);
    const [command, options] = sandbox.runCommand.mock.calls[0] as unknown as [
      string,
      { cwd: string; files: Array<{ content: Uint8Array; path: string }> },
    ];
    expect(command).toBe('python scripts/fill.py');
    expect(options.cwd).toBe('skills/github.anthropics.skills.pdf');
    expect(options.files.map((file) => file.path)).toEqual([
      'SKILL.md',
      'forms.md',
      'scripts/fill.py',
      'assets/blank.pdf',
    ]);
    expect(Buffer.from(options.files[0].content).toString()).toContain('run scripts/fill.py');
    expect(Buffer.from(options.files[2].content).toString()).toBe('text of scripts/fill.py');
    // бинарный справочник приходит как base64 и кладётся байтами
    expect(Buffer.from(options.files[3].content).toString()).toBe('%PDF');
    // '../evil.sh' не читался вовсе
    expect(resourceService.readResource).toHaveBeenCalledTimes(3);
  });

  it('встроенный навык: SKILL.md и справочники из пакета, чтения базы нет', async () => {
    const { base, sandbox, service } = make();
    const seo = filterBuiltinSkills(builtinSkills).find((skill) => skill.name === 'SEO Demand')!;

    await service.execScript('cat references/workflow', {
      activatedSkills: [{ id: seo.name, name: seo.name }],
      description: 'read',
    });

    const options = sandbox.runCommand.mock.calls[0][1] as unknown as {
      cwd: string;
      files: Array<{ path: string }>;
    };
    expect(options.cwd).toBe('skills/seo-demand');
    expect(options.files.map((file) => file.path)).toEqual(['SKILL.md', 'references/workflow']);
    expect(base.findByName).not.toHaveBeenCalled();
  });

  it('несколько навыков: команда идёт из папки первого, файлы второго лежат рядом', async () => {
    const { sandbox, service } = make();
    await service.execScript('ls ..', {
      activatedSkills: [
        { id: 'SEO Demand', name: 'SEO Demand' },
        { id: 'Content Articles', name: 'Content Articles' },
      ],
      description: 'list',
    });

    const options = sandbox.runCommand.mock.calls[0][1] as unknown as {
      cwd: string;
      files: Array<{ path: string }>;
    };
    expect(options.cwd).toBe('skills/seo-demand');
    expect(options.files.map((file) => file.path)).toEqual([
      'SKILL.md',
      'references/workflow',
      '../content-articles/SKILL.md',
      '../content-articles/references/article-brief',
    ]);
  });

  it('неизвестный навык — ошибка со списком доступных', async () => {
    const { sandbox, service } = make();
    const result = await service.execScript('ls', {
      activatedSkills: [{ id: 'nope', name: 'nope' }],
      description: 'x',
    });
    expect(result.success).toBe(false);
    expect(result.stderr).toContain('Skill "nope" not found');
    expect(result.stderr).toContain('pdf-forms');
    expect(result.stderr).toContain('SEO Demand');
    expect(sandbox.runCommand).not.toHaveBeenCalled();
  });
});

describe('HeadlessSkillRuntimeService.exportFile', () => {
  it('сохраняет файл в хранилище, возвращает fileId и текст без ссылки', async () => {
    const { fileService, sandbox, service } = make();
    const result = await service.exportFile('output/report.pdf', 'Квартальный отчёт.pdf');

    expect(sandbox.readFile).toHaveBeenCalledWith('output/report.pdf');
    expect(result.success).toBe(true);
    expect(result.fileId).toBe('file_9');
    expect(result.mimeType).toBe('application/pdf');
    expect(result.size).toBe(14);

    const [key, buffer, mime] = fileService.uploadBuffer.mock.calls[0] as unknown as [
      string,
      Buffer,
      string,
    ];
    expect(key).toMatch(/\/skills\/exports\/\d{4}-\d{2}-\d{2}\/tpc_77\/.+\.pdf$/);
    expect(key).not.toContain('Квартальный');
    expect(buffer.toString()).toBe('%PDF-1.4 hello');
    expect(mime).toBe('application/pdf');

    expect(fileService.createFileRecord).toHaveBeenCalledWith(
      expect.objectContaining({ fileType: 'application/pdf', size: 14, url: key }),
    );
    // модели не отдаётся адрес /f/<id>: людям он недоступен
    expect(result.note).not.toContain('http');
    expect(result.note).toContain('ARCKEP_FILE {"fileId":"file_9"');
  });

  it('нет файла в песочнице — причина доходит до модели', async () => {
    const { fileService, sandbox, service } = make();
    sandbox.readFile.mockResolvedValueOnce({
      message: 'File not found: out.pdf',
      ok: false,
    } as any);

    const result = await service.exportFile('out.pdf', 'out.pdf');

    expect(result).toEqual({
      error: 'File not found: out.pdf',
      filename: 'out.pdf',
      success: false,
    });
    expect(fileService.uploadBuffer).not.toHaveBeenCalled();
  });

  it('слишком большой файл не сохраняется', async () => {
    const { fileService, sandbox, service } = make();
    sandbox.readFile.mockResolvedValueOnce({
      base64: Buffer.alloc(25 * 1024 * 1024 + 1).toString('base64'),
      filename: 'big.bin',
      ok: true,
      size: 25 * 1024 * 1024 + 1,
    });

    const result = await service.exportFile('big.bin', 'big.bin');

    expect(result.success).toBe(false);
    expect(result.error).toContain('too large');
    expect(fileService.uploadBuffer).not.toHaveBeenCalled();
    expect(fileService.createFileRecord).not.toHaveBeenCalled();
  });

  it('ошибка хранилища не роняет вызов', async () => {
    const { fileService, service } = make();
    fileService.uploadBuffer.mockRejectedValueOnce(new Error('S3 down'));

    const result = await service.exportFile('a.txt', 'a.txt');

    expect(result.success).toBe(false);
    expect(result.error).toContain('S3 down');
  });
});

describe('HeadlessSkillRuntimeService без песочницы (аккаунт не из студии)', () => {
  const reason = 'The sandbox is available only to Arckep accounts: open the chat from arckep.ru.';
  const makeClosed = () => {
    const { base, fileService, resourceService } = make();
    return new HeadlessSkillRuntimeService({
      base,
      fileService,
      resourceService,
      sandboxUnavailable: reason,
      topicId: 'tpc_77',
    } as any);
  };

  it('команды, скрипты и экспорт файлов отказывают с понятной причиной', async () => {
    const service = makeClosed();

    expect(await service.runCommand({ command: 'ls' })).toMatchObject({
      stderr: reason,
      success: false,
    });
    expect(
      await service.execScript('ls', {
        activatedSkills: [{ id: 'x', name: 'SEO Demand' }],
        description: 'x',
      }),
    ).toMatchObject({ stderr: reason, success: false });
    expect(await service.exportFile('a.txt', 'a.txt')).toEqual({
      error: reason,
      filename: 'a.txt',
      success: false,
    });
  });

  it('справочники навыков по-прежнему читаются', async () => {
    const result = await new SkillsExecutionRuntime({
      builtinSkills: filterBuiltinSkills(builtinSkills),
      service: makeClosed(),
    }).readReference({ id: 'SEO Demand', path: 'references/workflow' });
    expect(result.success).toBe(true);
  });
});

describe('SkillsExecutionRuntime поверх HeadlessSkillRuntimeService', () => {
  const runtimeFor = (service: HeadlessSkillRuntimeService) =>
    new SkillsExecutionRuntime({ builtinSkills: filterBuiltinSkills(builtinSkills), service });

  it('execScript с параметром skill передаёт его как активированный навык', async () => {
    const { sandbox, service } = make();
    const result = await runtimeFor(service).execScript({
      command: 'python scripts/fill.py',
      description: 'fill form',
      skill: 'pdf-forms',
    });

    expect(result.success).toBe(true);
    expect((sandbox.runCommand.mock.calls[0][1] as any).cwd).toBe(
      'skills/github.anthropics.skills.pdf',
    );
  });

  it('exportFile: модель видит fileId и маркер для экрана, а не адрес загрузки', async () => {
    const { service } = make();
    const result = await runtimeFor(service).exportFile({ filename: 'r.pdf', path: 'r.pdf' });

    expect(result.success).toBe(true);
    expect(result.content).toContain('ARCKEP_FILE');
    expect(result.content).not.toContain('Download URL');
    expect(result.state).toMatchObject({ fileId: 'file_9', mimeType: 'application/pdf', size: 14 });
  });

  it('exportFile: при неудаче модель видит причину', async () => {
    const { sandbox, service } = make();
    sandbox.readFile.mockResolvedValueOnce({ message: 'File not found: r.pdf', ok: false } as any);

    const result = await runtimeFor(service).exportFile({ filename: 'r.pdf', path: 'r.pdf' });

    expect(result.success).toBe(false);
    expect(result.content).toBe('Failed to export file: r.pdf — File not found: r.pdf');
  });

  it('readReference встроенного навыка читает справочник из пакета', async () => {
    const { service } = make();
    const result = await runtimeFor(service).readReference({
      id: 'Yandex Direct Guide',
      path: 'references/structure',
    });
    expect(result.success).toBe(true);
    expect(result.state).toMatchObject({ path: 'references/structure' });
  });
});
