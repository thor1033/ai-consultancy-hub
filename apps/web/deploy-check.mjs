// The deployment check (docs/client-deployment.md): this deployment's
// settings in words, where its data goes, and anything set up wrong — the
// same reading as Admin → This deployment, for a pipeline to run before it
// deploys.
//
//   node --experimental-transform-types deploy-check.mjs            (CI: the deployment's own env)
//   node --experimental-transform-types --env-file=.env.local deploy-check.mjs
//
// Exits 1 when anything must be fixed, 0 otherwise (warnings included). It
// reads settings and prints only what they amount to — "set", a host name,
// a region — never a value. It connects to nothing. Connections added on
// the Connections page live in the database and are listed on the Admin page,
// not here.
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

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

const { deploymentPosture, worst } = await import("./src/lib/deployment.ts");

// Remote servers declared in the environment, by name and host only.
let remotes = [];
try {
  const parsed = JSON.parse(process.env.HUB_REMOTE_MCP_SERVERS || "{}");
  remotes = Object.entries(parsed).map(([name, e]) => ({ name, url: String(e?.url ?? "") }));
} catch {
  console.log("HUB_REMOTE_MCP_SERVERS is not valid JSON — the hub will start with no remote servers.");
}

const { items, recipients } = deploymentPosture(process.env, remotes);
const mark = { ok: "ok   ", warn: "CHECK", bad: "FIX  " };
console.log("This deployment\n");
for (const i of items) {
  console.log(`${mark[i.status]}  ${i.label}: ${i.value}`);
  if (i.note && i.status !== "ok") console.log(`       ${i.note}`);
}
console.log("\nWho receives its data\n");
for (const r of recipients) console.log(`  ${r.who} — ${r.what} (${r.where}; ${r.account})`);
const result = worst(items);
console.log(`\n${result === "bad" ? "Not ready: fix the items marked FIX." : result === "warn" ? "Ready, with items to check." : "Ready."}`);
process.exit(result === "bad" ? 1 : 0);
