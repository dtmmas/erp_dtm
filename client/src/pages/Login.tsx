import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuthStore } from '../store/auth'
import { useConfigStore } from '../store/config'
import { formatCompanyName } from '../utils/text'

export default function Login() {
  const navigate = useNavigate()
  const { login, user, hasPermission, canSell } = useAuthStore()
  const config = useConfigStore(s => s.config)
  const companyName = formatCompanyName(config?.name)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setIsSubmitting(true)
    const ok = await login(email.trim(), password)
    setIsSubmitting(false)
    if (ok) {
      const nextUser = useAuthStore.getState().user || user
      const isAdmin = String(nextUser?.role || '').toUpperCase() === 'ADMIN'
      if (isAdmin) navigate('/dashboard')
      else if (hasPermission('products:read')) navigate('/products')
      else if (canSell()) navigate('/pos')
      else navigate('/no-access')
    }
    else setError('Credenciales inválidas')
  }

  return (
    <div className="login-shell">
      <div className="login-backdrop" aria-hidden="true" />
      <div className="login-layout login-layout--split">
        <section className="login-panel login-panel--form">
          <div className="login-form-panel">
            <div className="login-form-header">
              {config?.logoUrl ? (
                <img src={config.logoUrl} alt="logo" className="login-logo-small" />
              ) : (
                <div className="login-logo-small login-logo-small--fallback" aria-hidden="true">
                  {companyName.slice(0, 2).toUpperCase()}
                </div>
              )}

              <div className="login-form-header-copy">
                <div className="login-company">{companyName}</div>
                <div className="login-subtitle">Inicia sesión</div>
              </div>
            </div>

            <form className="login-form login-form--flat" onSubmit={onSubmit}>
              <div className="login-field">
                <label htmlFor="email">Correo</label>
                <input
                  id="email"
                  autoComplete="username"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="Correo"
                />
              </div>

              <div className="login-field">
                <label htmlFor="password">Contraseña</label>
                <input
                  id="password"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Contraseña"
                />
              </div>

              {error && <div className="login-error">{error}</div>}

              <button className="login-submit" type="submit" disabled={isSubmitting}>
                {isSubmitting ? 'Ingresando...' : 'Entrar'}
              </button>
            </form>
          </div>
        </section>
        <section className="login-panel login-panel--brand">
          <div
            className="login-brand-card"
            aria-hidden="true"
            style={config?.logoUrl ? { backgroundImage: `url(${config.logoUrl})` } : undefined}
          >
            {!config?.logoUrl && (
              <div className="login-brand-fallback">
                {companyName.slice(0, 2).toUpperCase()}
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  )
}
