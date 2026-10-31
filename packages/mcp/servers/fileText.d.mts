// Types for fileText.mjs, for the web app (the stdio servers need none).

/** Text from a file by its name's extension, or null when the format is not one fileText reads. Throws, in words, on a broken file. */
export function fileText(name: string, bytes: Uint8Array): Promise<string | null>;
/** Whether fileText reads this file's format, judged by its extension. */
export function canRead(name: string): boolean;
export function extOf(name: string): string;
export function tidy(s: string): string;
/** The formats fileText reads, in words for a person. */
export const READABLE: string;
export const READABLE_EXTENSIONS: string[];
