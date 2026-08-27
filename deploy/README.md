# Fishroom split Docker deployment

正式源码发版包把系统拆为三个镜像：

- `fishroom-frontend:<RELEASE_VERSION>`：前端与 `/api/` 反向代理。
- `fishroom-backend:<RELEASE_VERSION>`：Node API 服务。
- `fishroom-database:<RELEASE_VERSION>`：PostgreSQL 初始化镜像。

发版目录会同时提供：

- `fishroom-management-<commit>.tar.gz`：经路径排除和凭据扫描后的源码包。
- `RELEASE.env`：只含 commit、短版号和构建时间，不含密码或密钥。
- `RELEASE_MANIFEST.json`：版本、校验值和生产必需配置说明。
- `SHA256SUMS`：源码包校验值。

源码包不会包含小程序、`.env`、数据库备份、上传文件、Docker 镜像归档或任何生产凭据。

## 1. 校验并解压

```bash
sha256sum -c SHA256SUMS
tar -xzf fishroom-management-<commit>.tar.gz
cd fishroom-management-<commit>
```

包内 `.release-revision`、`RELEASE.env` 和 `RELEASE_MANIFEST.json` 应指向同一个完整 commit。

## 2. 首次部署：建立版本目录外的生产配置与上传目录

```bash
sudo install -d -m 700 -o "$(id -un)" -g "$(id -gn)" /srv/fishroom/config
sudo install -d -m 750 -o "$(id -un)" -g "$(id -gn)" /srv/fishroom/uploads
install -m 600 deploy/.env.example /srv/fishroom/config/production.env
```

以上路径可按服务器规范调整，但必须是不会随版本目录更换的绝对路径。编辑 `/srv/fishroom/config/production.env`，至少替换以下四项：

```env
AUTH_SESSION_SECRET=replace_with_long_random_session_secret
PERSONNEL_DATA_KEYRING_JSON={"activeKid":"personnel-v1","keys":{"personnel-v1":"replace_with_32_byte_base64_key"}}
POSTGRES_PASSWORD=replace_with_strong_database_password
UPLOADS_DIR=/srv/fishroom/uploads
```

- 会话密钥可用 `openssl rand -base64 48` 生成。
- 人员敏感数据密钥必须单独用 `openssl rand -base64 32` 生成，不能复用会话密钥。
- 身份证号、银行卡开户名、银行卡号、开户行使用 AES-256-GCM 字段级加密；身份证正反面和学历证明图片按附件独立加密后保存在 `UPLOADS_DIR/.personnel-private`，只能通过鉴权接口访问。
- 密钥轮换必须分阶段进行：先让所有实例和回滚配置同时持有旧、新密钥且保持旧 `activeKid`；再切换新 `activeKid` 并逐一重启。健康检查通过表示数据库字段和已登记私密附件均已完成重新加密。确认所有实例、附件及仍在保留期内的备份都完成过渡后，才能移除旧 `kid`。
- `/srv/fishroom/config/production.env` 和真实密钥不得放入 Git、发版包、聊天记录或镜像层。
- 普通升级必须继续使用这同一份生产配置，不能再次从 `deploy/.env.example` 创建或覆盖。
- 已有数据库卷上不能随意更换 `POSTGRES_PASSWORD`；人员密钥轮换时不能删除任何仍用于历史数据的旧密钥。两者都只能按受控轮换流程修改。

## 3. 构建带版本指纹的镜像

从源码包根目录执行：

```bash
docker compose \
  --env-file /srv/fishroom/config/production.env \
  --env-file RELEASE.env \
  -f deploy/docker-compose.separated.yml \
  build
```

Compose 会把 `RELEASE.env` 中的完整 commit 和构建时间传给三个 Dockerfile，并使用短 commit 作为不可变镜像标签。Dockerfile 使用锁定的 `pnpm-lock.yaml` 安装依赖；缺少版本参数时构建会直接失败。

构建后可核对 OCI 标签：

```bash
docker compose \
  --env-file /srv/fishroom/config/production.env \
  --env-file RELEASE.env \
  -f deploy/docker-compose.separated.yml \
  images -q backend | xargs docker image inspect \
  --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}'
```

输出必须与 `.release-revision` 完全一致。

## 4. 升级前备份并启动

生产升级前先对数据库和 `UPLOADS_DIR` 指向的稳定上传目录做独立备份（该目录包含加密的人员证件与学历附件），并记录当前三个镜像 digest 作为回滚点。本源码包不携带生产数据或备份。升级时继续复用上一版的 `/srv/fishroom/config/production.env`，不要复制新版示例文件覆盖它。

```bash
docker compose \
  --env-file /srv/fishroom/config/production.env \
  --env-file RELEASE.env \
  -f deploy/docker-compose.separated.yml \
  up -d
```

打开 `http://SERVER_IP:8787`。再核对：

```bash
curl -fsS http://127.0.0.1:8787/api/version
curl -fsS http://127.0.0.1:8787/api/health
```

`/api/version` 返回的 `revision` 必须与 `.release-revision` 一致。人员敏感数据密钥缺失时，生产后端会拒绝启动，避免以明文模式降级运行。

## Domain and HTTPS

The production domain uses host-level Nginx while the Docker frontend remains
available on port `8787`:

- `nginx-fishroom.conf`: HTTP bootstrap proxy used before a certificate exists.
- `nginx-fishroom-ssl.conf`: HTTPS proxy and HTTP-to-HTTPS redirect.
- `certbot-dnspod-hook.py`: DNSPod DNS-01 hook for unattended certificate renewal.
- `certbot-reload-nginx.sh`: reloads Nginx after Certbot replaces a certificate.

The DNS hook reads `COS_SECRET_ID` and `COS_SECRET_KEY` from the running
`fishroom-backend` container. Those credentials must retain DNSPod record
permissions, and the container name can be overridden with
`FISHROOM_BACKEND_CONTAINER`.

## 5. 停止服务

```bash
docker compose \
  --env-file /srv/fishroom/config/production.env \
  --env-file RELEASE.env \
  -f deploy/docker-compose.separated.yml \
  down
```

不要在生产升级或普通停机时使用 `down -v`；它会删除数据库卷。
