FROM node:22-alpine@sha256:8ea2348b068a9544dae7317b4f3aafcdc032df1647bb7d768a05a5cad1a7683f

ARG RELEASE_REVISION
ARG RELEASE_BUILT_AT
RUN test -n "$RELEASE_REVISION" && test -n "$RELEASE_BUILT_AT"
LABEL org.opencontainers.image.title="Fishroom Management System" \
      org.opencontainers.image.revision="$RELEASE_REVISION" \
      org.opencontainers.image.created="$RELEASE_BUILT_AT"

WORKDIR /app
ENV HOST=0.0.0.0
ENV PORT=8787
ENV PGHOST=127.0.0.1
ENV PGPORT=5432
ENV RELEASE_REVISION=$RELEASE_REVISION
ENV RELEASE_BUILT_AT=$RELEASE_BUILT_AT

RUN apk add --no-cache ffmpeg postgresql postgresql-client su-exec

RUN npm install --global pnpm@11.19.0 --no-audit --no-fund
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm config set registry https://registry.npmmirror.com \
  && pnpm install --frozen-lockfile

COPY . .
RUN npm run build
RUN chmod +x /app/docker/entrypoint.sh

ENV NODE_ENV=production

EXPOSE 8787 5432
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8787) + '/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["/app/docker/entrypoint.sh"]
