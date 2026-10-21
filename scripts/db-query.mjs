// Read-only SQL against the hub's database, for a person or an agent working
// in this repo.
//
//   node --env-file=apps/web/.env.local scripts/db-query.mjs "select count(*) from agents"
//   node --env-file=apps/web/.env.local scripts/db-query.mjs --file query.sql
//   echo "select 1" | node --env-file=apps/web/.env.local scripts/db-query.mjs
//
// The connection string comes from the environment and is never printed, so
// whoever runs this sees rows, not the secret. HUB_DB_READONLY_URL is used when
// set (a role granted SELECT only — the right thing to give an agent), else
// DATABASE_URL.
//
// Read-only by construction, not by trust: every query runs inside
// BEGIN READ ONLY, which Postgres enforces for INSERT, UPDATE, DELETE and DDL
// alike, whatever the role can do. A statement timeout keeps a bad join from
// holding a connection to production open.
import { readFileSync } from "node:fs";

const url = process.env.HUB_DB_READONLY_URL ?? process.env.DATABASE_URL;
if (!url) {
  console.error(
    "No HUB_DB_READONLY_URL or DATABASE_URL in the environment. Run with --env-file=apps/web/.env.local.",
  );
  process.exit(2);
}

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : args.splice(i, 2)[1];
};
const file = flag("--file");
const limit = Number(flag("--limit") ?? 200);
const asJson = args.includes("--json") && args.splice(args.indexOf("--json"), 1);

let query = file ? readFileSync(file, "utf8") : args.join(" ").trim();
if (!query && !process.stdin.isTTY) query = readFileSync(0, "utf8").trim();
if (!query) {
  console.error("Usage: db-query.mjs \"<sql>\" | --file <path>  [--limit N] [--json]");
  process.exit(2);
}

const { default: postgres } = await import("postgres");
const sql = postgres(url, { onnotice: () => {}, max: 1, connect_timeout: 15 });

const started = Date.now();
try {
  const rows = await sql.begin("read only", async (tx) => {
    await tx.unsafe("set local statement_timeout = '20s'");
    return tx.unsafe(query);
  });
  const ms = Date.now() - started;
  const shown = rows.slice(0, limit);
  if (asJson) {
    console.log(JSON.stringify(shown, null, 2));
  } else if (shown.length) {
    console.table(
      shown.map((r) =>
        Object.fromEntries(
          Object.entries(r).map(([k, v]) => [
            k,
            v instanceof Date
              ? v.toISOString()
              : typeof v === "object" && v !== null
                ? JSON.stringify(v).slice(0, 80)
                : typeof v === "string" && v.length > 80
                  ? v.slice(0, 77) + "…"
                  : v,
          ]),
        ),
      ),
    );
  }
  console.log(
    `${rows.length} row${rows.length === 1 ? "" : "s"}${rows.length > limit ? ` (showing ${limit}; --limit to change)` : ""} in ${ms}ms`,
  );
} catch (err) {
  // Postgres errors never carry the connection string, but be sure nothing
  // that does can reach the terminal.
  const message = (err instanceof Error ? err.message : String(err)).replaceAll(url, "<database url>");
  console.error(`Query failed: ${message}`);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 2 });
}
