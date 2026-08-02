// Shared shapes for the admin control plane, kept out of the "use server" module
// (which may only export async functions).

export interface AdminSkill {
  slug: string;
  name: string;
  enabled: boolean;
  latestVersion: number | null;
  mcpServers: string[]; // built-in server names this skill's latest version uses
  runnableRoles: string[]; // roles allowed to run it, ignoring per-skill grants
  grantedPrincipals: string[]; // explicit run grants (empty ⇒ any runnable role)
}

export interface AdminMcp {
  name: string;
  label: string;
  description: string;
  enabled: boolean;
  usedBySkills: string[]; // skill names whose latest version references this server
}

export interface Registry {
  skills: AdminSkill[];
  mcpServers: AdminMcp[];
}
