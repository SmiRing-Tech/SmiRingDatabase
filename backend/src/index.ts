import * as dotenv from 'dotenv';
dotenv.config();
import express, { Request, Response } from 'express';
import cors from 'cors';

import profileRoutes from './routes/profileRoutes';
import formRoutes from './routes/formRoutes';
import aiRoutes from './routes/aiRoutes';
import storageRoutes from './routes/storageRoutes';
import authRoutes from './routes/authRoutes';

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

// ==========================================
// サーバー起動
// ==========================================
app.listen(port, () => {
  console.log(`🚀 サーバーが起動しました: ${port}`);
});