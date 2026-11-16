/**
 * The Supabase Send Email Hook (POST /api/public/hooks/auth-email) is tested
 * through handleAuthEmailHook with a fake Supabase client, fake renderer and a
 * fake clock, so no network, no database and no React Email rendering are involved.
 *
 * Requests are signed the way Supabase signs them (Standard Webhooks), the same
 * way scripts/tests/auth-email-hook.test.mjs does.
 *
 * Node's own test runner, no dependencies. Types are stripped at load.
 */
import { describe, it, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

import {
  handleAuthEmailHook,
  redactEmail,
  subjectFor,
} from "../../src/lib/auth-email-handler.server.ts";
import { senderDisplayName } from "../../src/lib/auth-email-brand.server.ts";

const RAW_KEY = "test-secret-bytes-32-long-xxxxxx";
const SECRET = `v1,whsec_${Buffer.from(RAW_KEY).toString("base64")}`;
const SUPABASE_URL = "https://project.supabase.co";
const SERVICE_ROLE_KEY = "sb_secret_service_role_0123456789abcdef";
const FROM_ADDRESS = "notify@sthenos.live";
const SENDING_DOMAIN = "sthenos.live";
const SITE_URL = "https://sthenos.live";
const ROUTE_URL = "https://sthenos.live/api/public/hooks/auth-email";
const WEBHOOK_ID = "msg_abc123";
const MESSAGE_ID = "11111111-2222-4333-8444-555555555555";
const RECIPIENT = "member@example.com";
const REDACTED_RECIPIENT = "m***@example.com";
const BRAND = "Iron Dojo";
const FIXED_NOW = Date.parse("2026-11-13T10:00:00.000Z");

const nowSeconds = () => Math.floor(Date.now() / 1000);

function recoveryBody(overrides = {}) {
  return JSON.stringify({
    user: { id: "user-1", email: RECIPIENT, ...overrides.user },
    email_data: {
      token: "123456",
      token_hash: "hash-current",
      redirect_to: "https://app.example.com/reset",
      email_action_type: "recovery",
      site_url: SITE_URL,
      token_new: "",
      token_hash_new: "",
      ...overrides.email_data,
    },
  });
}

function signature(body, { id = WEBHOOK_ID, timestamp, key = RAW_KEY } = {}) {
  const digest = createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64");
  return `v1,${digest}`;
}

/** A request signed with the real key and a current timestamp. */
function signedRequest(body, { key } = {}) {
  const timestamp = nowSeconds();
  return new Request(ROUTE_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "webhook-id": WEBHOOK_ID,
      "webhook-timestamp": String(timestamp),
      "webhook-signature": signature(body, { timestamp, key }),
    },
    body,
  });
}

