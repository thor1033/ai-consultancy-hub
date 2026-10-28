// The release command (fly.toml): bring the database up to the code being
// deployed, before that code serves a request.
//
//   1. migrate.mjs        — schema.sql, idempotent
//   2. release-seeds.mjs  — every agent that lives in code, merged with what
//                           people changed since the last release
//
// Each runs as its own process, in order; the first failure stops here with
// its exit code, and Fly aborts the deploy with the old version still up.
// Seeds after migrations, because a seed may need a column the migration adds.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const steps = [
  ["migrate", [join(here, "migrate.mjs")]],
  ["seeds", ["--experimental-transform-types", "--disable-warning=ExperimentalWarning", join(here, "release-seeds.mjs")]],
];

for (const [name, args] of steps) {
  const r = spawnSync(process.execPath, args, { stdio: "inherit", env: process.env });
  if (r.status !== 0) {
    console.error(`[release] ${name} failed (exit ${r.status ?? r.signal}) — the deploy stops here.`);
    process.exit(r.status || 1);
  }
}
console.log("[release] database migrated and seeds applied.");
