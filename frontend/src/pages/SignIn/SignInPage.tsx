import React, { useState } from 'react';
import { useFeedback } from '../../context/FeedbackContext';
import { supabase } from '../../lib/supabase';
import { useNavigate } from 'react-router-dom';
import { API_BASE_URL } from '../../config';
import { Eye, EyeOff, Mail, Lock, ArrowRight, Loader2 } from 'lucide-react';
import AuthLayout from './AuthLayout';

export default function SignInPage() {
  const { showFeedback } = useFeedback();
  const [email, setEmail] = useState(() => localStorage.getItem('saved_email') ?? '');
  const [password, setPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const navigate = useNavigate();

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

            navigate('/home');
    } catch (error: any) {
      showFeedback(`ログインエラー: ${error.message}`, { type: 'error', mode: 'banner' });
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <AuthLayout variant="signin">
      {/* Mobile title */}
      <div className="md:hidden mb-7">
        <h2 className="text-2xl font-black text-gray-900">Welcome back!</h2>
        <p className="text-gray-400 text-sm mt-1">あなたの留学生活を、鮮明に。</p>
      </div>

      <form onSubmit={handleSignIn} className="space-y-4">
        {/* Email */}
        <div className="space-y-1.5">
          <label className="block text-[11px] font-black text-gray-500 uppercase tracking-wider">
            Email
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
              Password
            </label>
            <button
              type="button"
              onClick={() => navigate('/forgot-password')}
              className="text-[11px] text-sky-500 hover:text-sky-600 font-bold transition-colors"
            >
              Forgot password?
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
              Signing in...
            </>
          ) : (
            <>
              Sign In
              <ArrowRight className="w-4 h-4" />
            </>
          )}
        </button>
      </form>

      {/* Bottom link */}
      <div className="mt-7 text-center">
        <p className="text-sm text-gray-400">
          Don't have an account?{' '}
          <button
            onClick={() => navigate('/sign-up')}
            className="text-sky-500 font-bold hover:text-sky-600 transition-colors"
          >
            Create account
          </button>
        </p>
      </div>
    </AuthLayout>
  );
}