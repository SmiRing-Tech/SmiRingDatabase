import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { Eye, EyeOff, Lock, ArrowRight, Loader2, CheckCircle2, ArrowLeft, ShieldCheck } from 'lucide-react';
import AuthLayout from './AuthLayout';

type PasswordStrength = 'weak' | 'medium' | 'strong';

function getPasswordStrength(pw: string): PasswordStrength {
  if (pw.length < 6) return 'weak';
  if (pw.length >= 10 && /[A-Z]/.test(pw) && /[0-9]/.test(pw)) return 'strong';
  return 'medium';
}

const strengthConfig = {
  weak: { label: 'Weak', color: 'bg-red-400', width: 'w-1/3', text: 'text-red-400' },
  medium: { label: 'Medium', color: 'bg-yellow-400', width: 'w-2/3', text: 'text-yellow-500' },
  strong: { label: 'Strong', color: 'bg-green-400', width: 'w-full', text: 'text-green-500' },
};

export default function ResetPasswordPage() {
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [isSuccess, setIsSuccess] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [isAgreed, setIsAgreed] = useState(false);
  const navigate = useNavigate();

  const strength = password.length > 0 ? getPasswordStrength(password) : null;
  const sConfig = strength ? strengthConfig[strength] : null;

  useEffect(() => {
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'PASSWORD_RECOVERY') {
        setErrorMsg('');
      } else if (!session) {
        setErrorMsg('セッションが無効です。もう一度リセットメールのリンクからやり直してください。');
      }
    });
    return () => subscription.unsubscribe();
  }, []);

  const handleUpdate = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg('');

    if (password !== confirmPassword) {
      setErrorMsg('パスワードが一致しません');
      return;
    }

    setIsLoading(true);
    try {
      const { error } = await supabase.auth.updateUser({ password });
      if (error) throw error;
      setIsSuccess(true);
      setTimeout(() => navigate('/home'), 2000);
    } catch (err: any) {
      setErrorMsg(err.message || 'パスワードの更新に失敗しました。');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <AuthLayout variant="reset">
      {/* Mobile title */}
      <div className="md:hidden mb-7">
        <h2 className="text-2xl font-black text-gray-900">New password</h2>
        <p className="text-gray-400 text-sm mt-1">Almost there — set your new password.</p>
      </div>

      {isSuccess ? (
        /* ===== Success state ===== */
        <div className="flex flex-col items-center text-center py-4 animate-in fade-in zoom-in-95 duration-500">
          <div className="w-16 h-16 rounded-full bg-green-50 flex items-center justify-center mb-5 ring-4 ring-green-100">
            <CheckCircle2 className="w-8 h-8 text-green-500" />
          </div>
          <h3 className="text-xl font-black text-gray-900 mb-2">Password updated!</h3>
          <p className="text-sm text-gray-500">ホーム画面へ移動します...</p>
          <div className="mt-4 flex gap-1.5">
            <div className="w-1.5 h-1.5 bg-sky-300 rounded-full animate-bounce [animation-delay:0ms]" />
            <div className="w-1.5 h-1.5 bg-sky-300 rounded-full animate-bounce [animation-delay:150ms]" />
            <div className="w-1.5 h-1.5 bg-sky-300 rounded-full animate-bounce [animation-delay:300ms]" />
          </div>
        </div>
      ) : (
        <>
          {/* Session error */}
          {errorMsg && (
            <div className="mb-5 flex items-start gap-2.5 p-3.5 rounded-xl bg-red-50 border-l-4 border-red-400 text-red-600 text-sm leading-relaxed">
              {errorMsg}
            </div>
          )}

          {!errorMsg && (
            <div className="mb-5 flex items-center gap-2.5 p-3.5 rounded-xl bg-sky-50 border border-sky-100 text-sky-500 text-sm">
              <ShieldCheck className="w-4 h-4 flex-shrink-0" />
              <span>リセットメールのリンクから来た場合は、このまま新しいパスワードを設定できます。</span>
            </div>
          )}

          <form onSubmit={handleUpdate} className="space-y-4">
            {/* New password */}
            <div className="space-y-1.5">
              <label className="block text-[11px] font-black text-gray-500 uppercase tracking-wider">
                New Password
              </label>
              <div className="relative group">
                <Lock className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-300 group-focus-within:text-sky-400 transition-colors duration-200" />
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  required
                  minLength={6}
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

              {/* Password strength bar */}
              {sConfig && (
                <div className="space-y-1 px-0.5">
                  <div className="h-1 w-full bg-gray-100 rounded-full overflow-hidden">
                    <div className={`h-full rounded-full transition-all duration-500 ${sConfig.color} ${sConfig.width}`} />
                  </div>
                  <p className={`text-[11px] font-bold ${sConfig.text}`}>{sConfig.label} password</p>
                </div>
              )}
            </div>

            {/* Confirm password */}
            <div className="space-y-1.5">
              <label className="block text-[11px] font-black text-gray-500 uppercase tracking-wider">
                Confirm Password
              </label>
              <div className="relative group">
                <Lock className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-300 group-focus-within:text-sky-400 transition-colors duration-200" />
                <input
                  type={showConfirmPassword ? 'text' : 'password'}
                  value={confirmPassword}
                  onChange={e => setConfirmPassword(e.target.value)}
                  required
                  minLength={6}
                  placeholder="••••••••"
                  className={`w-full pl-11 pr-12 py-3.5 bg-gray-50 border rounded-xl text-sm
                             focus:outline-none focus:ring-2 focus:ring-sky-400/50 focus:bg-white
                             transition-all duration-200 placeholder:text-gray-300
                             ${confirmPassword && password !== confirmPassword
                               ? 'border-red-300 focus:border-red-400'
                               : 'border-gray-200 focus:border-sky-300'}`}
                />
                <button
                  type="button"
                  onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                  className="absolute right-4 top-1/2 -translate-y-1/2 text-gray-300 hover:text-gray-600 transition-colors"
                >
                  {showConfirmPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
              {confirmPassword && password !== confirmPassword && (
                <p className="text-[11px] text-red-400 font-bold px-0.5">パスワードが一致しません</p>
              )}
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

            <button
              type="submit"
              disabled={isLoading || !!(confirmPassword && password !== confirmPassword) || !isAgreed}
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
                  Updating...
                </>
              ) : (
                <>
                  Update Password
                  <ArrowRight className="w-4 h-4" />
                </>
              )}
            </button>
          </form>

          <div className="mt-7 text-center">
            <button
              onClick={() => navigate('/sign-in')}
              className="flex items-center gap-1.5 text-sm text-gray-400 hover:text-sky-500 font-medium transition-colors mx-auto"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              Back to Sign In
            </button>
          </div>
        </>
      )}
    </AuthLayout>
  );
}