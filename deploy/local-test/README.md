# 本地测试环境

使用真实 PostgreSQL、管理系统后端和前端。正式数据库的副本与本地上传目录独立保存，新增本地测试管理员，不修改原有人员及业务记录。

配置文件、数据库备份、人员加密密钥和测试登录信息全部保存在仓库外的私有目录；不要将这些文件复制进本目录。

## 启动

先在宿主机构建前端 `npm run build`。复制运行时配置后，使用同一份文件运行以下命令：

```sh
docker compose --env-file /absolute/private/runtime.env -f deploy/local-test/compose.yml build
docker compose --env-file /absolute/private/runtime.env -f deploy/local-test/compose.yml up -d --wait database
```

仅首次初始化时，将数据库备份恢复到本地 `fishroom_test`，并复制与之配套的原始上传文件和加密密钥。恢复完成、后端尚未启动时执行：

```sh
docker compose --env-file /absolute/private/runtime.env -f deploy/local-test/compose.yml run --rm --no-deps backend node /app/deploy/local-test/bootstrap-local-admin.mjs
docker compose --env-file /absolute/private/runtime.env -f deploy/local-test/compose.yml run --rm --no-deps backend node /app/deploy/local-test/inspect-local-copy.mjs
docker compose --env-file /absolute/private/runtime.env -f deploy/local-test/compose.yml up -d --wait backend frontend
```

日常启动只执行最后的 `up -d --wait`，不重新导入数据库。停止使用 `docker compose ... stop`，保留本地数据卷。

## 当前隔离设置

- 只有前端绑定本机 `127.0.0.1:8787`，数据库和后端均不发布端口。
- 后端和数据库仅连接内部隔离网络，禁止后端出站访问；前端另接专用网页入口网络，以支持本机端口映射。云存储、微信、飞书和 AI 凭据均为空。
- 关闭自动订单流转和凭证草稿定时清理，保留启动所需的结构、加密和附件校验。
- 原始媒体单独复制；可再生的视频预览缓存不随副本复制。数据库中的绝对云端媒体网址保留，浏览器可只读查看这些公开媒体。
- 两个运行时基底使用本机缓存镜像；已核对 Node、FFmpeg、PG 客户端及 COS SDK 版本。构建会完整替换旧应用代码，前端显示专用测试标题。
