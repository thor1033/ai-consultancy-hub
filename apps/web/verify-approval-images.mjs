// Images on held writes (docs/approvals.md, "Images").
//
//   node --experimental-transform-types verify-approval-images.mjs
//   node --experimental-transform-types --env-file=.env.local verify-approval-images.mjs
//
// Without DATABASE_URL it checks what needs no database: the schema the model
// sees on a held tool (reason required, images optional, an upstream's own
// arguments untouched); that both are taken off the arguments before anything
// is recorded; the image type read from the bytes, never a header; SVG and
// non-images refused; and the fetch guard — https only, no private or
// internal address at any redirect hop, the size cap held while reading. The
// fetch checks use a stand-in fetcher and resolver, so nothing leaves the
// machine. With DATABASE_URL it goes on to hold a real write with an image,
// add one with the attach path, hit the four-image cap, and refuse an image on
// a decided write. Fixtures are created and deleted here.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@/")) {
      const base = new URL("./src/", import.meta.url);
      for (const ext of ["", ".ts", ".tsx", ".mjs", ".js", "/index.ts"]) {
        const url = new URL(specifier.slice(2) + ext, base);
        if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true };
      }
    }
    try {
      return nextResolve(specifier, context);
    } catch (err) {
      if (!specifier.startsWith(".")) return nextResolve(`${specifier}.js`, context);
      if (!context.parentURL) throw err;
      for (const ext of [".ts", ".mjs", ".js", "/index.ts"]) {
        const url = new URL(specifier + ext, context.parentURL);
        if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true };
      }
      throw err;
    }
  },
});

const checks = [];
function check(label, ok, detail = "") {
  checks.push({ label, ok });
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}

const img = await import("./src/lib/proposalImages.ts");
const gate = await import("./src/lib/approvals.ts");

// A 1×1 PNG, and the other formats' magic numbers.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46]);
const GIF = Buffer.from("GIF89a\x01\x00\x01\x00", "latin1");
const WEBP = Buffer.from("RIFF\x00\x00\x00\x00WEBPVP8 ", "latin1");
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

// ── the schema the model sees ───────────────────────────────────────────────
{
  const schema = gate.withReasonSchema({ type: "object", properties: { title: { type: "string" } }, required: ["title"] });
  check("a held tool gains a required reason", schema.required.includes("reason") && schema.properties.reason?.type === "string");
  check("…and an optional images argument beside it", schema.properties.images?.type === "array" && !schema.required.includes("images"));
  check("the images argument caps at four", schema.properties.images.maxItems === 4);
  const own = gate.withReasonSchema({ type: "object", properties: { images: { type: "string", description: "the upstream's own" } } });
  check("an upstream that declares its own images keeps it", own.properties.images.description === "the upstream's own" && own.properties.reason);
}
{
  const tool = { inputSchema: { type: "object", properties: { title: { type: "string" } } } };
  const out = gate.takeReason(tool, { title: "T", reason: "Because", images: [{ url: "https://x.example/a.png" }] });
  check("reason and images are taken off before the call is recorded", !("reason" in out.args) && !("images" in out.args) && out.args.title === "T");
  check("…and handed back to the gate", out.reason === "Because" && Array.isArray(out.images) && out.images.length === 1);
  const own = gate.takeReason({ inputSchema: { properties: { images: {} } } }, { images: "theirs", reason: "r" });
  check("an upstream's own images argument is forwarded untouched", own.args.images === "theirs" && own.images === undefined);
}

// ── reading the requests ────────────────────────────────────────────────────
{
  const r = img.readImageRequests([{ url: "https://a" }, { data: "xx", caption: "  Before  " }, { caption: "nothing" }, "junk"]);
  check("well-formed requests are kept, captions trimmed", r.requests.length === 2 && r.requests[1].caption === "Before");
  check("a request with neither url nor data is reported, not silently lost", r.notes.some((n) => n.includes("neither a url nor data")) && r.notes.some((n) => n.includes("not an object")));
  const five = img.readImageRequests(Array.from({ length: 6 }, (_, i) => ({ url: `https://x/${i}` })));
  check("past four, the rest are dropped with a note", five.requests.length === 4 && five.notes.some((n) => n.includes("first 4")));
  check("no images is no notes", img.readImageRequests(undefined).notes.length === 0);
}

