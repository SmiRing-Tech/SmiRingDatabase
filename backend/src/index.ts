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

const app = express();
const port = process.env.PORT || 3000;

// ミドルウェアの設定
app.use(cors()); // Reactからの通信を許可
app.use(express.json({ limit: '50mb' }));
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
app.use('/api/management', managementRoutes); // ⚙️ 管理・設定系
app.use(connectRoutes); // 🎥 SmiRing Connect (video calls)

// ==========================================
// サーバー起動
// ==========================================
async function startServer() {
  try {
    console.log('サーバーの起動準備中...');
    
    // 🌟 3. リクエストを受け付ける前に、AIモデルを確実にロードする
    await initAIModel();

    // 🌟 4. AIの準備が完了したら、はじめてポートを開放する
    app.listen(port, () => {
      console.log(`🚀 サーバーが起動しました: ${port}`);
    });
  } catch (error) {
    console.error('❌ サーバー起動エラー:', error);
    process.exit(1); // エラーが起きたらプロセスを終了させる
  }
}

startServer();