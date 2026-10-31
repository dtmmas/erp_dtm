import { Navigate } from 'react-router-dom'
import { useAuthStore } from '../store/auth'

export default function PermissionGuard({ permission, children }: { permission: string | string[], children: JSX.Element }) {
  const hasPermission = useAuthStore(s => s.hasPermission)
  const user = useAuthStore(s => s.user)
  const required = Array.isArray(permission) ? permission : [permission]
  const allowed = !!user && required.some(p => hasPermission(p))

  if (!user) return <Navigate to="/login" />
  if (!allowed) return <Navigate to="/no-access" replace />
  
  return children
}
