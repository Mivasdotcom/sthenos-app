// Server-only: pause / resume the collection of dues on a live Stripe
// subscription. Dues subscriptions live on the PLATFORM account (destination
// charges), so every call uses the centralised platform request options.
//
// A pause uses `pause_collection: { behavior: "void" }`, which means Stripe
// keeps the subscription and its cycle but does NOT charge and does NOT build
// up a debt for the paused period. Resuming therefore returns the member to
// exactly the amount they were paying before.

import type Stripe from "stripe";

export type PauseOutcome = {
  /** Stripe confirms collection is paused (or the subscription is already gone). */
  ok: boolean;
  /** No live subscription existed — nothing to pause. */
  absent: boolean;
  resumesAt: string | null;
};

export async function pauseDuesSubscription(
  stripe: Stripe,
  subscriptionId: string,
  resumeAtISO: string | null,
): Promise<PauseOutcome> {
  const { duesRequestOptions, getConnectErrorMessage } = await import(
    "@/lib/stripe-connect.server"
  );
  const opts = duesRequestOptions();
  try {
    const sub: any = await stripe.subscriptions.retrieve(subscriptionId, undefined, opts);
    if (!sub || sub.status === "canceled") return { ok: true, absent: true, resumesAt: null };

    const resumesAt = resumeAtISO
      ? Math.floor(new Date(resumeAtISO).getTime() / 1000)
      : undefined;

    await stripe.subscriptions.update(
      subscriptionId,
      {
        pause_collection: {
          behavior: "void",
          ...(resumesAt ? { resumes_at: resumesAt } : {}),
        },
      } as any,
      opts,
    );

    const after: any = await stripe.subscriptions.retrieve(subscriptionId, undefined, opts);
    if (after?.pause_collection?.behavior !== "void") {
      throw new Error("Stripe did not confirm the pause");
    }
    return {
      ok: true,
      absent: false,
      resumesAt: after.pause_collection.resumes_at
        ? new Date(after.pause_collection.resumes_at * 1000).toISOString()
        : null,
    };
  } catch (e) {
    throw new Error(
      `Stripe would not pause this membership's billing, so nothing was changed: ${getConnectErrorMessage(e)}`,
    );
  }
}

export async function resumeDuesSubscription(
  stripe: Stripe,
  subscriptionId: string,
): Promise<{ ok: boolean; absent: boolean }> {
  const { duesRequestOptions, getConnectErrorMessage } = await import(
    "@/lib/stripe-connect.server"
  );
  const opts = duesRequestOptions();
  try {
    const sub: any = await stripe.subscriptions.retrieve(subscriptionId, undefined, opts);
    if (!sub || sub.status === "canceled") return { ok: true, absent: true };
    if (!sub.pause_collection) return { ok: true, absent: false };

    await stripe.subscriptions.update(
      subscriptionId,
      { pause_collection: null } as any,
      opts,
    );

    const after: any = await stripe.subscriptions.retrieve(subscriptionId, undefined, opts);
    if (after?.pause_collection) throw new Error("Stripe did not confirm the resume");
    return { ok: true, absent: false };
  } catch (e) {
    throw new Error(
      `Stripe would not resume this membership's billing, so nothing was changed: ${getConnectErrorMessage(e)}`,
    );
  }
}
