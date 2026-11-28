import { normalizeMaintenanceMedia } from "./daily-log-save-rules.mjs";

const list = value => Array.isArray(value) ? value : [];
const text = value => String(value ?? "").trim();
const fail = (message, statusCode = 400) => { throw Object.assign(new Error(message), { statusCode }); };
const LIMIT = 200;
export const isLegacyRoomId = (groups, groupId) => Boolean(text(groupId) && list(groups).some(group => text(group.legacyRoomId) === text(groupId)));
const fields = (value, keys) => Object.fromEntries(keys.filter(key => Object.hasOwn(value ?? {}, key)).map(key => [key, value[key]]));
const media = value => list(value).slice(0, 30).flatMap(url => { try { return normalizeMaintenanceMedia([url], "历史附件"); } catch { return []; } });
const safeLog = record => ({ ...fields(record, ["id", "siteId", "tankGroupId", "date", "action", "operator", "createdBy", "notes"]), photos: media(record.photos), videos: media(record.videos) });
const safeWater = record => ({ ...fields(record, ["id", "siteId", "tankGroupId", "measuredAt", "operator", "createdBy", "notes"]),
  values: list(record.values).map(value => fields(value, ["parameterId", "parameterName", "unit", "precision", "value", "testMethod"])),
  photos: media(record.photos), videos: media(record.videos) });

/** Original room records are references only: no copies, writes, synchronization or current water summaries. */
export function createTankGroupLegacyHistoryHandler({ pool, stateId, sendJson, refreshAuth, requireSite, hasPermission }) {
  return async (req, res, url) => {
    if (url.pathname !== "/api/tank-groups/legacy-history") return false;
    res.setHeader("Cache-Control", "no-store, private");
    let client;
    try {
      if (req.method !== "GET") fail("不支持的请求方式", 405);
      const groupId = text(url.searchParams.get("tankGroupId")), requestedSiteId = text(url.searchParams.get("siteId"));
      if (!groupId || groupId.length > 160 || requestedSiteId.length > 160) fail("请选择有效缸组");
      client = await pool.connect(); await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const row = (await client.query(`SELECT data -> 'sites' AS sites, data -> 'personnel' AS personnel,
        data -> 'tankGroups' AS tank_groups FROM app_state WHERE id = $1`, [stateId])).rows[0] ?? {};
      const state = { sites: list(row.sites), personnel: list(row.personnel), tankGroups: list(row.tank_groups) };
      refreshAuth(req, state);
      if (!["create", "update", "delete"].some(action => hasPermission(req.auth?.account, "daily", action))) fail("当前账号没有维护管理权限", 403);
      const groups = state.tankGroups.filter(group => text(group.id) === groupId);
      if (groups.length !== 1) fail("缸组不存在或编号重复", 404);
      const group = groups[0], siteId = text(group.siteId) || "nanjing";
      requireSite(req, state, siteId);
      if (requestedSiteId && requestedSiteId !== siteId) fail("所选缸组不属于当前场地", 404);
      const legacyRoomId = text(group.legacyRoomId), legacyRoomName = text(group.legacyRoomName);
      if (!legacyRoomId) {
        await client.query("COMMIT"); sendJson(req, res, 200, { ok: true, legacyRoomId: "", legacyRoomName: "", logs: [], waterQualityRecords: [], limit: LIMIT, truncated: { logs: false, waterQualityRecords: false } }); return true;
      }
      if (legacyRoomId.length > 160 || legacyRoomId === groupId) fail("原房间关联无效，请管理员核对", 409);
      const originals = state.tankGroups.filter(item => text(item.id) === legacyRoomId);
      if (originals.length > 1 || originals.some(item => (text(item.siteId) || "nanjing") !== siteId)) fail("原房间关联场地不一致，请管理员核对", 409);
      // Missing record.siteId is accepted only when a surviving original room
      // establishes that site's ownership. A deleted room cannot prove it.
      const originalSiteId = originals.length === 1 ? text(originals[0].siteId) || "nanjing" : "";
      const history = (await client.query(`SELECT
        COALESCE((SELECT json_agg(entry ORDER BY occurred_at DESC, record_id DESC) FROM (
          SELECT json_build_object('id', item -> 'id', 'siteId', item -> 'siteId', 'tankGroupId', item -> 'tankGroupId',
            'date', item -> 'date', 'action', item -> 'action', 'operator', item -> 'operator', 'createdBy', item -> 'createdBy',
            'notes', item -> 'notes', 'photos', item -> 'photos', 'videos', item -> 'videos') AS entry,
            item ->> 'date' AS occurred_at, item ->> 'id' AS record_id
          FROM jsonb_array_elements(COALESCE(data -> 'logs', '[]'::jsonb)) AS log_rows(item)
          WHERE item ->> 'tankGroupId' = $2 AND COALESCE(NULLIF(item ->> 'siteId', ''), $4::text) = $3
          ORDER BY item ->> 'date' DESC, item ->> 'id' DESC LIMIT $5
        ) AS selected_logs), '[]'::json) AS legacy_room_logs,
        COALESCE((SELECT json_agg(entry ORDER BY occurred_at DESC, record_id DESC) FROM (
          SELECT json_build_object('id', item -> 'id', 'siteId', item -> 'siteId', 'tankGroupId', item -> 'tankGroupId',
            'measuredAt', item -> 'measuredAt', 'operator', item -> 'operator', 'createdBy', item -> 'createdBy',
            'values', item -> 'values', 'notes', item -> 'notes', 'photos', item -> 'photos', 'videos', item -> 'videos') AS entry,
            item ->> 'measuredAt' AS occurred_at, item ->> 'id' AS record_id
          FROM jsonb_array_elements(COALESCE(data -> 'waterQualityRecords', '[]'::jsonb)) AS water_rows(item)
          WHERE item ->> 'tankGroupId' = $2 AND COALESCE(NULLIF(item ->> 'siteId', ''), $4::text) = $3
          ORDER BY item ->> 'measuredAt' DESC, item ->> 'id' DESC LIMIT $5
        ) AS selected_water), '[]'::json) AS legacy_room_water_records
        FROM app_state WHERE id = $1`, [stateId, legacyRoomId, siteId, originalSiteId, LIMIT + 1])).rows[0] ?? {};
      const logs = list(history.legacy_room_logs), water = list(history.legacy_room_water_records);
      await client.query("COMMIT");
      sendJson(req, res, 200, { ok: true, legacyRoomId, legacyRoomName, logs: logs.slice(0, LIMIT).map(safeLog), waterQualityRecords: water.slice(0, LIMIT).map(safeWater),
        limit: LIMIT, truncated: { logs: logs.length > LIMIT, waterQualityRecords: water.length > LIMIT } });
    } catch (error) {
      await client?.query("ROLLBACK").catch(() => undefined);
      sendJson(req, res, Number(error.statusCode || 500), { ok: false, error: error.statusCode ? error.message : "原房间历史暂时无法加载，请重试" });
    } finally { client?.release(); }
    return true;
  };
}
