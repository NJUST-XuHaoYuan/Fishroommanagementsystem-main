const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const LOCAL_DATE_TIME_PATTERN = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(?::(\d{2}))?/;

export function nowDatetimeLocal(): string {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 19);
}

export function minDatetimeForDate(value?: string): string | undefined {
  const date = String(value ?? "").trim().slice(0, 10);
  return DATE_ONLY_PATTERN.test(date) ? `${date}T00:00:00` : undefined;
}

export function normalizeBioRecordTime(value?: string): string {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return "";
  if (DATE_ONLY_PATTERN.test(trimmed)) return `${trimmed}T00:00:00`;
  const normalized = trimmed.replace(" ", "T");
  const match = normalized.match(LOCAL_DATE_TIME_PATTERN);
  if (!match) return normalized.slice(0, 19);
  return `${match[1]}:${match[2] ?? "00"}`;
}

export function formatBioRecordTime(value?: string, fallback = "—"): string {
  const normalized = normalizeBioRecordTime(value);
  return normalized ? normalized.replace("T", " ") : fallback;
}

export function isoToDatetimeLocal(value?: string): string {
  const date = new Date(String(value ?? ""));
  if (!Number.isFinite(date.getTime())) return "";
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 19);
}
