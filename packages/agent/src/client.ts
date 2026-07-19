import Anthropic from "@anthropic-ai/sdk";

let client: Anthropic | null = null;

// Single lazily-constructed Anthropic client. Reads ANTHROPIC_API_KEY from env.
// Kept behind a getter so importing the package never throws — only running does.
export function getAnthropic(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set — the agent runtime cannot reach Claude.",
    );
  }
  if (!client) client = new Anthropic();
  return client;
}
