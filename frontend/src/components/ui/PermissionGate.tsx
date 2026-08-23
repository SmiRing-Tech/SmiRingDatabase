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
 * 権限が未判明の間は fallback を表示して権限なし状態と同じ見た目にする（セキュリティ優先）。
 * バックグラウンドでの再取得中は判明済みの権限で判定するので、表示がちらつかない。
 */
export default function PermissionGate({ resource, action, children, fallback = null }: Props) {
  const { hasPermission, isPermissionsReady } = useAuth();

  if (!isPermissionsReady) return <>{fallback}</>;
  if (!hasPermission(resource, action)) return <>{fallback}</>;

  return <>{children}</>;
}
