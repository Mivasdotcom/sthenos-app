/**
 * Who a login may act for.
 *
 * A member's own record is reached through `members.user_id`, and RLS lets
 * them read only that row. A parent, though, needs to act for their children:
 * book their classes, see what was charged, sign their waiver. Those children
 * are separate member records, and the parent's login is not on them.
 *
 * `member_managers` is that link -- one row per (member, login) -- and every
 * read of a managed member goes through the admin client, because the member
 * policy would silently return nothing. Authorisation is therefore explicit
 * here rather than delegated to the database.
 *
 * Why not give each parent a member record of their own? Because a gym counts
 * members, and a parent who never trains is not one. Linking logins to records
 * keeps the roster honest.
 */

export type ActingMember = {
  id: string;
  name: string;
  dateOfBirth: string | null;
  isSelf: boolean;
  status: string | null;
  paymentStatus: string | null;
};

function isMinor(dob: string | null | undefined): boolean {
  if (!dob) return false;
  const d = new Date(`${dob}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return false;
  const eighteen = new Date(d);
  eighteen.setUTCFullYear(eighteen.getUTCFullYear() + 18);
  return eighteen.getTime() > Date.now();
}

/** The caller's own member record in this dojo, if they have one. */
export async function ownMember(db: any, userId: string, dojoId: string, columns = "*") {
  const { data, error } = await db
    .from("members")
    .select(columns)
    .eq("user_id", userId)
    .eq("dojo_id", dojoId)
    .maybeSingle();
  if (error) throw error;
  return data ?? null;
}

/**
 * Every record this login may act for: their own, plus anyone linked to them.
 * Self comes first; the rest are alphabetical, so a switcher reads sensibly.
 */
export async function listActingMembers(
  db: any,
  userId: string,
  dojoId: string,
): Promise<ActingMember[]> {
  const self = await ownMember(
    db,
    userId,
    dojoId,
    "id, name, date_of_birth, status, payment_status",
  );

  const { data: links, error: linkErr } = await db
    .from("member_managers")
    .select("member_id")
    .eq("user_id", userId)
    .eq("dojo_id", dojoId);
  if (linkErr) throw linkErr;

  const managedIds = ((links ?? []) as { member_id: string }[])
    .map((l) => l.member_id)
    .filter((id) => id && id !== (self as any)?.id);

  let managed: any[] = [];
  if (managedIds.length) {
    const { data, error } = await db
      .from("members")
      .select("id, name, date_of_birth, status, payment_status")
      .in("id", managedIds)
      .eq("dojo_id", dojoId);
    if (error) throw error;
    managed = (data ?? []) as any[];
    managed.sort((a, b) => String(a.name ?? "").localeCompare(String(b.name ?? "")));
  }

  const row = (m: any, isSelf: boolean): ActingMember => ({
    id: m.id,
    name: m.name ?? "Member",
    dateOfBirth: m.date_of_birth ?? null,
    isSelf,
    status: m.status ?? null,
    paymentStatus: m.payment_status ?? null,
  });

  return [
    ...(self ? [row(self, true)] : []),
    ...managed.map((m) => row(m, false)),
  ];
}

/**
 * Resolve the member a request is acting for, refusing anything the caller
 * has no claim to. `memberId` omitted means "me", which is what every
 * member-facing call did before children existed.
 *
 * Pass the ADMIN client: a managed child's row is invisible to the caller's
 * own client by design.
 */
export async function resolveActingMember(args: {
  db: any;
  userId: string;
  dojoId: string;
  memberId?: string | null;
  columns?: string;
}): Promise<any> {
  const columns = args.columns ?? "*";

  if (!args.memberId) {
    const me = await ownMember(args.db, args.userId, args.dojoId, columns);
    if (!me) throw new Error("No member profile for this dojo");
    return me;
  }

  const { data: member, error } = await args.db
    .from("members")
    .select(columns.includes("user_id") ? columns : `${columns}, user_id`)
    .eq("id", args.memberId)
    .eq("dojo_id", args.dojoId)
    .maybeSingle();
  if (error) throw error;
  if (!member) throw new Error("That member no longer exists.");

  if ((member as any).user_id === args.userId) return member;

  const { data: link, error: linkErr } = await args.db
    .from("member_managers")
    .select("id")
    .eq("member_id", args.memberId)
    .eq("user_id", args.userId)
    .eq("dojo_id", args.dojoId)
    .maybeSingle();
  if (linkErr) throw linkErr;
  if (!link) throw new Error("You don't manage that member.");

  return member;
}

/**
 * Record that a login manages a member. Idempotent: a parent adding a second
 * child, or a retried request, must not create duplicates.
 */
export async function linkManager(args: {
  db: any;
  dojoId: string;
  memberId: string;
  userId: string;
  relationship?: string | null;
}): Promise<void> {
  const { error } = await args.db
    .from("member_managers")
    .upsert(
      {
        dojo_id: args.dojoId,
        member_id: args.memberId,
        user_id: args.userId,
        relationship: args.relationship ?? null,
      },
      { onConflict: "member_id,user_id" },
    );
  if (error) throw error;
}

/**
 * True when this login is a guardian rather than the member themselves --
 * either it holds no member record of its own, or the record it holds is a
 * minor's whose waiver a guardian signed. Both are the same person in
 * practice: the parent who signed the child up.
 */
export function isGuardianLogin(ownRow: any | null): boolean {
  if (!ownRow) return true;
  return isMinor(ownRow.date_of_birth) && !!ownRow.guardian_name;
}

export { isMinor };
