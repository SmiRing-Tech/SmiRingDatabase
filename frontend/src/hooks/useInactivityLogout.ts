import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';

const TIMEOUT_MS = 30 * 60 * 1000; // 30分

const ACTIVITY_EVENTS = [
  'mousemove',
  'mousedown',
  'keydown',
  'touchstart',
  'scroll',
  'click',
] as const;

export function useInactivityLogout() {
  const navigate = useNavigate();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const logout = async () => {
      await supabase.auth.signOut();
      navigate('/sign-in');
    };

    const resetTimer = () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(logout, TIMEOUT_MS);
    };

    // 初回タイマーセット
    resetTimer();

    // アクティビティを検知したらタイマーをリセット
    ACTIVITY_EVENTS.forEach(event => {
      window.addEventListener(event, resetTimer, { passive: true });
    });

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      ACTIVITY_EVENTS.forEach(event => {
        window.removeEventListener(event, resetTimer);
      });
    };
  }, [navigate]);
}
