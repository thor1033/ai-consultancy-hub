// Designing agents and skills from an MCP client (lib/mcp/designTools.ts,
// docs/agent-design-tools.md), through the real hub MCP server and a real MCP
// client over InMemoryTransport — what is asserted is what Claude Code sees.
//
//   node --experimental-transform-types --env-file=.env.local verify-design-tools.mjs
//
// Needs DATABASE_URL and a migrated database. No API key: nothing here runs a
// model. It creates agents and skills under a stamped slug and deletes them.
//
// What is proven: the tools are offered only to a principal who may manage
// agents; an agent created by tool lands as the form would save it (brief,
// model, tools, whom it may ask, knowledge, memory); the form's rules hold —
// an unknown model or an agent it cannot ask is refused, a tool server this
// hub does not have is left out and said so; an update changes only what was
// sent and keeps an entry's own settings (a mailbox, writes an admin allowed);
// a long brief arrives whole through hub_put_text; a skill's prompt may only
// use declared parameters; a skill is found only under its own agent.
//
// Not proven here: that the agent form behaves the same. It saves through the
// same function (lib/agentDesign.ts saveAgentAs); verify:views drives the page.
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@/")) {
      const base = new URL("./src/", import.meta.url);
      for (const ext of ["", ".ts", ".tsx", ".mjs", ".js", "/index.ts"]) {
        const url = new URL(specifier.slice(2) + ext, base);
        if (existsSync(fileURLToPath(url)) && (ext !== "" || /\.(tsx?|mjs|js)$/.test(url.pathname))) return { url: url.href, shortCircuit: true };
      }
    }
    try {
      return nextResolve(specifier, context);
    } catch (err) {
      if (!specifier.startsWith(".")) return nextResolve(`${specifier}.js`, context);
      if (!context.parentURL) throw err;
      for (const ext of [".ts", ".mjs", ".js", "/index.ts"]) {
        const url = new URL(specifier + ext, context.parentURL);
        if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true };
      }
      throw err;
    }
  },
});

const checks = [];
function check(label, ok, detail = "") {
  checks.push({ label, ok });
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set — run with --env-file=.env.local");
  process.exit(1);
}

const { buildHubMcpServer } = await import("./src/lib/mcp/hubServer.ts");
const db = await import("../../packages/db/src/index.ts");
const sql = db.getSql();

const parse = (t) => {
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
};
async function connect(principal) {
  const server = await buildHubMcpServer(principal, { baseUrl: "https://hub.example" });
  const client = new Client({ name: "verify", version: "0" });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return client;
}
const call = async (client, name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  return parse(r.content?.[0]?.text ?? "");
};
const toolNames = async (client) => (await client.listTools()).tools.map((t) => t.name);

const stamp = Date.now();
const ADMIN = { id: `verify-design-admin-${stamp}`, roles: ["admin"], source: "credential" };
const ANALYST = { id: `verify-design-analyst-${stamp}`, roles: ["analyst"], source: "credential" };
const DESIGN = ["hub_list_design_options", "hub_agent_get", "hub_agent_create", "hub_agent_update", "hub_skill_create", "hub_skill_update"];
const made = [];

