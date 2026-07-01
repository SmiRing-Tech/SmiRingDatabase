import { createBrowserRouter, RouterProvider, Navigate, useLocation } from 'react-router-dom';
import { useEffect } from 'react';
import type { PermissionAction } from './context/AuthContext';

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
import FeedbackPage from './pages/Form/Answer/FeedbackPage';
import FormResponseDetailPage from './pages/Form/Response/FormResponseDetailPage';
import SearchPage from './pages/Search/SearchPage';
import ChatPage from './pages/Search/ChatPage';
import AppsPage from './pages/Apps/AppsPage';
import ManagementConsolePage from './pages/Management/ManagementConsolePage';
import { FeedbackProvider } from './context/FeedbackContext';
import FeedbackSystem from './components/ui/FeedbackSystem';
import { AuthProvider, useAuth } from './context/AuthContext';
import { apiClient } from './lib/apiClient';

// ==========================================
// ログイン判定ガード (Flutterの redirect 処理に相当)
// ==========================================
const ProtectedRoute = ({ children }: { children: React.ReactNode }) => {
  const { session, isLoading } = useAuth();
  const location = useLocation();

  // タイムゾーン同期ロジック (セッションがある時だけ動かす)
  useEffect(() => {
    if (session) {
      const syncTimezone = async () => {
        try {
          const browserTZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
          
          // apiClient を使って自動認証＆エラー復旧
          const response = await apiClient.get('/api/basic_profile_info/me');
          
          if (response.ok) {
            const profile = await response.json();
            if (profile.timezone !== browserTZ) {
              await apiClient.patch('/api/basic_profile_info/me', { timezone: browserTZ });
              console.log(`[Timezone Sync] Updated to ${browserTZ}`);
            }
          }
        } catch (error) {
          console.warn('[Timezone Sync] Failed:', error);
        }
      };
      
      const timer = setTimeout(syncTimezone, 2000);
      return () => clearTimeout(timer);
    }
  }, [session]);

  // ロード中は何も出さない
  if (isLoading) return null; 

  // 未ログインならWelcome画面へ (元のパスを state に引き渡す)
  if (!session) {
    return <Navigate to="/" state={{ from: location }} replace />;
  }

  return <>{children}</>;
};

// ==========================================
// 権限ベースのルートガード
// 外側の ProtectedRoute（セッションチェック）の内側で使う想定
// ==========================================
const RequirePermission = ({
  resource,
  action,
  children,
}: {
  resource: string;
  action: PermissionAction;
  children: React.ReactNode;
}) => {
  const { hasPermission, isPermissionsLoading, isLoading } = useAuth();

  if (isLoading || isPermissionsLoading) return null;
  if (!hasPermission(resource, action)) return <Navigate to="/home" replace />;

  return <>{children}</>;
};

// ==========================================
// ロールベースのルートガード（内部メンバー専用）
// ==========================================
const RequireInternalRole = ({ children }: { children: React.ReactNode }) => {
  const { roles, isPermissionsLoading, isLoading } = useAuth();

  if (isLoading || isPermissionsLoading) return null;

  const hasInternalAccess = roles.some(r =>
    ['smiring_member', 'admin', 'smiring_core'].includes(r)
  );

  if (!hasInternalAccess) {
    return <Navigate to="/profile" replace />;
  }

  return <>{children}</>;
};

// ==========================================
// ルーターの設定 (Flutter前のに相当)
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
      { path: '/home', element: <RequireInternalRole><HomePage /></RequireInternalRole> },
      { path: '/profile', element: <ProfilePage /> },
      { path: '/members', element: <RequireInternalRole><MembersPage /></RequireInternalRole> },
      { path: '/members/:id', element: <ProfilePage /> },
      { path: '/gallery', element: <RequireInternalRole><GalleryPage /></RequireInternalRole> },
      { path: '/form-list', element: <RequireInternalRole><FormListPage /></RequireInternalRole> },
      { path: '/form-editor/:id', element: <RequireInternalRole><FormEditorPage /></RequireInternalRole> },
      { path: '/form-preview/:id', element: <RequireInternalRole><FormAnswerPage /></RequireInternalRole> },
      { path: '/form-answer/:id', element: <FormAnswerPage /> },
      { path: '/feedback', element: <FeedbackPage /> },
      { path: '/form-responses/:responseId', element: <RequireInternalRole><FormResponseDetailPage /></RequireInternalRole> },
      { path: '/search', element: <RequireInternalRole><SearchPage /></RequireInternalRole> },
      { path: '/search/chat', element: <RequireInternalRole><ChatPage /></RequireInternalRole> },
      { path: '/apps', element: <RequireInternalRole><AppsPage /></RequireInternalRole> },
      { path: '/management', element: (
        <RequireInternalRole>
          <RequirePermission resource="management" action="read">
            <ManagementConsolePage />
          </RequirePermission>
        </RequireInternalRole>
      ) },
    ],
  },
]);

// アプリの起点
export default function App() {
  return (
    <AuthProvider>
      <FeedbackProvider>
        <FeedbackSystem />
        <RouterProvider router={router} />
      </FeedbackProvider>
    </AuthProvider>
  );
}