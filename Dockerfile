# ──────────────────────────────────────────────
# Marinara Engine — Multi-stage Docker Build
# ──────────────────────────────────────────────

# ── Stage 1: Build ──
FROM node:20-slim AS builder
ARG PNPM_VERSION=9.15.0
WORKDIR /app

# Enable corepack for pnpm
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate

# Copy workspace config first (layer cache for deps)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/client/package.json packages/client/

# Install all dependencies (including dev for building)
RUN pnpm install --frozen-lockfile

# Copy source code
COPY tsconfig.base.json ./
COPY packages/shared/ packages/shared/
COPY packages/server/ packages/server/
COPY packages/client/ packages/client/

# Build everything: shared → server + client in parallel
RUN pnpm build

# ── Stage 2: Production ──
FROM node:20-slim AS production
ARG PNPM_VERSION=9.15.0
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate

# Copy workspace config
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/client/package.json packages/client/

# Install production deps only
RUN pnpm install --frozen-lockfile --prod

# Copy built artifacts from builder
COPY --from=builder /app/packages/shared/dist packages/shared/dist
COPY --from=builder /app/packages/server/dist packages/server/dist
COPY --from=builder /app/packages/client/dist packages/client/dist

# Ensure /app/data exists for runtime use (fonts, default backgrounds, db, uploads)
RUN mkdir -p /app/data

# Point the server at /app/data regardless of working directory
ENV DATA_DIR=/app/data

# The SQLite database + user uploads live in /app/data at runtime.
# Mount a volume here for persistence.
VOLUME /app/data

# Default port
ENV PORT=7860
ENV HOST=0.0.0.0
ENV NODE_ENV=production
EXPOSE 7860

# Run the server (serves both API and client SPA)
CMD ["node", "packages/server/dist/index.js"]
