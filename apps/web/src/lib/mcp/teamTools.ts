/*
 * The team, as a client outside the hub sees it: Teqneo Code's Hub page asks
 * these with the person's own hub credential (docs/teqneo-code.md).
 *
 *   hub_team_overview ....... the agents as an org chart: function, owner, where
 *                             each runs, who decides its writes, its skills and
 *                             schedules; and what is waiting on whom
 *   hub_team_board .......... the open work on the PM board, per person
 *   hub_schedule_create ..... set an agent to run on a clock, owned by the caller
 *   hub_schedule_set_enabled  pause or resume one's own schedule (or any, as admin)
 *
 * Nothing here widens what a person may do. All four need agent:run, the same
 * as the agent pages they mirror. The board is read through the hub's own
 * read-only PM-tool connection, which any agent:run caller already reaches by
 * asking the Project Manager. Team-wide approval counts are an admin's view;
 * everyone else sees only what waits for them. Schedules obey the page's rules
 * (lib/scheduleRules.ts), which is the one copy of them.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { authorize, type Principal } from "@ai-hub/authz";
import {
  getAgent,
  listAgents,
  listPrincipals,
  listProposals,
  listSchedules,
  listSkills,
  COMPANY_BOARD_PROJECT_ID,
  type PrincipalRow,
} from "@ai-hub/db";
import { connectMcpServers, type ConnectedMcp } from "@ai-hub/mcp";
import { mayDecide } from "@/lib/approvals";
import { resolveServer } from "@/lib/runSession";
import { createScheduleFor, pauseOrResumeSchedule, scheduleChangeableBy } from "@/lib/scheduleRules";
import { boardByOwner, describeSchedule } from "@/lib/teamView";
import { text } from "@/lib/mcp/memoryTools";

/** The board the team view reads: a deployment's own (HUB_BOARD_PROJECT_ID), else the company's. */
const boardProject = () => process.env.HUB_BOARD_PROJECT_ID?.trim() || COMPANY_BOARD_PROJECT_ID;

/** The hub's read-scoped PM-tool connection, the one the product owners hold. */
const PM_READ_SERVER = "pm-tool-read";

const toolNameFor = (slug: string) => `hub_agent_${slug.replace(/-/g, "_")}`;

function nameOf(row: PrincipalRow | undefined, fallback: string): string {
  return row?.displayName?.trim() || row?.email || fallback;
}

