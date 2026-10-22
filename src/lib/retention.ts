export type RiskLevel = "high" | "watch" | "healthy";

/** A booking outcome from class_bookings within the scoring window. */
export interface BookingOutcome {
  /** ISO date (YYYY-MM-DD) of the class occurrence. */
  booked_for_date: string;
  status: "booked" | "attended" | "no_show";
}

export interface MemberRiskScore {
  memberId: string;
  name: string;
  beltColor: string;
  stripes: number;
  daysSinceLastSeen: number;
  sessionsLast30: number;
  sessionsPrev30: number;
  noShowsLast30: number;
  bookingsLast30: number;
  noShowPoints: number;
  score: number;
  level: RiskLevel;
  reasons: string[];
}

export function scoreRetentionRisk(member: {
  id: string;
  name: string;
  belt_color: string;
  stripes: number;
  joined_at: string;
  last_seen_at: string | null;
  recentSessions: number;
  previousSessions: number;
  /** Bookings from the last 30 days (class_bookings), scoped to the dojo. */
  recentBookings?: BookingOutcome[];
}): MemberRiskScore {
  let score = 0;
  const reasons: string[] = [];

  const daysSinceLastSeen = member.last_seen_at
    ? Math.floor((Date.now() - new Date(member.last_seen_at).getTime()) / 86400000)
    : 999;


  if (daysSinceLastSeen > 60) {
    score += 40;
    reasons.push("Not seen in 60+ days");
  } else if (daysSinceLastSeen > 30) {
    score += 30;
    reasons.push("Not seen in 30+ days");
  } else if (daysSinceLastSeen > 21) {
    score += 20;
    reasons.push("Not seen in 3 weeks");
  } else if (daysSinceLastSeen > 14) {
    score += 10;
    reasons.push("Not seen in 2 weeks");
  }

  const drop = member.previousSessions - member.recentSessions;
  if (member.previousSessions > 0 && member.recentSessions === 0) {
    score += 30;
    reasons.push("No attendance this month (had sessions last month)");
  } else if (drop >= 4) {
    score += 20;
    reasons.push(`Attendance dropped by ${drop} sessions vs last month`);
  } else if (drop >= 2) {
    score += 10;
    reasons.push(`Attendance down ${drop} sessions vs last month`);
  }

  const monthsAtBelt = Math.floor(
    (Date.now() - new Date(member.joined_at).getTime()) / (86400000 * 30),
  );
  if (member.belt_color === "blue" && monthsAtBelt > 24) {
    score += 30;
    reasons.push("Blue belt for 24+ months (high dropout risk)");
  } else if (member.belt_color === "blue" && monthsAtBelt > 18) {
    score += 20;
    reasons.push("Blue belt for 18+ months");
  } else if (member.belt_color === "purple" && monthsAtBelt > 30) {
    score += 15;
    reasons.push("Purple belt for 30+ months");
  }

  // ---- No-show pattern (0–20) ----
  const bookings = (member.recentBookings ?? [])
    .slice()
    .sort((a, b) => a.booked_for_date.localeCompare(b.booked_for_date));
  const bookingsLast30 = bookings.length;
  const outcomes = bookings.filter((b) => b.status === "attended" || b.status === "no_show");
  const noShowsLast30 = bookings.filter((b) => b.status === "no_show").length;

  let noShowPoints = 0;
  if (bookingsLast30 > 0) {
    if (noShowsLast30 >= 3) noShowPoints = 20;
    else if (noShowsLast30 === 2) noShowPoints = 12;
    else if (noShowsLast30 === 1) noShowPoints = 5;

    const lastTwo = outcomes.slice(-2);
    if (lastTwo.length >= 2 && lastTwo.every((b) => b.status === "no_show")) {
      noShowPoints = Math.max(noShowPoints, 15);
    }
  }

  if (noShowPoints > 0) {
    score += noShowPoints;
    const attended = bookings.filter((b) => b.status === "attended").length;
    if (attended === 0) {
      reasons.push(
        `Booked ${bookingsLast30} class${bookingsLast30 === 1 ? "" : "es"} recently but didn't attend any`,
      );
    } else {
      reasons.push(
        `Missed ${noShowsLast30} booked class${noShowsLast30 === 1 ? "" : "es"} in the last 30 days`,
      );
    }
  }

  const total = Math.min(score, 100);
  const level: RiskLevel = total >= 60 ? "high" : total >= 30 ? "watch" : "healthy";
  return {
    memberId: member.id,
    name: member.name,
    beltColor: member.belt_color,
    stripes: member.stripes,
    daysSinceLastSeen,
    sessionsLast30: member.recentSessions,
    sessionsPrev30: member.previousSessions,
    noShowsLast30,
    bookingsLast30,
    noShowPoints,
    score: total,
    level,

    reasons,
  };
}
