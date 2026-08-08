// Types for the pptx-template public API (implementation is ESM .mjs).
export type PlaceholderKind = "text" | "list" | "table-rows" | "chart-series" | "data";

export interface Placeholder {
  key: string;
  kind: PlaceholderKind;
  where: string;
  hasDefault?: boolean;
}

export interface StoredTemplate {
  id: string;
  name: string;
  template: unknown;
}

export interface RenderFileResult {
  filePath: string;
  slides: number;
}

export interface RenderBufferResult {
  buffer: Buffer;
  slides: number;
  fileName: string;
}

export function renderTemplate(
  template: unknown,
  values?: Record<string, unknown>,
): Promise<RenderFileResult>;

export function renderTemplateToBuffer(
  template: unknown,
  values?: Record<string, unknown>,
): Promise<RenderBufferResult>;

export function resolve(node: unknown, values: Record<string, unknown>): unknown;

export function parseTemplate(t: unknown): unknown;
export const templateSchema: unknown;

export function extractPlaceholders(template: unknown): Placeholder[];

export function loadTemplates(): Map<string, StoredTemplate>;

export const sampleTemplate: unknown;
export const sampleValues: Record<string, unknown>;
