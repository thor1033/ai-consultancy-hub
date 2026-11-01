// Types for detect.mjs, for the web app and @ai-hub/db (the stdio servers need none).

export type IdentifierKind = "cpr" | "card" | "iban";
export interface IdentifierSpan {
  kind: IdentifierKind;
  start: number;
  end: number;
}
export const IDENTIFIER_NAMES: Record<IdentifierKind, string>;
export const IDENTIFIER_MASKS: Record<IdentifierKind, string>;
/** Every CPR number, card number and IBAN in a text, in order, never overlapping. */
export function findIdentifiers(text: string): IdentifierSpan[];
export function countIdentifiers(text: string): Record<IdentifierKind, number>;
/** The text with each identifier replaced by its mask. */
export function maskIdentifiers(text: string): { text: string; masked: number };
/** Every string inside a JSON-shaped value masked. */
export function maskDeep<T>(value: T): { value: T; masked: number };
/** Why a text may not be remembered, in words for the agent; null when it may. */
export function identifierRefusal(text: string): string | null;
