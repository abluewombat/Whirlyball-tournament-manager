export function dateInputValue(value: string | null | undefined) {
  return value ? value.slice(0, 10) : "";
}

export function dateTimeLocalInputValue(value: string | null | undefined) {
  return value ? value.slice(0, 16) : "";
}

export function displayDateTime(value: string | null | undefined) {
  if (!value) return "";
  const literal = literalDateTimeParts(value);
  if (literal) return `${literal.date}, ${literal.time}`;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function literalDateTimeParts(value: string) {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!match) return null;
  const [, year, month, day, hour, minute] = match;
  const date = new Date(Number(year), Number(month) - 1, Number(day));
  if (Number.isNaN(date.getTime())) return null;
  return {
    date: date.toLocaleDateString(),
    time: formatClock(Number(hour), minute)
  };
}

function formatClock(hour: number, minute: string) {
  const suffix = hour >= 12 ? "PM" : "AM";
  const displayHour = hour % 12 || 12;
  return `${displayHour}:${minute} ${suffix}`;
}
