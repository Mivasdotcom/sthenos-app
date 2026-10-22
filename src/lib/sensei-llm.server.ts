/**
 * Sensei's call to the Anthropic Messages API. This module takes an already
 * built client, so it has no knowledge of env vars or the server function.
 *
 * Alias-free on purpose: it imports only the SDK, so the test script can load
 * it with Node's type stripping.
 */
import Anthropic from "@anthropic-ai/sdk";

const MAX_TOKENS = 16000;
const FALLBACK_BETA = "server-side-fallback-2026-06-01";
const FALLBACK_MODEL = "claude-opus-4-8";

const EMPTY_REPLY_ERROR = "Empty response from AI.";
const REFUSAL_ERROR = "Sensei can't answer that one.";
const RATE_LIMIT_ERROR = "Rate limit hit. Try again in a moment.";
const UNAVAILABLE_ERROR = "Sensei is unavailable right now.";

/** The part of the Anthropic client that Sensei uses. A real `Anthropic` satisfies it. */
export type SenseiClient = {
  beta: {
    messages: {
      create(
        params: Anthropic.Beta.MessageCreateParamsNonStreaming,
      ): Promise<Anthropic.Beta.BetaMessage>;
    };
  };
};

export type SenseiTurn = { role: "user" | "assistant"; content: string };

export type SenseiResult = { reply: string | null; error: string | null };

export async function callSensei(args: {
  client: SenseiClient;
  model: string;
  system: string;
  messages: SenseiTurn[];
}): Promise<SenseiResult> {
  // The API requires the conversation to open with a user turn.
  const firstUser = args.messages.findIndex((m) => m.role === "user");
  if (firstUser === -1) return { reply: null, error: EMPTY_REPLY_ERROR };
  const messages = args.messages
    .slice(firstUser)
    .map((m) => ({ role: m.role, content: m.content }));

  try {
    const response = await args.client.beta.messages.create({
      model: args.model,
      max_tokens: MAX_TOKENS,
      system: args.system,
      messages,
      betas: [FALLBACK_BETA],
      fallbacks: [{ model: FALLBACK_MODEL }],
    });

    if (response.stop_reason === "refusal") return { reply: null, error: REFUSAL_ERROR };

    const text = response.content
      .filter((block): block is Anthropic.Beta.BetaTextBlock => block.type === "text")
      .map((block) => block.text)
      .join("")
      .trim();
    if (!text) return { reply: null, error: EMPTY_REPLY_ERROR };
    return { reply: text, error: null };
  } catch (err) {
    // Most specific first: RateLimitError and APIConnectionError both extend APIError.
    if (err instanceof Anthropic.RateLimitError) return { reply: null, error: RATE_LIMIT_ERROR };
    if (err instanceof Anthropic.APIConnectionError) {
      console.error("Sensei connection failed:", err.name);
      return { reply: null, error: UNAVAILABLE_ERROR };
    }
    if (err instanceof Anthropic.APIError) {
      console.error("Sensei API error:", err.status, err.requestID ?? "no-request-id");
      return { reply: null, error: `AI error (${err.status}).` };
    }
    console.error("Sensei call failed:", err instanceof Error ? err.name : "unknown");
    return { reply: null, error: UNAVAILABLE_ERROR };
  }
}
