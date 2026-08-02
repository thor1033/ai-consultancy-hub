// Shared shape for the sidebar's live Skills list (kept out of the "use server"
// module, which may only export async functions).
export interface SkillNavItem {
  slug: string;
  name: string;
}
