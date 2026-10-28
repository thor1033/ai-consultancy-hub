import { authorize } from "@ai-hub/authz";
import { getProposal, getProposalImage } from "@ai-hub/db";
import { sessionCan } from "@/lib/sessionPrincipal";

/*
 * One image attached to a proposal, for the Approvals page.
 *
 * Served only to someone who may see the proposal it belongs to: an admin,
 * the person the run acted as, or the person it was sent to — the same rule
 * the page lists by. Anyone else gets a 404, not a 403, so an image id says
 * nothing about whether it exists.
 *
 * The bytes are untrusted. They were sniffed to be PNG, JPEG, GIF or WebP on
 * the way in (lib/proposalImages.ts); here they go out with that type pinned,
 * nosniff, and a CSP that lets them do nothing but be an image, so even a
 * crafted file opened in its own tab cannot run anything.
 */
export const dynamic = "force-dynamic";

const SAFE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const notFound = () => new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  if (!/^[0-9a-f-]{36}$/i.test(id)) return notFound();

  const viewer = await sessionCan("agent:run");
  if (!viewer) return notFound();
  const image = await getProposalImage(id);
  if (!image || !SAFE_TYPES.has(image.mediaType)) return notFound();
  const proposal = await getProposal(image.proposalId);
  if (!proposal) return notFound();
  const admin = await authorize(viewer, "admin:manage");
  const visible = admin || proposal.principalId === viewer.id || proposal.assignedTo === viewer.id;
  if (!visible) return notFound();

  return new Response(Buffer.from(image.bytes), {
    headers: {
      "Content-Type": image.mediaType,
      "Content-Length": String(image.bytes.byteLength),
      // An image never changes once stored; the viewer's browser may keep it.
      "Cache-Control": "private, max-age=86400, immutable",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
      "Cross-Origin-Resource-Policy": "same-origin",
    },
  });
}
