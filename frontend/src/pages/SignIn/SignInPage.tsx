import React, { useState } from 'react';
import { useFeedback } from '../../context/FeedbackContext';
import { supabase } from '../../lib/supabase';
import { useNavigate } from 'react-router-dom';
import { Eye, EyeOff } from 'lucide-react';

export default function SignInPage() {
  const { showFeedback } = useFeedback();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const navigate = useNavigate();

  const handleSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
  
    try {
      const { error } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password: password,
      });
  
      if (error) throw error;
      
      navigate('/home');
    } catch (error: any) {
      showFeedback(`ログインエラー: ${error.message}`, { type: 'error', mode: 'banner' });
    } finally {
      setIsLoading(false);
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
  };

  return (
    <div className="flex min-h-screen bg-white">
      {/* 左側：ロゴエリア（md:flex で画面幅768px以上のみ表示） */}
      <div className="hidden md:flex flex-1 bg-blue-100 flex-col items-center justify-center p-8">
        <img src="/assets/images/SmiRing_logo_temp.png" alt="Logo" className="w-48 h-48 object-contain" />
        <h1 className="mt-6 text-3xl font-bold text-blue-900">SmiRing Database</h1>
      </div>

      {/* 右側：フォームエリア */}
      <div className="flex-1 flex flex-col items-center justify-center p-8 overflow-y-auto">
        <div className="w-full max-w-md">
          {/* スマホ用ロゴ（md:hidden で画面幅768px未満のみ表示） */}
          <div className="md:hidden text-center mb-8">
            <h1 className="text-2xl font-bold text-blue-900">SmiRing DB</h1>
          </div>

          <h2 className="text-3xl font-bold text-center mb-8">Sign In</h2>

          <form onSubmit={handleSignIn} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Email</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                className="w-full px-4 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Password</label>
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  className="w-full px-4 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 pr-10"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 focus:outline-none"
                >
                  {showPassword ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                </button>
              </div>
            </div>

            {/* テスト用アカウント情報 */}
            <div className="bg-gray-50 p-3 rounded-md text-sm text-gray-600 mt-2">
              <p className="font-bold mb-1">For test use:</p>
              <div className="flex items-center justify-between mb-1">
                <span>Email: smiring.ryugaku@gmail.com</span>
                <button type="button" onClick={() => copyToClipboard('smiring.ryugaku@gmail.com')} className="text-blue-600 cursor-pointer hover:underline">Copy</button>
              </div>
              <div className="flex items-center justify-between">
                <span>Password: SmiRingTech</span>
                <button type="button" onClick={() => copyToClipboard('SmiRingTech')} className="text-blue-600 cursor-pointer hover:underline">Copy</button>
              </div>
            </div>

            <button
              type="submit"
              disabled={isLoading}
              className="w-full mt-6 bg-blue-600 text-white py-3 rounded-md font-bold cursor-pointer hover:bg-blue-700 transition disabled:opacity-50"
            >
              {isLoading ? 'Loading...' : 'Login'}
            </button>
          </form>

          <div className="flex justify-between mt-6 text-sm">
            <button onClick={() => navigate('/forgot-password')} className="text-blue-600 cursor-pointer hover:underline">
              Forgot Password?
            </button>
            <button onClick={() => navigate('/sign-up')} className="text-blue-600 cursor-pointer hover:underline">
              Create Account
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}