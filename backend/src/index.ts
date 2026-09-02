import * as dotenv from 'dotenv';
dotenv.config();
import express, { Request, Response } from 'express';
import cors from 'cors';
import { initAIModel } from './lib/ai';

import profileRoutes from './routes/profileRoutes';
import formRoutes from './routes/formRoutes';
import aiRoutes from './routes/aiRoutes';
import storageRoutes from './routes/storageRoutes';
import authRoutes from './routes/authRoutes';
import workerRoutes from './routes/workerRoutes';
import managementRoutes from './routes/managementRoutes';
import connectRoutes from './routes/connectRoutes';
import eventRoutes from './routes/eventRoutes';
import roleRequestRoutes from './routes/roleRequestRoutes';
import maintenanceRoutes from './routes/maintenanceRoutes';

const app = express();
const port = process.env.PORT || 3000;

// ミドルウェアの設定
app.use(cors()); // Reactからの通信を許可
app.use(express.json({
  limit: '50mb',
  // Keep the exact raw bytes around so the LiveKit webhook handler can verify
  // its HMAC signature (the signature is computed over the raw body, not the
  // re-serialized JSON, which is not guaranteed to be byte-identical).
  verify: (req: Request, _res, buf) => {
    req.rawBody = buf;
  },
}));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// ==========================================
// 疎通確認用のルート
// ==========================================
app.get('/', (_req: Request, res: Response) => {
  res.send('SmiRing Backend API is running!');
});

// ==========================================
// ルートの登録
// ==========================================
app.use(profileRoutes); // 👤 プロフィール系
app.use(formRoutes);    // 📖 フォーム系
app.use(aiRoutes);      // 🧠 AI系
app.use(storageRoutes); // ☁️ ストレージ（R2）系
app.use(authRoutes);    // 🔐 認証系
app.use(workerRoutes);  // 🤖 ワーカー系
app.use(maintenanceRoutes); // ⏰ Cloud Scheduler からの定期ポーリング
app.use('/api/management', managementRoutes); // ⚙️ 管理・設定系
app.use(connectRoutes); // 🎥 SmiRing Connect (video calls)
app.use(eventRoutes);   // 📅 イベント系
app.use(roleRequestRoutes); // 📝 メンバー申請系

// ==========================================
// サーバー起動
// ==========================================
function startServer() {
  console.log('サーバーの起動準備中...');

  // 🌟 3. ポートは即座に開放し、起動プローブ（コールドスタート判定）をブロックしない
  app.listen(port, () => {
    console.log(`🚀 サーバーが起動しました: ${port}`);
  });

  // 🌟 4. AIモデルはバックグラウンドでロードを開始する。
  //    データ表示系のリクエストはこれを待たずに処理できる。
  //    検索など getLocalEmbedding を呼ぶリクエストだけ、ロード中ならその完了を待つ。
  initAIModel().catch(() => {
    // エラーは initAIModel 内でログ済み。次回 getLocalEmbedding 呼び出し時に再試行される。
  });
}

startServer();