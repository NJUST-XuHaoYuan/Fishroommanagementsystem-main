const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const LOCAL_DATE_TIME_PATTERN = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(?::(\d{2}))?/;

export function normalizeLocalDateTime(value) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return "";
  if (DATE_ONLY_PATTERN.test(trimmed)) return `${trimmed}T00:00:00`;
  const normalized = trimmed.replace(" ", "T");
  const match = normalized.match(LOCAL_DATE_TIME_PATTERN);
  if (!match) return normalized.slice(0, 19);
  return `${match[1]}:${match[2] ?? "00"}`;
}
