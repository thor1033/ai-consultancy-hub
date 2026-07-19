import postgres from "postgres";

let sql: ReturnType<typeof postgres> | null = null;

// Single lazily-constructed postgres.js connection pool. Reads DATABASE_URL.
// Behind a getter so importing the package never throws — only querying does.
export function getSql(): ReturnType<typeof postgres> {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set — the skill store is unavailable.");
  }
  if (!sql) sql = postgres(process.env.DATABASE_URL, { onnotice: () => {} });
  return sql;
}
