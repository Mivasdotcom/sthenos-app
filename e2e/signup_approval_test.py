"""End-to-end test: public signup -> manager approval -> active member.

Flow:
  1. Anonymous user submits /j/<slug>/signup (info + plan + waiver).
  2. Manager session (restored from LOVABLE_BROWSER_SUPABASE_*) opens /approvals.
  3. Manager clicks "Approve as member" on that pending row.
  4. We re-check that the row is gone and the member appears in /members.

Run: python3 e2e/signup_approval_test.py
Requires: dev server on http://localhost:8080 and LOVABLE_BROWSER_AUTH_STATUS=injected.
"""
import asyncio
import json
import os
import sys
import time
from pathlib import Path

from playwright.async_api import async_playwright, TimeoutError as PWTimeout

BASE = "http://localhost:8080"
SLUG = os.environ.get("E2E_DOJO_SLUG", "sthenos-hq")
OUT = Path("/tmp/browser/signup-approval")
OUT.mkdir(parents=True, exist_ok=True)
VIEWPORT = {"width": 1280, "height": 1800}

STAMP = int(time.time() * 1000)
TEST_NAME = f"Lovable E2E {STAMP}"
TEST_EMAIL = f"lovable-e2e+{STAMP}@example.com"


def fail(msg: str):
    raise AssertionError(msg)


async def shot(page, name: str):
    await page.screenshot(path=str(OUT / f"{name}.png"))


async def restore_manager_session(context):
    key = os.environ.get("LOVABLE_BROWSER_SUPABASE_STORAGE_KEY")
    session = os.environ.get("LOVABLE_BROWSER_SUPABASE_SESSION_JSON")
    if not key or not session:
        fail("Manager session env vars missing (LOVABLE_BROWSER_SUPABASE_*)")
    page = await context.new_page()
    await page.goto(BASE, wait_until="domcontentloaded")
    await page.evaluate(
        f"window.localStorage.setItem({json.dumps(key)}, {json.dumps(session)})"
    )
    await page.close()


async def run_signup(context):
    page = await context.new_page()
    await page.goto(f"{BASE}/j/{SLUG}/signup", wait_until="domcontentloaded")
    await page.wait_for_selector("input#name", timeout=15000)
    await shot(page, "01_signup_info")

    await page.fill("input#name", TEST_NAME)
    await page.fill("input#email", TEST_EMAIL)
    await page.get_by_role("button", name="Continue").click()

    await page.wait_for_selector("text=/choose a plan/i")
    await shot(page, "02_signup_plan")
    await page.get_by_role("button", name="Continue").click()

    await page.wait_for_selector("input#signedName")
    await page.fill("input#signedName", TEST_NAME)
    await page.fill("textarea#signatureText", "I agree to the waiver terms.")
    await shot(page, "03_signup_waiver")
    await page.get_by_role("button", name="Complete signup").click()

    await page.wait_for_selector("text=/you're all set/i", timeout=15000)
    await shot(page, "04_signup_success")
    await page.close()


async def approve_as_manager(context):
    page = await context.new_page()
    await page.goto(f"{BASE}/approvals", wait_until="domcontentloaded")
    await page.wait_for_selector("table, text=/no pending approvals/i", timeout=20000)
    await shot(page, "05_approvals_loaded")

    row = page.locator("tr", has_text=TEST_EMAIL)
    try:
        await row.wait_for(timeout=15000)
    except PWTimeout:
        await shot(page, "05b_no_row")
        fail(f"Pending row for {TEST_EMAIL} not found in /approvals")

    await row.get_by_role("button", name="Approve as member").click()
    await row.wait_for(state="detached", timeout=15000)
    await shot(page, "06_after_approve")
    await page.close()


async def verify_member_active(context):
    page = await context.new_page()
    await page.goto(f"{BASE}/members", wait_until="domcontentloaded")
    await page.wait_for_load_state("networkidle")
    search = page.get_by_placeholder("Search", exact=False).first
    if await search.count():
        await search.fill(TEST_EMAIL)
        await page.wait_for_timeout(500)
    await shot(page, "07_members_after")
    cell = page.locator("td", has_text=TEST_EMAIL)
    if await cell.count() == 0:
        fail(f"Approved member {TEST_EMAIL} not visible in /members")
    await page.close()


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        try:
            anon_ctx = await browser.new_context(viewport=VIEWPORT)
            print(f"[1/4] Signing up {TEST_EMAIL} at /j/{SLUG}/signup")
            await run_signup(anon_ctx)
            await anon_ctx.close()

            mgr_ctx = await browser.new_context(viewport=VIEWPORT)
            await restore_manager_session(mgr_ctx)

            print("[2/4] Approving pending member as manager")
            await approve_as_manager(mgr_ctx)

            print("[3/4] Verifying member is active in /members")
            await verify_member_active(mgr_ctx)

            print(f"[4/4] PASS - signup -> approval -> active for {TEST_EMAIL}")
            await mgr_ctx.close()
        finally:
            await browser.close()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except AssertionError as e:
        print(f"FAIL: {e}")
        sys.exit(1)
