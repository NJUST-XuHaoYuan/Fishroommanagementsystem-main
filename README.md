# 鱼房管理系统

这是从 Figma Make 导出的鱼房管理系统初稿。当前版本已改为完全本地独立运行，不再依赖 Supabase。

## Docker 本地部署

```bash
docker compose up --build -d
```

启动前必须设置会话密钥、人员敏感数据密钥和数据库密码。身份证号、工资银行卡号、开户名与开户行使用独立的 AES-256-GCM 字段级加密密钥：

```env
AUTH_SESSION_SECRET=请替换为高强度随机值
PERSONNEL_DATA_KEYRING_JSON={"activeKid":"personnel-v1","keys":{"personnel-v1":"请替换为 openssl rand -base64 32 的输出"}}
POSTGRES_PASSWORD=请替换为高强度数据库密码
```

轮换人员数据密钥时，先在 `keys` 中同时保留旧密钥和新密钥，再把 `activeKid` 指向新密钥；服务启动时会在数据库事务中完成重新加密。不要把真实密钥提交到代码仓库或发版包。

启动后打开：

```text
http://127.0.0.1:8787
```

数据会保存在同一个容器里的本地 PostgreSQL 中。PostgreSQL 数据目录挂载到 Docker 命名卷 `fishroom-postgres-data`，上传文件挂载到 `fishroom-uploads`，升级容器时不会随容器消失。

镜像会把完整项目源码、`node_modules` 依赖、生产构建产物和 PostgreSQL 服务都放进同一个容器。运行时不会挂载宿主机代码目录，只挂载 Docker 数据卷。

常用命令：

```bash
docker compose ps
docker compose logs -f
docker compose down
```

## 生成正式源码发版包

所有修改通过测试并提交后执行：

```bash
pnpm release:source
```

脚本只打包当前 Git 提交，会在 `release-output/fishroom-management-<commit>/` 生成源码包、`RELEASE.env`、清单和 SHA-256 校验文件。它会排除小程序、环境变量、凭据、上传、备份、构建产物和 Git 元数据，并在校验完成前把候选产物留在临时目录。生成发版包不会自动部署生产；生产构建、备份、启动和版本核对见 `deploy/README.md`。

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
