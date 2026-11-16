/**
 * The pg_cron email worker (POST /api/public/hooks/email-queue) is tested here
 * through handleEmailQueue with a fake Supabase client and a fake sender, so no
 * network, no database and no real delay are involved.
 *
 * Node's own test runner, no dependencies. Types are stripped at load.
 */
import { describe, it, afterEach, mock } from "node:test";
import assert from "node:assert/strict";

import { handleEmailQueue } from "../../src/lib/email-queue-handler.server.ts";
import { EmailProviderError, isDomainNotVerified } from "../../src/lib/email-provider.server.ts";

const FIXED_NOW = Date.parse("2026-11-13T10:00:00.000Z");
const CRON_SECRET = "0123456789abcdef0123";
const PUBLISHABLE_KEY = "sb_publishable_test_0123456789abcdef";
const SERVICE_ROLE_KEY = "sb_secret_service_role_0123456789abcdef";
const RESEND_KEY = "re_test_0123456789abcdef";
const SUPABASE_URL = "https://project.supabase.co";
const ROUTE_URL = "https://sthenos.live/api/public/hooks/email-queue";

const DEFAULT_STATE = {
  retry_after_until: null,
  batch_size: 10,
  send_delay_ms: 0,
  auth_email_ttl_minutes: 15,
  transactional_email_ttl_minutes: 60,
};

function fullEnv(overrides = {}) {
  return {
    CRON_SECRET,
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY,
    SUPABASE_PUBLISHABLE_KEY: PUBLISHABLE_KEY,
    RESEND_API_KEY: RESEND_KEY,
    ...overrides,
  };
}

function request(authorization) {
  const headers = new Headers();
  if (authorization !== undefined) headers.set("authorization", authorization);
  return new Request(ROUTE_URL, { method: "POST", headers });
}

const bearer = (token) => `Bearer ${token}`;

// Every method a query in the worker chains, so the fake can record the whole chain.
const CHAIN_METHODS = [
  "select",
  "insert",
  "update",
  "upsert",
  "delete",
  "eq",
  "neq",
  "in",
  "is",
  "order",
  "limit",
  "single",
  "maybeSingle",
];

/** Default result for a table with no script: maybeSingle has no row, other reads are empty. */
function defaultTableResult(ops) {
  if (ops.some((op) => op.method === "maybeSingle")) return { data: null, error: null };
  return { data: [], error: null };
}

/**
 * Fake Supabase client. `tables[name]` is a static result or a function of the
 * recorded chain (`[{method, args}]`). `rpc[name]` is a static result or a
 * function of the rpc args. Every call is recorded on `log`.
 */
function fakeSupabase({ tables = {}, rpc = {} } = {}) {
  const log = { from: [], rpc: [] };
  return {
    log,
    from(table) {
      const entry = { table, ops: [] };
      log.from.push(entry);
      const builder = {
        then(onFulfilled, onRejected) {
          const scripted = tables[table];
          let result;
          if (typeof scripted === "function") result = scripted(entry.ops);
          else if (scripted !== undefined) result = scripted;
          else result = defaultTableResult(entry.ops);
          return Promise.resolve(result).then(onFulfilled, onRejected);
        },
      };
      for (const method of CHAIN_METHODS) {
        builder[method] = (...args) => {
          entry.ops.push({ method, args });
          return builder;
        };
      }
      return builder;
    },
    rpc(name, args) {
      log.rpc.push({ name, args });
      const scripted = rpc[name];
      const result = typeof scripted === "function" ? scripted(args) : scripted;
      return Promise.resolve(result ?? { data: null, error: null });
    },
  };
}

function fakeSend(script = () => ({ messageId: "re_ok" })) {
  const calls = [];
  const send = async (input, opts) => {
    calls.push({ input, opts });
    return script(input);
  };
  return { send, calls };
}

/** Builds the injected deps and the recorders the assertions read. */
function makeDeps({ env = fullEnv(), supabase = fakeSupabase(), send = fakeSend().send } = {}) {
  const created = [];
  const sleeps = [];
  const deps = {
    env,
    createSupabase(url, key) {
      created.push({ url, key });
      return supabase;
    },
    send,
    now: () => FIXED_NOW,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  };
  return { deps, supabase, created, sleeps };
}

