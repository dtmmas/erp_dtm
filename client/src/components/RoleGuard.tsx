import { Navigate } from 'react-router-dom'
import { useAuthStore } from '../store/auth'

export default function RoleGuard({ roles, children }: { roles: ('ADMIN'|'CAJERO'|'ALMACEN')[], children: JSX.Element }) {
  const user = useAuthStore(s => s.user)
  if (!user) return <Navigate to="/login" />
  if (!roles.includes(user.role)) return <Navigate to="/no-access" replace />
  return children
}