// ── the bytes decide the type ───────────────────────────────────────────────
check("PNG sniffed", img.sniffImage(PNG) === "image/png");
check("JPEG sniffed", img.sniffImage(JPEG) === "image/jpeg");
check("GIF sniffed", img.sniffImage(GIF) === "image/gif");
check("WebP sniffed", img.sniffImage(WEBP) === "image/webp");
check("SVG is refused: it is a document that can carry script", img.sniffImage(SVG) === null);
{
  const ok = img.decodeImage(PNG.toString("base64"));
  check("base64 PNG decodes", !("error" in ok) && ok.mediaType === "image/png");
  const prefixed = img.decodeImage(`data:image/png;base64,${PNG.toString("base64")}`);
  check("a data: prefix is tolerated", !("error" in prefixed));
  const lying = img.decodeImage(`data:image/png;base64,${SVG.toString("base64")}`);
  check("an SVG labelled as PNG is refused by its bytes", "error" in lying, "error" in lying ? lying.error : "");
  check("non-base64 is refused", "error" in img.decodeImage("not base64 at all!"));
  const huge = "A".repeat(Math.ceil((img.MAX_IMAGE_BYTES * 4) / 3) + 8);
  check("an oversized payload is refused before decoding", "error" in img.decodeImage(huge));
}

// ── the fetch guard ─────────────────────────────────────────────────────────
for (const [ip, want] of [
  ["127.0.0.1", true], ["10.1.2.3", true], ["172.20.0.1", true], ["192.168.1.1", true],
  ["169.254.169.254", true], ["100.64.0.1", true], ["0.0.0.0", true], ["::1", true],
  ["fd00::1", true], ["fe80::1", true], ["::ffff:127.0.0.1", true],
  ["8.8.8.8", false], ["2606:4700::1111", false],
]) {
  check(`${ip} is ${want ? "refused" : "allowed"}`, img.isPrivateAddress(ip) === want);
}
{
  const publicDns = async () => ["93.184.216.34"];
  const evilDns = async () => ["169.254.169.254"];
  check("http is refused", (await img.urlRefusal("http://example.com/a.png", publicDns)) === "is not https");
  check("credentials in the URL are refused", (await img.urlRefusal("https://u:p@example.com/a.png", publicDns)) === "carries credentials");
  check("a name that resolves to the metadata address is refused", /private or internal/.test(await img.urlRefusal("https://evil.example/a.png", evilDns)));
  check("a literal private address is refused without a lookup", /private or internal/.test(await img.urlRefusal("https://10.0.0.5/a.png", publicDns)));
  check("a public https URL passes", (await img.urlRefusal("https://example.com/a.png", publicDns)) === null);

  const respond = (body, init = {}) => new Response(body, init);
  const seen = [];
  const fetcher = async (url) => {
    seen.push(url);
    if (url.endsWith("/png")) return respond(PNG, { status: 200, headers: { "content-type": "text/html" } });
    if (url.endsWith("/svg")) return respond(SVG, { status: 200, headers: { "content-type": "image/png" } });
    if (url.endsWith("/hop")) return respond(null, { status: 302, headers: { location: "https://inside.example/png" } });
    if (url.endsWith("/loop")) return respond(null, { status: 302, headers: { location: "/loop" } });
    if (url.endsWith("/404")) return respond("no", { status: 404 });
    if (url.endsWith("/big")) return respond(new Uint8Array(img.MAX_IMAGE_BYTES + 10).fill(0x89), { status: 200 });
    return respond("?", { status: 500 });
  };
  const dns = async (host) => (host === "inside.example" ? ["10.0.0.9"] : ["93.184.216.34"]);
  const ok = await img.fetchImage("https://cdn.example/png", { fetcher, resolve: dns });
  check("a PNG is fetched and typed by its bytes, whatever the header says", !("error" in ok) && ok.mediaType === "image/png");
  const svg = await img.fetchImage("https://cdn.example/svg", { fetcher, resolve: dns });
  check("an SVG served as image/png is refused", "error" in svg);
  seen.length = 0;
  const hop = await img.fetchImage("https://cdn.example/hop", { fetcher, resolve: dns });
  check("a redirect to a private address is refused at the hop", "error" in hop && /private or internal/.test(hop.error) && !seen.includes("https://inside.example/png"), "error" in hop ? hop.error : "");
  const loop = await img.fetchImage("https://cdn.example/loop", { fetcher, resolve: dns });
  check("redirects stop after three", "error" in loop && /more than 3/.test(loop.error));
  check("an error status is reported with its code", /404/.test((await img.fetchImage("https://cdn.example/404", { fetcher, resolve: dns })).error ?? ""));
  const big = await img.fetchImage("https://cdn.example/big", { fetcher, resolve: dns });
  check("the 5 MB cap holds while reading, whatever the headers say", "error" in big && /5 MB/.test(big.error));
}

