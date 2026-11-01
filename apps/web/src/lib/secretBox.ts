import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

/*
 * Sealing a secret the hub must be able to read back — a connection's token,
 * and its address, which can carry a key in its path (docs/connections.md).
 * Hashing is not an option, as it is for the hub's own credentials: the hub
 * has to present this token to someone else.
 *
 * AES-256-GCM, a fresh 96-bit IV per seal, and the purpose bound in as
 * associated data ("mcp:<name>:token"), so a sealed value copied from one row
 * to another — another connection, or the address field — does not open.
 *
 * The key is derived (HKDF-SHA256) from HUB_SECRET_KEY when it is set, else
 * from WORKOS_COOKIE_PASSWORD, which every deployment already has because
 * AuthKit will not start without it. A sealed value records which one sealed
 * it, so adding HUB_SECRET_KEY later leaves what was sealed before readable
 * (new seals use the new key). Changing either secret makes what it sealed
 * unreadable; the hub then says so on the connection, and a person enters
 * the token again. Server-only: never import this from a client component,
 * the middleware or the edge.
 *
 *   v1.<hub|workos>.<iv>.<tag>.<ciphertext>   (each part base64url)
 */

type KeyId = "hub" | "workos";

const SOURCES: { id: KeyId; env: string }[] = [
  { id: "hub", env: "HUB_SECRET_KEY" },
  { id: "workos", env: "WORKOS_COOKIE_PASSWORD" },
];

// AuthKit itself refuses a cookie password under 32 characters; the same floor
// keeps a placeholder value from becoming a key.
const MIN_SECRET = 32;

function keyFor(id: KeyId): Buffer | null {
  const env = SOURCES.find((s) => s.id === id)!.env;
  const secret = process.env[env];
  if (!secret || secret.length < MIN_SECRET) return null;
  return Buffer.from(hkdfSync("sha256", secret, "ai-hub", `sealed-secrets v1 (${id})`, 32));
}

/** The key new seals use, or null when the deployment has none. */
function sealingKey(): { id: KeyId; key: Buffer } | null {
  for (const { id } of SOURCES) {
    const key = keyFor(id);
    if (key) return { id, key };
  }
  return null;
}

/** Whether this deployment can seal at all, and with what — for the page to say. */
export function sealingStatus(): { ok: true; key: "HUB_SECRET_KEY" | "WORKOS_COOKIE_PASSWORD" } | { ok: false; reason: string } {
  const k = sealingKey();
  if (!k) return { ok: false, reason: `Set HUB_SECRET_KEY (at least ${MIN_SECRET} characters) on the deployment so the hub can store connection tokens encrypted.` };
  return { ok: true, key: k.id === "hub" ? "HUB_SECRET_KEY" : "WORKOS_COOKIE_PASSWORD" };
}

export function sealSecret(plain: string, purpose: string): string {
  const k = sealingKey();
  if (!k) throw new Error(sealingStatus().ok ? "No key." : (sealingStatus() as { reason: string }).reason);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", k.key, iv);
  cipher.setAAD(Buffer.from(purpose, "utf8"));
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v1", k.id, iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ct.toString("base64url")].join(".");
}

/** Opens what sealSecret sealed for the same purpose. Throws, in words a person can act on, when it cannot. */
export function openSecret(sealed: string, purpose: string): string {
  const parts = sealed.split(".");
  if (parts.length !== 5 || parts[0] !== "v1" || (parts[1] !== "hub" && parts[1] !== "workos")) {
    throw new Error("it is not in a form this hub stores");
  }
  const id = parts[1] as KeyId;
  const key = keyFor(id);
  if (!key) {
    throw new Error(`it was encrypted with ${id === "hub" ? "HUB_SECRET_KEY" : "WORKOS_COOKIE_PASSWORD"}, which this deployment no longer has`);
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(parts[2], "base64url"));
    decipher.setAAD(Buffer.from(purpose, "utf8"));
    decipher.setAuthTag(Buffer.from(parts[3], "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(parts[4], "base64url")), decipher.final()]).toString("utf8");
  } catch {
    throw new Error(`it no longer opens — ${id === "hub" ? "HUB_SECRET_KEY" : "WORKOS_COOKIE_PASSWORD"} has changed since it was saved`);
  }
}
