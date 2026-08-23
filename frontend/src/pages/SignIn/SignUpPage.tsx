import React, { useState } from 'react';
import { useFeedback } from '../../context/FeedbackContext';
import { supabase } from '../../lib/supabase';
import { useNavigate } from 'react-router-dom';
import { User, Mail, Lock, Eye, EyeOff, ArrowRight, ChevronDown, Loader2 } from 'lucide-react';
import AuthLayout from './AuthLayout';
import GoogleIcon from '../../components/ui/GoogleIcon';
import { PENDING_USERNAME_KEY } from './pendingUsername';

export default function SignUpPage() {
  const { showFeedback } = useFeedback();
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [isEmailFormOpen, setIsEmailFormOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isGoogleLoading, setIsGoogleLoading] = useState(false);
  const [isAgreed, setIsAgreed] = useState(false);
  const navigate = useNavigate();

  // ユーザー名・利用規約への同意は登録方法（メール/Google）に共通の前提条件
  const validateCommonFields = () => {
    if (!username.trim()) {
      showFeedback('ユーザー名を入力してください。', { type: 'error', mode: 'banner' });
      return false;
    }
    if (!isAgreed) {
      showFeedback('利用規約とプライバシーポリシーへの同意が必要です。', { type: 'error', mode: 'banner' });
      return false;
    }
    return true;
  };

  const handleSignUp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isEmailFormOpen) {
      setIsEmailFormOpen(true);
      return;
    }
    if (!validateCommonFields()) return;

    setIsLoading(true);

    try {
      const { data, error: signUpError } = await supabase.auth.signUp({
        email: email.trim(),
        password,
        options: {
          emailRedirectTo: `${window.location.origin}/sign-in`,
          data: {
            display_name: username.trim(),
          },
        },
      });

      if (signUpError) throw signUpError;

      if (data.session === null) {
        showFeedback('確認メールを送信しました！メールを確認してください。', { type: 'success', mode: 'toast' });
        navigate('/sign-in');
      } else {
        showFeedback('アカウントを作成しました！', { type: 'success', mode: 'toast' });
        navigate('/profile');
      }
    } catch (error: any) {
      showFeedback(`エラー: ${error.message}`, { type: 'error', mode: 'banner' });
    } finally {
      setIsLoading(false);
    }
  };

  const handleGoogleSignUp = async () => {
    if (!validateCommonFields()) return;

    setIsGoogleLoading(true);
    try {
      // Googleの認証画面に遷移すると画面状態が失われるので、戻ってきた後に
      // display_name として反映できるよう一時的に保存しておく
      localStorage.setItem(PENDING_USERNAME_KEY, username.trim());

      const { error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo: `${window.location.origin}/sign-in`,
        },
      });

      if (error) throw error;
    } catch (error: any) {
      localStorage.removeItem(PENDING_USERNAME_KEY);
      showFeedback(`Google登録エラー: ${error.message}`, { type: 'error', mode: 'banner' });
      setIsGoogleLoading(false);
    }
  };

  return (
    <AuthLayout variant="signup">
      {/* Mobile title */}
      <div className="md:hidden mb-7">
        <h2 className="text-2xl font-black text-gray-900">新規登録</h2>
        <p className="text-gray-400 text-sm mt-1">ようこそ、SmiRingDatabaseへ！</p>
      </div>

      <form onSubmit={handleSignUp} className="space-y-4">
        {/* Username */}
        <div className="space-y-1.5">
          <label className="block text-[11px] font-black text-gray-500 uppercase tracking-wider">
            ユーザー名
          </label>
          <div className="relative group">
            <User className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-300 group-focus-within:text-blue-500 transition-colors duration-200" />
            <input
              type="text"
              value={username}
              onChange={e => setUsername(e.target.value)}
              placeholder="ユーザー名"
              className="w-full pl-11 pr-4 py-3.5 bg-gray-50 border border-gray-200 rounded-xl text-sm
                         focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-400 focus:bg-white
                         transition-all duration-200 placeholder:text-gray-300"
            />
          </div>
        </div>

        {/* Agreement Checkbox */}
        <div className="flex items-center gap-2 py-1">
          <input
            type="checkbox"
            id="agreement"
            checked={isAgreed}
            onChange={e => setIsAgreed(e.target.checked)}
            className="w-4 h-4 text-sky-500 border-gray-300 rounded focus:ring-sky-500"
          />
          <label htmlFor="agreement" className="text-xs text-gray-500 cursor-pointer">
            <a href="https://drive.google.com/file/d/1pHINgk_mihMKVoU-IZlEx-Z1_u9o7MMF/view?usp=sharing" target="_blank" rel="noopener noreferrer" className="text-sky-500 font-bold hover:text-sky-600 transition-colors">利用規約</a>
            {' と '}
            <a href="https://drive.google.com/file/d/1a6fHqKALgQQMu4pCmuZlQmNAQ9wMpDta/view?usp=sharing" target="_blank" rel="noopener noreferrer" className="text-sky-500 font-bold hover:text-sky-600 transition-colors">プライバシーポリシー</a>
            {' に同意する'}
          </label>
        </div>

        {/* メールアドレスで登録 トグル */}
        <button
          type="button"
          onClick={() => setIsEmailFormOpen(open => !open)}
          className="w-full py-3 px-4 rounded-xl border border-gray-200 bg-white hover:bg-gray-50
                     text-gray-700 font-bold text-sm shadow-sm hover:shadow
                     transition-all duration-200 flex items-center justify-center gap-3
                     cursor-pointer"
        >
          <Mail className="w-4 h-4" />
          <span>メールアドレスで登録</span>
          <ChevronDown className={`w-4 h-4 text-gray-400 transition-transform duration-200 ${isEmailFormOpen ? 'rotate-180' : ''}`} />
        </button>

        {isEmailFormOpen && (
          <div className="space-y-3 pt-1">
            {/* Email */}
            <div className="relative group">
              <Mail className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-300 group-focus-within:text-blue-500 transition-colors duration-200" />
              <input
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                required={isEmailFormOpen}
                placeholder="メールアドレス"
                className="w-full pl-11 pr-4 py-3.5 bg-gray-50 border border-gray-200 rounded-xl text-sm
                           focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-400 focus:bg-white
                           transition-all duration-200 placeholder:text-gray-300"
              />
            </div>

            {/* Password */}
            <div className="relative group">
              <Lock className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-300 group-focus-within:text-blue-500 transition-colors duration-200" />
              <input
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={e => setPassword(e.target.value)}
                required={isEmailFormOpen}
                minLength={6}
                placeholder="パスワード（6文字以上）"
                className="w-full pl-11 pr-12 py-3.5 bg-gray-50 border border-gray-200 rounded-xl text-sm
                           focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-400 focus:bg-white
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

            {/* Submit */}
            <button
              type="submit"
              disabled={isLoading || isGoogleLoading}
              className="w-full py-3.5 rounded-xl font-bold text-white text-sm
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
                  登録中...
                </>
              ) : (
                <>
                  新規登録
                  <ArrowRight className="w-4 h-4" />
                </>
              )}
            </button>
          </div>
        )}
      </form>

      {/* Google Sign Up Button */}
      <button
        type="button"
        onClick={handleGoogleSignUp}
        disabled={isLoading || isGoogleLoading}
        className="w-full mt-3 py-3 px-4 rounded-xl border border-gray-200 bg-white hover:bg-gray-50
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
            <span>Googleで登録</span>
          </>
        )}
      </button>

      {/* Bottom link */}
      <div className="mt-7 text-center">
        <p className="text-sm text-gray-400">
          すでにアカウントをお持ちですか？{' '}
          <button
            onClick={() => navigate('/sign-in')}
            className="text-sky-500 font-bold hover:text-sky-600 transition-colors"
          >
            ログイン
          </button>
        </p>
      </div>
    </AuthLayout>
  );
}
