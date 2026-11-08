# One image per app, identical on every cloud.
# Build:  docker build -t app .
# Run:    docker run -p 3000:3000 --env-file .env app

FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm build

# One-off migration job: same source, full dependencies.
#   docker build --target migrate -t app-migrate . && docker run --env DATABASE_URL=... app-migrate
FROM build AS migrate
CMD ["pnpm", "db:migrate"]

# Web server: only the standalone bundle, run as a non-root user.
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
RUN addgroup -S app && adduser -S app -G app
COPY --from=build --chown=app:app /app/.next/standalone ./
COPY --from=build --chown=app:app /app/.next/static ./.next/static
COPY --from=build --chown=app:app /app/public ./public
# Migrations, applied at startup when MIGRATE_ON_START=true (see src/instrumentation.ts).
COPY --from=build --chown=app:app /app/drizzle ./drizzle
# AWS Lambda Web Adapter: lets this same image run on Lambda. It's an extension that
# only activates inside Lambda; on every other platform it is inert.
COPY --from=public.ecr.aws/awsguru/aws-lambda-adapter:0.9.1 /lambda-adapter /opt/extensions/lambda-adapter
USER app
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD wget -qO- "http://127.0.0.1:${PORT}/api/health" >/dev/null || exit 1
CMD ["node", "server.js"]
