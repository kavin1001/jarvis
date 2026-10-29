FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY schema.sql tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
EXPOSE 8787
USER node
CMD ["npx", "tsx", "src/index.ts"]
