#!/usr/bin/env node
/**
 * Authorisation gate for client-callable server functions.
 *
 * Multi-tenancy rests on RLS, and `supabaseAdmin` exists to bypass RLS. That
 * is fine and often necessary -- a staff member acting on another person's
 * record cannot go through their own row-level policies. It is only safe while
 * every such function checks, itself, that the caller is allowed to act on the
 * dojo it was handed. Nothing in the type system enforces that. This does.
 *
 * Three invariants:
 *
 *   0. No role set changes meaning, and no new one appears, without someone
 *      saying so in the same commit. See ROLE_SETS below.
 *
 *   1. Every server function in src/lib/*.functions.ts that touches
 *      supabaseAdmin must contain a recognised authorisation guard, or be
 *      listed in REVIEWED_WITHOUT_GUARD with the reason it is safe.
 *
 *   2. Every server function without `requireSupabaseAuth` is reachable by
 *      anyone on the internet, so it must be listed in PUBLIC_BY_DESIGN.
 *
 * Functions that use `context.supabase` are not checked: that is the caller's
 * own RLS-scoped client, so the database enforces tenancy for them.
 *
 * When this fails, the fix is almost always to call assertDojoStaff (or the
 * right sibling) from src/lib/dojo-access.ts before touching supabaseAdmin --
 * not to add an entry below. Add an entry only when the function genuinely
 * cannot use one, and say why.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";

const DIR = "src/lib";
const SRC = "src";

/**
 * Role sets, pinned.
 *
 * `STAFF_ROLES` is declared in nine places with four different meanings, and
 * `manager` is not a role that exists -- dojo_memberships holds only member,
 * owner and coach. So today a coach may issue a refund and change plan prices
 * (assertDojoStaff, which includes coach) but may not connect Stripe or
 * backfill billing (sets that do not). Nobody chose that; it is an accident of
 * which file each function was written in.
 *
 * Consolidating means deciding what a coach is allowed to do, which is the
 * owner's call, not a refactor. Until that decision is made, this pins every
 * definition so the divergence cannot quietly grow: changing one, or adding a
 * new one, fails the build.
 *
 * Roles are compared as a sorted set, so reordering or reformatting is fine.
 * Changing who is in the set is not.
 */
const ROLE_SETS = new Map([
  ["src/hooks/use-current-dojo.tsx::STAFF_DOJO_ROLES", "admin,coach,owner"],
  ["src/lib/billing-backfill.functions.ts::STAFF_ROLES", "admin,owner"],
  ["src/lib/communications.server.ts::STAFF_ROLES", "admin,coach,owner"],
  ["src/lib/connect.functions.ts::STAFF_ROLES", "admin,manager,owner"],
  ["src/lib/dojo-access.ts::STAFF_ROLES", "admin,coach,owner"],
  ["src/lib/family-pricing.functions.ts::CONFIG_ROLES", "admin,manager,owner"],
  ["src/lib/family-pricing.functions.ts::STAFF_ROLES", "admin,coach,manager,owner"],
  ["src/lib/payment-methods.functions.ts::STAFF_ROLES", "admin,owner"],
  ["src/lib/payments.functions.ts::STAFF_ROLES", "admin,manager,owner"],
  ["src/lib/plans.functions.ts::STAFF_ROLES", "admin,manager,owner"],
  ["src/lib/platform-billing.functions.ts::STAFF_ROLES", "admin,manager,owner"],
  ["src/routes/settings.agreements.tsx::EDIT_ROLES", "admin,owner"],
]);

const ROLE_WORDS = /"(owner|admin|coach|manager)"/;

/**
 * Calls that establish the caller may act on the dojo or member in question.
 * `assertDojoPublic` belongs here because it gates the public-page endpoints
 * on the gym having opted in, which is the relevant permission for those.
 */
const GUARDS = [
  "assertDojoStaff",
  "assertDojoMember",
  "assertDojoOwnerOrAdmin",
  "assertDojoPublic",
  "assertOwnerOrAdmin",
  "assertOwner",
  "assertStaff",
  "assertManager",
  "assertConfig",
  "loadAuthorizedMember",
  "is_dojo_staff", // the RPC form
  'from("dojo_memberships")', // an inline role lookup
  "member_managers", // the guardian-to-child link
  "guardian_member_id",
];

/**
 * Reviewed and found safe without a dojo-level guard, September 2026.
 * Each one either scopes every query to context.userId, or is deliberately
 * public. Removing a reason here means re-reviewing the function.
 */
const REVIEWED_WITHOUT_GUARD = new Map([
  ["getWeekClassesForMe", "reads only classes for the caller's own membership"],
  ["bookClassForMe", "books against the caller's own member row"],
  ["cancelMyBooking", "cancels a booking owned by the caller"],
  ["getMyFamilyPricing", "returns the caller's own family quote"],
  ["selectMyPlan", "scoped by eq(user_id, context.userId)"],
  ["getAddChildContext", "returns context for the caller's own guardian record"],
  ["listMyMembers", "lists the member rows belonging to context.userId"],
  ["getPortalSnapshot", "portal view for the caller's own member row"],
  ["getPortalPayments", "payments for the caller's own member row"],
  ["getMyTrialUsage", "the caller's own trial"],
  ["getPublicAgreements", "current agreements for a public signup page"],
  ["getPublicPrivacyNotice", "the published privacy notice for a public page"],
  ["checkUnsubscribeToken", "authorised by a single-use unsubscribe token"],
  ["confirmUnsubscribe", "authorised by a single-use unsubscribe token"],
]);