export function registerTeamTools(server: McpServer, principal: Principal): void {
  const may = (action: Parameters<typeof authorize>[1]) => authorize(principal, action);
  const notAllowed = () => text("You are not permitted to run agents, so the team view is not offered.");

  server.registerTool(
    "hub_team_overview",
    {
      description:
        "The team of agents as an org chart: each agent's function, owner, where it runs (hub, Claude Code, or both), " +
        "who decides its writes, its skills and its schedules; plus what is waiting for your approval (and, for an admin, on whom).",
      inputSchema: {},
    },
    async () => {
      if (!(await may("agent:run"))) return notAllowed();
      const admin = await may("admin:manage");
      const [summaries, people, schedules, skills, pending] = await Promise.all([
        listAgents(),
        listPrincipals(),
        listSchedules(),
        listSkills(),
        listProposals({ status: "pending", ...(admin ? {} : { visibleTo: principal.id }), limit: 500 }),
      ]);
      const byId = new Map(people.map((p) => [p.id, p]));

      const agents = await Promise.all(
        summaries.map(async (a) => {
          const full = await getAgent(a.slug);
          return {
            slug: a.slug,
            name: a.name,
            description: a.description ?? "",
            enabled: a.enabled,
            tool: toolNameFor(a.slug),
            placement: a.placement,
            function: a.functionName?.trim() || null,
            owner: a.owner?.trim() || null,
            approvalsTo: (full?.sendApprovalsTo ?? []).map((id) => nameOf(byId.get(id), id)),
            skills: skills.filter((s) => s.agentId === a.id && s.enabled).map((s) => ({ slug: s.slug, name: s.name })),
            schedules: schedules
              .filter((s) => s.agentId === a.id)
              .map((s) => ({
                id: s.id,
                name: s.name,
                when: describeSchedule(s),
                enabled: s.enabled,
                lastRunAt: s.lastRunAt,
                lastError: s.lastError,
                owner: nameOf(byId.get(s.ownerPrincipalId), "someone"),
                yours: s.ownerPrincipalId === principal.id,
              })),
          };
        }),
      );

      // What waits on whom: a write waits on the person whose run it was and on
      // whoever it was sent to (admins can always decide, so they are not listed).
      let waitingForYou = 0;
      const waitingOn = new Map<string, number>();
      for (const p of pending) {
        if (await mayDecide(principal, p)) waitingForYou++;
        if (!admin) continue;
        const deciders = new Set<string>(p.sentTo.map((x) => x.name));
        if (p.principalId) deciders.add(nameOf(byId.get(p.principalId), p.principalId));
        if (deciders.size === 0) deciders.add("an admin");
        for (const d of deciders) waitingOn.set(d, (waitingOn.get(d) ?? 0) + 1);
      }

      const me = byId.get(principal.id);
      return text({
        you: { name: nameOf(me, principal.email ?? principal.id), admin },
        agents,
        approvals: {
          waitingForYou,
          ...(admin
            ? { waitingOn: [...waitingOn.entries()].map(([person, count]) => ({ person, count })).sort((a, b) => b.count - a.count) }
            : {}),
        },
      });
    },
  );

  server.registerTool(
    "hub_team_board",
    {
      description:
        "The open work on the PM board, per person: how many open, late and in review, and each person's tasks, late first. " +
        "Read through the hub's read-only PM-tool connection.",
      inputSchema: {
        projectId: z.string().optional().describe("PM project id. Default: the company's own board."),
      },
    },
    async ({ projectId }) => {
      if (!(await may("agent:run"))) return notAllowed();
      const config = resolveServer(PM_READ_SERVER);
      if (!config) return text(`The PM board is not connected to this hub ("${PM_READ_SERVER}" is not declared).`);
      let mcp: ConnectedMcp | undefined;
      try {
        mcp = await connectMcpServers([config]);
        const out = await mcp.execute("pm_list_tasks", { projectId: projectId ?? boardProject() });
        if (out.startsWith("Tool error:") || out.startsWith("Error:")) return text(`The PM board answered: ${out}`);
        const parsed = JSON.parse(out) as { tasks?: Parameters<typeof boardByOwner>[0] };
        return text({ projectId: projectId ?? boardProject(), people: boardByOwner(parsed.tasks ?? []) });
      } catch (err) {
        return text(`Could not read the PM board: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        await mcp?.close().catch(() => {});
      }
    },
  );

  server.registerTool(
    "hub_schedule_create",
    {
      description:
        "Set a hub agent to run on a clock: every N minutes, or daily at a time on chosen weekdays. " +
        "The schedule is yours and runs with your reach; its writes wait for approval like any run's.",
      inputSchema: {
        agent: z.string().describe("The agent's slug."),
        name: z.string().min(1).describe("What the schedule is for, e.g. 'Monday status'."),
        prompt: z.string().min(1).describe("What to ask the agent each time."),
        kind: z.enum(["every", "daily"]),
        intervalMinutes: z.number().int().min(5).optional().describe("For kind 'every'."),
        time: z
          .string()
          .regex(/^\d{1,2}:\d{2}$/)
          .optional()
          .describe("For kind 'daily': local time, HH:MM."),
        weekdays: z.array(z.number().int().min(0).max(6)).optional().describe("For kind 'daily': 0=Sunday … 6=Saturday. Empty: every day."),
        timezone: z.string().optional().describe("IANA zone, e.g. Europe/Copenhagen. Default: the hub's."),
      },
    },
    async ({ agent: slug, name, prompt, kind, intervalMinutes, time, weekdays, timezone }) => {
      if (!(await may("agent:run"))) return notAllowed();
      if (principal.agentId) return text("An agent's own credential cannot own a schedule; a person sets it up.");
      const agent = await getAgent(slug);
      if (!agent) return text(`No agent "${slug}".`);
      let atMinute: number | null = null;
      if (kind === "daily") {
        if (!time) return text("A daily schedule needs a time (HH:MM).");
        const [h, m] = time.split(":").map(Number);
        if (h! > 23 || m! > 59) return text(`"${time}" is not a time of day.`);
        atMinute = h! * 60 + m!;
      } else if (!intervalMinutes) {
        return text("An 'every' schedule needs intervalMinutes.");
      }
      const created = await createScheduleFor(principal.id, {
        agentId: agent.id,
        name,
        prompt,
        kind,
        intervalMinutes: kind === "every" ? intervalMinutes ?? null : null,
        atMinute,
        weekdays: weekdays ?? [],
        ...(timezone ? { timezone } : {}),
      });
      if ("error" in created) return text(`Not created: ${created.error}`);
      return text({ created: { id: created.schedule.id, name: created.schedule.name, agent: slug, when: describeSchedule(created.schedule) } });
    },
  );

  server.registerTool(
    "hub_schedule_set_enabled",
    {
      description: "Pause or resume a schedule. Yours, or any as an admin.",
      inputSchema: { id: z.string(), enabled: z.boolean() },
    },
    async ({ id, enabled }) => {
      if (!(await may("agent:run"))) return notAllowed();
      const schedule = await scheduleChangeableBy(principal.id, await may("admin:manage"), id);
      if ("error" in schedule) return text(schedule.error);
      await pauseOrResumeSchedule(schedule, enabled);
      return text({ id, enabled });
    },
  );
}
