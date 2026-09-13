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

// --- Access: principals, credentials and the audit trail --------------------

export interface AccessPrincipal {
  id: string;
  email: string | null;
  displayName: string;
  roles: string[];
  agentId: string | null;
  enabled: boolean;
  /** True once an AuthKit token has bound this person's WorkOS user id. */
  workosBound: boolean;
  /** Live (unrevoked) credentials this principal holds. */
  credentialCount: number;
}

export interface AccessCredential {
  id: string;
  name: string;
  principalId: string;
  tokenPrefix: string;
  roles: string[];
  agentId: string | null;
  createdBy: string;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
}

export interface AccessEvent {
  id: string;
  at: string;
  event: string;
  source: string | null;
  principalId: string | null;
  actor: string | null;
  detail: Record<string, unknown>;
}

export interface OAuthStatus {
  configured: boolean;
  issuer: string | null;
  resource: string | null;
  metadataUrl: string | null;
}

export interface AccessSnapshot {
  principals: AccessPrincipal[];
  credentials: AccessCredential[];
  events: AccessEvent[];
  oauth: OAuthStatus;
  /**
   * How many principals the deprecated HUB_API_TOKENS map still carries. The
   * migration is not finished until this is zero and the secret is deleted.
   */
  legacyTokens: number;
  knowledge: KnowledgeAccessSnapshot;
}

// --- Knowledge access: which shared drives each person may open -------------

export interface AccessCollection {
  name: string;
  visibility: "open" | "restricted";
  documentCount: number;
  /** Principal ids explicitly granted access. Only meaningful while restricted. */
  grantedTo: string[];
  /**
   * True when this collection has no row of its own and is running on the
   * deployment default. Surfaced because these are exactly the collections
   * nobody has decided about yet.
   */
  unclassified: boolean;
}

export interface KnowledgeAccessSnapshot {
  collections: AccessCollection[];
  /** The policy applied to a collection nobody has classified. */
  defaultVisibility: "open" | "restricted";
  /** Documents filed into no collection at all. */
  unfiledDocuments: number;
}
