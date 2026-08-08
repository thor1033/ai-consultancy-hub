import { allStudioTemplates } from "@/lib/pptxTemplates";
import { PptxStudio } from "./PptxStudio";

export const dynamic = "force-dynamic";

// The PowerPoint Studio — a full-screen editor: create/edit templates, manage
// slides and elements, fill with the agent, and download a real .pptx.
// Templates persist in the DB; the bundled sample is the starting point.
export default async function PptxPage() {
  const templates = await allStudioTemplates();
  return <PptxStudio initialTemplates={templates} />;
}
