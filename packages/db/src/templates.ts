import { getSql } from "./client";

// User-authored PowerPoint templates from the pptx Studio. `spec` is the
// structured template JSON (see @ai-hub/mcp/pptx-template) — these are the
// library the agent fills. The bundled sample template lives in code, not here.
export interface TemplateRow {
  id: string;
  name: string;
  spec: unknown;
  createdAt: string;
  updatedAt: string;
}

export async function listTemplates(): Promise<TemplateRow[]> {
  const sql = getSql();
  return sql<TemplateRow[]>`
    select id, name, spec, created_at as "createdAt", updated_at as "updatedAt"
    from templates
    order by updated_at desc
  `;
}

export async function getTemplate(id: string): Promise<TemplateRow | null> {
  const sql = getSql();
  const rows = await sql<TemplateRow[]>`
    select id, name, spec, created_at as "createdAt", updated_at as "updatedAt"
    from templates where id = ${id}
  `;
  return rows[0] ?? null;
}

export async function createTemplate(name: string, spec: unknown): Promise<TemplateRow> {
  const sql = getSql();
  const rows = await sql<TemplateRow[]>`
    insert into templates (name, spec)
    values (${name}, ${sql.json(spec as Parameters<typeof sql.json>[0])})
    returning id, name, spec, created_at as "createdAt", updated_at as "updatedAt"
  `;
  return rows[0];
}

export async function updateTemplate(
  id: string,
  name: string,
  spec: unknown,
): Promise<TemplateRow | null> {
  const sql = getSql();
  const rows = await sql<TemplateRow[]>`
    update templates
    set name = ${name}, spec = ${sql.json(spec as Parameters<typeof sql.json>[0])}, updated_at = now()
    where id = ${id}
    returning id, name, spec, created_at as "createdAt", updated_at as "updatedAt"
  `;
  return rows[0] ?? null;
}

export async function deleteTemplate(id: string): Promise<boolean> {
  const sql = getSql();
  const rows = await sql`delete from templates where id = ${id}`;
  return rows.count > 0;
}