async function run(req, deps) {
  const response = await handleEmailQueue(req, deps);
  return { status: response.status, body: await response.json() };
}

function iso(ms) {
  return new Date(ms).toISOString();
}

function queuedMessage(msgId, messageOverrides = {}) {
  return {
    msg_id: msgId,
    read_ct: 1,
    enqueued_at: iso(FIXED_NOW - 60_000),
    message: {
      message_id: `m-${msgId}`,
      to: "member@example.com",
      from: "Sthenos <notify@sthenos.live>",
      subject: `Subject ${msgId}`,
      html: "<p>Hello</p>",
      text: "Hello",
      label: "welcome",
      queued_at: iso(FIXED_NOW - 60_000),
      ...messageOverrides,
    },
  };
}

/** read_email_batch script: each queue returns its messages, or an error when given `{ error }`. */
function readBatches(byQueue) {
  return ({ queue_name: queueName }) => {
    const entry = byQueue[queueName] ?? [];
    if (entry && !Array.isArray(entry)) return { data: null, error: entry.error };
    return { data: entry, error: null };
  };
}

const readFailure = (message) => ({ error: { message } });

function rpcCalls(supabase, name) {
  return supabase.log.rpc.filter((call) => call.name === name).map((call) => call.args);
}

function logRows(supabase, status) {
  return supabase.log.from
    .filter((entry) => entry.table === "email_send_log")
    .flatMap((entry) => entry.ops.filter((op) => op.method === "insert").map((op) => op.args[0]))
    .filter((row) => status === undefined || row.status === status);
}

function stateUpdates(supabase) {
  return supabase.log.from
    .filter((entry) => entry.table === "email_send_state")
    .flatMap((entry) => entry.ops.filter((op) => op.method === "update").map((op) => op.args[0]));
}

afterEach(() => {
  mock.restoreAll();
});

function silenceConsole() {
  mock.method(console, "error", () => {});
  mock.method(console, "warn", () => {});
}

describe("authorisation", () => {
  it("rejects a request with no Authorization header with 401 and touches nothing", async () => {
    silenceConsole();
    const sent = fakeSend();
    const { deps, created } = makeDeps({ send: sent.send });

    const result = await run(request(), deps);

    assert.deepEqual(result, { status: 401, body: { error: "Unauthorized" } });
    assert.equal(created.length, 0);
    assert.equal(sent.calls.length, 0);
  });

  it("rejects the publishable key as a Bearer token, even though it is configured", async () => {
    silenceConsole();
    const sent = fakeSend();
    const { deps } = makeDeps({ send: sent.send });

    const result = await run(request(bearer(PUBLISHABLE_KEY)), deps);

    assert.equal(result.status, 401);
    assert.equal(sent.calls.length, 0);
  });

  it("rejects the service-role key as a Bearer token, even though it is configured", async () => {
    silenceConsole();
    const sent = fakeSend();
    const { deps } = makeDeps({ send: sent.send });

    const result = await run(request(bearer(SERVICE_ROLE_KEY)), deps);

    assert.equal(result.status, 401);
    assert.equal(sent.calls.length, 0);
  });

  it("accepts the correct CRON_SECRET Bearer (positive control)", async () => {
    silenceConsole();
    const { deps } = makeDeps();

    const result = await run(request(bearer(CRON_SECRET)), deps);

    assert.deepEqual(result, { status: 200, body: { processed: 0 } });
  });

  it("returns 401, not 500, to an unauthenticated caller when SUPABASE_URL and RESEND_API_KEY are unset", async () => {
    silenceConsole();
    const env = fullEnv({ SUPABASE_URL: undefined, RESEND_API_KEY: undefined });
    const { deps, created } = makeDeps({ env });

    const result = await run(request(), deps);

    assert.deepEqual(result, { status: 401, body: { error: "Unauthorized" } });
    assert.equal(created.length, 0);
  });

  it("returns 500 to the correct CRON_SECRET when SUPABASE_URL and RESEND_API_KEY are unset (positive control)", async () => {
    silenceConsole();
    const env = fullEnv({ SUPABASE_URL: undefined, RESEND_API_KEY: undefined });
    const { deps, created } = makeDeps({ env });

    const result = await run(request(bearer(CRON_SECRET)), deps);

    assert.deepEqual(result, { status: 500, body: { error: "Server configuration error" } });
    assert.equal(created.length, 0);
  });
});

