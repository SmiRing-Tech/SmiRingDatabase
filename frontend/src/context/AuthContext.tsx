import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
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
  isPermissionsLoading: boolean;
  hasPermission: (resource: string, action: PermissionAction) => boolean;
  signOut: () => Promise<void>;
  refreshSession: () => Promise<Session | null>;
  refreshPermissions: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [permissions, setPermissions] = useState<Permission[]>([]);
  const [isPermissionsLoading, setIsPermissionsLoading] = useState(false);

  // ユーザーIDが変わったタイミングで権限を取得・クリア
  useEffect(() => {
    if (!session?.user.id) {
      setPermissions([]);
      return;
    }

    setIsPermissionsLoading(true);
    apiClient.get('/api/me/permissions')
      .then(res => res.json())
      .then((data: Permission[]) => setPermissions(data))
      .catch(err => console.error('[Auth] Permissions fetch failed:', err))
      .finally(() => setIsPermissionsLoading(false));
  }, [session?.user.id]);

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
    if (!session?.user.id) return;
    setIsPermissionsLoading(true);
    try {
      const res = await apiClient.get('/api/me/permissions');
      const data: Permission[] = await res.json();
      setPermissions(data);
    } catch (err) {
      console.error('[Auth] Permissions refresh failed:', err);
    } finally {
      setIsPermissionsLoading(false);
    }
  };

  return (
    <AuthContext.Provider value={{
      session, user, isLoading,
      permissions, isPermissionsLoading, hasPermission,
      signOut, refreshSession, refreshPermissions,
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
