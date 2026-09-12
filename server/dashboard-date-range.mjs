export const DEFAULT_DASHBOARD_DAYS = 30;
export const MAX_DASHBOARD_DAYS = 730;
const DAY_MS = 86_400_000;

function invalidRange(message) {
  const error = new Error(message);
  error.statusCode = 400;
  error.code = "INVALID_DASHBOARD_DATE_RANGE";
  return error;
}

function dateTimestamp(value, label) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw invalidRange(`${label}须为 YYYY-MM-DD 格式`);
  }
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value) {
    throw invalidRange(`${label}不是有效日期`);
  }
  return timestamp;
}

/** Inclusive calendar dates, independent of browser/server timezone and DST. */
export function resolveDashboardDateRange(options = {}, today = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10)) {
  const hasStart = options.startDate != null;
  const hasEnd = options.endDate != null;
  let startTimestamp;
  let endTimestamp;
  if (hasStart || hasEnd) {
    if (!hasStart || !hasEnd) throw invalidRange("请同时选择开始日期和结束日期");
    startTimestamp = dateTimestamp(options.startDate, "开始日期");
    endTimestamp = dateTimestamp(options.endDate, "结束日期");
    if (startTimestamp > endTimestamp) throw invalidRange("开始日期不能晚于结束日期");
    if ((endTimestamp - startTimestamp) / DAY_MS + 1 > MAX_DASHBOARD_DAYS) {
      throw invalidRange(`日期范围最多支持 ${MAX_DASHBOARD_DAYS} 天`);
    }
  } else {
    // Preserve existing financeDays behavior for older clients and reports.
    const legacyDays = Number.parseInt(String(options.financeDays ?? ""), 10);
    const days = Number.isFinite(legacyDays)
      ? Math.min(MAX_DASHBOARD_DAYS, Math.max(7, legacyDays))
      : DEFAULT_DASHBOARD_DAYS;
    endTimestamp = dateTimestamp(today, "当前日期");
    startTimestamp = endTimestamp - (days - 1) * DAY_MS;
  }
  const financeDays = (endTimestamp - startTimestamp) / DAY_MS + 1;
  const dates = Array.from({ length: financeDays }, (_, index) =>
    new Date(startTimestamp + index * DAY_MS).toISOString().slice(0, 10)
  );
  return { dates, startDate: dates[0], endDate: dates[dates.length - 1], financeDays };
}