describe("rate-limit cooldown", () => {
  it("skips the whole run while retry_after_until is in the future and never sends", async () => {
    silenceConsole();
    const supabase = fakeSupabase({
      tables: {
        email_send_state: {
          data: { ...DEFAULT_STATE, retry_after_until: iso(FIXED_NOW + 60_000) },
          error: null,
        },
      },
      rpc: { read_email_batch: readBatches({ auth_emails: [queuedMessage(1)] }) },
    });
    const sent = fakeSend();
    const { deps } = makeDeps({ supabase, send: sent.send });

    const result = await run(request(bearer(CRON_SECRET)), deps);

    assert.deepEqual(result, { status: 200, body: { skipped: true, reason: "rate_limited" } });
    assert.equal(sent.calls.length, 0);
    assert.equal(rpcCalls(supabase, "read_email_batch").length, 0);
  });
});

describe("provider responses", () => {
  it("on a 429 writes retry_after_until about 120s ahead and stops processing", async () => {
    silenceConsole();
    const supabase = fakeSupabase({
      tables: { email_send_state: { data: DEFAULT_STATE, error: null } },
      rpc: {
        read_email_batch: readBatches({
          auth_emails: [queuedMessage(1), queuedMessage(2)],
          transactional_emails: [queuedMessage(3)],
        }),
      },
    });
    const sent = fakeSend(() => {
      throw new EmailProviderError("Too many requests", 429, 120);
    });
    const { deps } = makeDeps({ supabase, send: sent.send });

    const result = await run(request(bearer(CRON_SECRET)), deps);

    assert.deepEqual(result, { status: 200, body: { processed: 0, stopped: "rate_limited" } });
    assert.equal(sent.calls.length, 1, "the second message in the batch must not be attempted");
    assert.equal(
      rpcCalls(supabase, "read_email_batch").length,
      1,
      "the transactional queue must not be read",
    );

    const updates = stateUpdates(supabase);
    assert.equal(updates.length, 1);
    assert.equal(updates[0].retry_after_until, iso(FIXED_NOW + 120_000));
    assert.equal(updates[0].updated_at, iso(FIXED_NOW));
  });

  it("on a 403 moves the message to the DLQ and logs a dlq row, then stops", async () => {
    silenceConsole();
    const supabase = fakeSupabase({
      tables: { email_send_state: { data: DEFAULT_STATE, error: null } },
      rpc: {
        read_email_batch: readBatches({ auth_emails: [queuedMessage(7), queuedMessage(8)] }),
      },
    });
    const sent = fakeSend(() => {
      throw new EmailProviderError("Forbidden", 403, null);
    });
    const { deps } = makeDeps({ supabase, send: sent.send });

    const result = await run(request(bearer(CRON_SECRET)), deps);

    assert.deepEqual(result, { status: 200, body: { processed: 0, stopped: "forbidden" } });
    assert.equal(sent.calls.length, 1);
    assert.deepEqual(rpcCalls(supabase, "move_to_dlq"), [
      {
        source_queue: "auth_emails",
        dlq_name: "auth_emails_dlq",
        message_id: 7,
        payload: queuedMessage(7).message,
      },
    ]);
    const dlqRows = logRows(supabase, "dlq");
    assert.equal(dlqRows.length, 1);
    assert.equal(dlqRows[0].message_id, "m-7");
    assert.equal(dlqRows[0].recipient_email, "member@example.com");
  });

  it("moves an expired message to the DLQ without sending it (TTL)", async () => {
    silenceConsole();
    const supabase = fakeSupabase({
      tables: { email_send_state: { data: DEFAULT_STATE, error: null } },
      rpc: {
        read_email_batch: readBatches({
          auth_emails: [queuedMessage(9, { queued_at: iso(FIXED_NOW - 2 * 60 * 60 * 1000) })],
        }),
      },
    });
    const sent = fakeSend();
    const { deps } = makeDeps({ supabase, send: sent.send });

    const result = await run(request(bearer(CRON_SECRET)), deps);

    assert.deepEqual(result, { status: 200, body: { processed: 0 } });
    assert.equal(sent.calls.length, 0);
    assert.equal(rpcCalls(supabase, "move_to_dlq")[0].dlq_name, "auth_emails_dlq");
  });
});

