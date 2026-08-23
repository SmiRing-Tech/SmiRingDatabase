import React, { useState } from 'react';
import { useFeedback } from '../../context/FeedbackContext';
import { supabase } from '../../lib/supabase';
import { useNavigate, useLocation } from 'react-router-dom';
import { Eye, EyeOff, Mail, Lock, ArrowRight, Loader2 } from 'lucide-react';
import AuthLayout from './AuthLayout';

import { useAuth } from '../../context/AuthContext';
import { isInternalUser, getDefaultPathForUser } from '../../hooks/useIsInternal';
import GoogleIcon from '../../components/ui/GoogleIcon';
import { PENDING_USERNAME_KEY } from './pendingUsername';

export default function SignInPage() {
  const { showFeedback } = useFeedback();
  const { fetchUserPermissions, session, isLoading: isAuthLoading } = useAuth();
  const [email, setEmail] = useState(() => localStorage.getItem('saved_email') ?? '');
  const [password, setPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isGoogleLoading, setIsGoogleLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();

  // OAuthなどでログイン済みセッションが取得できた場合、ロールに応じた画面へ自動遷移
  React.useEffect(() => {
    if (session?.user?.id && !isAuthLoading) {
      (async () => {
        // Google新規登録直後なら、遷移前に一時保存しておいたユーザー名を display_name として反映する
        const pendingUsername = localStorage.getItem(PENDING_USERNAME_KEY);
        if (pendingUsername) {
          localStorage.removeItem(PENDING_USERNAME_KEY);
          try {
            await supabase.auth.updateUser({ data: { display_name: pendingUsername } });
          } catch (err) {
            console.warn('[SignIn] Failed to apply pending username:', err);
          }
        }

        let isInternal = false;
        try {
          const permsResult = await fetchUserPermissions(session.user.id);
          isInternal = isInternalUser(permsResult.roles, permsResult.roleIds);
        } catch (err) {
          console.warn('[SignIn] Failed to fetch role flags for existing session:', err);
        }
        const from = (location.state as any)?.from;
        let targetPath = from ? `${from.pathname}${from.search || ''}${from.hash || ''}` : '';
        if (!targetPath || targetPath === '/') {
          targetPath = getDefaultPathForUser(isInternal);
        }
        navigate(targetPath, { replace: true });
      })();
    }
  }, [session, isAuthLoading, fetchUserPermissions, navigate, location.state]);

  const handleSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    try {
      const { data, error } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });

      if (error) throw error;

      localStorage.setItem('saved_email', email.trim());

      // ユーザーのロール情報を取得して内部/外部を判定
      let isInternal = false;
      try {
        const permsResult = await fetchUserPermissions(data.user?.id);
        isInternal = isInternalUser(permsResult.roles, permsResult.roleIds);
      } catch (err) {
        console.warn('[SignIn] Failed to fetch role flags:', err);
      }

      const from = (location.state as any)?.from;
      let targetPath = from ? `${from.pathname}${from.search || ''}${from.hash || ''}` : '';
      if (!targetPath || targetPath === '/') {
        targetPath = getDefaultPathForUser(isInternal);
      }

      navigate(targetPath, { replace: true });
    } catch (error: any) {
      showFeedback(`ログインエラー: ${error.message}`, { type: 'error', mode: 'banner' });
    } finally {
      setIsLoading(false);
    }
  };

  const handleGoogleSignIn = async () => {
    setIsGoogleLoading(true);
    try {
      const { error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo: `${window.location.origin}/sign-in`,
        },
      });

      if (error) throw error;
    } catch (error: any) {
      showFeedback(`Googleログインエラー: ${error.message}`, { type: 'error', mode: 'banner' });
      setIsGoogleLoading(false);
    }
  };

  return (
    <AuthLayout variant="signin">
      {/* Mobile title */}
      <div className="md:hidden mb-7">
        <h2 className="text-2xl font-black text-gray-900">おかえりなさい！</h2>
        <p className="text-gray-400 text-sm mt-1">あなたの留学生活を、鮮明に。</p>
      </div>

      <form onSubmit={handleSignIn} className="space-y-4">
        {/* Email */}
        <div className="space-y-1.5">
          <label className="block text-[11px] font-black text-gray-500 uppercase tracking-wider">
            メールアドレス
          </label>
          <div className="relative group">
            <Mail className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-300 group-focus-within:text-blue-500 transition-colors duration-200" />
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              required
              placeholder="you@example.com"
              className="w-full pl-11 pr-4 py-3.5 bg-gray-50 border border-gray-200 rounded-xl text-sm
                         focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-400 focus:bg-white
                         transition-all duration-200 placeholder:text-gray-300"
            />
          </div>
        </div>

        {/* Password */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <label className="block text-[11px] font-black text-gray-500 uppercase tracking-wider">
              パスワード
            </label>
            <button
              type="button"
              onClick={() => navigate('/forgot-password')}
              className="text-[11px] text-sky-500 hover:text-sky-600 font-bold transition-colors"
            >
              パスワードをお忘れですか？
            </button>
          </div>
          <div className="relative group">
            <Lock className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-300 group-focus-within:text-sky-400 transition-colors duration-200" />
            <input
              type={showPassword ? 'text' : 'password'}
              value={password}
              onChange={e => setPassword(e.target.value)}
              required
              placeholder="••••••••"
              className="w-full pl-11 pr-12 py-3.5 bg-gray-50 border border-gray-200 rounded-xl text-sm
                         focus:outline-none focus:ring-2 focus:ring-sky-400/50 focus:border-sky-300 focus:bg-white
                         transition-all duration-200 placeholder:text-gray-300"
            />
            <button
              type="button"
              onClick={() => setShowPassword(!showPassword)}
              className="absolute right-4 top-1/2 -translate-y-1/2 text-gray-300 hover:text-gray-600 transition-colors"
            >
              {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>
        </div>

        {/* Submit button */}
        <button
          type="submit"
          disabled={isLoading || isGoogleLoading}
          className="w-full py-3.5 rounded-xl font-bold text-white text-sm mt-2
                     bg-gradient-to-r from-sky-300 to-sky-500
                     hover:from-sky-400 hover:to-sky-600
                     hover:shadow-lg hover:shadow-sky-100
                     active:scale-[0.99]
                     disabled:opacity-60 disabled:cursor-not-allowed disabled:shadow-none
                     transition-all duration-200 flex items-center justify-center gap-2"
        >
          {isLoading ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              ログイン中...
            </>
          ) : (
            <>
              ログイン
              <ArrowRight className="w-4 h-4" />
            </>
          )}
        </button>
      </form>

      {/* Divider */}
      <div className="flex items-center gap-3 my-5">
        <div className="flex-1 h-px bg-gray-200" />
        <span className="text-[11px] font-medium text-gray-400">または</span>
        <div className="flex-1 h-px bg-gray-200" />
      </div>

      {/* Google Sign In Button */}
      <button
        type="button"
        onClick={handleGoogleSignIn}
        disabled={isLoading || isGoogleLoading}
        className="w-full py-3 px-4 rounded-xl border border-gray-200 bg-white hover:bg-gray-50
                   text-gray-700 font-bold text-sm shadow-sm hover:shadow
                   transition-all duration-200 flex items-center justify-center gap-3
                   disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer"
      >
        {isGoogleLoading ? (
          <>
            <Loader2 className="w-4 h-4 animate-spin text-gray-500" />
            <span>Google認証中...</span>
          </>
        ) : (
          <>
            <GoogleIcon className="w-4 h-4" />
            <span>Googleでログイン</span>
          </>
        )}
      </button>

      {/* Bottom link */}
      <div className="mt-7 text-center">
        <p className="text-sm text-gray-400">
          アカウントをお持ちでないですか？{' '}
          <button
            onClick={() => navigate('/sign-up')}
            className="text-sky-500 font-bold hover:text-sky-600 transition-colors"
          >
            新規登録
          </button>
        </p>
      </div>
    </AuthLayout>
  );
}