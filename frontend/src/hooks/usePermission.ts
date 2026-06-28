import { useAuth, type PermissionAction } from '../context/AuthContext';

export function usePermission(resource: string, action: PermissionAction): boolean {
  const { hasPermission } = useAuth();
  return hasPermission(resource, action);
}
