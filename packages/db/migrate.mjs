// Applies schema.sql to DATABASE_URL. Idempotent — run it any time.
import postgres from "postgres";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");

// Load env from the repo's .env.local files so `npm run migrate` works without
// the caller having to export DATABASE_URL first. Existing env wins; first file
// to define a key wins. Mirrors where Next reads config from.
function loadEnv() {
  const files = [
    join(repoRoot, ".env.local"),
    join(repoRoot, "apps", "web", ".env.local"),
    join(repoRoot, ".env"),
  ];
  for (const file of files) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
      if (!m || line.trimStart().startsWith("#")) continue;
      const key = m[1];
      if (process.env[key] !== undefined) continue;
      let value = m[2].trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      process.env[key] = value;
    }
  }
}

loadEnv();

if (!process.env.DATABASE_URL) {
  console.error(
    "DATABASE_URL is not set (checked env and .env.local / apps/web/.env.local / .env).",
  );
  process.exit(1);
}

const schema = readFileSync(join(here, "schema.sql"), "utf8");

const sql = postgres(process.env.DATABASE_URL, { onnotice: () => {} });
try {
  await sql.unsafe(schema);
  console.log("Schema applied.");
} finally {
  await sql.end();
}
