// PowerPoint-generation MCP server (demo). Builds a real .pptx from structured
// sections using pptxgenjs and writes it to an outputs directory.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import pptxgen from "pptxgenjs";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const OUTPUT_DIR = process.env.HUB_OUTPUT_DIR ?? join(tmpdir(), "ai-hub-outputs");

const server = new McpServer({ name: "pptx", version: "0.1.0" });

server.registerTool(
  "create_presentation",
  {
    description:
      "Create a PowerPoint (.pptx) from a title and a list of content sections. " +
      "Returns the path to the generated file.",
    inputSchema: {
      title: z.string().describe("Presentation title"),
      subtitle: z.string().optional().describe("Subtitle / client name / date"),
      sections: z
        .array(
          z.object({
            heading: z.string(),
            bullets: z.array(z.string()).optional(),
            body: z.string().optional(),
          }),
        )
        .describe("One slide per section"),
    },
  },
  async ({ title, subtitle, sections }) => {
    const pptx = new pptxgen();
    pptx.layout = "LAYOUT_WIDE";

    // Title slide.
    const title_slide = pptx.addSlide();
    title_slide.background = { color: "0B1220" };
    title_slide.addText(title, {
      x: 0.6, y: 2.1, w: 12, h: 1.2, fontSize: 40, bold: true, color: "FFFFFF",
    });
    if (subtitle) {
      title_slide.addText(subtitle, {
        x: 0.6, y: 3.4, w: 12, h: 0.6, fontSize: 20, color: "6EE7B7",
      });
    }

    // Content slides.
    for (const sec of sections) {
      const slide = pptx.addSlide();
      slide.addText(sec.heading, {
        x: 0.6, y: 0.4, w: 12, h: 0.8, fontSize: 26, bold: true, color: "0B1220",
      });
      if (sec.body) {
        slide.addText(sec.body, { x: 0.6, y: 1.4, w: 12, h: 1.2, fontSize: 14, color: "333333" });
      }
      if (sec.bullets && sec.bullets.length > 0) {
        slide.addText(
          sec.bullets.map((b) => ({ text: b, options: { bullet: true } })),
          { x: 0.6, y: sec.body ? 2.6 : 1.4, w: 12, h: 4, fontSize: 16, color: "1F2937" },
        );
      }
    }

    mkdirSync(OUTPUT_DIR, { recursive: true });
    const safe = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const fileName = `${safe || "presentation"}-${Date.now()}.pptx`;
    const filePath = join(OUTPUT_DIR, fileName);
    await pptx.writeFile({ fileName: filePath });

    return {
      content: [
        {
          type: "text",
          text: `Created presentation with ${sections.length + 1} slides at: ${filePath}`,
        },
      ],
    };
  },
);

await server.connect(new StdioServerTransport());
