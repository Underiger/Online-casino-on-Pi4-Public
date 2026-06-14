# syntax=docker/dockerfile:1
# ============================================================
# backend Dockerfile — node:20-alpine 多階段（arm64 相容，目標 Pi 4）
# build context 必須是 repo 根目錄（npm workspaces 需要 root package.json）：
#   開發：  docker build -f backend/Dockerfile --target dev     -t casino-backend:dev .
#   生產：  docker build -f backend/Dockerfile --target runtime -t casino-backend .
# node:20-alpine 官方映像為 multi-arch（amd64 / arm64），Pi 4 直接可用。
# ============================================================

# ---------- 1. deps：安裝 workspace 全部依賴 ----------
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
COPY backend/package.json backend/
COPY packages/shared/package.json packages/shared/
RUN npm install

# ---------- 2. dev：熱重載開發（tsx watch；原始碼由 compose volume 掛載覆蓋） ----------
FROM deps AS dev
ENV NODE_ENV=development
COPY packages/shared packages/shared
COPY backend backend
EXPOSE 3000
CMD ["npm", "run", "dev", "--workspace=backend"]

# ---------- 3. build：編譯 TypeScript 並裁剪 dev 依賴 ----------
FROM deps AS build
COPY packages/shared packages/shared
COPY backend backend
RUN npm run build --workspace=backend \
  && npm prune --omit=dev

# ---------- 4. runtime：最小生產映像（非 root 使用者） ----------
FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/shared ./packages/shared
COPY --from=build /app/backend/package.json ./backend/
COPY --from=build /app/backend/dist ./backend/dist
USER node
EXPOSE 3000
CMD ["node", "backend/dist/cluster.js"]
