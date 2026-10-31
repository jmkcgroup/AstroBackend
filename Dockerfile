# AstroVeda API: production image for Dokploy (Build Type: Dockerfile).
# Runtime env (DATABASE_URL, JWT secrets, FRONTEND_URL, ...) is set in Dokploy, not here.

FROM node:24-bookworm-slim AS build
WORKDIR /app

# python3/make/g++ compile the native sweph (Swiss Ephemeris) and better-sqlite3 modules.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# `npm ci` runs postinstall -> prisma generate, which picks the schema from DATABASE_URL.
# A placeholder PostgreSQL URL makes it generate the PostgreSQL client; nothing connects to it.
ENV DATABASE_URL="postgresql://build:build@localhost:5432/build?schema=public"

COPY package.json package-lock.json prisma.config.ts ./
COPY prisma ./prisma
COPY scripts ./scripts
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build


FROM node:24-bookworm-slim AS runtime
WORKDIR /app

# openssl is needed by the Prisma CLI for `prisma migrate deploy`.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PORT=4000 \
    SWISSEPH_EPHE_PATH=/app/ephe \
    STORAGE_DIR=/app/storage

# Dev dependencies are kept on purpose: tsx is needed to run the one-off seed (prisma/seed.ts).
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/src ./src
COPY --from=build --chown=node:node /app/prisma ./prisma
COPY --from=build --chown=node:node /app/scripts ./scripts
COPY --chown=node:node package.json package-lock.json prisma.config.ts tsconfig.json ./
COPY --chown=node:node ephe ./ephe

# Generated report PDFs; mount a Dokploy volume here so they survive redeploys.
RUN mkdir -p /app/storage && chown node:node /app/storage

USER node
EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Apply pending migrations, then start the API.
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/server.js"]