describe("email_send_state read", () => {
  it("returns 500 without sending when the state read fails with a non-PGRST116 error", async () => {
    silenceConsole();
    const supabase = fakeSupabase({
      tables: {
        email_send_state: {
          data: null,
          error: { code: "08006", message: "connection failure" },
        },
      },
      rpc: { read_email_batch: readBatches({ auth_emails: [queuedMessage(1)] }) },
    });
    const sent = fakeSend();
    const { deps } = makeDeps({ supabase, send: sent.send });

    const result = await run(request(bearer(CRON_SECRET)), deps);

    assert.deepEqual(result, { status: 500, body: { error: "Failed to read email state" } });
    assert.equal(sent.calls.length, 0);
    assert.equal(rpcCalls(supabase, "read_email_batch").length, 0);
  });

  it("continues with defaults when the state read returns PGRST116 (no row), positive control", async () => {
    silenceConsole();
    const supabase = fakeSupabase({
      tables: {
        email_send_state: {
          data: null,
          error: {
            code: "PGRST116",
            message: "JSON object requested, multiple (or no) rows returned",
          },
        },
      },
      rpc: { read_email_batch: readBatches({ auth_emails: [queuedMessage(1)] }) },
    });
    const sent = fakeSend();
    const { deps } = makeDeps({ supabase, send: sent.send });

    const result = await run(request(bearer(CRON_SECRET)), deps);

    assert.deepEqual(result, { status: 200, body: { processed: 1 } });
    assert.equal(sent.calls.length, 1);
  });
});

describe("queue reads", () => {
  it("returns 500 when reading both queues fails", async () => {
    silenceConsole();
    const supabase = fakeSupabase({
      tables: { email_send_state: { data: DEFAULT_STATE, error: null } },
      rpc: {
        read_email_batch: readBatches({
          auth_emails: readFailure("pgmq down"),
          transactional_emails: readFailure("pgmq down"),
        }),
      },
    });
    const sent = fakeSend();
    const { deps } = makeDeps({ supabase, send: sent.send });

    const result = await run(request(bearer(CRON_SECRET)), deps);

    assert.equal(result.status, 500);
    assert.equal(result.body.error, "Failed to read email queues");
    assert.equal(sent.calls.length, 0);
  });

  it("keeps going when only one queue read fails and sends the other queue's message", async () => {
    silenceConsole();
    const supabase = fakeSupabase({
      tables: { email_send_state: { data: DEFAULT_STATE, error: null } },
      rpc: {
        read_email_batch: readBatches({
          auth_emails: readFailure("transient"),
          transactional_emails: [queuedMessage(5)],
        }),
      },
    });
    const sent = fakeSend();
    const { deps } = makeDeps({ supabase, send: sent.send });

    const result = await run(request(bearer(CRON_SECRET)), deps);

    assert.deepEqual(result, { status: 200, body: { processed: 1 } });
    assert.equal(sent.calls.length, 1);
    assert.equal(sent.calls[0].input.to, "member@example.com");
  });
});

