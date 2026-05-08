import { createBrowserRouter, RouterProvider, Navigate } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { supabase } from './lib/supabase';
import type { Session } from '@supabase/supabase-js';
import { API_BASE_URL } from './config';

// ページのインポート
import SignInPage from './pages/SignIn/SignInPage';
import SignUpPage from './pages/SignIn/SignUpPage';
import ForgotPasswordPage from './pages/SignIn/ForgotPasswordPage';
import ResetPasswordPage from './pages/SignIn/ResetPasswordPage';
import HomePage from './pages/Home/HomePage';
import MainLayout from './components/layout/MainLayout';
import WelcomePage from './pages/Welcome/WelcomePage';
import ProfilePage from './pages/Profile/ProfilePage';
import MembersPage from './pages/Members/MembersPage';
import GalleryPage from './pages/Gallery/GalleryPage';
import FormEditorPage from './pages/Form/FormEditor/FormEditorPage';
import FormListPage from './pages/Form/FormList/FormListPage';
import FormAnswerPage from './pages/Form/Answer/FormAnswerPage';
import FormResponseDetailPage from './pages/Form/Response/FormResponseDetailPage';
import SearchPage from './pages/Search/SearchPage';

// ==========================================
// ログイン判定ガード (Flutterの redirect 処理に相当)
// ==========================================
const ProtectedRoute = ({ children }: { children: React.ReactNode }) => {
  const [session, setSession] = useState<Session | null | undefined>(undefined);

  useEffect(() => {
    // 1. 現在のログイン状態を一度チェック
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
    });

    // 2. 状態変化（ログイン・ログアウト）をリアルタイムで監視
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
    });

    return () => subscription.unsubscribe();
  }, []);

  // タイムゾーン同期ロジック
  useEffect(() => {
    if (session) {
      const syncTimezone = async () => {
        try {
          const browserTZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
          
          // 現在のプロフィールを取得
          const response = await fetch(`${API_BASE_URL}/api/basic_profile_info/me`, {
            headers: { 'Authorization': `Bearer ${session.access_token}` }
          });
          
          if (response.ok) {
            const profile = await response.json();
            // 不一致の場合のみバックグラウンドで更新
            if (profile.timezone !== browserTZ) {
              await fetch(`${API_BASE_URL}/api/basic_profile_info/me`, {
                method: 'PATCH',
                headers: { 
                  'Authorization': `Bearer ${session.access_token}`,
                  'Content-Type': 'application/json'
                },
                body: JSON.stringify({ timezone: browserTZ })
              });
              console.log(`[Timezone Sync] Updated to ${browserTZ}`);
            }
          }
        } catch (error) {
          console.warn('[Timezone Sync] Failed:', error);
        }
      };
      
      // ユーザーの邪魔をしないよう少し遅らせて実行
      const timer = setTimeout(syncTimezone, 2000);
      return () => clearTimeout(timer);
    }
  }, [session]);

  // ロード中は何も出さない（またはスプラッシュ画面）
  if (session === undefined) return null; 

  // 未ログインならログイン画面へ
  if (session === null) {
    return <Navigate to="/sign-in" replace />;
  }

  return <>{children}</>;
};

// ==========================================
// ルーターの設定 (Flutterの routes リストに相当)
// ==========================================
const router = createBrowserRouter([
  // 1. 公開ルート
  { path: '/', element: <WelcomePage /> },
  { path: '/sign-in', element: <SignInPage /> },
  { path: '/sign-up', element: <SignUpPage /> },
  { path: '/forgot-password', element: <ForgotPasswordPage /> },
  { path: '/reset-password', element: <ResetPasswordPage /> },

  // 2. ログイン必須ルート (MainLayoutで囲む = ShellRoute相当)
  {
    element: (
      <ProtectedRoute>
        <MainLayout />
      </ProtectedRoute>
    ),
    children: [
      { path: '/home', element: <HomePage /> },
      { path: '/profile', element: <ProfilePage /> },
      { path: '/members', element: <MembersPage /> },
      { path: '/members/:id', element: <ProfilePage /> },
      { path: '/gallery', element: <GalleryPage /> },
      { path: '/form-list', element: <FormListPage /> },
      { path: '/form-editor/:id', element: <FormEditorPage /> },
      { path: '/form-preview/:id', element: <FormAnswerPage /> },
      { path: '/form-answer/:id', element: <FormAnswerPage /> },
      { path: '/form-responses/:responseId', element: <FormResponseDetailPage /> },
      { path: '/search', element: <SearchPage /> },
    ],
  },
]);

// アプリの起点
export default function App() {
  return <RouterProvider router={router} />;
}