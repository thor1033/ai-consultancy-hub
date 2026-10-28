// Apply every seeded agent (src/seeds/all.ts) with the release rules in
// src/seeds/apply.ts. Run by release.mjs on every deploy; safe to run by hand:
//
//   node --experimental-transform-types --env-file=apps/web/.env.local packages/db/release-seeds.mjs
//
// The definitions were checked when the image was built (`npm run
// seeds:check`), so this only applies them. It exits 1 if the database cannot
// be reached or a write fails — which aborts the deploy with the old version
// still serving — and 0 otherwise, including when a skill slug is refused:
// that is reported, and every other seed still applies.
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The package's TypeScript uses extensionless relative imports, which only a
// bundler resolves. Same hook as the verify scripts.
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (err) {
      if (!specifier.startsWith(".") || !context.parentURL) throw err;
      for (const ext of [".ts", ".mjs", ".js", "/index.ts"]) {
        const url = new URL(specifier + ext, context.parentURL);
        if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true };
      }
      throw err;
    }
  },
});

if (!process.env.DATABASE_URL) {
  console.error("[seeds] DATABASE_URL is not set — nothing applied.");
  process.exit(1);
}

const { SEEDS } = await import("./src/seeds/all.ts");
const { applySeed } = await import("./src/seeds/apply.ts");
const { getSql } = await import("./src/client.ts");

let code = 0;
try {
  for (const seed of SEEDS) {
    await applySeed(seed, { log: (line) => console.log(`[seeds] ${line}`) });
  }
  console.log(`[seeds] ${SEEDS.length} seeded agent(s) applied.`);
} catch (err) {
  console.error(`[seeds] failed: ${err instanceof Error ? err.message : String(err)}`);
  code = 1;
} finally {
  await getSql().end({ timeout: 5 }).catch(() => {});
}
process.exit(code);
