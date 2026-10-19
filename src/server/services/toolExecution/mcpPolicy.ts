import {
  ARCKEP_STUDIO_CONNECTOR_PREFIX,
  ARCKEP_USER_MCP_PREFIX,
  isArckepUserMcpId,
} from '@lobechat/builtin-tools';

/**
 * arckep (19.10.2026, этап 3 «свои инструменты», п. 3.Е): защита MCP-клиента движка.
 *
 * Движок стоит рядом с внутренними службами (бэкенд студии, шлюз подключений, база), а манифест подключения —
 * данные человека. Поэтому:
 *  - stdio-подключения на сервере выключены: это запуск программы на хосте;
 *  - у подключений `mcp-arckep-*` адрес только из своего списка: шлюз (`ARCKEP_MCP_GATEWAY_URL_PREFIX`,
 *    по умолчанию http://127.0.0.1:8410/mcp/) и MCP студии (`ARCKEP_STUDIO_MCP_URL`);
 *  - у своих `umcp-*` адрес вообще не из строки базы, а из окружения (USER_MCP_GATEWAY_URL);
 *  - остальные сетевые подключения в безголовом режиме (ARCKEP_HEADLESS_TOOLS=1) отклоняются: экран студии
 *    ставит только подключения из каталога;
 *  - `X-Arckep-User` уходит только на шлюз и MCP студии (см. `isInternalConnectorUrl`).
 */
export const DEFAULT_GATEWAY_URL_PREFIX = 'http://127.0.0.1:8410/mcp/';
export const DEFAULT_STUDIO_MCP_URL = 'http://127.0.0.1:8422/mcp';

export const getGatewayUrlPrefix = (): string =>
  process.env.ARCKEP_MCP_GATEWAY_URL_PREFIX || DEFAULT_GATEWAY_URL_PREFIX;
export const getStudioMcpUrl = (): string =>
  process.env.ARCKEP_STUDIO_MCP_URL || DEFAULT_STUDIO_MCP_URL;

const isHeadless = () => process.env.ARCKEP_HEADLESS_TOOLS === '1';

const parseUrl = (value: unknown): URL | undefined => {
  if (typeof value !== 'string') return undefined;
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
};

/**
 * Адрес — наш шлюз или MCP студии. Сравнение по разобранному адресу, а не по началу строки: `…:8410@evil/`,
 * `/mcp/../x`, `%2e%2e` разбираются в другой хост или путь и не проходят; логин и пароль в адресе запрещены.
 */
export const isInternalConnectorUrl = (url: unknown): boolean => {
  const parsed = parseUrl(url);
  if (!parsed || parsed.username || parsed.password) return false;

  const gateway = parseUrl(getGatewayUrlPrefix());
  if (
    gateway &&
    parsed.origin === gateway.origin &&
    parsed.pathname.startsWith(gateway.pathname.endsWith('/') ? gateway.pathname : `${gateway.pathname}/`)
  ) {
    return true;
  }

  const studio = parseUrl(getStudioMcpUrl());
  return Boolean(studio && parsed.origin === studio.origin && parsed.pathname === studio.pathname);
};

export interface McpPolicyInput {
  identifier: string;
  mcpParams: { type?: string; url?: unknown } | undefined;
}

/**
 * Можно ли вызывать это подключение. Ошибка — текст для модели (executeMCPTool отдаёт его как ответ
 * инструмента). Подключения студии `mcp-arckep-studio-*` берут адрес из окружения при вызове, их строка
 * базы не читается — проверять нечего; тип stdio у них всё равно запрещён.
 */
export const assertMcpConnectionAllowed = ({ identifier, mcpParams }: McpPolicyInput): void => {
  const type = mcpParams?.type;

  if (type === 'stdio') {
    throw new Error('Подключения-программы (stdio) на сервере отключены.');
  }

  if (isArckepUserMcpId(identifier) || identifier.startsWith(ARCKEP_USER_MCP_PREFIX)) {
    // Адрес и заголовки у своих подключений серверные; манифест только называет тип.
    if (!isArckepUserMcpId(identifier) || type !== 'http') {
      throw new Error('Своё подключение повреждено: добавьте его заново на экране «Подключения».');
    }
    return;
  }

  if (identifier.startsWith(ARCKEP_STUDIO_CONNECTOR_PREFIX)) return;

  if (identifier.startsWith('mcp-arckep-')) {
    if (type !== 'http' && type !== 'sse') {
      throw new Error('Тип подключения не поддерживается на сервере.');
    }
    if (!isInternalConnectorUrl(mcpParams?.url)) {
      throw new Error('Адрес подключения не входит в список разрешённых: вызов отклонён.');
    }
    return;
  }

  if (isHeadless()) {
    throw new Error(
      'Это подключение недоступно: сервер принимает только подключения из каталога «Подключения».',
    );
  }
};