try {
  console.log("— who is offered the tools —");
  const analyst = await connect(ANALYST);
  const aTools = await toolNames(analyst);
  check("someone who may run but not manage agents is offered none of them", DESIGN.every((t) => !aTools.includes(t)) && aTools.includes("hub_run_agent"));
  const admin = await connect(ADMIN);
  const xTools = await toolNames(admin);
  check("someone who may manage agents is offered all six", DESIGN.every((t) => xTools.includes(t)), DESIGN.filter((t) => !xTools.includes(t)).join(", "));

  const options = await call(admin, "hub_list_design_options");
  check("the design options list this hub's tool servers, without memory or the ask entry",
    Array.isArray(options.toolServers) && options.toolServers.includes("microsoft365") && !options.toolServers.includes("memory") && !options.toolServers.includes("agents"),
    options.toolServers?.join(", "));
  check("and its models", options.models?.includes("claude-haiku-4-5"));

  // An agent to be asked, made the ordinary way.
  const helper = await db.createAgent({ slug: `verify-design-helper-${stamp}`, name: "Helper", instructions: "x" });
  made.push(helper.id);

  console.log("\n— creating an agent —");
  const name = `Contracts ${stamp}`;
  const created = await call(admin, "hub_agent_create", {
    name,
    description: "Reads contracts.",
    instructions: "You read contracts and list what to watch for.",
    model: "claude-haiku-4-5",
    tools: ["microsoft365", `no-such-server-${stamp}`],
    asks: [helper.slug],
    knowledgeCollections: ["contracts"],
    keepsMemory: false,
    function: "Legal",
  });
  const row = await db.getAgent(`contracts-${stamp}`);
  if (row) made.push(row.id);
  check("hub_agent_create makes the agent, with the slug from its name", Boolean(row) && /Created/.test(created), String(created).split("\n")[0]);
  check("with its brief, model, memory setting, knowledge and function",
    row?.instructions === "You read contracts and list what to watch for." && row?.model === "claude-haiku-4-5" && row?.keepsMemory === false &&
      row?.knowledgeCollections?.join() === "contracts" && row?.functionName === "Legal");
  const names = (row?.mcpServers ?? []).map((e) => e.name);
  check("with the tool server it named, and whom it may ask", names.includes("microsoft365") && (row?.mcpServers ?? []).find((e) => e.name === "agents")?.agents?.join() === helper.slug);
  check("a tool server this hub does not have is left out, and the answer says so", !names.includes(`no-such-server-${stamp}`) && created.includes(`no-such-server-${stamp}`));
  check("the answer says how to run it now and where its page is", /hub_run_agent/.test(created) && created.includes(`https://hub.example/agents/contracts-${stamp}`));

  const badModel = await call(admin, "hub_agent_create", { name: `Bad model ${stamp}`, model: "gpt-9" });
  check("an unknown model is refused, and nothing is created", /Not created: Unknown model "gpt-9"/.test(badModel) && !(await db.getAgent(`bad-model-${stamp}`)), badModel);
  const badAsk = await call(admin, "hub_agent_create", { name: `Bad ask ${stamp}`, asks: [`nobody-${stamp}`] });
  check("an agent it cannot ask is refused", /There is no agent/.test(badAsk) && !(await db.getAgent(`bad-ask-${stamp}`)), badAsk);
  const reserved = await call(admin, "hub_agent_create", { name: "New" });
  check("the form's reserved slug is refused here too", /reserved/.test(reserved));

  console.log("\n— reading and changing it —");
  // Settings only the agent's page can set: a mailbox, and writes an admin allowed.
  await db.updateAgent(row.id, {
    mcpServers: row.mcpServers.map((e) => (e.name === "microsoft365" ? { ...e, mailbox: "legal@example.com", writes: "allow" } : e)),
  });
  const got = await call(admin, "hub_agent_get", { agent: row.slug });
  check("hub_agent_get returns the agent whole", got.instructions === row.instructions && got.tools?.includes("microsoft365") && got.asks?.join() === helper.slug && Array.isArray(got.skills));

  const upd = await call(admin, "hub_agent_update", { agent: row.slug, description: "Reads every contract." });
  const afterUpd = await db.getAgent(row.id);
  check("an update changes what was sent", /Saved/.test(upd) && afterUpd.description === "Reads every contract.", upd);
  check("and nothing else: brief, model, memory, knowledge, asks",
    afterUpd.instructions === row.instructions && afterUpd.model === "claude-haiku-4-5" && afterUpd.keepsMemory === false &&
      afterUpd.knowledgeCollections.join() === "contracts" && afterUpd.mcpServers.find((e) => e.name === "agents")?.agents?.join() === helper.slug);
  const m365 = afterUpd.mcpServers.find((e) => e.name === "microsoft365");
  check("an entry that stays keeps its own settings (mailbox, writes allowed)", m365?.mailbox === "legal@example.com" && m365?.writes === "allow", JSON.stringify(m365));

  await call(admin, "hub_agent_update", { agent: row.slug, tools: [] });
  const noTools = await db.getAgent(row.id);
  check("tools: [] removes the tool servers and keeps whom it may ask",
    !noTools.mcpServers.some((e) => e.name === "microsoft365") && noTools.mcpServers.find((e) => e.name === "agents")?.agents?.join() === helper.slug);
  await call(admin, "hub_agent_update", { agent: row.slug, asks: [] });
  check("asks: [] removes asking", !(await db.getAgent(row.id)).mcpServers.some((e) => e.name === "agents"));
  const selfAsk = await call(admin, "hub_agent_update", { agent: row.slug, asks: [row.slug] });
  check("an agent may not be allowed to ask itself", /cannot ask itself/.test(selfAsk), selfAsk);

  // A brief longer than one tool call, through hub_put_text.
  const long = `Section. ${"Read every clause twice. ".repeat(1200)}End.`;
  const half = Math.ceil(long.length / 2);
  const p1 = await call(admin, "hub_put_text", { part: 1, parts: 2, text: long.slice(0, half) });
  const p2 = await call(admin, "hub_put_text", { handle: p1.handle, part: 2, parts: 2, text: long.slice(half) });
  await call(admin, "hub_agent_update", { agent: row.slug, instructions: p2.use });
  check("a long brief arrives whole through hub_put_text", (await db.getAgent(row.id)).instructions === long, `${(await db.getAgent(row.id)).instructions.length} of ${long.length} chars`);
  const unknown = await call(admin, "hub_agent_update", { agent: `nobody-${stamp}`, description: "x" });
  check("an unknown agent is named in the answer", /There is no agent/.test(unknown));

  console.log("\n— skills —");
  const sk = await call(admin, "hub_skill_create", {
    agent: row.slug,
    name: `Review contract ${stamp}`,
    description: "Five things to watch for.",
    prompt: "Review this contract for the {{side}}: {{contract}}",
    parameters: [
      { name: "contract", description: "The text", required: true },
      { name: "side", description: "Which side", options: ["buyer", "seller"] },
    ],
  });
  const skills = await db.listSkills(row.id);
  check("hub_skill_create gives the agent the skill, slug from its name", skills.length === 1 && skills[0].slug === `review-contract-${stamp}` && /Run button/.test(sk), sk);
  check("with its prompt and parameters", skills[0]?.promptTemplate.includes("{{side}}") && skills[0]?.parameters.map((p) => p.name).join() === "contract,side" && skills[0]?.parameters[1].options?.join() === "buyer,seller");
  const undeclared = await call(admin, "hub_skill_create", { agent: row.slug, name: "Broken", prompt: "Hello {{client}}" });
  check("a prompt using an undeclared parameter is refused", /no parameter is called "client"/.test(undeclared) && (await db.listSkills(row.id)).length === 1, undeclared);
  const dup = await call(admin, "hub_skill_create", { agent: helper.slug, name: `Review contract ${stamp}`, prompt: "x" });
  check("a slug already taken is refused in words", /already uses the slug/.test(dup), dup);

  const off = await call(admin, "hub_skill_update", { agent: row.slug, skill: `review-contract-${stamp}`, enabled: false, parameters: [{ name: "contract", description: "The text" }], prompt: "Review: {{contract}}" });
  const s2 = (await db.listSkills(row.id))[0];
  check("hub_skill_update switches it off and replaces prompt and parameters", s2.enabled === false && s2.promptTemplate === "Review: {{contract}}" && s2.parameters.length === 1 && /switched off/.test(off), off);
  const keep = await call(admin, "hub_skill_update", { agent: row.slug, skill: `review-contract-${stamp}`, description: "Changed." });
  const s3 = (await db.listSkills(row.id))[0];
  check("and an update of one field leaves the rest, including off", s3.description === "Changed." && s3.enabled === false && s3.promptTemplate === "Review: {{contract}}", keep);
  const elsewhere = await call(admin, "hub_skill_update", { agent: helper.slug, skill: `review-contract-${stamp}`, description: "Hijack" });
  check("a skill is found only under its own agent", /has no skill/.test(elsewhere) && (await db.listSkills(row.id))[0].description === "Changed.");

  await analyst.close();
  await admin.close();
} finally {
  await sql`delete from agents where slug like ${`%-${stamp}`} or id = any(${made})`.catch((e) => console.error(e));
  await sql.end({ timeout: 5 });
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed.`);
if (failed.length) process.exit(1);
console.log("Not proven here: the agent form, which saves through the same function — verify:views drives the page.");