describe("happy path", () => {
  it("sends each message with its to/from/subject, deletes it from its queue and counts it", async () => {
    silenceConsole();
    const supabase = fakeSupabase({
      tables: {
        email_send_state: { data: { ...DEFAULT_STATE, send_delay_ms: 200 }, error: null },
      },
      rpc: {
        read_email_batch: readBatches({
          auth_emails: [
            queuedMessage(1, { to: "a@example.com", subject: "Verify" }),
            queuedMessage(2, { to: "b@example.com", subject: "Reset" }),
          ],
          transactional_emails: [queuedMessage(3, { to: "c@example.com", subject: "Receipt" })],
        }),
      },
    });
    const sent = fakeSend();
    const { deps, sleeps } = makeDeps({ supabase, send: sent.send });

    const result = await run(request(bearer(CRON_SECRET)), deps);

    assert.deepEqual(result, { status: 200, body: { processed: 3 } });
    assert.deepEqual(
      sent.calls.map((call) => [call.input.to, call.input.from, call.input.subject]),
      [
        ["a@example.com", "Sthenos <notify@sthenos.live>", "Verify"],
        ["b@example.com", "Sthenos <notify@sthenos.live>", "Reset"],
        ["c@example.com", "Sthenos <notify@sthenos.live>", "Receipt"],
      ],
    );
    assert.equal(sent.calls[0].opts.apiKey, RESEND_KEY);
    assert.deepEqual(
      rpcCalls(supabase, "delete_email").map((args) => [args.queue_name, args.message_id]),
      [
        ["auth_emails", 1],
        ["auth_emails", 2],
        ["transactional_emails", 3],
      ],
    );
    assert.deepEqual(
      logRows(supabase, "sent").map((row) => row.message_id),
      ["m-1", "m-2", "m-3"],
    );
    // Delay is injected: one pause between the two auth messages, none after the last one of a queue.
    assert.deepEqual(sleeps, [200]);
  });
});

describe("isDomainNotVerified", () => {
  it("is true for Resend's 403 domain-not-verified text", () => {
    assert.equal(
      isDomainNotVerified(
        403,
        "The sthenos.live domain is not verified. Please add and verify your domain on https://resend.com/domains",
      ),
      true,
    );
  });

  it("is false for a generic 403", () => {
    assert.equal(
      isDomainNotVerified(403, "This API key is restricted to only send emails."),
      false,
    );
  });

  it("is false for the same text on a non-403/400/422 status", () => {
    assert.equal(isDomainNotVerified(500, "The sthenos.live domain is not verified."), false);
  });
});

/**
 * email_send_log script for the worker's two lookups: the duplicate guard
 * (`.eq(message_id).eq(status,'sent').maybeSingle()`) and the failed-attempt
 * counter (`.in(message_id, ids).eq(status,'failed')`).
 */
function sendLogScript({ sentIds = [], failedCounts = {} } = {}) {
  return (ops) => {
    if (ops.some((op) => op.method === "maybeSingle")) {
      const messageId = ops.find((op) => op.method === "eq" && op.args[0] === "message_id")
        ?.args[1];
      return { data: sentIds.includes(messageId) ? { id: 1 } : null, error: null };
    }
    if (ops.some((op) => op.method === "in")) {
      const rows = [];
      for (const [messageId, count] of Object.entries(failedCounts)) {
        for (let i = 0; i < count; i++) rows.push({ message_id: messageId });
      }
      return { data: rows, error: null };
    }
    return { data: [], error: null };
  };
}

function sentSubjects(sent) {
  return sent.calls.map((call) => call.input.subject);
}

describe("duplicate-send guard", () => {
  it("skips a message that already has a sent row, deletes it from the queue, and still sends the decoy", async () => {
    silenceConsole();
    const supabase = fakeSupabase({
      tables: {
        email_send_state: { data: DEFAULT_STATE, error: null },
        email_send_log: sendLogScript({ sentIds: ["m-1"] }),
      },
      rpc: {
        read_email_batch: readBatches({ auth_emails: [queuedMessage(1), queuedMessage(2)] }),
      },
    });
    const sent = fakeSend();
    const { deps } = makeDeps({ supabase, send: sent.send });

    const result = await run(request(bearer(CRON_SECRET)), deps);

    assert.deepEqual(result, { status: 200, body: { processed: 1 } });
    assert.deepEqual(sentSubjects(sent), ["Subject 2"], "only the decoy may be sent");
    assert.deepEqual(rpcCalls(supabase, "delete_email"), [
      { queue_name: "auth_emails", message_id: 1 },
      { queue_name: "auth_emails", message_id: 2 },
    ]);
    assert.deepEqual(
      logRows(supabase, "sent").map((row) => row.message_id),
      ["m-2"],
      "no second sent row is written for the duplicate",
    );
    assert.equal(rpcCalls(supabase, "move_to_dlq").length, 0);
  });
});

