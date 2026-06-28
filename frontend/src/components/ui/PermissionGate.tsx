import { useAuth, type PermissionAction } from '../../context/AuthContext';

interface Props {
  resource: string;
  action: PermissionAction;
  children: React.ReactNode;
  fallback?: React.ReactNode;
}

/**
 * 権限を持つ場合だけ children を表示するラッパー。
 * 権限がない場合は fallback（デフォルト null）を表示。
 * 権限読み込み中は fallback を表示して権限なし状態と同じ見た目にする（セキュリティ優先）。
 */
export default function PermissionGate({ resource, action, children, fallback = null }: Props) {
  const { hasPermission, isPermissionsLoading } = useAuth();

  if (isPermissionsLoading) return <>{fallback}</>;
  if (!hasPermission(resource, action)) return <>{fallback}</>;

  return <>{children}</>;
}
