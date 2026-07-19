// Applies schema.sql to DATABASE_URL. Idempotent — run it any time.
import postgres from "postgres";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
const schema = readFileSync(join(here, "schema.sql"), "utf8");

const sql = postgres(process.env.DATABASE_URL, { onnotice: () => {} });
try {
  await sql.unsafe(schema);
  console.log("Schema applied.");
} finally {
  await sql.end();
}
