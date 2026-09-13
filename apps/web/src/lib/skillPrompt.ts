import type { SkillParameter } from "@ai-hub/db";

/*
 * Turning a skill's template and a caller's arguments into a prompt.
 *
 * The arguments arrive from a language model on someone else's machine, so
 * nothing here trusts them: unknown keys are dropped, types are checked, and a
 * value is only ever substituted into a placeholder. The template is a prompt,
 * not a query or a shell command, so the risk is not injection into an
 * interpreter — it is a missing value silently becoming the literal text
 * "{{client}}" in something a client reads, or an unfilled skill running
 * anyway and producing confident nonsense.
 */

export interface FilledPrompt {
  prompt: string;
  /** The values actually used, for the run record. */
  used: Record<string, string>;
}

export type FillResult = FilledPrompt | { error: string };

const PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

/** The placeholders a template actually references, in order of appearance. */
export function templatePlaceholders(template: string): string[] {
  return [...new Set(Array.from(template.matchAll(PLACEHOLDER), (m) => m[1]))];
}

/**
 * Parameters declared but never referenced by the template.
 *
 * Worth surfacing in the editor: a declared-but-unused parameter means the
 * caller is asked for something that changes nothing, which reads as a broken
 * tool long before anyone suspects a typo in a placeholder.
 */
export function unusedParameters(
  template: string,
  parameters: SkillParameter[],
): string[] {
  const used = new Set(templatePlaceholders(template));
  return parameters.map((p) => p.name).filter((n) => !used.has(n));
}

/** Placeholders the template references that no parameter declares. */
export function undeclaredPlaceholders(
  template: string,
  parameters: SkillParameter[],
): string[] {
  const declared = new Set(parameters.map((p) => p.name));
  return templatePlaceholders(template).filter((n) => !declared.has(n));
}

export function fillTemplate(
  template: string,
  parameters: SkillParameter[],
  args: Record<string, unknown>,
): FillResult {
  const used: Record<string, string> = {};

  for (const param of parameters) {
    const raw = args[param.name];
    const missing = raw === undefined || raw === null || raw === "";

    if (missing) {
      if (param.required) return { error: `"${param.name}" is required.` };
      // An omitted optional parameter renders as empty rather than leaving the
      // placeholder in the text. A prompt containing a literal "{{week}}" is
      // worse than one missing a clause: the model treats it as content.
      used[param.name] = "";
      continue;
    }

    if (param.type === "number") {
      const n = typeof raw === "number" ? raw : Number(String(raw).trim());
      if (!Number.isFinite(n)) return { error: `"${param.name}" must be a number.` };
      used[param.name] = String(n);
      continue;
    }

    if (param.type === "boolean") {
      const s = String(raw).trim().toLowerCase();
      if (typeof raw !== "boolean" && s !== "true" && s !== "false") {
        return { error: `"${param.name}" must be true or false.` };
      }
      used[param.name] = String(raw === true || s === "true");
      continue;
    }

    const value = String(raw);
    if (param.options?.length && !param.options.includes(value)) {
      return {
        error: `"${param.name}" must be one of: ${param.options.join(", ")}.`,
      };
    }
    used[param.name] = value;
  }

  // Replaced from the parameter list rather than by scanning the template, so a
  // placeholder nobody declared stays literal instead of being filled from an
  // undeclared argument the caller invented.
  const prompt = template.replace(PLACEHOLDER, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(used, name) ? used[name] : whole,
  );

  return { prompt, used };
}
