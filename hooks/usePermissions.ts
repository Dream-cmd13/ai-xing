import { useAuthStore } from '../store/useAuthStore';
import { useAppStore } from '../store/useAppStore';
import { hasPermission } from '../utils/permissions';

export const usePermissions = (menuId: string) => {
  const { currentUser } = useAuthStore();
  const { systemRoles } = useAppStore();

  if (!currentUser) return { view: false, create: false, update: false };

  return {
    view: hasPermission(currentUser, systemRoles || [], menuId, 'view'),
    create: hasPermission(currentUser, systemRoles || [], menuId, 'create'),
    update: hasPermission(currentUser, systemRoles || [], menuId, 'update'),
  };
};
