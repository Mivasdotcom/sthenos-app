import { timingSafeEqual } from "node:crypto";

// Below this length a secret is too weak to be a bearer credential: fail closed.
const MIN_CRON_SECRET_LENGTH = 16;

/**
 * Authorise a call to a public cron/worker hook.
 *
 * Only `Authorization: Bearer <CRON_SECRET>` is accepted. The Supabase
 * publishable/anon key is public (it ships to every browser), and the
 * service-role key is far too powerful to be a scheduler credential, so neither
 * is ever honoured here, and the `apikey` header is ignored.
 */
export function authorizeCron(
  request: Request,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const secret = env.CRON_SECRET;
  if (!secret || secret.length < MIN_CRON_SECRET_LENGTH) return false;

  const match = /^Bearer\s+(.+)$/i.exec(request.headers.get("authorization") ?? "");
  const token = match?.[1].trim() ?? "";
  if (!token) return false;

  const provided = Buffer.from(token, "utf8");
  const expected = Buffer.from(secret, "utf8");
  // timingSafeEqual throws on unequal lengths; a length mismatch is already a rejection.
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}