describe("max retries", () => {
  it("moves a message with 5 failed attempts to the DLQ without sending it, and still sends the decoy", async () => {
    silenceConsole();
    const supabase = fakeSupabase({
      tables: {
        email_send_state: { data: DEFAULT_STATE, error: null },
        email_send_log: sendLogScript({ failedCounts: { "m-1": 5 } }),
      },
      rpc: {
        read_email_batch: readBatches({ auth_emails: [queuedMessage(1), queuedMessage(2)] }),
      },
    });
    const sent = fakeSend();
    const { deps } = makeDeps({ supabase, send: sent.send });

    const result = await run(request(bearer(CRON_SECRET)), deps);

    assert.deepEqual(result, { status: 200, body: { processed: 1 } });
    assert.deepEqual(sentSubjects(sent), ["Subject 2"], "the exhausted message must not be sent");
    assert.deepEqual(rpcCalls(supabase, "move_to_dlq"), [
      {
        source_queue: "auth_emails",
        dlq_name: "auth_emails_dlq",
        message_id: 1,
        payload: queuedMessage(1).message,
      },
    ]);
    const dlqRows = logRows(supabase, "dlq");
    assert.equal(dlqRows.length, 1);
    assert.equal(dlqRows[0].message_id, "m-1");
    assert.equal(dlqRows[0].error_message, "Max retries (5) exceeded (attempted 5 times)");
    assert.deepEqual(
      rpcCalls(supabase, "delete_email").map((call) => call.message_id),
      [2],
      "the DLQ move replaces the delete for message 1",
    );
  });

  it("still sends a message with 4 failed attempts (one below the limit, positive control)", async () => {
    silenceConsole();
    const supabase = fakeSupabase({
      tables: {
        email_send_state: { data: DEFAULT_STATE, error: null },
        email_send_log: sendLogScript({ failedCounts: { "m-1": 4 } }),
      },
      rpc: { read_email_batch: readBatches({ auth_emails: [queuedMessage(1)] }) },
    });
    const sent = fakeSend();
    const { deps } = makeDeps({ supabase, send: sent.send });

    const result = await run(request(bearer(CRON_SECRET)), deps);

    assert.deepEqual(result, { status: 200, body: { processed: 1 } });
    assert.deepEqual(sentSubjects(sent), ["Subject 1"]);
    assert.equal(rpcCalls(supabase, "move_to_dlq").length, 0);
  });

  it("a high pgmq read_ct alone does not DLQ a message: the budget counts failed sends", async () => {
    silenceConsole();
    const supabase = fakeSupabase({
      tables: {
        email_send_state: { data: DEFAULT_STATE, error: null },
        email_send_log: sendLogScript({ failedCounts: {} }),
      },
      rpc: {
        read_email_batch: readBatches({
          auth_emails: [{ ...queuedMessage(1), read_ct: 9 }, queuedMessage(2)],
        }),
      },
    });
    const sent = fakeSend();
    const { deps } = makeDeps({ supabase, send: sent.send });

    const result = await run(request(bearer(CRON_SECRET)), deps);

    assert.deepEqual(result, { status: 200, body: { processed: 2 } });
    assert.deepEqual(sentSubjects(sent), ["Subject 1", "Subject 2"]);
    assert.equal(rpcCalls(supabase, "move_to_dlq").length, 0);
  });
});

