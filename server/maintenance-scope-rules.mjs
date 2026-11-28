const text = value => String(value ?? "").trim();
const fail = (message, statusCode = 400) => { throw Object.assign(new Error(message), { statusCode }); };

// Match explicit operation names only. Never infer or rewrite old free-text notes.
export const GROUP_WATER_ACTIONS = Object.freeze(["下药", "水体下药", "治疗", "下药治疗", "水质", "测水质", "水质测试", "水质检测"]);
export const isSharedWaterAction = action => GROUP_WATER_ACTIONS.includes(text(action));
// Tank maintenance always belongs to a group. Individual-fish treatment uses
// bioRecords/stockItemId instead of this log path.
export const isGroupMaintenanceLog = () => true;

/** A compartment may be an entry location, never a separate shared-water scope. */
export function maintenanceRecordLocation(input = {}, { current, group } = {}) {
  if (input.scope !== undefined && !["group", "sub", "subTank"].includes(input.scope)) fail("请选择有效的记录范围");
  const subTankId = text(Object.hasOwn(input, "subTankId") ? input.subTankId : current?.subTankId);
  const explicitSource = text(input.recordedFromSubTankId);
  const originalSource = text(current?.recordedFromSubTankId || current?.subTankId);
  const validate = id => {
    // Historical entry locations may since have been removed. Keep that
    // original snapshot, while validating every newly supplied location.
    if (id && !(id === originalSource && text(current?.tankGroupId) === text(group?.id)) && (group?.subTanks ?? []).filter(tank => text(tank?.id) === id).length !== 1) fail("所选子缸不存在或不属于当前缸组", 404);
  };
  validate(subTankId); validate(explicitSource);
  if (explicitSource && subTankId && explicitSource !== subTankId) fail("录入位置与所选子缸不一致", 409);
  const suppliedSource = explicitSource || subTankId;
  if (originalSource && suppliedSource && originalSource !== suppliedSource) fail("不能修改记录的原录入位置", 409);
  const recordedFromSubTankId = originalSource || suppliedSource;
  validate(recordedFromSubTankId);
  return {
    scope: "group",
    ...(recordedFromSubTankId ? { recordedFromSubTankId } : {}),
    // Migration references and audit data are server-owned. Old editors may
    // omit them, but new requests must never be able to forge them.
    ...(current?.scopeMigration ? { scopeMigration: current.scopeMigration } : {}),
    ...(Array.isArray(current?.inheritedTankGroupIds) ? { inheritedTankGroupIds: current.inheritedTankGroupIds } : {}),
  };
}

// Read/retry semantics for legacy rows without modifying their stored contents.
export function comparableMaintenanceLocation(record = {}) {
  return { scope: "group", recordedFromSubTankId: text(record.recordedFromSubTankId || record.subTankId) };
}
