import type { UserInterventionConfig } from '../../tool';

export interface UserToolConfig {
  humanIntervention?: UserInterventionConfig;
  /**
   * Whether default MCP connectors have already been provisioned into the user's inbox agent.
   */
  inboxMcpProvisioned?: boolean;
  /**
   * List of builtin tool identifiers that have been uninstalled by the user.
   * By default, all builtin tools are enabled. Users can explicitly
   * uninstall tools they don't want to use.
   */
  uninstalledBuiltinTools?: string[];
  /**
   * List of Arckep MCP connector identifiers (`mcp-arckep-*`) explicitly uninstalled by the user.
   */
  uninstalledConnectors?: string[];
}