describe("generic send failure", () => {
  /** Sends message 1 with the given error and message 2 normally. */
  async function runWithFailingFirstSend(error) {
    silenceConsole();
    const supabase = fakeSupabase({
      tables: { email_send_state: { data: DEFAULT_STATE, error: null } },
      rpc: {
        read_email_batch: readBatches({ auth_emails: [queuedMessage(1), queuedMessage(2)] }),
      },
    });
    const sent = fakeSend((input) => {
      if (input.subject === "Subject 1") throw error;
      return { messageId: "re_ok" };
    });
    const { deps } = makeDeps({ supabase, send: sent.send });

    const result = await run(request(bearer(CRON_SECRET)), deps);
    return { result, supabase, sent };
  }

  function assertFailureRecorded(supabase, sent, result, errorMessage) {
    assert.deepEqual(result, { status: 200, body: { processed: 1 } }, "the batch must continue");
    assert.deepEqual(sentSubjects(sent), ["Subject 1", "Subject 2"]);
    assert.deepEqual(
      rpcCalls(supabase, "delete_email").map((call) => call.message_id),
      [2],
      "the failed message must not be deleted from the queue",
    );
    assert.equal(rpcCalls(supabase, "move_to_dlq").length, 0);

    const failedRows = logRows(supabase, "failed");
    assert.equal(failedRows.length, 1);
    assert.equal(failedRows[0].message_id, "m-1");
    assert.equal(failedRows[0].recipient_email, "member@example.com");
    assert.equal(failedRows[0].error_message, errorMessage);
    assert.deepEqual(
      logRows(supabase, "sent").map((row) => row.message_id),
      ["m-2"],
    );
  }

  it("an Error with no status is not deleted, is logged as failed, and the batch continues", async () => {
    const { result, supabase, sent } = await runWithFailingFirstSend(new Error("socket hang up"));

    assertFailureRecorded(supabase, sent, result, "socket hang up");
  });

  it("a 500 from the provider is not deleted, is logged as failed, and the batch continues", async () => {
    const { result, supabase, sent } = await runWithFailingFirstSend(
      new EmailProviderError("Internal server error", 500, null),
    );

    assertFailureRecorded(supabase, sent, result, "Internal server error");
  });
});

describe("TTL boundary and decoy", () => {
  it("an expired auth email goes to the DLQ with a dlq row, and a fresh decoy in the batch is sent", async () => {
    silenceConsole();
    const supabase = fakeSupabase({
      tables: { email_send_state: { data: DEFAULT_STATE, error: null } },
      rpc: {
        read_email_batch: readBatches({
          auth_emails: [
            queuedMessage(1, { queued_at: iso(FIXED_NOW - 16 * 60 * 1000) }),
            queuedMessage(2),
          ],
        }),
      },
    });
    const sent = fakeSend();
    const { deps } = makeDeps({ supabase, send: sent.send });

    const result = await run(request(bearer(CRON_SECRET)), deps);

    assert.deepEqual(result, { status: 200, body: { processed: 1 } });
    assert.deepEqual(sentSubjects(sent), ["Subject 2"]);
    assert.deepEqual(
      rpcCalls(supabase, "move_to_dlq").map((call) => call.message_id),
      [1],
    );
    const dlqRows = logRows(supabase, "dlq");
    assert.equal(dlqRows.length, 1);
    assert.equal(dlqRows[0].message_id, "m-1");
    assert.equal(dlqRows[0].error_message, "TTL exceeded (15 minutes)");
  });

  it("an auth email exactly at the 15-minute TTL is not expired and is sent (boundary control)", async () => {
    silenceConsole();
    const supabase = fakeSupabase({
      tables: { email_send_state: { data: DEFAULT_STATE, error: null } },
      rpc: {
        read_email_batch: readBatches({
          auth_emails: [queuedMessage(1, { queued_at: iso(FIXED_NOW - 15 * 60 * 1000) })],
        }),
      },
    });
    const sent = fakeSend();
    const { deps } = makeDeps({ supabase, send: sent.send });

    const result = await run(request(bearer(CRON_SECRET)), deps);

    assert.deepEqual(result, { status: 200, body: { processed: 1 } });
    assert.deepEqual(sentSubjects(sent), ["Subject 1"]);
    assert.equal(rpcCalls(supabase, "move_to_dlq").length, 0);
  });
});
