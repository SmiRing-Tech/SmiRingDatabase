# ベースとなる環境（Node.js 20の軽量版）
FROM node:20-slim

# コンテナ内の作業ディレクトリを指定
WORKDIR /app

# パッケージの定義ファイルを先にコピーしてインストール（キャッシュを効かせるため）
COPY package*.json ./
RUN npm install

# プロジェクトの全ファイルをコピー
COPY . .

# TypeScriptを使っている場合、ここでビルドを実行（ビルドコマンドに合わせてください）
RUN npm run build

# Cloud Runが通信に使うポート（8080）を指定
ENV PORT 8080
EXPOSE 8080

# アプリの起動コマンド（ビルド後のJSファイルを実行するか、npm start）
CMD ["npm", "start"]