#!/usr/bin/env node
/**
 * Security gate for critical multi-tenancy and data-scoping invariants.
 *
 * Fails CI if any of the following regressions are detected:
 *
 *   1. Public signup endpoints (`getDojoPlansPublic`, `getDojoClassTypes`,
 *      `getCurrentWaiver`) must verify `public_page_enabled` before
 *      returning data — enforced via `assertDojoPublic(...)`.
 *
 *   2. Any `dojo_plans` lookup in `submitSignup` filtered by the submitted
 *      `selectedPlanId` must also scope to the submitted `dojoId` so a
 *      plan from another dojo cannot influence the new member record.
 *
 *   3. `buildSnapshot` in `sensei.functions.ts` must accept a `dojoId`
 *      parameter and apply `.eq("dojo_id", ...)` scoping so one gym
 *      cannot read another gym's analytics data.
 *
 *   4. `archivePlan` in `plans.functions.ts` must verify dojo ownership
 *      (via dojo_memberships) before toggling `is_active`.
 *
 *   5. Every tenant-data server-function file must reference dojo
 *      scoping at least once (guards against a regenerated file
 *      dropping all dojo_id filters, as happened previously).
 *
 * Add new invariants as additional entries in CHECKS below.
 */

import { readFileSync, existsSync } from "node:fs";

const FILES = {
  signup: "src/lib/signup.functions.ts",
  sensei: "src/lib/sensei.functions.ts",
  plans: "src/lib/plans.functions.ts",
};

// Files that query tenant tables and must always contain dojo scoping.
const TENANT_SCOPED_FILES = [
  "src/lib/ai-insights.functions.ts",
  "src/lib/marketing.functions.ts",
  "src/lib/member-ai.functions.ts",
  "src/lib/tasks.functions.ts",
  "src/lib/workflows.functions.ts",
  "src/lib/email-settings.functions.ts",
  "src/lib/sensei.functions.ts",
];

for (const path of [...Object.values(FILES), ...TENANT_SCOPED_FILES]) {
  if (!existsSync(path)) {
    console.error(`security-gate: ${path} not found`);
    process.exit(1);
  }
}

const src = readFileSync(FILES.signup, "utf8");
const senseiSrc = readFileSync(FILES.sensei, "utf8");
const plansSrc = readFileSync(FILES.plans, "utf8");

const CHECKS = [
  {
    id: "signup_bypass_public_flag",
    description:
      "Public signup endpoints must guard on public_page_enabled via assertDojoPublic().",
    test: () => {
      const defines = /function\s+assertDojoPublic\s*\(/.test(src);
      const guards = [
        "getDojoPlansPublic",
        "getDojoClassTypes",
        "getCurrentWaiver",
      ].every((fn) => {
        const re = new RegExp(
          `export const ${fn}[\\s\\S]*?\\.handler\\(async \\(\\{[^}]*\\}\\) => \\{([\\s\\S]*?)\\n\\s*\\}\\);`,
          "m",
        );
        const m = src.match(re);
        return !!m && /assertDojoPublic\s*\(/.test(m[1]);
      });
      return defines && guards;
    },
  },
  {
    id: "signup_planid_no_dojo_check",
    description:
      "submitSignup plan lookups filtered by selectedPlanId must also filter by dojo_id so cross-dojo plan IDs are ignored.",
    test: () => {
      // Shape-tolerant: any dojo_plans query chain ending in single/maybeSingle
      // that filters by data.selectedPlanId must also filter by data.dojoId,
      // regardless of which columns are selected.
      const re = /from\("dojo_plans"\)([\s\S]*?)(?:\.maybeSingle|\.single)\(\)/g;
      let m;
      let found = false;
      while ((m = re.exec(src)) !== null) {
        const chain = m[1];
        if (/\.eq\("id",\s*data\.selectedPlanId\)/.test(chain)) {
          found = true;
          if (!/\.eq\("dojo_id",\s*data\.dojoId\)/.test(chain)) return false;
        }
      }
      return found;
    },
  },
  {
    id: "sensei_dojo_scope",
    description:
      "buildSnapshot() must accept a dojoId parameter and scope its table queries with .eq(\"dojo_id\", dojoId).",
    test: () => {
      if (!/function buildSnapshot\s*\([^)]*dojoId/.test(senseiSrc)) return false;
      const scopedCount = (senseiSrc.match(/\.eq\(["']dojo_id["'],\s*dojoId\)/g) ?? []).length;
      return scopedCount >= 5;
    },
  },
  {
    id: "archive_plan_ownership",
    description:
      "archivePlan() must verify the caller's dojo_memberships role before toggling is_active.",
    test: () => {
      const re =
        /export const archivePlan[\s\S]*?\.handler\(async \(\{[^}]*\}\) => \{([\s\S]*?)\n\s*\}\);/m;
      const m = plansSrc.match(re);
      if (!m) return false;
      const body = m[1];
      // Ownership is verified either inline via dojo_memberships or via
      // the shared assertManager helper (which queries dojo_memberships).
      return /dojo_memberships/.test(body) || /assertManager\s*\(/.test(body);
    },
  },
  {
    id: "tenant_files_dojo_scoped",
    description:
      "Every tenant-data server-function file must reference dojo scoping (dojo_id/dojoId) at least once.",
    test: () =>
      TENANT_SCOPED_FILES.every((path) => {
        const content = readFileSync(path, "utf8");
        return /dojo_id|dojoId/.test(content);
      }),
  },
];

const failures = CHECKS.filter((c) => {
  try {
    return !c.test();
  } catch (err) {
    console.error(`security-gate: check ${c.id} threw`, err);
    return true;
  }
});

if (failures.length > 0) {
  console.error("\n❌ Security gate failed:\n");
  for (const f of failures) {
    console.error(`  - [${f.id}] ${f.description}`);
  }
  console.error(
    "\nRevert the regression or update scripts/security-gate.mjs if the invariant has intentionally changed.\n",
  );
  process.exit(1);
}

console.log(`✅ Security gate passed (${CHECKS.length} checks).`);
