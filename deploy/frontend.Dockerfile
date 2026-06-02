FROM node:22-alpine AS builder

WORKDIR /app

COPY package.json ./
RUN npm config set registry https://registry.npmmirror.com \
  && npm install --include=dev --legacy-peer-deps --no-audit --no-fund --loglevel=info

COPY . .
RUN npm run build

FROM node:22-alpine

WORKDIR /app

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=80
ENV BACKEND_URL=http://backend:8787

COPY deploy/frontend-server.mjs ./frontend-server.mjs
COPY --from=builder /app/dist ./dist

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 80) + '/').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "frontend-server.mjs"]
