import React, { useState } from 'react';
import { useFeedback } from '../../context/FeedbackContext';
import { supabase } from '../../lib/supabase';
import { useNavigate } from 'react-router-dom';
import { API_BASE_URL } from '../../config';
import { User, Mail, Lock, Key, Eye, EyeOff, ArrowRight, Loader2 } from 'lucide-react';
import AuthLayout from './AuthLayout';

export default function SignUpPage() {
  const { showFeedback } = useFeedback();
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [signupCode, setSignupCode] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const navigate = useNavigate();

  const handleSignUp = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);

    try {
      const codeRes = await fetch(`${API_BASE_URL}/api/auth/check-invitation-code`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: signupCode.trim() }),
      });

      if (!codeRes.ok) throw new Error('コードの検証中にエラーが発生しました');
      const { isValid: isValidCode } = await codeRes.json();

      if (!isValidCode) {
        showFeedback('サインアップコードが正しくありません。', { type: 'error', mode: 'banner' });
        setIsLoading(false);
        return;
      }

      const { data, error: signUpError } = await supabase.auth.signUp({
        email: email.trim(),
        password,
        options: {
          data: {
            display_name: username.trim(),
            signup_code: signupCode.trim(),
          },
        },
      });

      if (signUpError) throw signUpError;

      if (data.session === null) {
        showFeedback('確認メールを送信しました！メールを確認してください。', { type: 'success', mode: 'toast' });
        navigate('/sign-in');
      }
    } catch (error: any) {
      showFeedback(`エラー: ${error.message}`, { type: 'error', mode: 'banner' });
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <AuthLayout variant="signup">
      {/* Mobile title */}
      <div className="md:hidden mb-7">
        <h2 className="text-2xl font-black text-gray-900">Create account</h2>
        <p className="text-gray-400 text-sm mt-1">Join the global community.</p>
      </div>

      <form onSubmit={handleSignUp} className="space-y-4">
        {/* Account Info Group */}
        <div className="space-y-3">
          <p className="text-[10px] font-black text-gray-400 uppercase tracking-[0.2em]">Account Info</p>

          {/* Username */}
          <div className="relative group">
            <User className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-300 group-focus-within:text-blue-500 transition-colors duration-200" />
            <input
              type="text"
              value={username}
              onChange={e => setUsername(e.target.value)}
              required
              placeholder="Username"
              className="w-full pl-11 pr-4 py-3.5 bg-gray-50 border border-gray-200 rounded-xl text-sm
                         focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-400 focus:bg-white
                         transition-all duration-200 placeholder:text-gray-300"
            />
          </div>

          {/* Email */}
          <div className="relative group">
            <Mail className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-300 group-focus-within:text-blue-500 transition-colors duration-200" />
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              required
              placeholder="Email address"
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
              required
              minLength={6}
              placeholder="Password (6+ characters)"
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
        </div>

        {/* Divider */}
        <div className="flex items-center gap-3 py-1">
          <div className="flex-1 h-px bg-gray-100" />
          <span className="text-[10px] font-bold text-gray-300 uppercase tracking-widest">Access</span>
          <div className="flex-1 h-px bg-gray-100" />
        </div>

        {/* Signup Code Group */}
        <div className="space-y-1.5">
          <p className="text-[10px] font-black text-gray-400 uppercase tracking-[0.2em]">Invitation Code</p>
          <div className="relative group">
            <Key className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-300 group-focus-within:text-blue-500 transition-colors duration-200" />
            <input
              type="text"
              value={signupCode}
              onChange={e => setSignupCode(e.target.value)}
              required
              placeholder="Enter your invite code"
              className="w-full pl-11 pr-4 py-3.5 bg-gray-50 border border-gray-200 rounded-xl text-sm
                         focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-400 focus:bg-white
                         transition-all duration-200 placeholder:text-gray-300 font-mono tracking-widest"
            />
          </div>
          <p className="text-[11px] text-gray-400 pl-1">
            🔒 SmiRingは招待制です。管理者からコードを受け取ってください。
          </p>
        </div>

        {/* Submit */}
        <button
          type="submit"
          disabled={isLoading}
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
              Creating account...
            </>
          ) : (
            <>
              Create Account
              <ArrowRight className="w-4 h-4" />
            </>
          )}
        </button>
      </form>

      {/* Bottom link */}
      <div className="mt-7 text-center">
        <p className="text-sm text-gray-400">
          Already have an account?{' '}
          <button
            onClick={() => navigate('/sign-in')}
            className="text-sky-500 font-bold hover:text-sky-600 transition-colors"
          >
            Sign In
          </button>
        </p>
      </div>
    </AuthLayout>
  );
}