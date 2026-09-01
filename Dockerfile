FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

# THE IMAGE KNOWS ITS OWN COMMIT. attribution.ts reports
# `commit: null, commit_source: 'unstamped-build'` when this is absent —
# honest, and useless for attributing a session's findings to a tree. The
# S-6 baseline capture (`/api/economy/guards` → session-baseline.json)
# exists to make every finding traceable to a known state; without this the
# baseline records a fingerprint and no commit. Passed by the publish
# workflow as github.sha; empty on a local build, which then says so rather
# than guessing.
ARG SEA_DOG_BUILD_SHA=""
ENV SEA_DOG_BUILD_SHA=$SEA_DOG_BUILD_SHA

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs && \
    mkdir -p /app/runtime-data && \
    chown nextjs:nodejs /app/runtime-data

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

CMD ["node", "server.js"]
