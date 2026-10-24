import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Principal } from "@ai-hub/authz";
import type { Deck } from "@ai-hub/db";
import {
  addSlide,
  createDeck,
  describeDeck,
  moveSlide,
  removeSlide,
  updateSlide,
  visibleDeck,
  visibleDecks,
} from "@/lib/decks/ops";
import { SLIDE_KINDS, SLIDE_SPEC } from "@/lib/decks/schema";
import { text } from "@/lib/mcp/memoryTools";

/*
 * Decks, from any MCP client (docs/decks.md).
 *
 * Every call here is an agent's: a model decided to make it. So while a deck
 * is being presented, a new slide goes to the presenter's tray, and live
 * slides cannot be changed, moved or removed until the presentation stops.
 * These are hub_* tools and the approval gate does not hold them — the tray
 * is the review, and it is where the presenter already is.
 */

const slideInput = z
  .looseObject({ kind: z.enum(SLIDE_KINDS as [string, ...string[]]) })
  .describe("One slide. Its fields depend on its kind; see the tool description.");

const refused = (message: string) => ({ ...text(message), isError: true });

export function registerDeckTools(server: McpServer, principal: Principal, baseUrl?: string) {
  const url = (d: Pick<Deck, "id">) => (baseUrl ? `${baseUrl}/decks/${d.id}` : undefined);

  server.registerTool(
    "hub_deck_list",
    {
      description: "List the presentation decks you can open in the hub: id, title, slide count, whether it is being presented now.",
      inputSchema: {},
    },
    async () => {
      const decks = await visibleDecks(principal);
      if (!decks.length) return text("No decks yet. Make one with hub_deck_create.");
      return text(
        decks.map((d) => ({
          deck: d.id,
          title: d.title,
          slides: d.slides.filter((s) => s.status === "live").length,
          inTray: d.slides.filter((s) => s.status === "pending").length,
          presenting: d.presenting,
          collection: d.collection,
          updatedAt: d.updatedAt,
          ...(url(d) ? { url: url(d) } : {}),
        })),
      );
    },
  );

  server.registerTool(
    "hub_deck_create",
    {
      description:
        "Create a presentation deck in the hub, drawn in Teqneo's design and presentable from the hub (it can change live while presented). " +
        "Give it its slides in order; the first is usually a title slide. Returns the deck's id and its URL.\n\n" +
        SLIDE_SPEC,
      inputSchema: {
        title: z.string().min(1).max(160).describe("The deck's title, shown in every slide's footer."),
        collection: z
          .string()
          .optional()
          .describe("The knowledge collection the deck is about. Questions answered live draw from it, and only people who may read it can open the deck."),
        slides: z.array(slideInput).min(1).max(80),
      },
    },
    async ({ title, collection, slides }) => {
      const res = await createDeck(principal, { title, collection, slides }, "agent");
      if ("error" in res) return refused(res.error);
      return text(describeDeck(res.value, url(res.value)));
    },
  );

  server.registerTool(
    "hub_deck_get",
    {
      description: "Read a deck: its slides in order with their ids, which slide is on screen, and what waits in the presenter's tray (status \"pending\").",
      inputSchema: { deck: z.string().describe("The deck id.") },
    },
    async ({ deck }) => {
      const d = await visibleDeck(principal, deck);
      return d ? text(describeDeck(d, url(d))) : refused(`No deck ${deck}.`);
    },
  );

  server.registerTool(
    "hub_deck_add_slide",
    {
      description:
        "Add one slide to a deck. Outside a presentation it goes into the deck, after the slide you name (or at the end). " +
        "While the deck is being presented it goes to the presenter's tray instead, and the presenter decides whether to show it: say so to the user.\n\n" +
        SLIDE_SPEC,
      inputSchema: {
        deck: z.string().describe("The deck id."),
        slide: slideInput,
        after: z.string().optional().describe("Put it after this slide id. Omit for the end (or, while presenting, after the slide on screen)."),
      },
    },
    async ({ deck, slide, after }) => {
      const res = await addSlide(principal, deck, slide, { after: after ?? null, by: "agent" });
      if ("error" in res) return refused(res.error);
      const { slide: s, placed } = res.value;
      return text({
        slide: s.id,
        placed,
        note:
          placed === "tray"
            ? "The deck is being presented: the slide is in the presenter's tray, not on screen, until they show it."
            : "Added to the deck.",
      });
    },
  );

  server.registerTool(
    "hub_deck_update_slide",
    {
      description:
        "Replace a slide's content (the whole slide, not a patch). Refused for a live slide while the deck is being presented; " +
        "a slide still in the tray can be revised.\n\n" +
        SLIDE_SPEC,
      inputSchema: { deck: z.string(), slideId: z.string(), slide: slideInput },
    },
    async ({ deck, slideId, slide }) => {
      const res = await updateSlide(principal, deck, slideId, slide, "agent");
      return "error" in res ? refused(res.error) : text({ slide: res.value.id, status: res.value.status, updated: true });
    },
  );

  server.registerTool(
    "hub_deck_move_slide",
    {
      description: "Move a slide to just after another one, or to the start when `after` is omitted. Refused while the deck is being presented.",
      inputSchema: { deck: z.string(), slideId: z.string(), after: z.string().optional() },
    },
    async ({ deck, slideId, after }) => {
      const res = await moveSlide(principal, deck, slideId, after ?? null, "agent");
      return "error" in res ? refused(res.error) : text({ moved: slideId, after: after ?? null });
    },
  );

  server.registerTool(
    "hub_deck_remove_slide",
    {
      description: "Remove a slide. While the deck is being presented only slides in the tray can be removed.",
      inputSchema: { deck: z.string(), slideId: z.string() },
    },
    async ({ deck, slideId }) => {
      const res = await removeSlide(principal, deck, slideId, "agent");
      return "error" in res ? refused(res.error) : text({ removed: slideId });
    },
  );
}
