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

## AI 助手与飞书集成

登录系统后，右下角会出现 AI 助手入口。助手会读取当前场地的库存、订单、发货、损耗和养护摘要，只做只读问答，不会直接修改业务数据。

后端通过环境变量配置 AI 服务：

```env
AI_API_KEY=sk-...
AI_API_BASE_URL=https://api.openai.com/v1
AI_MODEL=gpt-4o-mini
AI_TEMPERATURE=0.2
```

`AI_API_BASE_URL` 支持 OpenAI-compatible 的 Chat Completions 服务。没有配置 `AI_API_KEY` 时，助手仍会显示系统摘要，但不会调用模型。

飞书有两种接入方式：

```env
# 从系统内把 AI 问答摘要推送到飞书自定义机器人
FEISHU_WEBHOOK_URL=
FEISHU_WEBHOOK_SECRET=

# 飞书里直接问机器人，并由系统回复消息事件
FEISHU_APP_ID=
FEISHU_APP_SECRET=
FEISHU_VERIFICATION_TOKEN=
FEISHU_DEFAULT_SITE_ID=all
```

飞书应用事件订阅的请求地址配置为：

```text
http://你的域名或服务器地址/api/assistant/feishu/events
```

如果启用了飞书事件回调加密，需要先关闭加密，或再补充解密逻辑；当前版本支持 verification token 校验和文本消息回复。
