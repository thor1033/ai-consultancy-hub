// Paragraph-aware chunking with a hard character cap. Deliberately simple for
// the MVP — a smarter splitter (token-based, overlap) is a later refinement.
export function chunkText(text: string, maxChars = 1000): string[] {
  const clean = text.replace(/\r\n/g, "\n").trim();
  if (clean.length === 0) return [];
  if (clean.length <= maxChars) return [clean];

  const paragraphs = clean.split(/\n\s*\n/);
  const chunks: string[] = [];
  let current = "";

  for (const p of paragraphs) {
    if (current && (current + "\n\n" + p).length > maxChars) {
      chunks.push(current.trim());
      current = "";
    }
    if (p.length > maxChars) {
      for (let i = 0; i < p.length; i += maxChars) {
        chunks.push(p.slice(i, i + maxChars).trim());
      }
    } else {
      current = current ? current + "\n\n" + p : p;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}
