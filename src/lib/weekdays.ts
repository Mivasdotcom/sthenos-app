// Weekday helpers. Storage convention is unchanged: classes.weekday uses JS
// Date#getDay() indexing (0=Sun .. 6=Sat). Display order is UK/European:
// Monday first, Sunday last.

export const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export const WEEKDAY_LABELS_LONG = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

/** Display order of getDay() indexes: Mon..Sun. */
export const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;

/** Monday-first list of { index, label } for grids and pickers. */
export const WEEK_DISPLAY = WEEK_ORDER.map((index) => ({
  index,
  label: WEEKDAY_LABELS[index],
  longLabel: WEEKDAY_LABELS_LONG[index],
}));

/** 0 for Monday .. 6 for Sunday — useful for sorting. */
export function weekdaySortKey(getDayIndex: number) {
  return (getDayIndex + 6) % 7;
}
