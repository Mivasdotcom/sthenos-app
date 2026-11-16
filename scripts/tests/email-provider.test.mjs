/**
 * The single Resend adapter every outgoing email goes through.
 *
 * Covers the behaviour the send path and the queue worker depend on: the
 * Resend id comes back on success, 429 and 403 surface as EmailProviderError
 * with the status and Retry-After the worker branches on, unsubscribe headers
 * are only sent when a token exists, and the API key never leaks into an
 * error message.
 *
 * Node's own test runner, no dependencies. Types are stripped at load.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { EmailProviderError, sendEmail } from "../../src/lib/email-provider.server.ts";

const KEY = "re_test_key_abc";

const BASE_INPUT = {
  to: "member@example.com",
  from: "Dojo <noreply@notify.example.com>",
  subject: "Hello",
  html: "<p>Hello</p>",
  text: "Hello",
};

/** Records every call and answers with the given Response. */
function stubFetch(makeResponse) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return makeResponse();
  };
  return { fetchImpl, calls };
}

function jsonResponse(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

test("a success returns the Resend message id", async () => {
  const { fetchImpl } = stubFetch(() => jsonResponse(200, { id: "msg_123" }));

  const result = await sendEmail(BASE_INPUT, { apiKey: KEY, fetchImpl });

  assert.deepEqual(result, { messageId: "msg_123" });
});

test("the request goes to the Resend emails endpoint as a JSON POST with the bearer key", async () => {
  const { fetchImpl, calls } = stubFetch(() => jsonResponse(200, { id: "msg_1" }));

  await sendEmail(BASE_INPUT, { apiKey: KEY, fetchImpl });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.resend.com/emails");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${KEY}`);
  assert.equal(calls[0].init.headers["Content-Type"], "application/json");
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body.to, [BASE_INPUT.to]);
  assert.equal(body.from, BASE_INPUT.from);
  assert.equal(body.subject, BASE_INPUT.subject);
  assert.equal(body.html, BASE_INPUT.html);
  assert.equal(body.text, BASE_INPUT.text);
});

test("Idempotency-Key is sent when given and absent otherwise", async () => {
  const withKey = stubFetch(() => jsonResponse(200, { id: "m" }));
  await sendEmail(
    { ...BASE_INPUT, idempotencyKey: "idem-42" },
    { apiKey: KEY, fetchImpl: withKey.fetchImpl },
  );
  assert.equal(withKey.calls[0].init.headers["Idempotency-Key"], "idem-42");

  const withoutKey = stubFetch(() => jsonResponse(200, { id: "m" }));
  await sendEmail(BASE_INPUT, { apiKey: KEY, fetchImpl: withoutKey.fetchImpl });
  assert.equal(withoutKey.calls[0].init.headers["Idempotency-Key"], undefined);
});

test("HTTP 429 throws EmailProviderError with status 429 and Retry-After seconds", async () => {
  const { fetchImpl } = stubFetch(() =>
    jsonResponse(429, { message: "Too many requests" }, { "retry-after": "30" }),
  );

  await assert.rejects(sendEmail(BASE_INPUT, { apiKey: KEY, fetchImpl }), (error) => {
    assert.ok(error instanceof EmailProviderError);
    assert.equal(error.status, 429);
    assert.equal(error.retryAfterSeconds, 30);
    assert.equal(error.message, "Too many requests");
    return true;
  });
});

test("HTTP 429 without a Retry-After header leaves retryAfterSeconds null", async () => {
  const { fetchImpl } = stubFetch(() => jsonResponse(429, { message: "slow down" }));

  await assert.rejects(sendEmail(BASE_INPUT, { apiKey: KEY, fetchImpl }), (error) => {
    assert.equal(error.status, 429);
    assert.equal(error.retryAfterSeconds, null);
    return true;
  });
});

test("HTTP 403 throws EmailProviderError with status 403 and the provider message", async () => {
  const { fetchImpl } = stubFetch(() =>
    jsonResponse(403, { message: "The notify.example.com domain is not verified" }),
  );

  await assert.rejects(sendEmail(BASE_INPUT, { apiKey: KEY, fetchImpl }), (error) => {
    assert.ok(error instanceof EmailProviderError);
    assert.equal(error.status, 403);
    assert.equal(error.retryAfterSeconds, null);
    assert.ok(error.message.includes("domain is not verified"), error.message);
    return true;
  });
});

test("a non-JSON error body falls back to a generic message with the status", async () => {
  const { fetchImpl } = stubFetch(() => new Response("<html>bad gateway</html>", { status: 502 }));

  await assert.rejects(sendEmail(BASE_INPUT, { apiKey: KEY, fetchImpl }), (error) => {
    assert.equal(error.status, 502);
    assert.equal(error.message, "Resend error 502");
    return true;
  });
});

