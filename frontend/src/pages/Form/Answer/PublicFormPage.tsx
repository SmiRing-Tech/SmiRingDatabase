import { useEffect, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { LogIn, UserRound, Lock, Loader2 } from 'lucide-react';
import { useAuth } from '../../../context/AuthContext';
import { apiClient } from '../../../lib/apiClient';
import {
  formGuestRequestOptions,
  getOrCreateFormGuestKey,
  getSavedFormGuestName,
  saveFormGuestName,
  type FormGuest,
} from '../../../lib/formGuest';
import FormAnswerPage from './FormAnswerPage';

type ProbeState =
  | { status: 'loading' }
  | { status: 'public'; title: string; isAnonymous: boolean }
  | { status: 'login_required' }
  | { status: 'error' };

/**
 * Shareable form URL (/f/:id), reachable without an account. Logged-in visitors answer as
 * themselves; others choose between logging in and answering as a guest — the latter only
 * when the form is published with access_mode = 'public'.
 */
export default function PublicFormPage() {
  const { id } = useParams<{ id: string }>();
  const { session, isLoading: isAuthLoading } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [guestKey] = useState(getOrCreateFormGuestKey);
  const [guestName, setGuestName] = useState(getSavedFormGuestName);
  const [guest, setGuest] = useState<FormGuest | null>(null);
  const [probe, setProbe] = useState<ProbeState>({ status: 'loading' });

  useEffect(() => {
    if (isAuthLoading || session || !id) return;
    let isMounted = true;
    apiClient
      .get(`/api/forms/${id}`, formGuestRequestOptions({ key: guestKey, name: '' }))
      .then(async (res) => {
        if (!isMounted) return;
        if (res.status === 401) return setProbe({ status: 'login_required' });
        if (!res.ok) return setProbe({ status: 'error' });
        const form = await res.json();
        setProbe({ status: 'public', title: form.title || '無題のフォーム', isAnonymous: !!form.allow_anonymous });
      })
      .catch(() => isMounted && setProbe({ status: 'error' }));
    return () => {
      isMounted = false;
    };
  }, [id, session, isAuthLoading, guestKey]);

  const goToSignIn = () => navigate('/sign-in', { state: { from: location } });

  if (isAuthLoading) return <CenteredSpinner />;
  if (session) return <FormAnswerPage />;
  if (guest) return <FormAnswerPage guest={guest} />;
  if (probe.status === 'loading') return <CenteredSpinner />;

  if (probe.status === 'login_required' || probe.status === 'error') {
    return (
      <Card>
        <div className="w-20 h-20 bg-gray-100 text-gray-500 rounded-full flex items-center justify-center mx-auto mb-6">
          <Lock className="w-10 h-10" />
        </div>
        <h2 className="text-2xl font-bold text-gray-800 mb-2">
          {probe.status === 'error' ? 'フォームを開けませんでした' : 'ログインが必要です'}
        </h2>
        <p className="text-gray-500 mb-8 leading-relaxed">
          {probe.status === 'error'
            ? 'URLが正しいか確認してください。'
            : 'このフォームに回答するにはログインしてください。'}
        </p>
        <button
          onClick={goToSignIn}
          className="w-full py-4 bg-blue-600 text-white rounded-xl font-bold hover:bg-blue-700 transition-all shadow-md flex items-center justify-center gap-2"
        >
          <LogIn className="w-5 h-5" />
          ログインする
        </button>
      </Card>
    );
  }

  const startAsGuest = () => {
    if (probe.isAnonymous) {
      setGuest({ key: guestKey, name: '' });
      return;
    }
    const name = guestName.trim();
    saveFormGuestName(name);
    setGuest({ key: guestKey, name });
  };

  return (
    <Card>
      <h2 className="text-2xl font-bold text-gray-800 mb-2 break-words">{probe.title}</h2>
      <p className="text-gray-500 mb-8 leading-relaxed">回答方法を選んでください</p>

      <div className="flex flex-col gap-3 text-left">
        <button
          onClick={goToSignIn}
          className="w-full py-4 bg-gray-800 text-white rounded-xl font-bold hover:bg-gray-900 transition-all shadow-md flex items-center justify-center gap-2"
        >
          <LogIn className="w-5 h-5" />
          ログインして回答する
        </button>

        <div className="flex items-center gap-3 my-2 text-xs text-gray-400">
          <span className="flex-1 border-t border-gray-200" />
          または
          <span className="flex-1 border-t border-gray-200" />
        </div>

        {probe.isAnonymous ? (
          <p className="text-xs text-gray-500 text-center">このフォームは匿名で回答されます</p>
        ) : (
          <>
            <label className="text-sm font-bold text-gray-700" htmlFor="guest-name">
              お名前（任意）
            </label>
            <input
              id="guest-name"
              type="text"
              value={guestName}
              maxLength={100}
              onChange={(e) => setGuestName(e.target.value)}
              placeholder="例: 山田 太郎"
              className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl outline-none focus:ring-2 focus:ring-blue-500 focus:bg-white transition-all text-sm"
            />
          </>
        )}
        <button
          onClick={startAsGuest}
          className="w-full py-4 bg-white border-2 border-gray-200 text-gray-700 rounded-xl font-bold hover:bg-gray-50 transition-all flex items-center justify-center gap-2"
        >
          <UserRound className="w-5 h-5" />
          ログインせずに回答する
        </button>
      </div>
    </Card>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen w-full flex flex-col items-center justify-center bg-gray-50 p-6">
      <div className="bg-white p-10 rounded-3xl shadow-xl text-center w-full max-w-md">{children}</div>
    </div>
  );
}

function CenteredSpinner() {
  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-blue-50">
      <Loader2 className="w-10 h-10 text-blue-600 animate-spin" />
    </div>
  );
}
