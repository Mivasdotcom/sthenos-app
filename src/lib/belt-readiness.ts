export type ReadinessLevel = "ready" | "almost" | "not-yet";

const MIN_MONTHS_BJJ: Record<string, number> = {
  white: 12,
  blue: 18,
  purple: 18,
  brown: 12,
  black: 0,
};
const MIN_MONTHS_DEFAULT: Record<string, number> = {
  white: 6,
  yellow: 4,
  orange: 4,
  green: 6,
  blue: 8,
  brown: 12,
  black: 0,
};

const MIN_SESSIONS_90 = 20;

export interface ReadinessResult {
  memberId: string;
  name: string;
  discipline: string;
  beltColor: string;
  stripes: number;
  monthsAtBelt: number;
  minMonthsRequired: number;
  sessionsLast90: number;
  meetsTime: boolean;
  meetsAttendance: boolean;
  level: ReadinessLevel;
  notes: string;
}

export function assessReadiness(member: {
  id: string;
  name: string;
  discipline: string;
  belt_color: string;
  stripes: number;
  joined_at: string;
  sessionsLast90: number;
}): ReadinessResult {
  const monthsAtBelt = Math.floor(
    (Date.now() - new Date(member.joined_at).getTime()) / (86400000 * 30),
  );

  const minMap = member.discipline === "BJJ" ? MIN_MONTHS_BJJ : MIN_MONTHS_DEFAULT;
  const minMonths = minMap[member.belt_color] ?? 12;

  const meetsTime = monthsAtBelt >= minMonths;
  const meetsAttendance = member.sessionsLast90 >= MIN_SESSIONS_90;

  let level: ReadinessLevel;
  let notes: string;

  if (meetsTime && meetsAttendance) {
    level = "ready";
    notes = `${monthsAtBelt} months at ${member.belt_color} belt, ${member.sessionsLast90} sessions in 90 days`;
  } else if (meetsTime && !meetsAttendance) {
    level = "almost";
    notes = `Time requirement met but attendance low (${member.sessionsLast90} sessions, need ${MIN_SESSIONS_90} in 90 days)`;
  } else if (!meetsTime && meetsAttendance) {
    const monthsLeft = minMonths - monthsAtBelt;
    level = "almost";
    notes = `Great attendance but needs ${monthsLeft} more month${monthsLeft > 1 ? "s" : ""} at this belt`;
  } else {
    const monthsLeft = Math.max(1, minMonths - monthsAtBelt);
    level = "not-yet";
    notes = `${monthsLeft} more month${monthsLeft > 1 ? "s" : ""} needed, attendance also needs improvement`;
  }

  return {
    memberId: member.id,
    name: member.name,
    discipline: member.discipline,
    beltColor: member.belt_color,
    stripes: member.stripes,
    monthsAtBelt,
    minMonthsRequired: minMonths,
    sessionsLast90: member.sessionsLast90,
    meetsTime,
    meetsAttendance,
    level,
    notes,
  };
}
