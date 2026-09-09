import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { AlertTriangle, Loader2, Video } from 'lucide-react';
import { apiClient } from '../../lib/apiClient';
import CallRoomPage from './CallRoomPage';

interface InviteInfo {
  room_id: string;
  room_title: string;
}

/**
 * Public landing page for an external meeting's invite URL (/j/:token) — reachable with
 * no SmiRing Database account. Resolves the invite token to a room first (so an
 * expired/invalid link fails here with a clear message instead of inside CallRoomPage),
 * then hands off to the same CallRoomPage everyone else uses, in its anonymous mode.
 */
export default function JoinExternalMeetingPage() {
  const { token } = useParams<{ token: string }>();
  const [invite, setInvite] = useState<InviteInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!token) {
      setError('招待URLが不正です');
      setLoading(false);
      return;
    }
    let isMounted = true;
    apiClient
      .get(`/api/connect/invite/${token}`)
      .then(async (res) => {
        if (!isMounted) return;
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          setError(body.error || 'この招待URLは無効です');
          return;
        }
        setInvite(await res.json());
      })
      .catch(() => {
        if (isMounted) setError('通信エラーが発生しました');
      })
      .finally(() => {
        if (isMounted) setLoading(false);
      });
    return () => {
      isMounted = false;
    };
  }, [token]);

  if (loading) {
    return (
      <div className="h-dvh w-screen bg-[#0f1115] flex flex-col items-center justify-center gap-4 text-white">
        <Loader2 className="w-10 h-10 animate-spin text-sky-500" />
        <p className="font-bold text-sm text-gray-300">招待URLを確認しています...</p>
      </div>
    );
  }

  if (error || !invite || !token) {
    return (
      <div className="h-dvh w-screen bg-[#0f1115] flex flex-col items-center justify-center p-6 text-white text-center">
        <div className="w-16 h-16 rounded-3xl bg-rose-500/10 border border-rose-500/30 flex items-center justify-center mb-4">
          <AlertTriangle className="w-8 h-8 text-rose-500" />
        </div>
        <h1 className="text-2xl font-black mb-2">参加できませんでした</h1>
        <p className="text-sm text-gray-400 mb-2 max-w-md">
          {error || 'この招待URLは無効です'}
        </p>
        <div className="flex items-center gap-2 text-gray-500 text-xs font-semibold mt-4">
          <Video className="w-3.5 h-3.5" />
          <span>SmiRing Connect</span>
        </div>
      </div>
    );
  }

  return (
    <CallRoomPage
      anonymousInvite={{
        token,
        roomId: invite.room_id,
        roomTitle: invite.room_title,
      }}
    />
  );
}
