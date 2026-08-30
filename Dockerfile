# syntax=docker/dockerfile:1

# ---- build stage -----------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

RUN npm prune --omit=dev

# ---- runtime stage --------------------------------------------------------
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

# dumb-init gives us correct signal forwarding for graceful shutdown.
RUN apk add --no-cache dumb-init

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
COPY migrations ./migrations

USER node
EXPOSE 3000

ENTRYPOINT ["dumb-init", "--"]
# Overridden per service in docker-compose (scheduler / worker / watchdog).
CMD ["node", "dist/server.js"]