test("List-Unsubscribe headers are sent when unsubscribeUrl is given", async () => {
  const url = "https://sthenos.live/unsubscribe?token=tok_abc";
  const { fetchImpl, calls } = stubFetch(() => jsonResponse(200, { id: "m" }));

  await sendEmail({ ...BASE_INPUT, unsubscribeUrl: url }, { apiKey: KEY, fetchImpl });

  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body.headers, {
    "List-Unsubscribe": `<${url}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  });
});

test("no headers key is sent when unsubscribeUrl is absent", async () => {
  const { fetchImpl, calls } = stubFetch(() => jsonResponse(200, { id: "m" }));

  await sendEmail(BASE_INPUT, { apiKey: KEY, fetchImpl });

  const body = JSON.parse(calls[0].init.body);
  assert.equal("headers" in body, false);
});

test("tags are sent as name/value pairs with characters Resend rejects replaced by underscores", async () => {
  const { fetchImpl, calls } = stubFetch(() => jsonResponse(200, { id: "m" }));

  await sendEmail(
    { ...BASE_INPUT, tags: { label: "welcome email/v2", purpose: "transactional" } },
    { apiKey: KEY, fetchImpl },
  );

  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body.tags, [
    { name: "label", value: "welcome_email_v2" },
    { name: "purpose", value: "transactional" },
  ]);
});

test("the API key never appears in a thrown error message", async () => {
  const leakingKey = "re_secret123";
  const { fetchImpl } = stubFetch(() => jsonResponse(401, { message: "bad key re_secret123" }));

  await assert.rejects(sendEmail(BASE_INPUT, { apiKey: leakingKey, fetchImpl }), (error) => {
    assert.ok(error instanceof EmailProviderError);
    assert.equal(error.status, 401);
    assert.equal(error.message.includes("re_secret123"), false, error.message);
    assert.ok(error.message.includes("[redacted]"), error.message);
    return true;
  });
});

test("a network failure throws EmailProviderError with no status and only the error type", async () => {
  const fetchImpl = async () => {
    throw new TypeError("fetch failed for https://api.resend.com/emails?key=re_secret123");
  };

  await assert.rejects(sendEmail(BASE_INPUT, { apiKey: KEY, fetchImpl }), (error) => {
    assert.ok(error instanceof EmailProviderError);
    assert.equal(error.status, null);
    assert.equal(error.retryAfterSeconds, null);
    assert.equal(error.message, "Email provider unreachable (TypeError)");
    return true;
  });
});

test("a missing API key throws before any request is made", async () => {
  const saved = process.env.RESEND_API_KEY;
  delete process.env.RESEND_API_KEY;
  const { fetchImpl, calls } = stubFetch(() => jsonResponse(200, { id: "m" }));
  try {
    await assert.rejects(sendEmail(BASE_INPUT, { fetchImpl }), (error) => {
      assert.ok(error instanceof EmailProviderError);
      assert.equal(error.message, "RESEND_API_KEY is not configured");
      assert.equal(error.status, null);
      return true;
    });
    assert.equal(calls.length, 0);
  } finally {
    if (saved !== undefined) process.env.RESEND_API_KEY = saved;
  }
});

const UNSUB_URL = "https://sthenos.live/unsubscribe?token=tok_abc";

test("with unsubscribeUrl the html gets exactly one Unsubscribe footer, before </body>", async () => {
  const html = "<html><body><p>Hi</p></body></html>";
  const { fetchImpl, calls } = stubFetch(() => jsonResponse(200, { id: "m" }));

  await sendEmail({ ...BASE_INPUT, html, unsubscribeUrl: UNSUB_URL }, { apiKey: KEY, fetchImpl });

  const sent = JSON.parse(calls[0].init.body).html;
  const links = sent.match(/>Unsubscribe<\/a>/g) ?? [];
  assert.equal(links.length, 1, sent);
  assert.ok(sent.includes(`href="${UNSUB_URL}"`), sent);
  const footerAt = sent.indexOf("You received this email");
  assert.ok(footerAt > sent.indexOf("<p>Hi</p>"), sent);
  assert.ok(footerAt < sent.toLowerCase().lastIndexOf("</body>"), sent);
});

test("the footer is appended when the html has no </body>", async () => {
  const { fetchImpl, calls } = stubFetch(() => jsonResponse(200, { id: "m" }));

  await sendEmail(
    { ...BASE_INPUT, html: "<p>Hi</p>", unsubscribeUrl: UNSUB_URL },
    { apiKey: KEY, fetchImpl },
  );

  const sent = JSON.parse(calls[0].init.body).html;
  assert.ok(sent.startsWith("<p>Hi</p><p "), sent);
  assert.ok(sent.endsWith("</a></p>"), sent);
});

test("the text body gets the plain footer line when unsubscribeUrl is given", async () => {
  const { fetchImpl, calls } = stubFetch(() => jsonResponse(200, { id: "m" }));

  await sendEmail({ ...BASE_INPUT, unsubscribeUrl: UNSUB_URL }, { apiKey: KEY, fetchImpl });

  const text = JSON.parse(calls[0].init.body).text;
  assert.equal(
    text,
    `${BASE_INPUT.text}\n\n—\nYou received this email because of an action on Dojo. Unsubscribe: ${UNSUB_URL}`,
  );
});

test("the display name in the footer is HTML-escaped", async () => {
  const { fetchImpl, calls } = stubFetch(() => jsonResponse(200, { id: "m" }));

  await sendEmail(
    { ...BASE_INPUT, from: 'Tom & "Jerry" <x@y.com>', unsubscribeUrl: UNSUB_URL },
    { apiKey: KEY, fetchImpl },
  );

  const sent = JSON.parse(calls[0].init.body).html;
  assert.ok(sent.includes("Tom &amp; &quot;Jerry&quot;"), sent);
  assert.equal(/&(?!(amp|lt|gt|quot|#39);)/.test(sent), false, `raw ampersand in: ${sent}`);
});

test("without unsubscribeUrl the html is sent byte-identical", async () => {
  const html = "<html><body><p>Hi & bye</p></body></html>";
  const { fetchImpl, calls } = stubFetch(() => jsonResponse(200, { id: "m" }));

  await sendEmail({ ...BASE_INPUT, html }, { apiKey: KEY, fetchImpl });

  assert.equal(JSON.parse(calls[0].init.body).html, html);
});
