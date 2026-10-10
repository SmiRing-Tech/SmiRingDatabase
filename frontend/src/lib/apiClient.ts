import { supabase } from './supabase';
import { API_BASE_URL } from '../config';

/**
 * SmiRing Connect の外部招待URL経由の参加者はゲストとして扱う。彼らの資格情報は入室時に発行された
 * LiveKitトークンなので、これが設定されている間はSupabaseセッションより優先してAuthorizationヘッダーへ
 * 載せる（backend側の authenticateChatCaller が検証する）。ブラウザにログインセッションが残っていても
 * ゲストトークンを使うことで、通話上のID（guest_*）とAPI上のIDが食い違わないようにしている。
 * CallRoomPage が入室/ミニルーム移動のたびに setGuestAuthToken で最新のトークンに更新し、退室時に null に戻す。
 */
let guestAuthToken: string | null = null;
export function setGuestAuthToken(token: string | null) {
  guestAuthToken = token;
}

/**
 * 認証ヘッダーを自動付与し、401エラー時に自動リフレッシュを行うfetchラッパー
 */
export async function apiRequest(path: string, options: RequestInit = {}) {
  // 1. 最新のセッションを取得（メモリ内またはストレージから）
  let { data: { session } } = await supabase.auth.getSession();

  const headers = new Headers(options.headers);
  const useGuestToken = !!guestAuthToken;
  if (guestAuthToken) {
    headers.set('Authorization', `Bearer ${guestAuthToken}`);
  } else if (session?.access_token) {
    headers.set('Authorization', `Bearer ${session.access_token}`);
  }
  if (!headers.has('Content-Type') && !(options.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json');
  }

  const url = path.startsWith('http') ? path : `${API_BASE_URL}${path}`;

  let response = await fetch(url, { ...options, headers });

  // 2. もし 401 (Unauthorized) が返ってきたら、トークンリフレッシュを試みる
  // (ゲストトークンにはSupabaseのリフレッシュ機構が無いので対象外)
  if (response.status === 401 && !useGuestToken && session?.access_token) {
    console.warn('[API] Unauthorized (401). Attempting session refresh...');
    const { data: { session: newSession }, error: refreshError } = await supabase.auth.refreshSession();

    if (refreshError || !newSession) {
      console.error('[API] Refresh failed. User must re-login.');
      // 必要に応じてここで強制ログアウトやリダイレクトを検討
      return response;
    }

    // 3. リフレッシュ成功。新しいトークンで再試行
    console.log('[API] Refresh success. Retrying request...');
    headers.set('Authorization', `Bearer ${newSession.access_token}`);
    response = await fetch(url, { ...options, headers });
  }

  return response;
}

/**
 * 便利メソッド（GET/POST/PATCH/DELETE）
 */
export const apiClient = {
  get: (path: string, options?: RequestInit) => apiRequest(path, { ...options, method: 'GET' }),
  post: (path: string, body?: any, options?: RequestInit) => apiRequest(path, { 
    ...options, 
    method: 'POST', 
    body: body instanceof FormData ? body : JSON.stringify(body) 
  }),
  patch: (path: string, body?: any, options?: RequestInit) => apiRequest(path, { 
    ...options, 
    method: 'PATCH', 
    body: body instanceof FormData ? body : JSON.stringify(body) 
  }),
  put: (path: string, body?: any, options?: RequestInit) => apiRequest(path, { 
    ...options, 
    method: 'PUT', 
    body: body instanceof FormData ? body : JSON.stringify(body) 
  }),
  delete: (path: string, options?: RequestInit) => apiRequest(path, { ...options, method: 'DELETE' }),
};
