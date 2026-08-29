// Embeddings behind a swappable interface (see docs/07-tech-stack): Voyage in
// production, a deterministic hash fallback for dev so the RAG pipeline works
// without any external key. Both emit 1024-dim vectors to match the DB column.

export const EMBEDDING_DIMENSIONS = 1024;

export interface Embedder {
  readonly dimensions: number;
  readonly name: string;
  embed(texts: string[]): Promise<number[][]>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Voyage rate-limits per minute, and hard: an unbilled account gets 3 requests
// per minute. Ingesting a source is one request per document, so a sync of any
// real corpus hits 429 partway and — without this — would abort with half the
// documents stored and no record of which half. Retrying is not a nicety here.
const MAX_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 5_000;

class VoyageEmbedder implements Embedder {
  readonly dimensions = EMBEDDING_DIMENSIONS;
  readonly name = "voyage-3.5";
  constructor(private readonly apiKey: string) {}

  async embed(texts: string[]): Promise<number[][]> {
    let lastError = "";

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const res = await fetch("https://api.voyageai.com/v1/embeddings", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: "voyage-3.5",
          input: texts,
          output_dimension: EMBEDDING_DIMENSIONS,
        }),
      });

      if (res.ok) {
        const json = (await res.json()) as { data: { embedding: number[] }[] };
        return json.data.map((d) => d.embedding);
      }

      lastError = `${res.status} ${await res.text()}`;

      // 4xx other than 429 is a bad key or a bad request — retrying changes
      // nothing and only delays the error the caller needs to see.
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt === MAX_ATTEMPTS) break;

      // Honour Retry-After when the server sends one; otherwise back off
      // exponentially. The per-minute window means the first retry has to wait
      // seconds, not milliseconds, to be worth making.
      const retryAfter = Number(res.headers.get("retry-after"));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : Math.min(BASE_BACKOFF_MS * 2 ** (attempt - 1), 60_000);
      console.warn(
        `[rag] Voyage ${res.status} — retrying in ${Math.round(waitMs / 1000)}s (attempt ${attempt}/${MAX_ATTEMPTS})`,
      );
      await sleep(waitMs);
    }

    throw new Error(`Voyage embeddings failed: ${lastError}`);
  }
}

// Deterministic bag-of-words hash embedding. Cosine similarity tracks token
// overlap — good enough to prove retrieval ranks the relevant chunk first.
class HashEmbedder implements Embedder {
  readonly dimensions = EMBEDDING_DIMENSIONS;
  readonly name = "hash-fallback";

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => embedOne(t));
  }
}

function embedOne(text: string): number[] {
  const v = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  const tokens = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  for (const tok of tokens) v[hash(tok) % EMBEDDING_DIMENSIONS] += 1;
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

let embedder: Embedder | undefined;

export function getEmbedder(): Embedder {
  if (!embedder) {
    const key = process.env.VOYAGE_API_KEY;
    embedder = key ? new VoyageEmbedder(key) : new HashEmbedder();
  }
  return embedder;
}

export interface EmbedderStatus {
  name: string;
  // false ⇒ the dev hash fallback: fine to demo, but its vectors are NOT
  // compatible with Voyage's, so switching later requires re-ingesting everything.
  production: boolean;
}

export function embedderStatus(): EmbedderStatus {
  const e = getEmbedder();
  return { name: e.name, production: e.name !== "hash-fallback" };
}
