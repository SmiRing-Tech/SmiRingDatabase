# ---------------------------------------
# 1. ビルドステージ
# ---------------------------------------
FROM node:22-slim AS builder

WORKDIR /app

# モデルダウンロード等で必要なツールをインストール（必要に応じて）
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# 🌟 重要なポイント: AIモデルをビルド時にダウンロードしておく
# cacheディレクトリを指定して、そこをプロダクション環境にコピーします
ENV TRANSFORMERS_CACHE=/app/.cache
RUN mkdir -p /app/.cache && node -e "const { pipeline, env } = require('@xenova/transformers'); env.cacheDir = '/app/.cache'; (async () => { console.log('🤖 モデルをダウンロード中...'); await pipeline('feature-extraction', 'Xenova/multilingual-e5-small'); console.log('✅ ダウンロード完了！'); })();"
# ---------------------------------------
# 2. 実行ステージ
# ---------------------------------------
FROM node:22-slim

WORKDIR /app

# 実行に不要なものは含めず、最小限のパッケージだけインストール
COPY package*.json ./
RUN npm ci --omit=dev

# ビルド成果物とAIモデルをコピー
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/.cache ./.cache

# 環境変数の設定
ENV PORT=8080
ENV NODE_ENV=production
ENV TRANSFORMERS_CACHE=/app/.cache

EXPOSE 8080

# Cloud Run では 0.0.0.0 で待機する必要があります
CMD ["node", "dist/index.js"]
