# =============================================================
# Stage 1: builder
# Instala TODAS las deps, compila shared + api + web
# =============================================================
FROM node:24-alpine AS builder

RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

WORKDIR /app

# Solo manifests primero (caché de layers)
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/

# Install full deps (incluye devDeps para poder compilar)
RUN pnpm install --frozen-lockfile

# Copiar código fuente
COPY packages/shared ./packages/shared
COPY apps/api ./apps/api
COPY apps/web ./apps/web
COPY tsconfig.base.json ./

# Compilar en orden: shared → api → web
RUN pnpm --filter @actions-self-hosted/shared build && \
    pnpm --filter @actions-self-hosted/api build && \
    pnpm --filter @actions-self-hosted/web build

# =============================================================
# Stage 2: runtime
# Solo prod deps + artefactos compilados
# =============================================================
FROM node:24-alpine AS runtime

RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

WORKDIR /app

ENV NODE_ENV=production

# Re-install con lockfile, pero solo deps de prod
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/api/package.json ./apps/api/
RUN pnpm install --frozen-lockfile --prod --filter @actions-self-hosted/api...

# Copiar artefactos compilados desde builder
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/packages/shared/package.json ./packages/shared/
COPY --from=builder /app/apps/api/dist ./apps/api/dist
COPY --from=builder /app/apps/api/package.json ./apps/api/
COPY --from=builder /app/apps/web/dist ./apps/web/dist

# Directorio de datos (SQLite) y config
RUN mkdir -p /app/data
VOLUME ["/app/data"]

EXPOSE 3000

WORKDIR /app/apps/api

# Healthcheck
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/api/health || exit 1

CMD ["node", "dist/server.js"]
