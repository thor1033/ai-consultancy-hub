// How a held call reads to a person. Pure functions over a proposal's tool
// name and arguments, with no knowledge of any one server beyond the verbs
// below: an unfamiliar tool still reads sensibly, it just reads more like its
// name. The exact call is always one click away, so nothing here may hide or
// change what will run — it only decides what is said first.

/** Verbs for the tools agents most often reach for. Anything else is derived from its name. */
const VERBS: Record<string, string> = {
  pm_create_task: "Create task",
  pm_update_task: "Update task",
  pm_add_note: "Add project note",
  teams_notes_save: "Save meeting note",
};

/** `pm_update_task` → "Update task"; `crm_contact_create` → "Contact create". */
export function verbFor(tool: string): string {
  if (VERBS[tool]) return VERBS[tool];
  const parts = tool.split("_").filter(Boolean);
  const words = (parts.length > 1 ? parts.slice(1) : parts).join(" ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Arguments that address a thing rather than change it. Shown as the subject, not as a change. */
const ADDRESS = new Set(["projectId", "taskId", "meetingId", "transcriptId", "id", "deckId", "slideId"]);
/** Arguments that name the thing. The first one present is the headline. */
const NAMES = ["title", "name", "subject", "summary"];

export interface Change {
  field: string;
  value: string;
  /** Long text, shown folded. */
  long: boolean;
}

export interface Presented {
  verb: string;
  /** What it is about, in words when the arguments say: a title, else the id it addresses. */
  headline: string | null;
  /** The id it addresses, when the headline is a name, so the two can be matched. */
  ref: string | null;
  changes: Change[];
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function humanField(key: string): string {
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function humanValue(v: unknown): { text: string; long: boolean } {
  if (v === null || v === undefined || v === "") return { text: "—", long: false };
  if (typeof v === "boolean") return { text: v ? "On" : "Off", long: false };
  if (typeof v === "number") return { text: String(v), long: false };
  if (typeof v === "string") {
    if (ISO_DATE.test(v)) {
      const d = new Date(`${v}T12:00:00Z`);
      if (!Number.isNaN(d.getTime())) {
        return { text: d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }), long: false };
      }
    }
    if (v === "inprogress") return { text: "In progress", long: false };
    if (v === "backlog") return { text: "Backlog", long: false };
    if (v === "done") return { text: "Done", long: false };
    return { text: v, long: v.length > 140 || v.includes("\n") };
  }
  if (Array.isArray(v)) return { text: `${v.length} item${v.length === 1 ? "" : "s"}`, long: false };
  return { text: JSON.stringify(v), long: true };
}

export function present(tool: string, args: Record<string, unknown>): Presented {
  const nameKey = NAMES.find((k) => typeof args[k] === "string" && (args[k] as string).trim());
  const refKey = ["taskId", "id", "meetingId", "deckId"].find((k) => typeof args[k] === "string" && args[k]);
  const headlineRaw = nameKey ? (args[nameKey] as string) : refKey ? (args[refKey] as string) : null;
  const headline = headlineRaw ? (headlineRaw.length > 120 ? `${headlineRaw.slice(0, 117)}…` : headlineRaw.split("\n")[0]) : null;

  const changes: Change[] = [];
  for (const [k, v] of Object.entries(args)) {
    if (ADDRESS.has(k) || k === nameKey) continue;
    const { text, long } = humanValue(v);
    changes.push({ field: humanField(k), value: text, long });
  }
  // Short changes first, so "Status → In progress" is never below a page of description.
  changes.sort((a, b) => Number(a.long) - Number(b.long));
  return { verb: verbFor(tool), headline, ref: nameKey && refKey ? (args[refKey] as string) : null, changes };
}
