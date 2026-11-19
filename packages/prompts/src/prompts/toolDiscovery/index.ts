export interface AvailableToolItem {
  description: string;
  identifier: string;
  name: string;
}

/**
 * Cap per-tool discovery descriptions in `<available_tools>` so verbose MCP or third-party
 * descriptions do not bloat every turn's prompt. Full schemas load via `activateTools`.
 */
export const TOOL_LIST_DESCRIPTION_LIMIT = 160;

export const truncateToolDescription = (
  description: string,
  limit: number = TOOL_LIST_DESCRIPTION_LIMIT,
): string => {
  const flat = description.replaceAll(/\s+/g, ' ').trim();
  if (flat.length <= limit) return flat;

  let head = flat.slice(0, limit);
  if (flat[limit] !== ' ') {
    const lastSpace = head.lastIndexOf(' ');
    if (lastSpace >= limit / 2) head = head.slice(0, lastSpace);
  }
  const lastCode = head.charCodeAt(head.length - 1);
  if (lastCode >= 0xd8_00 && lastCode <= 0xdb_ff) head = head.slice(0, -1);

  return `${head.replace(/[\s,.:;!?—–-]+$/, '')}…`;
};

export const availableToolPrompt = (tool: AvailableToolItem) =>
  `  <tool identifier="${tool.identifier}" name="${tool.name}">${truncateToolDescription(tool.description)}</tool>`;

export const availableToolsPrompts = (tools: AvailableToolItem[]) => {
  if (tools.length === 0) return '';

  const toolTags = tools.map((tool) => availableToolPrompt(tool)).join('\n');

  return `<available_tools description="Installed tools not yet loaded. Call activateTools with their identifiers when needed.">\n${toolTags}\n</available_tools>`;
};
