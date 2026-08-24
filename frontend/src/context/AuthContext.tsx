import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabase';
import { apiClient } from '../lib/apiClient';
import type { Session, User } from '@supabase/supabase-js';

export type PermissionAction = 'read' | 'write' | 'delete' | 'admin';

export interface Permission {
  permission_id: string;
  resource: string;
  action: PermissionAction;
  name: string;
}

interface AuthContextType {
  session: Session | null;
  user: User | null;
  isLoading: boolean;
  permissions: Permission[];
  roles: string[];
  roleIds: string[];
  isPermissionsLoading: boolean;
  /** 現在のユーザーのロール・権限が判明しているか（ルートガードはこれが true になるまで判断してはいけない） */
  isPermissionsReady: boolean;
  /** 権限取得に失敗して判定材料が無い状態かどうか */
  permissionsError: boolean;
  /** オンボーディング（初回プロフィール入力）を完了しているか。basic_profile_info.metadata 由来 */
  onboardingCompleted: boolean;
  hasPermission: (resource: string, action: PermissionAction) => boolean;
  signOut: () => Promise<void>;
  refreshSession: () => Promise<Session | null>;
  refreshPermissions: () => Promise<PermissionsFetchResult>;
  fetchUserPermissions: (userId?: string) => Promise<PermissionsFetchResult>;
}

interface PermissionsFetchResult {
  permissions: Permission[];
  roles: string[];
  roleIds: string[];
  onboardingCompleted: boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

// リロード直後にロール判定を待たずに済むよう、権限・ロールを localStorage にキャッシュする。
// あくまで初期描画を速くするためのものであり、実際のアクセス制御はバックエンドの
// requirePermission が行うので、キャッシュが古くても権限昇格にはつながらない。
const AUTH_CACHE_KEY = 'smiring.auth.permissions.v1';

interface AuthCache {
  userId: string;
  permissions: Permission[];
  roles: string[];
  roleIds: string[];
  onboardingCompleted: boolean;
}

const readAuthCache = (): AuthCache | null => {
  try {
    const raw = localStorage.getItem(AUTH_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.userId || !Array.isArray(parsed.roles) || !Array.isArray(parsed.roleIds) || !Array.isArray(parsed.permissions)) {
      return null;
    }
    return parsed as AuthCache;
  } catch {
    return null;
  }
};

const writeAuthCache = (cache: AuthCache) => {
  try {
    localStorage.setItem(AUTH_CACHE_KEY, JSON.stringify(cache));
  } catch {
    // ストレージが使えない環境ではキャッシュ無しで動作させる
  }
};

const clearAuthCache = () => {
  try {
    localStorage.removeItem(AUTH_CACHE_KEY);
  } catch {
    // 同上
  }
};

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [permissions, setPermissions] = useState<Permission[]>(() => readAuthCache()?.permissions ?? []);
  const [roles, setRoles] = useState<string[]>(() => readAuthCache()?.roles ?? []);
  const [roleIds, setRoleIds] = useState<string[]>(() => readAuthCache()?.roleIds ?? []);
  // 未取得時は既存ユーザーへのちらつきを避けるため「完了済み」扱いにしておく（未完了の新規ユーザーは取得後すぐ false に更新される）
  const [onboardingCompleted, setOnboardingCompleted] = useState<boolean>(() => readAuthCache()?.onboardingCompleted ?? true);
  // どのユーザーのロール・権限が今 state に入っているか（null = 判定材料なし）
  const [permissionsUserId, setPermissionsUserId] = useState<string | null>(() => readAuthCache()?.userId ?? null);
  const [isPermissionsLoading, setIsPermissionsLoading] = useState(false);
  const [permissionsError, setPermissionsError] = useState(false);
  // permissionsUserId の最新値を effect 内から参照するためのミラー
  const permissionsUserIdRef = useRef<string | null>(permissionsUserId);
  useEffect(() => { permissionsUserIdRef.current = permissionsUserId; }, [permissionsUserId]);

