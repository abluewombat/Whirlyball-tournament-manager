export function dateInputValue(value: string | null | undefined) {
  return value ? value.slice(0, 10) : "";
}

export function displayDateTime(value: string | null | undefined) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
