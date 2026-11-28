const list = value => Array.isArray(value) ? value : [];
const text = value => String(value ?? "").trim();
const fail = (message, statusCode = 400) => { throw Object.assign(new Error(message), { statusCode }); };

export function mobileMaintenanceHistoryQuery(url) {
  const siteId = text(url.searchParams.get("siteId"));
  const subTankId = text(url.searchParams.get("subTankId"));
  const tankGroupId = text(url.searchParams.get("tankGroupId"));
  const kind = text(url.searchParams.get("kind"));
  const reasonStatus = text(url.searchParams.get("reasonStatus"));
  const limit = Number(url.searchParams.get("limit") ?? 30);
  if (!siteId || siteId.length > 160 || subTankId.length > 160 || tankGroupId.length > 160) fail("请选择有效场地、缸组或子缸");
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail("记录条数须在1至100之间");
  if (!["", "loss"].includes(kind) || !["", "missing"].includes(reasonStatus) || reasonStatus && kind !== "loss") fail("请选择有效的记录筛选条件");
  return { siteId, tankGroupId, subTankId, limit, kind, reasonStatus };
}

/** Only the authenticated user's records; bounded combined result, never whole media arrays. */
export function createMobileMaintenanceHistoryHandler({ pool, stateId, sendJson, refreshAuth, requireSite, hasPermission }) {
  return async (req, res, url) => {
    if (url.pathname !== "/api/mobile-maintenance/history") return false;
    res.setHeader("Cache-Control", "no-store, private");
    let client;
    try {
      if (req.method !== "GET") fail("不支持的请求方式", 405);
      const { siteId, tankGroupId, subTankId, limit, kind, reasonStatus } = mobileMaintenanceHistoryQuery(url);
      client = await pool.connect();
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const row = (await client.query(`SELECT data -> 'sites' AS sites, data -> 'tankGroups' AS tank_groups,
        data -> 'personnel' AS personnel FROM app_state WHERE id = $1`, [stateId])).rows[0] ?? {};
      const state = { sites: list(row.sites), tankGroups: list(row.tank_groups), personnel: list(row.personnel) };
      refreshAuth(req, state);
      requireSite(req, state, siteId);
      if (!["create", "update", "delete"].some(action => hasPermission(req.auth?.account, "daily", action)) &&
          !(kind === "loss" && ["create", "update", "delete"].some(action => hasPermission(req.auth?.account, "lossRecords", action)))) fail("当前账号没有维护管理权限", 403);
      const username = text(req.auth?.user?.username);
      if (!username) fail("请重新登录", 401);
      let selectedGroupId = tankGroupId;
      if (tankGroupId) {
        const matches = state.tankGroups.filter(group => text(group.id) === tankGroupId);
        if (matches.length !== 1 || text(matches[0].siteId || "nanjing") !== siteId) fail("所选缸组不存在或不属于当前场地", 404);
      }
      if (subTankId) {
        const matches = state.tankGroups.flatMap(group => list(group.subTanks).filter(tank => text(tank.id) === subTankId).map(() => group));
        if (matches.length !== 1 || text(matches[0].siteId || "nanjing") !== siteId) fail("所选子缸不存在或不属于当前场地", 404);
        if (tankGroupId && text(matches[0].id) !== tankGroupId) fail("所选子缸不属于当前缸组", 404);
        selectedGroupId = text(matches[0].id);
      }
      const rows = (await client.query(`WITH source AS MATERIALIZED (SELECT data FROM app_state WHERE id = $1),
        legacy_room_ids AS MATERIALIZED (
          SELECT DISTINCT grp ->> 'legacyRoomId' AS id FROM source,
            LATERAL jsonb_array_elements(COALESCE(data -> 'tankGroups', '[]'::jsonb)) AS current_groups(grp)
          WHERE COALESCE(grp ->> 'legacyRoomId', '') <> ''
        ),
        own_records AS (
          SELECT 'tank' AS kind, entry FROM source,
            LATERAL jsonb_array_elements(COALESCE(data -> 'logs', '[]'::jsonb)) AS log_rows(entry)
          WHERE $7::text = '' AND COALESCE(NULLIF(entry ->> 'createdBy', ''), entry ->> 'operator') = $2
            AND (COALESCE(entry ->> 'tankGroupId', '') NOT IN (SELECT id FROM legacy_room_ids)
              OR jsonb_typeof(entry -> 'inheritedTankGroupIds') = 'array')
            AND COALESCE(NULLIF(entry ->> 'siteId', ''), (
              SELECT grp ->> 'siteId' FROM jsonb_array_elements(COALESCE(data -> 'tankGroups', '[]'::jsonb)) AS groups(grp)
              WHERE grp ->> 'id' = entry ->> 'tankGroupId' OR
                (grp ->> 'legacyRoomId' = entry ->> 'tankGroupId' AND entry -> 'inheritedTankGroupIds' ? (grp ->> 'id')) LIMIT 1), 'nanjing') = $3
            AND ($6 = '' OR COALESCE(NULLIF(entry ->> 'tankGroupId', ''), (
              SELECT grp ->> 'id' FROM jsonb_array_elements(COALESCE(data -> 'tankGroups', '[]'::jsonb)) AS groups(grp)
              WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(grp -> 'subTanks', '[]'::jsonb)) AS tanks(tank)
                WHERE tank ->> 'id' = entry ->> 'subTankId') LIMIT 1)) = $6
              OR (jsonb_typeof(entry -> 'inheritedTankGroupIds') = 'array' AND entry -> 'inheritedTankGroupIds' ? $6))
          UNION ALL
          SELECT 'fish' AS kind, entry FROM source,
            LATERAL jsonb_array_elements(COALESCE(data -> 'bioRecords', '[]'::jsonb)) AS bio_rows(entry)
          WHERE $7::text = '' AND entry ->> 'operator' = $2
            AND COALESCE(entry ->> 'sourceType', 'manual') IN ('manual', '')
            AND COALESCE(NULLIF(entry ->> 'siteId', ''), (
              SELECT item ->> 'siteId' FROM jsonb_array_elements(COALESCE(data -> 'stock', '[]'::jsonb)) AS fish(item)
              WHERE item ->> 'id' = entry ->> 'stockItemId' LIMIT 1), 'nanjing') = $3
            AND ($4 = '' OR COALESCE(NULLIF(entry ->> 'subTankId', ''), (
              SELECT item ->> 'subTankId' FROM jsonb_array_elements(COALESCE(data -> 'stock', '[]'::jsonb)) AS fish(item)
              WHERE item ->> 'id' = entry ->> 'stockItemId' LIMIT 1)) = $4)
            AND ($6 = '' OR COALESCE(NULLIF(entry ->> 'tankGroupId', ''), (
              SELECT grp ->> 'id' FROM jsonb_array_elements(COALESCE(data -> 'tankGroups', '[]'::jsonb)) AS groups(grp)
              WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(grp -> 'subTanks', '[]'::jsonb)) AS tanks(tank)
                WHERE tank ->> 'id' = COALESCE(NULLIF(entry ->> 'subTankId', ''), (
                  SELECT item ->> 'subTankId' FROM jsonb_array_elements(COALESCE(data -> 'stock', '[]'::jsonb)) AS fish(item)
                  WHERE item ->> 'id' = entry ->> 'stockItemId' LIMIT 1))) LIMIT 1)) = $6)
          UNION ALL
          SELECT 'water' AS kind, entry FROM source,
            LATERAL jsonb_array_elements(COALESCE(data -> 'waterQualityRecords', '[]'::jsonb)) AS water_rows(entry)
          WHERE $7::text = '' AND COALESCE(NULLIF(entry ->> 'createdBy', ''), entry ->> 'operator') = $2
            AND (COALESCE(entry ->> 'tankGroupId', '') NOT IN (SELECT id FROM legacy_room_ids)
              OR jsonb_typeof(entry -> 'inheritedTankGroupIds') = 'array')
            AND COALESCE(NULLIF(entry ->> 'siteId', ''), (
              SELECT grp ->> 'siteId' FROM jsonb_array_elements(COALESCE(data -> 'tankGroups', '[]'::jsonb)) AS groups(grp)
              WHERE grp ->> 'id' = entry ->> 'tankGroupId' OR
                (grp ->> 'legacyRoomId' = entry ->> 'tankGroupId' AND entry -> 'inheritedTankGroupIds' ? (grp ->> 'id')) LIMIT 1), 'nanjing') = $3
            AND ($6 = '' OR entry ->> 'tankGroupId' = $6
              OR (jsonb_typeof(entry -> 'inheritedTankGroupIds') = 'array' AND entry -> 'inheritedTankGroupIds' ? $6))
          UNION ALL
          SELECT 'loss' AS kind, entry FROM source,
            LATERAL jsonb_array_elements(COALESCE(data -> 'lossRecords', '[]'::jsonb)) AS loss_rows(entry)
          WHERE $7::text = 'loss' AND entry ->> 'operator' = $2
            AND COALESCE(NULLIF(entry ->> 'siteId', ''), (
              SELECT grp ->> 'siteId' FROM jsonb_array_elements(COALESCE(data -> 'tankGroups', '[]'::jsonb)) AS groups(grp)
              WHERE grp ->> 'id' = entry ->> 'tankGroupId' LIMIT 1), 'nanjing') = $3
            AND ($4 = '' OR entry ->> 'subTankId' = $4)
            AND ($6 = '' OR entry ->> 'tankGroupId' = $6)
            AND ($8::text = '' OR btrim(COALESCE(entry ->> 'reason', '')) = '')
        ), ranked AS (
          SELECT kind, entry, row_number() OVER (PARTITION BY kind
            ORDER BY (COALESCE(entry ->> 'measuredAt', entry ->> 'createdAt', entry ->> 'date', '') ~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])([T ]([01][0-9]|2[0-3]):[0-5][0-9])?') DESC,
              COALESCE(entry ->> 'measuredAt', entry ->> 'createdAt', entry ->> 'date') DESC, entry ->> 'id' DESC) AS record_rank
          FROM own_records
        ) SELECT kind, entry FROM ranked WHERE record_rank <= $5`, [stateId, username, siteId, subTankId, limit + 1, selectedGroupId, kind, reasonStatus])).rows;
      await client.query("COMMIT");
      // At most (limit + 1) from each of four kinds. Sort actual times in JS so
      // legacy malformed dates cannot make PostgreSQL reject the entire history.
      const time = row => {
        const raw = text(row.kind === "water" ? row.entry.measuredAt : row.kind === "loss" ? row.entry.createdAt || row.entry.date : row.entry.date);
        const value = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T00:00:00` : raw;
        const parsed = Date.parse(/(?:Z|[+-][0-9]{2}:?[0-9]{2})$/i.test(value) ? value : `${value}+08:00`);
        return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
      };
      rows.sort((a, b) => time(b) - time(a) || text(b.entry.id).localeCompare(text(a.entry.id)));
      const visible = rows.slice(0, limit);
      sendJson(req, res, 200, { ok: true, siteId, tankGroupId: selectedGroupId, subTankId, kind, reasonStatus, limit, truncated: rows.length > limit,
        logs: visible.filter(row => row.kind === "tank").map(row => row.entry),
        bioRecords: visible.filter(row => row.kind === "fish").map(row => row.entry),
        waterQualityRecords: visible.filter(row => row.kind === "water").map(row => row.entry),
        lossRecords: visible.filter(row => row.kind === "loss").map(row => row.entry) });
    } catch (error) {
      if (client) await client.query("ROLLBACK").catch(() => undefined);
      sendJson(req, res, error.statusCode || 500, { ok: false, error: error.statusCode ? error.message : "个人维护记录暂时无法加载，请重试" });
    } finally { client?.release(); }
    return true;
  };
}