// ── what the model is told ──────────────────────────────────────────────────
{
  const t = gate.heldText({ id: "p1", tool: "pm_update_task", server: "pm", images: [{}, {}], imageNotes: ["Image 3 was not attached: the URL is not https."] });
  check("the held-call text counts the images attached", /2 images are attached/.test(t));
  check("…and says which failed, so it reaches the answer a person reads", /Image 3 was not attached/.test(t) && /hub_attach_image/.test(t));
  check("no images, no image talk", !/image/i.test(gate.heldText({ id: "p", tool: "t", server: "s" })));
}

// ── with a database ─────────────────────────────────────────────────────────
if (!process.env.DATABASE_URL) {
  console.log("\n  (no DATABASE_URL — holding a write with images, the cap and the decided-write refusal were not driven)\n");
} else {
  const db = await import("../../packages/db/src/index.ts");
  const made = [];
  try {
    const tool = { name: "verify_write", server: "verify", description: "A write for the image checks.", inputSchema: { type: "object", properties: { title: { type: "string" } } } };
    const p = await gate.hold(tool, { title: "Ship it", reason: "Done, see screenshot", images: [{ data: PNG.toString("base64"), caption: "The finished page" }, { url: "http://insecure.example/a.png" }] }, {});
    made.push(p.id);
    check("holding a write stores its inline image", p.images.length === 1 && p.images[0].caption === "The finished page" && p.images[0].mediaType === "image/png");
    check("…and reports the one that failed, while still holding the write", p.imageNotes.length === 1 && /not https/.test(p.imageNotes[0]) && p.status === "pending");
    check("the recorded arguments carry neither reason nor images", JSON.stringify(p.args) === JSON.stringify({ title: "Ship it" }));
    const bytes = await db.getProposalImage(p.images[0].id);
    check("the stored bytes are the bytes sent", bytes && Buffer.compare(Buffer.from(bytes.bytes), PNG) === 0);
    for (let i = 0; i < 3; i++) await img.attachImages(p.id, [{ data: PNG.toString("base64"), caption: `extra ${i}` }], null);
    const fifth = await img.attachImages(p.id, [{ data: PNG.toString("base64") }], null);
    check("a fifth image is refused, naming the cap", fifth.attached.length === 0 && /already has 4/.test(fifth.notes[0] ?? ""));
    const four = await db.getProposal(p.id);
    check("images keep the order they were added in", four.images.map((i) => i.caption).join("|") === "The finished page|extra 0|extra 1|extra 2");
    await db.rejectProposal(p.id, "verify", "no");
    const late = await img.attachImages(p.id, [{ data: PNG.toString("base64") }], null);
    check("an image cannot be added once the write is decided", late.attached.length === 0 && /already rejected/.test(late.notes[0] ?? ""));
  } finally {
    const sql = db.getSql();
    for (const id of made) await sql`delete from proposals where id = ${id}`.catch(() => {});
    await sql.end();
  }
  console.log("\n  (not proven here: the image route's access rule, which needs a signed-in browser session)\n");
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed${failed.length ? ` — ${failed.length} FAILED` : ""}`);
process.exit(failed.length ? 1 : 0);
