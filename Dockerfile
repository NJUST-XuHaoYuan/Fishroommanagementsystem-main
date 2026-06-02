FROM node:22-alpine

WORKDIR /app
ENV HOST=0.0.0.0
ENV PORT=8787
ENV PGHOST=127.0.0.1
ENV PGPORT=5432

RUN apk add --no-cache postgresql postgresql-client su-exec

COPY package.json ./
RUN npm config set registry https://registry.npmmirror.com \
  && npm install --include=dev --legacy-peer-deps --no-audit --no-fund --loglevel=info

COPY . .
RUN npm run build
RUN chmod +x /app/docker/entrypoint.sh

ENV NODE_ENV=production

EXPOSE 8787 5432
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8787) + '/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["/app/docker/entrypoint.sh"]
