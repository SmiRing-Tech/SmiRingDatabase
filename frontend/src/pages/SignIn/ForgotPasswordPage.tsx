import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { Mail, ArrowRight, Loader2, CheckCircle2, ArrowLeft } from 'lucide-react';
import AuthLayout from './AuthLayout';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isSent, setIsSent] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const navigate = useNavigate();

  const handleReset = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setErrorMsg('');

    try {
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${window.location.origin}/reset-password`,
      });
      if (error) throw error;
      setIsSent(true);
    } catch (err: any) {
      setErrorMsg(err.message || 'メールの送信に失敗しました。');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <AuthLayout variant="forgot">
      {/* Mobile title */}
      <div className="md:hidden mb-7">
        <h2 className="text-2xl font-black text-gray-900">Reset password</h2>
        <p className="text-gray-400 text-sm mt-1">We'll send you a reset link.</p>
      </div>

      {isSent ? (
        /* ===== Success state ===== */
        <div className="flex flex-col items-center text-center py-4 animate-in fade-in zoom-in-95 duration-500">
          <div className="w-16 h-16 rounded-full bg-green-50 flex items-center justify-center mb-5 ring-4 ring-green-100">
            <CheckCircle2 className="w-8 h-8 text-green-500" />
          </div>
          <h3 className="text-xl font-black text-gray-900 mb-2">Email sent!</h3>
          <p className="text-sm text-gray-500 leading-relaxed max-w-xs">
            <span className="font-bold text-gray-700">{email}</span> にパスワードリセット用のリンクを送信しました。
            メールをご確認ください。
          </p>
          <p className="mt-4 text-[11px] text-gray-400 bg-gray-50 p-3 rounded-lg border border-gray-100 leading-relaxed">
            ※入力されたアドレスが登録されている場合のみ、メールが届きます。<br />
            届かない場合はアドレスに間違いがないかご確認ください。
          </p>
          <button
            onClick={() => navigate('/sign-in')}
            className="mt-8 flex items-center gap-2 text-sm text-sky-500 font-bold hover:text-sky-600 transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            Back to Sign In
          </button>
        </div>
      ) : (
        /* ===== Form state ===== */
        <>
          <p className="text-sm text-gray-500 mb-6 leading-relaxed">
            登録済みのメールアドレスを入力してください。パスワード再設定用のリンクをお送りします。
          </p>

          {errorMsg && (
            <div className="mb-5 flex items-start gap-2.5 p-3.5 rounded-xl bg-red-50 border-l-4 border-red-400 text-red-600 text-sm">
              <span className="leading-relaxed">{errorMsg}</span>
            </div>
          )}

          <form onSubmit={handleReset} className="space-y-4">
            <div className="space-y-1.5">
              <label className="block text-[11px] font-black text-gray-500 uppercase tracking-wider">Email</label>
              <div className="relative group">
                <Mail className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-300 group-focus-within:text-sky-400 transition-colors duration-200" />
                <input
                  type="email"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  required
                  placeholder="you@example.com"
                  className="w-full pl-11 pr-4 py-3.5 bg-gray-50 border border-gray-200 rounded-xl text-sm
                             focus:outline-none focus:ring-2 focus:ring-sky-400/50 focus:border-sky-300 focus:bg-white
                             transition-all duration-200 placeholder:text-gray-300"
                />
              </div>
            </div>

            <button
              type="submit"
              disabled={isLoading}
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
                  Sending...
                </>
              ) : (
                <>
                  Send Reset Email
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