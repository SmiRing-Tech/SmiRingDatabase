# ---------------------------------------
# 1. ビルドステージ
# ---------------------------------------
FROM node:22-slim AS builder

WORKDIR /app

# モデルダウンロード等で必要なツールをインストール（必要に応じて）
RUN apt-get update && apt-get install -y python3 make g++ curl && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# 🌟 重要なポイント: AIモデルは Hugging Face から直接取得せず、
# 自前の GCS バケット（事前にミラーしておいたもの）から取得する。
# Hugging Face の CDN が Cloud Build の IP をボット判定して 403 を返すことがあり、
# ビルドが不安定になっていたための対策。
ENV TRANSFORMERS_CACHE=/app/.cache
RUN MODEL_BASE_URL=https://storage.googleapis.com/smiringdatabase-model-cache/model-cache/Xenova/multilingual-e5-small && \
    mkdir -p /app/.cache/Xenova/multilingual-e5-small/onnx && \
    curl -fSL "$MODEL_BASE_URL/config.json" -o /app/.cache/Xenova/multilingual-e5-small/config.json && \
    curl -fSL "$MODEL_BASE_URL/tokenizer.json" -o /app/.cache/Xenova/multilingual-e5-small/tokenizer.json && \
    curl -fSL "$MODEL_BASE_URL/tokenizer_config.json" -o /app/.cache/Xenova/multilingual-e5-small/tokenizer_config.json && \
    curl -fSL "$MODEL_BASE_URL/onnx/model_quantized.onnx" -o /app/.cache/Xenova/multilingual-e5-small/onnx/model_quantized.onnx
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
