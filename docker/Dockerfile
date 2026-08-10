# docker/Dockerfile
# Multi-stage production build for Next.js application

# --- Base stage ---
# The Node major lives in .nvmrc, which CI reads directly (actions/setup-node's
# `node-version-file`) and which nvm/fnm/asdf read locally. Docker CANNOT read a
# file in a FROM line, so this ARG default is an unavoidable restatement of it.
# __tests__/lint/node-version-alignment.test.ts fails if the two ever diverge --
# see register row D-192 for why three unaligned numbers described one app.
# One-off override: `docker build --build-arg NODE_VERSION=<major> ...`
ARG NODE_VERSION=22
FROM node:${NODE_VERSION}-alpine AS base

# --- Dependencies stage ---
FROM base AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production

# --- Builder stage ---
FROM base AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npx prisma generate
RUN npm run build

# --- Runner stage (production) ---
FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma

USER nextjs

EXPOSE 3000

CMD ["node", "server.js"]
