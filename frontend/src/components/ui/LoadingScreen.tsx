import { Loader2, WifiOff } from 'lucide-react';

/**
 * セッション・権限の読み込み中に表示する全画面ローディング
 */
export default function LoadingScreen({ message = '読み込んでいます...' }: { message?: string }) {
  return (
    <div
      className="fixed inset-0 flex flex-col items-center justify-center gap-4"
      style={{ background: 'radial-gradient(ellipse at 50% 45%, #dbeafe 0%, #eff6ff 40%, #ffffff 75%)' }}
    >
      <Loader2 className="w-8 h-8 text-blue-500 animate-spin" />
      <p className="text-sm font-bold text-gray-400">{message}</p>
    </div>
  );
}

/**
 * 権限情報の取得に失敗したときの画面。
 * ここでリダイレクトしてしまうと本来のページを見失うので、再試行を促すだけにする。
 */
export function AuthErrorScreen({ onRetry }: { onRetry: () => void }) {
  return (
    <div
      className="fixed inset-0 flex flex-col items-center justify-center gap-5 px-6 text-center"
      style={{ background: 'radial-gradient(ellipse at 50% 45%, #dbeafe 0%, #eff6ff 40%, #ffffff 75%)' }}
    >
      <div className="w-14 h-14 rounded-2xl bg-white shadow-lg flex items-center justify-center">
        <WifiOff className="w-6 h-6 text-blue-500" />
      </div>
      <div className="space-y-1">
        <p className="text-base font-bold text-gray-700">アカウント情報を取得できませんでした</p>
        <p className="text-sm text-gray-400">通信環境を確認してからもう一度お試しください。</p>
      </div>
      <button
        onClick={onRetry}
        className="px-6 py-3 bg-blue-600 text-white text-sm font-bold rounded-2xl shadow-lg shadow-blue-200 hover:bg-blue-700 transition-all"
      >
        再試行する
      </button>
    </div>
  );
}