function unsignedRequest(body) {
  return new Request(ROUTE_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

function fullEnv(overrides = {}) {
  return {
    SEND_EMAIL_HOOK_SECRET: SECRET,
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY,
    ...overrides,
  };
}

/** Fake Supabase client. `insert(row)` and `rpc(name, args)` return the result the test scripts. */
function fakeSupabase({
  insert = () => ({ error: null }),
  rpc = () => ({ data: null, error: null }),
} = {}) {
  const log = { inserts: [], rpc: [] };
  return {
    log,
    from(table) {
      return {
        insert(row) {
          log.inserts.push({ table, row });
          return Promise.resolve(insert(row));
        },
      };
    },
    rpc(name, args) {
      log.rpc.push({ name, args });
      return Promise.resolve(rpc(name, args));
    },
  };
}

function makeDeps({
  env = fullEnv(),
  supabase = fakeSupabase(),
  render = () => ({ html: "<p>Hello</p>", text: "Hello" }),
} = {}) {
  const created = [];
  const renders = [];
  const brandLookups = [];
  const deps = {
    env,
    createSupabase(url, key) {
      created.push({ url, key });
      return supabase;
    },
    renderEmail: async (emailType, props) => {
      renders.push({ emailType, props });
      return render(emailType, props);
    },
    resolveBrand: async (_supabase, email) => {
      brandLookups.push(email);
      return BRAND;
    },
    senderDisplayName,
    fromAddress: FROM_ADDRESS,
    sendingDomain: SENDING_DOMAIN,
    siteUrl: SITE_URL,
    randomUUID: () => MESSAGE_ID,
    now: () => FIXED_NOW,
  };
  return { deps, supabase, created, renders, brandLookups };
}

async function run(request, deps) {
  const response = await handleAuthEmailHook(request, deps);
  return { status: response.status, body: await response.json() };
}

function logRows(supabase, status) {
  return supabase.log.inserts
    .map((entry) => entry.row)
    .filter((row) => status === undefined || row.status === status);
}

afterEach(() => {
  mock.restoreAll();
});

/** Captures every console.log/warn/error argument list so tests can read what was logged. */
function captureConsole() {
  const captured = [];
  for (const method of ["log", "warn", "error"]) {
    mock.method(console, method, (...args) => {
      captured.push({ method, args });
    });
  }
  return captured;
}

function silenceConsole() {
  captureConsole();
}

describe("request verification", () => {
  it("rejects an unsigned request with 400 and never touches Supabase or the queue", async () => {
    silenceConsole();
    const { deps, created, supabase } = makeDeps();

    const result = await run(unsignedRequest(recoveryBody()), deps);

    assert.equal(result.status, 400);
    assert.equal(created.length, 0);
    assert.equal(supabase.log.rpc.length, 0);
  });

  it("rejects a bad signature with 401 and never calls enqueue_email", async () => {
    silenceConsole();
    const { deps, supabase, renders } = makeDeps();

    const result = await run(
      signedRequest(recoveryBody(), { key: "some-other-key-entirely" }),
      deps,
    );

    assert.equal(result.status, 401);
    assert.equal(supabase.log.rpc.length, 0);
    assert.equal(supabase.log.inserts.length, 0);
    assert.equal(renders.length, 0);
  });

  it("answers the same correctly signed request with 200 (positive control)", async () => {
    silenceConsole();
    const { deps, supabase } = makeDeps();

    const result = await run(signedRequest(recoveryBody()), deps);

    assert.deepEqual(result, { status: 200, body: {} });
    assert.equal(supabase.log.rpc.length, 1);
  });
});

describe("configuration", () => {
  it("returns 500 when SEND_EMAIL_HOOK_SECRET is missing, and enqueues nothing", async () => {
    silenceConsole();
    const { deps, supabase, created } = makeDeps({
      env: fullEnv({ SEND_EMAIL_HOOK_SECRET: undefined }),
    });

    const result = await run(signedRequest(recoveryBody()), deps);

    assert.deepEqual(result, { status: 500, body: { error: "Server configuration error" } });
    assert.equal(created.length, 0);
    assert.equal(supabase.log.rpc.length, 0);
  });

  it("returns 200 for the same request once SEND_EMAIL_HOOK_SECRET is set (positive control)", async () => {
    silenceConsole();
    const { deps } = makeDeps({ env: fullEnv() });

    const result = await run(signedRequest(recoveryBody()), deps);

    assert.equal(result.status, 200);
  });

  it("returns 500 when SUPABASE_SERVICE_ROLE_KEY is missing, and never creates a client or enqueues", async () => {
    silenceConsole();
    const { deps, supabase, created } = makeDeps({
      env: fullEnv({ SUPABASE_SERVICE_ROLE_KEY: undefined }),
    });

    const result = await run(signedRequest(recoveryBody()), deps);

    assert.deepEqual(result, { status: 500, body: { error: "Server configuration error" } });
    assert.equal(created.length, 0);
    assert.equal(supabase.log.rpc.length, 0);
  });

  it("returns 200 for the same request once SUPABASE_SERVICE_ROLE_KEY is set (positive control)", async () => {
    silenceConsole();
    const { deps, created } = makeDeps({ env: fullEnv() });

    const result = await run(signedRequest(recoveryBody()), deps);

    assert.equal(result.status, 200);
    assert.deepEqual(created, [{ url: SUPABASE_URL, key: SERVICE_ROLE_KEY }]);
  });
});

describe("template lookup", () => {
  it("returns 400 when there is no template for the email type, and enqueues nothing", async () => {
    silenceConsole();
    const { deps, supabase } = makeDeps({ render: () => null });

    const result = await run(signedRequest(recoveryBody()), deps);

    assert.deepEqual(result, { status: 400, body: { error: "Unknown email type: recovery" } });
    assert.equal(supabase.log.rpc.length, 0);
    assert.equal(supabase.log.inserts.length, 0);
  });
});

describe("enqueue", () => {
  it("returns 500 when enqueue_email fails and records a 'failed' log row", async () => {
    silenceConsole();
    const supabase = fakeSupabase({
      rpc: () => ({ data: null, error: { message: "pgmq unavailable" } }),
    });
    const { deps } = makeDeps({ supabase });

    const result = await run(signedRequest(recoveryBody()), deps);

    assert.deepEqual(result, { status: 500, body: { error: "Failed to enqueue email" } });
    assert.equal(supabase.log.rpc.length, 1);
    const failed = logRows(supabase, "failed");
    assert.equal(failed.length, 1);
    assert.equal(failed[0].message_id, MESSAGE_ID);
    assert.equal(failed[0].template_name, "recovery");
    assert.equal(failed[0].error_message, "Failed to enqueue email");
  });

  it("sends the same request to the queue with the expected payload (positive control)", async () => {
    silenceConsole();
    const { deps, supabase } = makeDeps();

    const result = await run(signedRequest(recoveryBody()), deps);

    assert.deepEqual(result, { status: 200, body: {} });
    assert.equal(supabase.log.rpc.length, 1);
    assert.equal(supabase.log.rpc[0].name, "enqueue_email");
    assert.equal(supabase.log.rpc[0].args.queue_name, "auth_emails");
    assert.equal(logRows(supabase, "failed").length, 0);
  });
});

describe("pending log row", () => {
  it("logs a pending-insert error with the recipient redacted, and still enqueues and returns 200", async () => {
    const captured = captureConsole();
    const supabase = fakeSupabase({
      // The message echoes the clear address, so a log of the whole error would leak it.
      insert: (row) =>
        row.status === "pending"
          ? { error: { code: "23514", message: `check failed for ${RECIPIENT}` } }
          : { error: null },
    });
    const { deps } = makeDeps({ supabase });

    const result = await run(signedRequest(recoveryBody()), deps);

    assert.deepEqual(result, { status: 200, body: {} });
    assert.equal(supabase.log.rpc.length, 1, "enqueue_email must still be called");

    const pendingFailures = captured.filter(
      (entry) => entry.method === "error" && entry.args[0] === "Failed to log pending auth email",
    );
    assert.equal(pendingFailures.length, 1, "the pending-insert error must be logged");
    assert.equal(pendingFailures[0].args[1].email_redacted, REDACTED_RECIPIENT);

    const everythingLogged = JSON.stringify(captured.map((entry) => entry.args));
    assert.ok(
      everythingLogged.includes(REDACTED_RECIPIENT),
      "positive control: the redacted address is what was logged",
    );
    assert.ok(
      !everythingLogged.includes(RECIPIENT),
      "the clear recipient address must not appear in any console output",
    );
  });
});

describe("happy path", () => {
  it("enqueues one auth email with the expected queue, payload and response", async () => {
    silenceConsole();
    const { deps, supabase, renders, brandLookups } = makeDeps({
      render: () => ({ html: "<p>Reset</p>", text: "Reset" }),
    });

    const result = await run(signedRequest(recoveryBody()), deps);

    assert.deepEqual(result, { status: 200, body: {} });
    assert.deepEqual(brandLookups, [RECIPIENT]);
    assert.equal(renders.length, 1);
    assert.equal(renders[0].emailType, "recovery");
    assert.equal(renders[0].props.siteName, BRAND);
    assert.equal(renders[0].props.siteUrl, SITE_URL);

    assert.deepEqual(supabase.log.rpc, [
      {
        name: "enqueue_email",
        args: {
          queue_name: "auth_emails",
          payload: {
            run_id: WEBHOOK_ID,
            message_id: MESSAGE_ID,
            to: RECIPIENT,
            from: `${senderDisplayName(BRAND)} <${FROM_ADDRESS}>`,
            sender_domain: SENDING_DOMAIN,
            subject: `Reset your ${BRAND} password`,
            html: "<p>Reset</p>",
            text: "Reset",
            purpose: "transactional",
            label: "recovery",
            queued_at: new Date(FIXED_NOW).toISOString(),
          },
        },
      },
    ]);

    const pending = logRows(supabase, "pending");
    assert.equal(pending.length, 1);
    assert.equal(pending[0].recipient_email, RECIPIENT);
    assert.equal(pending[0].message_id, MESSAGE_ID);
  });

  it("looks up branding by the member's current address on an email change", async () => {
    silenceConsole();
    const body = JSON.stringify({
      user: { id: "user-1", email: "old@example.com", new_email: "new@example.com" },
      email_data: {
        token: "123456",
        token_hash: "hash-current",
        redirect_to: "https://app.example.com/",
        email_action_type: "email_change",
        site_url: SITE_URL,
        token_new: "654321",
        token_hash_new: "hash-new",
      },
    });
    const { deps, brandLookups, renders } = makeDeps();

    const result = await run(signedRequest(body), deps);

    assert.equal(result.status, 200);
    assert.deepEqual(brandLookups, ["old@example.com"]);
    assert.equal(renders.length, 2, "a secure email change renders one email per address");
    assert.equal(renders[0].props.recipient, "old@example.com");
    assert.equal(renders[1].props.recipient, "new@example.com");
  });
});

const CURRENT_ADDRESS = "old@example.com";
const NEW_ADDRESS = "new@example.com";

/** A secure email change: Supabase sends two OTPs, one per address. */
function secureEmailChangeBody() {
  return JSON.stringify({
    user: { id: "user-1", email: CURRENT_ADDRESS, new_email: NEW_ADDRESS },
    email_data: {
      token: "111111",
      token_hash: "hash-new-addr",
      token_new: "222222",
      token_hash_new: "hash-cur-addr",
      redirect_to: "https://app.example.com/",
      email_action_type: "email_change",
      site_url: SITE_URL,
    },
  });
}

/** Renders the confirmation URL into the html so each payload can be checked. */
const renderShowingUrl = (_emailType, props) => ({
  html: `<a href="${props.confirmationUrl}">${props.recipient}</a>`,
  text: props.recipient,
});

describe("secure email change", () => {
  it("enqueues one email to each address, each with its own confirmation link", async () => {
    silenceConsole();
    const { deps, supabase, renders } = makeDeps({ render: renderShowingUrl });

    const result = await run(signedRequest(secureEmailChangeBody()), deps);

    assert.deepEqual(result, { status: 200, body: {} });
    assert.equal(supabase.log.rpc.length, 2);
    const [toCurrent, toNew] = supabase.log.rpc.map((call) => call.args.payload);
    assert.equal(toCurrent.to, CURRENT_ADDRESS);
    assert.equal(toNew.to, NEW_ADDRESS);

    assert.ok(
      toCurrent.html.includes(
        `${SUPABASE_URL}/auth/v1/verify?token=hash-cur-addr&type=email_change`,
      ),
      "the current address must get token_hash_new",
    );
    assert.ok(
      toNew.html.includes(`${SUPABASE_URL}/auth/v1/verify?token=hash-new-addr&type=email_change`),
      "the new address must get token_hash",
    );
    assert.equal(renders.length, 2);
    assert.equal(renders[0].props.token, "111111");
    assert.equal(renders[1].props.token, "222222");
  });

  it("resolves branding once, from the current address", async () => {
    silenceConsole();
    const { deps, brandLookups } = makeDeps({ render: renderShowingUrl });

    await run(signedRequest(secureEmailChangeBody()), deps);

    assert.deepEqual(brandLookups, [CURRENT_ADDRESS]);
  });

  it("returns 500 when the second enqueue fails, after the first was queued", async () => {
    silenceConsole();
    const supabase = fakeSupabase({
      rpc: (_name, args) =>
        args.payload.to === NEW_ADDRESS
          ? { data: null, error: { code: "XX000", message: "queue down" } }
          : { data: null, error: null },
    });
    const { deps } = makeDeps({ supabase, render: renderShowingUrl });

    const result = await run(signedRequest(secureEmailChangeBody()), deps);

    assert.deepEqual(result, { status: 500, body: { error: "Failed to enqueue email" } });
    assert.equal(supabase.log.rpc.length, 2);
    const failed = logRows(supabase, "failed");
    assert.equal(failed.length, 1);
    assert.equal(failed[0].recipient_email, NEW_ADDRESS);
  });

  it("stops at the first failed enqueue and does not queue the second email", async () => {
    silenceConsole();
    const supabase = fakeSupabase({
      rpc: () => ({ data: null, error: { code: "XX000", message: "queue down" } }),
    });
    const { deps } = makeDeps({ supabase, render: renderShowingUrl });

    const result = await run(signedRequest(secureEmailChangeBody()), deps);

    assert.deepEqual(result, { status: 500, body: { error: "Failed to enqueue email" } });
    assert.equal(supabase.log.rpc.length, 1, "the second email must not be attempted");
    assert.equal(supabase.log.rpc[0].args.payload.to, CURRENT_ADDRESS);
  });
});

describe("enqueue error logging", () => {
  it("logs only the error code and the redacted address, never the address or message text", async () => {
    const captured = captureConsole();
    const supabase = fakeSupabase({
      // The RPC message echoes the clear address, as a Postgres error can.
      rpc: () => ({
        data: null,
        error: { code: "42501", message: `permission denied for ${RECIPIENT}` },
      }),
    });
    const { deps } = makeDeps({ supabase });

    const result = await run(signedRequest(recoveryBody()), deps);

    assert.equal(result.status, 500);
    const enqueueFailures = captured.filter(
      (entry) => entry.method === "error" && entry.args[0] === "Failed to enqueue auth email",
    );
    assert.equal(enqueueFailures.length, 1, "the enqueue failure must be logged");
    assert.deepEqual(enqueueFailures[0].args[1], {
      code: "42501",
      run_id: WEBHOOK_ID,
      emailType: "recovery",
      email_redacted: REDACTED_RECIPIENT,
    });

    const everythingLogged = JSON.stringify(captured.map((entry) => entry.args));
    assert.ok(
      everythingLogged.includes(REDACTED_RECIPIENT),
      "positive control: the redacted address is what was logged",
    );
    assert.ok(
      !everythingLogged.includes(RECIPIENT),
      "the clear recipient address must not appear in any console output",
    );
    assert.ok(
      !everythingLogged.includes("permission denied"),
      "the RPC error message text must not appear in any console output",
    );
  });
});

describe("subject and redaction helpers", () => {
  it("builds the subject for each auth email type", () => {
    assert.equal(subjectFor("signup", BRAND), "Confirm your email for Iron Dojo");
    assert.equal(subjectFor("invite", BRAND), "You've been invited to join Iron Dojo");
    assert.equal(subjectFor("magiclink", BRAND), "Your Iron Dojo login link");
    assert.equal(subjectFor("recovery", BRAND), "Reset your Iron Dojo password");
    assert.equal(subjectFor("email_change", BRAND), "Confirm your new email for Iron Dojo");
    assert.equal(subjectFor("reauthentication", BRAND), "Your Iron Dojo verification code");
    assert.equal(subjectFor("unknown_type", BRAND), "Iron Dojo notification");
  });

  it("keeps the first letter of the local part and the whole domain", () => {
    assert.equal(redactEmail(RECIPIENT), REDACTED_RECIPIENT);
    assert.equal(redactEmail(null), "***");
    assert.equal(redactEmail(""), "***");
    assert.equal(redactEmail("no-at-sign"), "***");
  });
});
