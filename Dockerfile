# Сборка и запуск сайта (site/) для Railway. Порт — 8080.
FROM node:24-alpine AS deps
WORKDIR /app
COPY site/package.json site/package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM node:24-alpine AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY site/ ./
RUN npm run build

FROM node:24-alpine AS run
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=8080 \
    HOSTNAME=0.0.0.0
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
COPY --from=build /app/content ./content
EXPOSE 8080
CMD ["node", "server.js"]
