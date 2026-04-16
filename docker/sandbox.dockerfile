# syntax=docker/dockerfile:1.6

# ─── builder: install deps & compile TypeScript ─────────────────────────────
FROM node:22-bookworm-slim AS builder
WORKDIR /app
# Native build tools needed for better-sqlite3 / isolated-vm
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package*.json tsconfig.json ./
RUN npm ci
COPY src ./src
COPY scripts ./scripts
COPY skills ./skills
COPY public ./public
RUN npm run build

# ─── runtime: minimal image with compiled JS + prod deps ────────────────────
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends \
      tini ca-certificates && rm -rf /var/lib/apt/lists/* \
 && groupadd --system --gid 1001 app \
 && useradd  --system --uid 1001 --gid app --home /app app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/skills ./skills
COPY --from=builder /app/public ./public
# scripts/ source is NOT copied — the backup endpoint spawns dist/scripts/backup.js
# Writable data locations
RUN mkdir -p data logs config uploads output sessions backups \
 && chown -R app:app /app
USER app
EXPOSE 3000
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/src/Gateway.js"]
