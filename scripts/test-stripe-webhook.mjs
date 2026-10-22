#!/usr/bin/env node
/**
 * Local integration test for /api/public/stripe-webhook.
 *
 * Verifies the four event handlers update the database correctly:
 *   - checkout.session.completed  -> members.payment_status='current' + member_subscriptions upsert
 *   - invoice.paid                -> payment_status='current' + invoices row inserted
 *   - invoice.payment_failed      -> payment_status='overdue'
 *   - customer.subscription.deleted -> subscription status='canceled' + payment_status='none'
 *
 * Requirements (env):
 *   STRIPE_WEBHOOK_SECRET   - matches what the running dev server has
 *   STRIPE_SECRET_KEY       - any sk_test_... key (needed for stripe SDK init and signature helper)
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY - for DB seed/verify
 *   WEBHOOK_URL             - optional; defaults to http://localhost:8080/api/public/stripe-webhook
 *   TEST_DOJO_ID            - optional; a dojo to attach the test member to
 *   TEST_PLAN_ID            - optional; a dojo_plans.id inside TEST_DOJO_ID
 *
 * Run:   node scripts/test-stripe-webhook.mjs
 */
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

const {
  STRIPE_WEBHOOK_SECRET,
  STRIPE_SECRET_KEY,
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  WEBHOOK_URL = "http://localhost:8080/api/public/stripe-webhook",
  TEST_DOJO_ID = "3648987a-348c-42b7-8ead-b2c99bea01ea",
  TEST_PLAN_ID = "1b45336a-a97b-4804-ab1e-7f7847ec30a5",
} = process.env;

function skip(reason) {
  console.log(`SKIP: ${reason}`);
  process.exit(0);
}

if (!STRIPE_WEBHOOK_SECRET) skip("STRIPE_WEBHOOK_SECRET not set");
if (!STRIPE_SECRET_KEY) skip("STRIPE_SECRET_KEY not set");
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) skip("Supabase admin env not set");

const stripe = new Stripe(STRIPE_SECRET_KEY);
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const stamp = Date.now();
const testEmail = `webhook-test+${stamp}@example.com`;
const subId = `sub_test_${stamp}`;
const custId = `cus_test_${stamp}`;

let failures = 0;
function assert(cond, msg) {
  if (cond) {
    console.log(`  ✓ ${msg}`);
  } else {
    console.log(`  ✗ ${msg}`);
    failures++;
  }
}

async function post(payload) {
  const body = JSON.stringify(payload);
  const header = stripe.webhooks.generateTestHeaderString({
    payload: body,
    secret: STRIPE_WEBHOOK_SECRET,
  });
  const res = await fetch(WEBHOOK_URL, {
    method: "POST",
    headers: { "stripe-signature": header, "content-type": "application/json" },
    body,
  });
  const text = await res.text();
  if (!res.ok) {
    console.log(`  ! POST ${res.status}: ${text}`);
  }
  return res;
}

function makeEvent(type, object) {
  return {
    id: `evt_test_${stamp}_${Math.random().toString(36).slice(2, 8)}`,
    object: "event",
    api_version: "2024-06-20",
    created: Math.floor(Date.now() / 1000),
    type,
    livemode: false,
    pending_webhooks: 0,
    request: { id: null, idempotency_key: null },
    data: { object },
  };
}

async function seedMember() {
  const { data, error } = await supabase
    .from("members")
    .insert({
      dojo_id: TEST_DOJO_ID,
      name: `Webhook Test ${stamp}`,
      email: testEmail,
      discipline: "BJJ",
      plan: "Monthly",
      status: "active",
      payment_status: "none",
      signup_source: "webhook_test",
    })
    .select("id")
    .single();
  if (error) throw new Error(`seed member: ${error.message}`);
  return data.id;
}

async function cleanup(memberId) {
  await supabase.from("invoices").delete().eq("member_id", memberId);
  await supabase.from("member_subscriptions").delete().eq("member_id", memberId);
  await supabase.from("members").delete().eq("id", memberId);
}

