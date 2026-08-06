export const DEFAULT_SHIPPING_CARRIER_SETTINGS = [
  { id: "carrier-high-speed-rail", name: "高铁", enabled: true },
  { id: "carrier-sf", name: "顺丰", enabled: true },
  { id: "carrier-jd", name: "京东", enabled: true },
];

export function normalizeShippingCarrierSettings(settings = {}) {
  const source = Array.isArray(settings?.shippingCarriers)
    ? settings.shippingCarriers
    : DEFAULT_SHIPPING_CARRIER_SETTINGS;
  const usedIds = new Set();
  return source.flatMap((carrier, index) => {
    const name = String(carrier?.name ?? "").trim();
    if (!name) return [];
    const fallbackId = `carrier-${index + 1}`;
    let id = String(carrier?.id ?? "").trim() || fallbackId;
    let suffix = 2;
    while (usedIds.has(id)) id = `${fallbackId}-${suffix++}`;
    usedIds.add(id);
    return [{ id, name, enabled: carrier?.enabled === true }];
  });
}

export function validateShippingCarrierSettings(value) {
  if (!Array.isArray(value)) throw new Error("快递公司配置格式无效");
  if (value.length > 100) throw new Error("快递公司最多配置 100 项");
  const normalized = normalizeShippingCarrierSettings({ shippingCarriers: value });
  if (normalized.length !== value.length) throw new Error("请填写快递公司名称");
  const duplicate = normalized.find((carrier, index) =>
    normalized.findIndex((candidate) => candidate.name.toLowerCase() === carrier.name.toLowerCase()) !== index
  );
  if (duplicate) throw new Error(`快递公司名称不能重复：${duplicate.name}`);
  if (!normalized.some((carrier) => carrier.enabled)) throw new Error("请至少启用一家快递公司");
  return normalized;
}

export function configuredShippingCarriers(settings = {}) {
  return normalizeShippingCarrierSettings(settings).filter((carrier) => carrier.enabled);
}

export function resolveShippingCarrier(settings = {}, requestedName = "", currentName = "") {
  const requested = String(requestedName ?? "").trim();
  const current = String(currentName ?? "").trim();
  if (!requested) throw new Error("请选择快递公司");
  if (current && requested === current) return current;
  const configured = configuredShippingCarriers(settings)
    .find((carrier) => carrier.name.toLowerCase() === requested.toLowerCase());
  if (!configured) throw new Error(`快递公司「${requested}」未启用或已删除`);
  return configured.name;
}
