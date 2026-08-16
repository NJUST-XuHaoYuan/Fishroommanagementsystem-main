FROM node:22-alpine@sha256:8ea2348b068a9544dae7317b4f3aafcdc032df1647bb7d768a05a5cad1a7683f AS builder

WORKDIR /app

RUN npm install --global pnpm@11.19.0 --no-audit --no-fund
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm config set registry https://registry.npmmirror.com \
  && pnpm install --frozen-lockfile

COPY . .
RUN npm run build

FROM node:22-alpine@sha256:8ea2348b068a9544dae7317b4f3aafcdc032df1647bb7d768a05a5cad1a7683f

ARG RELEASE_REVISION
ARG RELEASE_BUILT_AT
RUN test -n "$RELEASE_REVISION" && test -n "$RELEASE_BUILT_AT"
LABEL org.opencontainers.image.title="Fishroom Management Frontend" \
      org.opencontainers.image.revision="$RELEASE_REVISION" \
      org.opencontainers.image.created="$RELEASE_BUILT_AT"

WORKDIR /app

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=80
ENV BACKEND_URL=http://backend:8787
ENV RELEASE_REVISION=$RELEASE_REVISION
ENV RELEASE_BUILT_AT=$RELEASE_BUILT_AT

COPY deploy/frontend-server.mjs ./frontend-server.mjs
COPY --from=builder /app/dist ./dist

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 80) + '/').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "frontend-server.mjs"]
