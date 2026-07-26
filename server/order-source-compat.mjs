export const ORDER_FORM_SCHEMA_VERSION = 2;

export function normalizeLegacyDouyinOrderRequest(body = {}) {
  const source = String(body?.source ?? "").trim();
  const explicitOrderNo = String(body?.douyinOrderNo ?? "").trim();
  const schemaVersion = Number(body?.orderFormSchemaVersion ?? 0);

  if (
    source !== "平台下单" ||
    explicitOrderNo ||
    schemaVersion >= ORDER_FORM_SCHEMA_VERSION
  ) {
    return body;
  }

  const legacyOrderNo = String(body?.notes ?? "").trim();
  if (!legacyOrderNo) return body;

  return {
    ...body,
    douyinOrderNo: legacyOrderNo,
  };
}
