/**
 * Sensei calls the Anthropic Messages API through a fake client. The fake
 * records what callSensei sends and returns or throws what each case needs.
 *
 * Node's own test runner, no dependencies. Types are stripped at load.
 */
import test from "node:test";
import assert from "node:assert/strict";
import Anthropic from "@anthropic-ai/sdk";

import { callSensei } from "../../src/lib/sensei-llm.server.ts";

const MODEL = "claude-opus-5-5";
const SYSTEM = "SYSTEM PROMPT";
const FALLBACK_BETA = "server-side-fallback-2026-06-01";

/**
 * A fake client. `respond` is called with the recorded params and returns the
 * response, or throws.
 */
function fakeClient(respond) {
  const calls = [];
  return {
    calls,
    client: {
      beta: {
        messages: {
          create: async (params) => {
            calls.push(params);
            return respond(params);
          },
        },
      },
    },
  };
}

const okResponse = (text) => ({
  stop_reason: "end_turn",
  content: [{ type: "text", text }],
});

const userTurn = { role: "user", content: "How are we doing?" };
const assistantTurn = { role: "assistant", content: "Earlier answer." };

test("request carries model, max_tokens, system and the fallback beta, and no sampling or thinking keys", async () => {
  const { client, calls } = fakeClient(() => okResponse("ok"));

  await callSensei({ client, model: MODEL, system: SYSTEM, messages: [userTurn] });

  assert.equal(calls.length, 1);
  const params = calls[0];
  assert.equal(params.model, MODEL);
  assert.equal(params.max_tokens, 16000);
  assert.equal(params.system, SYSTEM);
  assert.deepEqual(params.betas, [FALLBACK_BETA]);
  assert.deepEqual(params.fallbacks, [{ model: "claude-opus-4-8" }]);
  assert.equal("thinking" in params, false);
  assert.equal("temperature" in params, false);
  assert.equal("top_p" in params, false);
  assert.equal("tool_choice" in params, false);
});

test("history starting with an assistant turn is trimmed so the request starts with a user message", async () => {
  const { client, calls } = fakeClient(() => okResponse("ok"));
  const history = [assistantTurn, userTurn, assistantTurn, userTurn];

  await callSensei({ client, model: MODEL, system: SYSTEM, messages: history });

  const sent = calls[0].messages;
  assert.equal(sent[0].role, "user");
  assert.equal(sent.length, 3);
});

test("only assistant messages returns the empty-response error without calling the API", async () => {
  const { client, calls } = fakeClient(() => okResponse("unused"));

  const result = await callSensei({
    client,
    model: MODEL,
    system: SYSTEM,
    messages: [assistantTurn, assistantTurn],
  });

  assert.deepEqual(result, { reply: null, error: "Empty response from AI." });
  assert.equal(calls.length, 0);
});

test("text blocks are joined and trimmed, thinking blocks are ignored", async () => {
  const { client } = fakeClient(() => ({
    stop_reason: "end_turn",
    content: [
      { type: "thinking", thinking: "" },
      { type: "text", text: " Hello " },
      { type: "text", text: "world" },
    ],
  }));

  const result = await callSensei({ client, model: MODEL, system: SYSTEM, messages: [userTurn] });

  assert.deepEqual(result, { reply: "Hello world", error: null });
});

test("only a thinking block returns the empty-response error", async () => {
  const { client } = fakeClient(() => ({
    stop_reason: "end_turn",
    content: [{ type: "thinking", thinking: "pondering" }],
  }));

  const result = await callSensei({ client, model: MODEL, system: SYSTEM, messages: [userTurn] });

  assert.deepEqual(result, { reply: null, error: "Empty response from AI." });
});

test("stop_reason refusal returns the refusal message", async () => {
  const { client } = fakeClient(() => ({
    stop_reason: "refusal",
    content: [{ type: "text", text: "I won't." }],
  }));

  const result = await callSensei({ client, model: MODEL, system: SYSTEM, messages: [userTurn] });

  assert.deepEqual(result, { reply: null, error: "Sensei can't answer that one." });
});

test("a 429 from the API maps to the rate-limit message", async () => {
  const { client } = fakeClient(() => {
    throw new Anthropic.RateLimitError(429, {}, "rate", new Headers());
  });

  const result = await callSensei({ client, model: MODEL, system: SYSTEM, messages: [userTurn] });

  assert.deepEqual(result, { reply: null, error: "Rate limit hit. Try again in a moment." });
});

test("a 500 from the API maps to the status error", async () => {
  const { client } = fakeClient(() => {
    throw new Anthropic.APIError(500, {}, "boom", new Headers());
  });

  const result = await callSensei({ client, model: MODEL, system: SYSTEM, messages: [userTurn] });

  assert.deepEqual(result, { reply: null, error: "AI error (500)." });
});

test("a connection failure maps to the unavailable message, not the API status error", async () => {
  const { client } = fakeClient(() => {
    throw new Anthropic.APIConnectionError({ message: "x" });
  });

  const result = await callSensei({ client, model: MODEL, system: SYSTEM, messages: [userTurn] });

  assert.deepEqual(result, { reply: null, error: "Sensei is unavailable right now." });
});

test("a plain network error maps to the unavailable message", async () => {
  const { client } = fakeClient(() => {
    throw new Error("socket hang up");
  });

  const result = await callSensei({ client, model: MODEL, system: SYSTEM, messages: [userTurn] });

  assert.deepEqual(result, { reply: null, error: "Sensei is unavailable right now." });
});
