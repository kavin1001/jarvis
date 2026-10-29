# Build from the repo root: docker build -f backend/Dockerfile .
# Stage 1 builds the web version of the app, which the backend serves at /.
FROM node:22-slim AS web
WORKDIR /app
COPY app/package.json app/package-lock.json ./
RUN npm ci
COPY app ./
RUN EXPO_OFFLINE=1 npx expo export --platform web --output-dir /web

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev
COPY backend/schema.sql backend/tsconfig.json ./
COPY backend/src ./src
COPY backend/scripts ./scripts
COPY --from=web /web ./public
EXPOSE 8787
USER node
CMD ["npx", "tsx", "src/index.ts"]
