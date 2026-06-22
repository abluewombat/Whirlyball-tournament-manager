export const DEFAULT_TOURNAMENT_TIMEZONE = "America/Detroit";

function formatter(timeZone: string, options: Intl.DateTimeFormatOptions) {
  return new Intl.DateTimeFormat("en-US", { timeZone, ...options });
}

function dateParts(date: Date, timeZone: string) {
  const parts = formatter(timeZone, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const value = (type: string) => parts.find((part) => part.type === type)?.value || "";
  return {
    year: value("year"),
    month: value("month"),
    day: value("day")
  };
}

function literalParts(value: string) {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!match) return null;
  const [, year, month, day, hour, minute] = match;
  return { year, month, day, hour: Number(hour), minute };
}

function hasExplicitTimeZone(value: string) {
  return /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value);
}

function literalDate(value: ReturnType<typeof literalParts>) {
  if (!value) return null;
  const date = new Date(Number(value.year), Number(value.month) - 1, Number(value.day));
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatClock(hour: number, minute: string) {
  const suffix = hour >= 12 ? "PM" : "AM";
  const displayHour = hour % 12 || 12;
  return `${displayHour}:${minute} ${suffix}`;
}

export function tournamentDateKey(value: string, timeZone = DEFAULT_TOURNAMENT_TIMEZONE) {
  const date = new Date(value);
  if (!Number.isNaN(date.getTime()) && hasExplicitTimeZone(value)) {
    const parts = dateParts(date, timeZone);
    return `${parts.year}-${parts.month}-${parts.day}`;
  }
  const literal = literalParts(value);
  return literal ? `${literal.year}-${literal.month}-${literal.day}` : value.slice(0, 10);
}

export function tournamentDayLabel(value: string, timeZone = DEFAULT_TOURNAMENT_TIMEZONE, weekday: "short" | "long" = "short") {
  const date = new Date(value);
  if (!Number.isNaN(date.getTime()) && hasExplicitTimeZone(value)) {
    return formatter(timeZone, { weekday, month: "numeric", day: "numeric" }).format(date);
  }
  const literal = literalParts(value);
  const literalDateValue = literalDate(literal);
  if (!literal || !literalDateValue) return value.slice(0, 10);
  return literalDateValue.toLocaleDateString("en-US", { weekday, month: "numeric", day: "numeric" });
}

export function tournamentWeekdayLabel(value: string, timeZone = DEFAULT_TOURNAMENT_TIMEZONE) {
  const date = new Date(value);
  if (!Number.isNaN(date.getTime()) && hasExplicitTimeZone(value)) {
    return formatter(timeZone, { weekday: "long" }).format(date);
  }
  const literal = literalParts(value);
  const literalDateValue = literalDate(literal);
  if (!literal || !literalDateValue) return value.slice(0, 10);
  return literalDateValue.toLocaleDateString("en-US", { weekday: "long" });
}

export function tournamentTimeLabel(value: string, timeZone = DEFAULT_TOURNAMENT_TIMEZONE) {
  const date = new Date(value);
  if (!Number.isNaN(date.getTime()) && hasExplicitTimeZone(value)) {
    return formatter(timeZone, { hour: "numeric", minute: "2-digit" }).format(date);
  }
  const literal = literalParts(value);
  if (!literal) return value.slice(11, 16);
  return formatClock(literal.hour, literal.minute);
}