  // 権限・ロールを取得して状態に保存する関数
  const fetchUserPermissions = useCallback(async (userId?: string): Promise<PermissionsFetchResult> => {
    const currentUserId = userId || session?.user.id;
    if (!currentUserId) {
      setPermissions([]);
      setRoles([]);
      setRoleIds([]);
      setOnboardingCompleted(true);
      setPermissionsUserId(null);
      setPermissionsError(false);
      clearAuthCache();
      return { permissions: [], roles: [], roleIds: [], onboardingCompleted: true };
    }

    setIsPermissionsLoading(true);
    setPermissionsError(false);
    try {
      const res = await apiClient.get('/api/me/permissions');
      if (!res.ok) {
        throw new Error(`Failed to fetch permissions: ${res.statusText}`);
      }
      const data: PermissionsFetchResult = await res.json();
      const perms = data.permissions || [];
      const userRoles = data.roles || [];
      const userRoleIds = data.roleIds || [];
      const isOnboarded = data.onboardingCompleted === true;

      setPermissions(perms);
      setRoles(userRoles);
      setRoleIds(userRoleIds);
      setOnboardingCompleted(isOnboarded);
      setPermissionsUserId(currentUserId);
      setPermissionsError(false);
      writeAuthCache({ userId: currentUserId, permissions: perms, roles: userRoles, roleIds: userRoleIds, onboardingCompleted: isOnboarded });
      return { permissions: perms, roles: userRoles, roleIds: userRoleIds, onboardingCompleted: isOnboarded };
    } catch (err) {
      // 取得に失敗したときは「権限なし」と確定させない。
      // 空のロールで確定させるとルートガードが外部メンバー扱いでリダイレクトしてしまうため、
      // エラー状態として扱い、キャッシュがあればそれを使い続ける。
      console.error('[Auth] Permissions fetch failed:', err);
      setPermissionsError(true);
      return { permissions: [], roles: [], roleIds: [], onboardingCompleted: true };
    } finally {
      setIsPermissionsLoading(false);
    }
  }, [session?.user.id]);

  // ユーザーIDが変わったタイミングで権限を取得・クリア
  useEffect(() => {
    // セッション復元中は「未ログイン」と判断できないので、キャッシュを消さずに待つ
    if (isLoading) return;

    const currentUserId = session?.user.id;
    if (!currentUserId) {
      setPermissions([]);
      setRoles([]);
      setRoleIds([]);
      setOnboardingCompleted(true);
      setPermissionsUserId(null);
      setPermissionsError(false);
      clearAuthCache();
      return;
    }

    // 別ユーザーのキャッシュが残っている場合は判定に使わせない
    if (permissionsUserIdRef.current && permissionsUserIdRef.current !== currentUserId) {
      setPermissions([]);
      setRoles([]);
      setRoleIds([]);
      setPermissionsUserId(null);
    }

    fetchUserPermissions(currentUserId);
  }, [isLoading, session?.user.id, fetchUserPermissions]);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setUser(session?.user ?? null);
      setIsLoading(false);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
      setUser(session?.user ?? null);
      setIsLoading(false);

      if (_event === 'SIGNED_OUT') {
        console.log('[Auth] User signed out');
      }
      if (_event === 'TOKEN_REFRESHED') {
        console.log('[Auth] Token refreshed successfully');
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  // resource + action で権限チェック（バックエンドの requirePermission と同じロジック）
  const hasPermission = useCallback((resource: string, action: PermissionAction): boolean => {
    return permissions.some(p => {
      if (p.resource !== resource) return false;
      if (p.action === 'admin') return true;        // admin は全操作を包含
      if (p.action === action) return true;
      if (action === 'read' && p.action === 'write') return true; // write は read を包含
      return false;
    });
  }, [permissions]);

  const signOut = async () => {
    await supabase.auth.signOut();
    setSession(null);
    setUser(null);
    setPermissions([]);
    setRoles([]);
    setRoleIds([]);
    setOnboardingCompleted(true);
    setPermissionsUserId(null);
    setPermissionsError(false);
    clearAuthCache();
  };

  const refreshSession = async () => {
    const { data: { session }, error } = await supabase.auth.refreshSession();
    if (error) {
      console.error('[Auth] Session refresh failed:', error);
      return null;
    }
    setSession(session);
    setUser(session?.user ?? null);
    return session;
  };

  // 権限を手動で再取得（管理者が権限を変更した直後などに使用）
  const refreshPermissions = async () => {
    return fetchUserPermissions();
  };

  // セッションが無いなら判定は不要、あるなら「そのユーザーの」権限が揃っているかを見る
  const isPermissionsReady = !session?.user.id || permissionsUserId === session.user.id;

  return (
    <AuthContext.Provider value={{
      session, user, isLoading,
      permissions, roles, roleIds, isPermissionsLoading, isPermissionsReady,
      permissionsError: permissionsError && !isPermissionsReady, onboardingCompleted, hasPermission,
      signOut, refreshSession, refreshPermissions, fetchUserPermissions,
    }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
