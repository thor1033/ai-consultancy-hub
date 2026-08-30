// Shared shapes for the admin control plane, kept out of the "use server" module
// (which may only export async functions).

export interface AdminMcp {
  name: string;
  label: string;
  description: string;
  enabled: boolean;
  /**
   * True when this server is declared in HUB_REMOTE_MCP_SERVERS. It matters for
   * deletion and nothing else: the registry re-registers declared servers on
   * every read, so deleting one removes the row until the next page load and no
   * longer. The console says so rather than offering a button that silently
   * undoes itself.
   */
  declared: boolean;
}

export interface Registry {
  mcpServers: AdminMcp[];
}
