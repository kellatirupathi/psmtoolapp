FROM node:20-bookworm-slim AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --legacy-peer-deps

FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package*.json ./
COPY tsconfig.json ./tsconfig.json
COPY backend ./backend
RUN npm run build:server

FROM node:20-bookworm-slim AS runtime
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --legacy-peer-deps --omit=dev
COPY --from=build /app/backend/dist ./backend/dist
COPY backend/prompts ./backend/prompts
COPY curriculum.txt ./curriculum.txt
EXPOSE 4000
CMD ["node", "backend/dist/server.js"]

