"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const dotenv = __importStar(require("dotenv"));
dotenv.config();
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const ai_1 = require("./lib/ai");
const profileRoutes_1 = __importDefault(require("./routes/profileRoutes"));
const formRoutes_1 = __importDefault(require("./routes/formRoutes"));
const aiRoutes_1 = __importDefault(require("./routes/aiRoutes"));
const storageRoutes_1 = __importDefault(require("./routes/storageRoutes"));
const authRoutes_1 = __importDefault(require("./routes/authRoutes"));
const workerRoutes_1 = __importDefault(require("./routes/workerRoutes"));
const managementRoutes_1 = __importDefault(require("./routes/managementRoutes"));
const connectRoutes_1 = __importDefault(require("./routes/connectRoutes"));
const app = (0, express_1.default)();
const port = process.env.PORT || 3000;
// ミドルウェアの設定
app.use((0, cors_1.default)()); // Reactからの通信を許可
app.use(express_1.default.json({ limit: '50mb' }));
app.use(express_1.default.urlencoded({ limit: '50mb', extended: true }));
// ==========================================
// 疎通確認用のルート
// ==========================================
app.get('/', (_req, res) => {
    res.send('SmiRing Backend API is running!');
});
// ==========================================
// ルートの登録
// ==========================================
app.use(profileRoutes_1.default); // 👤 プロフィール系
app.use(formRoutes_1.default); // 📖 フォーム系
app.use(aiRoutes_1.default); // 🧠 AI系
app.use(storageRoutes_1.default); // ☁️ ストレージ（R2）系
app.use(authRoutes_1.default); // 🔐 認証系
app.use(workerRoutes_1.default); // 🤖 ワーカー系
app.use('/api/management', managementRoutes_1.default); // ⚙️ 管理・設定系
app.use(connectRoutes_1.default); // 🎥 SmiRing Connect (video calls)
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
    (0, ai_1.initAIModel)().catch(() => {
        // エラーは initAIModel 内でログ済み。次回 getLocalEmbedding 呼び出し時に再試行される。
    });
}
startServer();
