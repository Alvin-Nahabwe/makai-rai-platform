# docker/Dockerfile
# Multi-stage production build for Next.js application

# --- Base stage ---
# The Node major lives in .nvmrc, which CI reads directly (actions/setup-node's
# `node-version-file`) and which nvm/fnm/asdf read locally. Docker CANNOT read a
# file in a FROM line, so the major in this FROM is an unavoidable restatement of it.
# __tests__/lint/node-version-alignment.test.ts fails if the two ever diverge --
# see register row D-192 for why three unaligned numbers described one app.
# The image is pinned by its multi-platform index digest (RL 7.7), and the tag is
# a literal so Dependabot can read and bump it. To move the pin, read the digest
# with `docker buildx imagetools inspect node:<major>-alpine`.
# __tests__/lint/compose-image-pins.test.ts fails if the digest goes missing.
FROM node:22-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914 AS base

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

# --- Migrator stage ---
# `prisma` and `tsx` are devDependencies, and the runner stage below ships
# neither: it copies `.next/standalone` (whose dependency trace holds only what
# the APP imports) plus the generated client at `node_modules/.prisma`. So
# `docker exec <container> npx prisma migrate deploy` -- what
# `docs/runbooks/deployment.md` instructed for months -- cannot work against any
# image this file builds. `npx` would try to fetch the CLI over the network at
# run time, as the unprivileged `nextjs` user, pulling an unpinned version into
# production. That is finding DEP-05 of the 2026-08-17 platform audit.
#
# Rather than fatten the long-lived serving image with a CLI it must never need
# while serving, the migration tooling gets its own short-lived image. `builder`
# already carries full node_modules, the schema, the migrations and a generated
# client, so this stage adds only a default command.
#
# Deliberately placed BEFORE `runner` so that a plain `docker build` with no
# `--target` still produces the serving image, not this one. In compose it sits
# behind the `tools` profile, so `up` never starts it -- see
# docker/docker-compose.prod.yml.
FROM builder AS migrator
WORKDIR /app
CMD ["npx", "prisma", "migrate", "deploy"]

# --- Runner stage (production) ---
FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production

# Listen on every interface. The standalone `server.js` binds to $HOSTNAME
# (node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/output.md),
# and Docker sets HOSTNAME to the container id, which resolves to the container's bridge
# address and not to loopback. Without this line nothing answers on 127.0.0.1:3000 inside
# the container, so the healthcheck in docker/docker-compose.prod.yml (which runs there,
# bypassing nginx) can never pass. D-236. An ENV here replaces the runtime default.
# __tests__/unit/health-route.test.ts holds this to the runner stage.
ENV HOSTNAME=0.0.0.0

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
