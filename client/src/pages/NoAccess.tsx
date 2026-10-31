import { useAuthStore } from '../store/auth'
import { useConfigStore } from '../store/config'
import { formatCompanyName } from '../utils/text'

export default function NoAccess() {
  const user = useAuthStore(s => s.user)
  const logout = useAuthStore(s => s.logout)
  const config = useConfigStore(s => s.config)
  const companyName = formatCompanyName(config?.name)

  return (
    <div className="page-shell page-shell--narrow">
      <div className="page-toolbar" style={{ marginBottom: 20 }}>
        <h2 style={{ margin: 0 }}>Acceso restringido</h2>
      </div>

      <div className="card" style={{ textAlign: 'center' }}>
        <div style={{ fontWeight: 800, fontSize: '1.1rem', marginBottom: 8 }}>{companyName}</div>
        <div style={{ color: 'var(--muted)', marginBottom: 16 }}>
          {user?.name ? `${user.name}, tu usuario no tiene permisos asignados para abrir módulos.` : 'Tu usuario no tiene permisos asignados para abrir módulos.'}
        </div>

        <button type="button" className="btn-secondary" onClick={logout}>
          Cerrar sesión
        </button>
      </div>
    </div>
  )
}