/** Reachable without a login, by design. */
const PUBLIC_BY_DESIGN = new Set([
  "bookFirstClass",
  "checkUnsubscribeToken",
  "confirmUnsubscribe",
  "getCurrentWaiver",
  "getDojoBySlug",
  "getDojoClassTypes",
  "getDojoPlansPublic",
  "getFamilyPricingPublic",
  "getPublicAgreements",
  "getPublicPrivacyNotice",
  "getTodayClasses",
  "requestPasswordReset",
  "submitSignup",
]);

if (!existsSync(DIR)) {
  console.error(`authorisation-gate: ${DIR} not found`);
  process.exit(1);
}

/** Every `export const NAME = createServerFn(...)` block in a file. */
function serverFunctions(src) {
  const marks = [...src.matchAll(/^export const ([A-Za-z0-9_]+) *=/gm)];
  const found = [];
  for (let i = 0; i < marks.length; i++) {
    const body = src.slice(marks[i].index, marks[i + 1]?.index ?? src.length);
    if (body.includes("createServerFn")) found.push({ name: marks[i][1], body });
  }
  return found;
}

const failures = [];
const seen = new Set();

for (const file of readdirSync(DIR).filter((f) => f.endsWith(".functions.ts")).sort()) {
  for (const fn of serverFunctions(readFileSync(`${DIR}/${file}`, "utf8"))) {
    seen.add(fn.name);
    const where = `${file} :: ${fn.name}`;

    if (!fn.body.includes("requireSupabaseAuth") && !PUBLIC_BY_DESIGN.has(fn.name)) {
      failures.push(
        `${where}\n    Reachable without a login. Add .middleware([requireSupabaseAuth]),\n` +
          `    or add it to PUBLIC_BY_DESIGN if that is intended.`,
      );
    }

    if (fn.body.includes("supabaseAdmin")) {
      const guarded = GUARDS.some((g) => fn.body.includes(g));
      if (!guarded && !REVIEWED_WITHOUT_GUARD.has(fn.name)) {
        failures.push(
          `${where}\n    Uses supabaseAdmin, which bypasses RLS, with no authorisation check.\n` +
            `    Call assertDojoStaff(context.supabase, context.userId, dojoId) from\n` +
            `    src/lib/dojo-access.ts before touching the admin client.`,
        );
      }
    }
  }
}

/** Every .ts/.tsx file under src, recursively. */
function sourceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...sourceFiles(path));
    else if (/\.tsx?$/.test(entry.name)) out.push(path);
  }
  return out;
}

const seenRoleSets = new Set();

for (const path of sourceFiles(SRC)) {
  const src = readFileSync(path, "utf8");
  const re = /const ([A-Z_]+)\s*(?::[^=]*)?=\s*(?:new Set\()?\[([^\]]*)\]/g;
  for (const [, constName, list] of src.matchAll(re)) {
    if (!ROLE_WORDS.test(list)) continue;

    const key = `${path}::${constName}`;
    const roles = [...list.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]).sort().join(",");
    seenRoleSets.add(key);

    const pinned = ROLE_SETS.get(key);
    if (pinned === undefined) {
      failures.push(
        `${key}\n    A new role set. Every one of these decides who may do what, and\n` +
          `    there are already four different definitions of STAFF_ROLES. Import an\n` +
          `    existing set instead, or pin this one in ROLE_SETS with its reason.`,
      );
    } else if (pinned !== roles) {
      failures.push(
        `${key}\n    Role set changed: was [${pinned}], now [${roles}].\n` +
          `    This changes who can perform these operations. If that is intended,\n` +
          `    update ROLE_SETS in this file in the same commit.`,
      );
    }
  }
}

for (const key of ROLE_SETS.keys()) {
  if (!seenRoleSets.has(key)) {
    console.warn(`authorisation-gate: warning: pinned role set "${key}" no longer exists`);
  }
}

// A stale entry is not a failure, but it hides the fact that nobody has looked
// at this list since the function it names disappeared.
const stale = [...REVIEWED_WITHOUT_GUARD.keys(), ...PUBLIC_BY_DESIGN].filter(
  (n) => !seen.has(n),
);
for (const name of [...new Set(stale)]) {
  console.warn(`authorisation-gate: warning: "${name}" is allowlisted but no longer exists`);
}

if (failures.length) {
  console.error(`\nauthorisation-gate: ${failures.length} problem(s)\n`);
  for (const f of failures) console.error(`  ${f}\n`);
  process.exit(1);
}

console.log(
  `authorisation-gate: ${seen.size} server functions checked, all guarded; ` +
    `${seenRoleSets.size} role sets unchanged`,
);
