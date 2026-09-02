import { useAuth } from '../context/AuthContext';

// ryugakusai-web と共通のロールID定義
export const SMIRING_MEMBER_ROLE_ID = 'c7f24039-c537-402e-91db-664684f5f8b3';
export const PARTNER_ROLE_ID = 'e9b3b5b3-b95e-4c87-bf1c-6b65603189cf';
export const ADMIN_ROLE_ID = 'a6dfbd9b-f64b-446d-b89f-b7d876e26988';

export const INTERNAL_ROLE_NAMES = [
  'smiring_member',
  'admin',
  'smiring_core',
  'smiring_partner',
  'partner',
];

export const INTERNAL_ROLE_IDS = [
  SMIRING_MEMBER_ROLE_ID,
  PARTNER_ROLE_ID,
  ADMIN_ROLE_ID,
];

/**
 * ロール名またはロールIDから内部メンバー（管理者・メンバー・パートナー）であるかを判定
 */
export const isInternalUser = (roles: string[] = [], roleIds: string[] = []): boolean => {
  const hasInternalName = roles.some(r => INTERNAL_ROLE_NAMES.includes(r.toLowerCase()));
  const hasInternalId = roleIds.some(id => INTERNAL_ROLE_IDS.includes(id));
  return hasInternalName || hasInternalId;
};

/**
 * 内部メンバーかどうかによってログイン後・初期アクセスのデフォルト遷移先を返す
 */
export const getDefaultPathForUser = (isInternal: boolean): string => {
  return isInternal ? '/home' : '/events';
};

export const useIsInternal = () => {
  const { roles, roleIds } = useAuth();
  return isInternalUser(roles, roleIds);
};

