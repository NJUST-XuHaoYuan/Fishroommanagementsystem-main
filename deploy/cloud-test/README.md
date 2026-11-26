# 云端测试环境

测试域名：`https://test.marineforest.com.cn`。测试环境使用生产数据的独立副本；不会自动与生产数据同步。

本配置与正式服务分开使用容器、网络、数据库卷、上传目录、会话密钥和数据库口令。只有前端绑定 `127.0.0.1:8797`，由专用 HTTPS 域名代理；不要公开数据库、后端端口或同域不同端口入口。

## 准备配置

私有配置保存在版本目录之外，权限为 `600`，目录权限为 `700`。不得把生产配置直接作为 `env_file` 加载。只设置下面的变量；加密密钥用于读取副本中已有的加密资料，不得输出到日志：

- `RELEASE_REVISION`、`RELEASE_BUILT_AT`
- `CLOUD_TEST_FRONTEND_BASE_IMAGE`、`CLOUD_TEST_BACKEND_BASE_IMAGE`：已核验、已缓存的运行时镜像。
- `CLOUD_TEST_DATABASE_IMAGE`：与生产相同大版本的 PostgreSQL 缓存镜像。
- `AUTH_SESSION_SECRET`、`POSTGRES_PASSWORD`：测试专用随机值，不复用生产值。
- `PERSONNEL_DATA_KEYRING_JSON`：数据库副本及附件对应的加密密钥环。
- `CLOUD_TEST_UPLOADS_DIR`：独立测试上传目录的绝对路径。
- `CLOUD_TEST_MEDIA_DIR`：宿主机生成的只读历史媒体签名映射目录；不得放入网页静态目录。

## 首次启动

从已提交版本构建前端，把源码和 `dist` 传到专用测试版本目录。以下命令的私有配置路径以实际部署为准：

```sh
docker compose --env-file /home/ubuntu/fishroom-cloud-test/private/runtime.env -f deploy/cloud-test/compose.yml build backend frontend
docker compose --env-file /home/ubuntu/fishroom-cloud-test/private/runtime.env -f deploy/cloud-test/compose.yml up -d --wait database
```

只在首次初始化时把一致性数据库快照恢复到测试库，并复制所需原始附件。不要复制可再生的 `.video-derived` 缓存，不要使用正式上传目录作为测试挂载。恢复数据库时去掉生产角色属主及 ACL。确认数据库名、用户和卷均属于测试环境后启动：

```sh
docker compose --env-file /home/ubuntu/fishroom-cloud-test/private/runtime.env -f deploy/cloud-test/compose.yml up -d --wait backend frontend
```

证书签发完成后，将本目录 `nginx.conf` 安装为独立虚拟主机；先通过 `nginx -t` 再重载。不得覆盖正式站点配置。

## 验证与日常更新

- 核对测试 `/api/version` 与镜像标签；检查数据库身份是 `fishroom_test`。
- 验证登录、保存后重开、手机维护工作台、媒体上传，并核对正式系统版本未改变。
- 页面及弹窗底部始终标注云端测试；公开鱼单接口不开放，媒体仍需登录权限。
- 后端与数据库仅加入内部网络；COS、微信、飞书、AI 凭据均为空；自动订单流转与凭证清理定时任务关闭。
- 历史 COS 素材通过 `refresh-media-map.py` 在宿主机签发只读 GET 地址，测试后端只读映射，不持有 COS 密钥。每小时刷新，链接有效期 24 小时；刷新只读取测试数据库并借用现有签名运行时，不改生产数据或云存储。签名映射缺失或过期时拒绝返回旧链接。新媒体仅写测试上传目录。
- 更新只重建、重启测试前后端，不重新导入数据库或覆盖测试上传。停止使用 `stop`，不得使用 `down -v`。
- 后端与数据库各 2 GB、前端 256 MB 内存上限；数据库恢复整行 JSONB 快照时需要足够的解析内存。视频转码并发为 1，日志轮转。定期检查磁盘空间，防止长期测试附件占满服务器。