async function main() {
  console.log(`Webhook URL: ${WEBHOOK_URL}`);
  console.log(`Seeding test member (${testEmail})...`);
  const memberId = await seedMember();
  console.log(`  member_id=${memberId}`);

  try {
    // ---- 1. checkout.session.completed ----
    console.log("\n[1] checkout.session.completed");
    let res = await post(
      makeEvent("checkout.session.completed", {
        id: `cs_test_${stamp}`,
        object: "checkout.session",
        mode: "subscription",
        subscription: subId,
        customer: custId,
        metadata: { memberId, dojoId: TEST_DOJO_ID, planId: TEST_PLAN_ID },
      }),
    );
    assert(res.ok, "webhook returned 200");
    let { data: m1 } = await supabase
      .from("members")
      .select("payment_status, selected_plan_id")
      .eq("id", memberId)
      .single();
    assert(m1?.payment_status === "current", "member.payment_status = current");
    assert(m1?.selected_plan_id === TEST_PLAN_ID, "member.selected_plan_id updated");
    let { data: sub } = await supabase
      .from("member_subscriptions")
      .select("id, status, stripe_subscription_id, stripe_customer_id, plan_id")
      .eq("stripe_subscription_id", subId)
      .maybeSingle();
    assert(!!sub, "member_subscriptions row created");
    assert(sub?.status === "active", "subscription.status = active");
    assert(sub?.stripe_customer_id === custId, "subscription.stripe_customer_id set");

    // ---- 2. invoice.paid ----
    console.log("\n[2] invoice.paid");
    res = await post(
      makeEvent("invoice.paid", {
        id: `in_test_${stamp}_paid`,
        object: "invoice",
        subscription: subId,
        amount_paid: 5000,
        amount_due: 5000,
        currency: "usd",
        hosted_invoice_url: "https://stripe.test/invoice/paid",
      }),
    );
    assert(res.ok, "webhook returned 200");
    let { data: m2 } = await supabase
      .from("members")
      .select("payment_status")
      .eq("id", memberId)
      .single();
    assert(m2?.payment_status === "current", "member.payment_status still current");
    let { data: inv } = await supabase
      .from("invoices")
      .select("id, amount_cents, status, stripe_invoice_id")
      .eq("stripe_invoice_id", `in_test_${stamp}_paid`)
      .maybeSingle();
    assert(!!inv, "invoices row inserted");
    assert(inv?.status === "paid", "invoice.status = paid");
    assert(inv?.amount_cents === 5000, "invoice.amount_cents = 5000");

    // ---- 3. invoice.payment_failed ----
    console.log("\n[3] invoice.payment_failed");
    res = await post(
      makeEvent("invoice.payment_failed", {
        id: `in_test_${stamp}_failed`,
        object: "invoice",
        subscription: subId,
        amount_due: 5000,
        currency: "usd",
      }),
    );
    assert(res.ok, "webhook returned 200");
    let { data: m3 } = await supabase
      .from("members")
      .select("payment_status")
      .eq("id", memberId)
      .single();
    assert(m3?.payment_status === "overdue", "member.payment_status = overdue");

    // ---- 4. customer.subscription.deleted ----
    console.log("\n[4] customer.subscription.deleted");
    res = await post(
      makeEvent("customer.subscription.deleted", {
        id: subId,
        object: "subscription",
        status: "canceled",
        customer: custId,
      }),
    );
    assert(res.ok, "webhook returned 200");
    let { data: sub2 } = await supabase
      .from("member_subscriptions")
      .select("status, canceled_at")
      .eq("stripe_subscription_id", subId)
      .maybeSingle();
    assert(sub2?.status === "canceled", "subscription.status = canceled");
    assert(!!sub2?.canceled_at, "subscription.canceled_at set");
    let { data: m4 } = await supabase
      .from("members")
      .select("payment_status")
      .eq("id", memberId)
      .single();
    assert(m4?.payment_status === "none", "member.payment_status = none");
  } finally {
    console.log("\nCleaning up...");
    await cleanup(memberId);
  }

  console.log(`\n${failures === 0 ? "PASS" : `FAIL (${failures} assertion(s))`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("ERROR:", e);
  process.exit(1);
});
