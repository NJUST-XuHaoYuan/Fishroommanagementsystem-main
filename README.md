# 鱼房管理系统

这是从 Figma Make 导出的鱼房管理系统初稿。当前版本已改为完全本地独立运行，不再依赖 Supabase。

## Docker 本地部署

```bash
docker compose up --build -d
```

启动后打开：

```text
http://127.0.0.1:8787
```

数据会保存在同一个容器里的本地 PostgreSQL 中。PostgreSQL 数据目录挂载到 Docker 命名卷 `fishroom-postgres-data`，容器内路径是 `/var/lib/postgresql/data`。

镜像会把完整项目源码、`node_modules` 依赖、生产构建产物和 PostgreSQL 服务都放进同一个容器。运行时不会挂载宿主机代码目录，只挂载 Docker 数据卷。

常用命令：

```bash
docker compose ps
docker compose logs -f
docker compose down
```

进入同容器里的 PostgreSQL：

```bash
docker exec -it fishroom-management-local psql -U fishroom -d fishroom
```

## 本地独立运行说明

- 前端 API 调用已从 Supabase Edge Function 改为 `/api/state`。
- `server/local-server.mjs` 同时提供静态页面和本地状态 API，并将状态存入 PostgreSQL 的 `app_state` 表。
- 生产容器里会先启动 PostgreSQL，再由 `node server/local-server.mjs` 运行应用服务。
