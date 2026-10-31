import { Outlet, Link, useLocation, useNavigate } from 'react-router-dom'
import { useEffect, useState } from 'react'
import { useAuthStore } from '../store/auth'
import { useConfigStore } from '../store/config'
import { formatCompanyName } from '../utils/text'

export default function Layout() {
  const location = useLocation()
  const navigate = useNavigate()
  const { user, logout, hasPermission, canSell } = useAuthStore()
  const config = useConfigStore(s => s.config)
  const companyName = formatCompanyName(config?.name)
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const [mobileMenuSections, setMobileMenuSections] = useState<Record<string, boolean>>({
    principal: true,
    procesos: false,
    catalogo: false,
    inventario: false,
    almacenes: false,
    reportes: false,
    sistema: false
  })
  const closeMobileMenu = () => setMobileMenuOpen(false)

  useEffect(() => {
    setMobileMenuOpen(false)
  }, [location.pathname])

  useEffect(() => {
    if (!mobileMenuOpen) return

    const previousOverflow = document.body.style.overflow
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMobileMenuOpen(false)
      }
    }

    document.body.style.overflow = 'hidden'
    window.addEventListener('keydown', handleKeyDown)

    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [mobileMenuOpen])

  const isAdmin = String(user?.role || '').toUpperCase() === 'ADMIN'
  const canManageProducts = String(user?.role || '').toUpperCase() === 'ADMIN' || hasPermission('products:write')
  const productsMenuLabel = canManageProducts ? 'Productos' : 'Catalogo de productos'
  const defaultHomePath = isAdmin ? '/dashboard' : '/products'
  const canAccessCash = hasPermission('cash:view') || hasPermission('cash:open') || hasPermission('cash:movements') || hasPermission('cash:close')
  const canAccessMyShipments = hasPermission('shipments:my:read')
  const showProcessesMenu = canSell() || hasPermission('credits:write') || hasPermission('purchases:read')
  const showCatalogMenu = hasPermission('products:read') || hasPermission('customers:read') || hasPermission('categories:read') || hasPermission('brands:read') || hasPermission('departments:read') || hasPermission('units:read') || hasPermission('suppliers:read')
  const showInventoryMenu = hasPermission('inventory:read')
  const showWarehousesMenu = hasPermission('shelves:read') || hasPermission('warehouses:read') || hasPermission('transfers:read')
  const showReportsMenu = hasPermission('sales:read') || hasPermission('credits:read') || hasPermission('cash:view') || hasPermission('cash:close')
  const showSystemMenu = hasPermission('config:read') || hasPermission('logs:read') || hasPermission('users:read') || hasPermission('roles:read')
  const showPrincipalMenu = isAdmin || canSell() || canAccessCash || canAccessMyShipments
  const isWarehouseRole = String(user?.role || '').toUpperCase() === 'ALMACEN'

  const openPOSWindow = (event?: React.MouseEvent<HTMLButtonElement>) => {
    event?.preventDefault()
    event?.stopPropagation()

    const posUrl = new URL('/pos', window.location.origin).toString()
    const anchor = document.createElement('a')
    anchor.href = posUrl
    anchor.target = 'dtmpos-pos-window'
    anchor.rel = 'noopener'
    anchor.style.display = 'none'
    document.body.appendChild(anchor)
    anchor.click()
    document.body.removeChild(anchor)

    setMobileMenuOpen(false)
  }

  const openQuotationWindow = (event?: React.MouseEvent<HTMLButtonElement>) => {
    event?.preventDefault()
    event?.stopPropagation()

    const quotationUrl = new URL('/quotations', window.location.origin).toString()
    const anchor = document.createElement('a')
    anchor.href = quotationUrl
    anchor.target = 'dtmpos-quotation-window'
    anchor.rel = 'noopener'
    anchor.style.display = 'none'
    document.body.appendChild(anchor)
    anchor.click()
    document.body.removeChild(anchor)

    setMobileMenuOpen(false)
  }

  const renderMobileMenuIcon = (kind: string) => {
    switch (kind) {
      case 'dashboard':
        return (
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path>
            <polyline points="9 22 9 12 15 12 15 22"></polyline>
          </svg>
        )
      case 'pos':
        return (
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"></path>
            <line x1="3" y1="6" x2="21" y2="6"></line>
            <path d="M16 10a4 4 0 0 1-8 0"></path>
          </svg>
        )
      case 'cash':
        return (
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="2" y="6" width="20" height="12" rx="2"></rect>
            <circle cx="12" cy="12" r="2"></circle>
            <path d="M6 12h.01M18 12h.01"></path>
          </svg>
        )
      case 'layers':
        return (
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polygon points="12 2 2 7 12 12 22 7 12 2"></polygon>
            <polyline points="2 17 12 22 22 17"></polyline>
            <polyline points="2 12 12 17 22 12"></polyline>
          </svg>
        )
      case 'catalog':
        return (
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path>
            <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"></path>
          </svg>
        )
      case 'inventory':
        return (
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="21 8 21 21 3 21 3 8"></polyline>
            <rect x="1" y="3" width="22" height="5"></rect>
            <line x1="10" y1="12" x2="14" y2="12"></line>
          </svg>
        )
      case 'warehouse':
        return (
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 21v-8a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v8"></path>
            <path d="M5 11V7a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v4"></path>
            <path d="M9 7v4"></path>
            <path d="M15 7v4"></path>
          </svg>
        )
      case 'reports':
        return (
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="20" x2="18" y2="10"></line>
            <line x1="12" y1="20" x2="12" y2="4"></line>
            <line x1="6" y1="20" x2="6" y2="14"></line>
          </svg>
        )
      case 'settings':
        return (
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3"></circle>
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
          </svg>
        )
      case 'user':
        return (
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20 21a8 8 0 1 0-16 0"></path>
            <circle cx="12" cy="7" r="4"></circle>
          </svg>
        )
      default:
        return (
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10"></circle>
          </svg>
        )
    }
  }

  const renderMobileMenuLinkCard = (to: string, label: string, description: string, icon: string) => (
    <Link to={to} className="mobile-menu-card" onClick={closeMobileMenu}>
      <span className="mobile-menu-card-icon">{renderMobileMenuIcon(icon)}</span>
      <span className="mobile-menu-card-title">{label}</span>
      <span className="mobile-menu-card-description">{description}</span>
    </Link>
  )

  const renderMobileMenuActionCard = (label: string, description: string, icon: string, onClick: () => void) => (
    <button type="button" className="mobile-menu-card" onClick={onClick}>
      <span className="mobile-menu-card-icon">{renderMobileMenuIcon(icon)}</span>
      <span className="mobile-menu-card-title">{label}</span>
      <span className="mobile-menu-card-description">{description}</span>
    </button>
  )

  const toggleMobileMenuSection = (section: string) => {
    setMobileMenuSections(prev => ({
      ...prev,
      [section]: !prev[section]
    }))
  }

  const renderMobileMenuSection = (section: string, title: string, icon: string, children: React.ReactNode) => {
    const isOpen = Boolean(mobileMenuSections[section])

    return (
      <div className={`mobile-menu-group${isOpen ? ' open' : ''}`}>
        <button
          type="button"
          className="mobile-menu-section-trigger"
          onClick={() => toggleMobileMenuSection(section)}
          aria-expanded={isOpen}
        >
          <span className="mobile-menu-section-trigger-main">
            <span className="mobile-menu-card-icon mobile-menu-section-icon">{renderMobileMenuIcon(icon)}</span>
            <span className="mobile-menu-title">{title}</span>
          </span>
          <span className={`mobile-menu-section-chevron${isOpen ? ' open' : ''}`}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="6 9 12 15 18 9"></polyline>
            </svg>
          </span>
        </button>
        {isOpen && (
          <div className="mobile-menu-cards">
            {children}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="app">
      <header className="header">
        <div className="brand" onClick={() => navigate(defaultHomePath) }>
          {config?.logoUrl && <img src={config.logoUrl} alt="logo" />}
          <div>
            <strong>{companyName}</strong>
            <small>{config?.currency ?? 'USD'}</small>
          </div>
        </div>
        <nav className="nav nav-desktop">
          {isAdmin && (
            <Link to="/dashboard" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path>
                <polyline points="9 22 9 12 15 12 15 22"></polyline>
              </svg>
              <span>DASHBOARD</span>
            </Link>
          )}
          {canSell() && (
            <button
              type="button"
              onClick={openPOSWindow}
              style={{ fontWeight: 'bold', color: '#2ecc71', display: 'flex', alignItems: 'center', gap: '8px', background: 'rgba(46, 204, 113, 0.1)', padding: '6px 12px', borderRadius: '8px', border: 'none', cursor: 'pointer' }}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"></path>
                <line x1="3" y1="6" x2="21" y2="6"></line>
                <path d="M16 10a4 4 0 0 1-8 0"></path>
              </svg>
              <span>VENTAS / POS</span>
            </button>
          )}

          {canAccessCash && (
            <Link to="/cash-register" style={{ fontWeight: 'bold', color: '#eab308', display: 'flex', alignItems: 'center', gap: '8px', background: 'rgba(234, 179, 8, 0.1)', padding: '6px 12px', borderRadius: '8px' }}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="2" y="6" width="20" height="12" rx="2"></rect>
                <circle cx="12" cy="12" r="2"></circle>
                <path d="M6 12h.01M18 12h.01"></path>
              </svg>
              <span>CAJA</span>
            </Link>
          )}
          {(isAdmin || canAccessMyShipments) && (
            <Link to="/my-shipments" style={{ fontWeight: 'bold', color: '#3b82f6', display: 'flex', alignItems: 'center', gap: '8px', background: 'rgba(59, 130, 246, 0.10)', padding: '6px 12px', borderRadius: '8px' }}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 7h11v10H3z"></path>
                <path d="M14 10h4l3 3v4h-7z"></path>
                <circle cx="7.5" cy="19" r="1.5"></circle>
                <circle cx="17.5" cy="19" r="1.5"></circle>
              </svg>
              <span>ENTREGAS</span>
            </Link>
          )}
          {showProcessesMenu && (
            <div className="nav-group">
              <button className="nav-trigger" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polygon points="12 2 2 7 12 12 22 7 12 2"></polygon>
                  <polyline points="2 17 12 22 22 17"></polyline>
                  <polyline points="2 12 12 17 22 12"></polyline>
                </svg>
                <span>PROCESOS</span>
              </button>
              <div className="nav-panel">
                {canSell() && (
                  <button
                    type="button"
                    onClick={openQuotationWindow}
                    style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', textAlign: 'left', width: '100%' }}
                  >
                    Cotizaciones
                  </button>
                )}
                {hasPermission('credits:write') && <Link to="/credits">Créditos</Link>}
                {hasPermission('purchases:read') && <Link to="/purchases">Compras</Link>}
              </div>
            </div>
          )}

          {showCatalogMenu && (
          <div className="nav-group">
            <button className="nav-trigger" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path>
                <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"></path>
              </svg>
              <span>CATÁLOGO</span>
            </button>
            <div className="nav-panel">
              {hasPermission('products:read') && <Link to="/products">{productsMenuLabel}</Link>}
              {hasPermission('customers:read') && <Link to="/customers">Clientes</Link>}
              {hasPermission('categories:read') && <Link to="/categories">Categorías</Link>}
              {hasPermission('brands:read') && <Link to="/brands">Marcas</Link>}
              {hasPermission('departments:read') && <Link to="/departments">Departamentos</Link>}
              {hasPermission('units:read') && <Link to="/units">Unidades</Link>}
              {hasPermission('suppliers:read') && <Link to="/suppliers">Proveedores</Link>}
            </div>
          </div>
          )}

          {/* Inventory Group */}
          {showInventoryMenu && (
          <div className="nav-group">
            <button className="nav-trigger" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="21 8 21 21 3 21 3 8"></polyline>
                <rect x="1" y="3" width="22" height="5"></rect>
                <line x1="10" y1="12" x2="14" y2="12"></line>
              </svg>
              <span>INVENTARIO</span>
            </button>
            <div className="nav-panel">
              <Link to="/inventory">Movimientos</Link>
              <Link to="/inventory/report">Reporte Stock</Link>
            </div>
          </div>
          )}

          {/* Warehouses Group */}
          {showWarehousesMenu && (
          <div className="nav-group">
            <button className="nav-trigger" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 21v-8a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v8"></path>
                <path d="M5 11V7a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v4"></path>
                <path d="M9 7v4"></path>
                <path d="M15 7v4"></path>
              </svg>
              <span>ALMACENES</span>
            </button>
            <div className="nav-panel">
              {hasPermission('warehouses:read') && <Link to="/warehouses">Almacenes/Tiendas</Link>}
              {hasPermission('transfers:read') && <Link to="/transfers">Traslados</Link>}
              {(isAdmin || isWarehouseRole) && <Link to="/shipments">Despachos</Link>}
              {hasPermission('shelves:read') && <Link to="/shelves">Ubicaciones</Link>}
            </div>
          </div>
          )}

          {showReportsMenu && (
            <div className="nav-group">
              <button className="nav-trigger" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="20" x2="18" y2="10"></line>
                  <line x1="12" y1="20" x2="12" y2="4"></line>
                  <line x1="6" y1="20" x2="6" y2="14"></line>
                </svg>
                <span>REPORTES</span>
              </button>
              <div className="nav-panel">
                {hasPermission('sales:read') && (user?.role === 'ADMIN' ? <Link to="/sales">Historial Ventas</Link> : <Link to="/my-sales">Mis Ventas</Link>)}
                {canAccessCash && !isAdmin && <Link to="/my-collections">Mis Cobros</Link>}
                {hasPermission('credits:read') && <Link to="/credit-reports">Reporte Créditos</Link>}
                {(hasPermission('cash:view') || hasPermission('cash:close')) && <Link to="/cash-history">Cierres de Caja</Link>}
              </div>
            </div>
          )}

          {showSystemMenu && (
          <div className="nav-group">
            <button className="nav-trigger" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="3"></circle>
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
              </svg>
              <span>SISTEMA</span>
            </button>
            <div className="nav-panel">
              {hasPermission('config:read') && <Link to="/config">Config</Link>}
              {hasPermission('logs:read') && <Link to="/logs">Logs</Link>}
              {hasPermission('users:read') && <Link to="/users">Usuarios</Link>}
              {hasPermission('roles:read') && <Link to="/roles">Roles</Link>}
            </div>
          </div>
          )}
        </nav>
        <div className="header-actions">
          <div className="user">
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>
                <circle cx="12" cy="7" r="4"></circle>
              </svg>
              <span>{user?.name} ({user?.role})</span>
            </span>
            <button onClick={logout} style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path>
                <path d="M16 17l5-5-5-5"></path>
                <path d="M21 12H9"></path>
              </svg>
              <span>Salir</span>
            </button>
          </div>
          <button
            type="button"
            className="mobile-menu-btn"
            onClick={() => setMobileMenuOpen(prev => !prev)}
            aria-label={mobileMenuOpen ? 'Cerrar menu' : 'Abrir menu'}
            aria-expanded={mobileMenuOpen}
          >
            {mobileMenuOpen ? 'Cerrar' : 'Menu'}
          </button>
        </div>
      </header>
      {mobileMenuOpen && (
        <div className="mobile-menu-backdrop" onClick={closeMobileMenu}>
          <div
            className="mobile-menu-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="Menu principal"
            onClick={event => event.stopPropagation()}
          >
            <div className="mobile-menu-dialog-header">
              <div>
                <div className="mobile-menu-dialog-title">Menú</div>
                <div className="mobile-menu-dialog-subtitle">Accesos rápidos del sistema</div>
              </div>
              <button type="button" className="mobile-menu-dialog-close" onClick={closeMobileMenu} aria-label="Cerrar menu">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18"></line>
                  <line x1="6" y1="6" x2="18" y2="18"></line>
                </svg>
              </button>
            </div>

            <div className="mobile-menu-dialog-body">
              <div className="mobile-menu-grid">
                {showPrincipalMenu && renderMobileMenuSection('principal', 'Principal', 'dashboard', (
                  <>
                    {isAdmin && renderMobileMenuLinkCard('/dashboard', 'Dashboard', 'Resumen general', 'dashboard')}
                    {canSell() && renderMobileMenuActionCard('Ventas / POS', 'Abrir punto de venta', 'pos', () => openPOSWindow())}
                    {canAccessCash &&
                      renderMobileMenuLinkCard('/cash-register', 'Caja', 'Operaciones de caja', 'cash')}
                    {(isAdmin || canAccessMyShipments) && renderMobileMenuLinkCard('/my-shipments', 'Entregas', 'Mis entregas asignadas', 'warehouse')}
                  </>
                ))}

                {showProcessesMenu && (
                  renderMobileMenuSection('procesos', 'Procesos', 'layers', (
                    <>
                      {canSell() && renderMobileMenuActionCard('Cotizaciones', 'Abrir cotizador', 'layers', () => openQuotationWindow())}
                      {hasPermission('credits:write') && renderMobileMenuLinkCard('/credits', 'Créditos', 'Gestionar cobros', 'layers')}
                      {hasPermission('purchases:read') && renderMobileMenuLinkCard('/purchases', 'Compras', 'Registrar entradas', 'layers')}
                    </>
                  ))
                )}

                {showCatalogMenu && (
                  renderMobileMenuSection('catalogo', 'Catálogo', 'catalog', (
                    <>
                      {hasPermission('products:read') && renderMobileMenuLinkCard('/products', productsMenuLabel, 'Listado principal', 'catalog')}
                      {hasPermission('customers:read') && renderMobileMenuLinkCard('/customers', 'Clientes', 'Gestionar clientes', 'catalog')}
                      {hasPermission('categories:read') && renderMobileMenuLinkCard('/categories', 'Categorías', 'Organizar productos', 'catalog')}
                      {hasPermission('brands:read') && renderMobileMenuLinkCard('/brands', 'Marcas', 'Gestionar marcas', 'catalog')}
                      {hasPermission('departments:read') && renderMobileMenuLinkCard('/departments', 'Departamentos', 'Clasificación interna', 'catalog')}
                      {hasPermission('units:read') && renderMobileMenuLinkCard('/units', 'Unidades', 'Medidas de venta', 'catalog')}
                      {hasPermission('suppliers:read') && renderMobileMenuLinkCard('/suppliers', 'Proveedores', 'Relación comercial', 'catalog')}
                    </>
                  ))
                )}

                {showInventoryMenu && (
                  renderMobileMenuSection('inventario', 'Inventario', 'inventory', (
                    <>
                      {renderMobileMenuLinkCard('/inventory', 'Movimientos', 'Entradas y ajustes', 'inventory')}
                      {renderMobileMenuLinkCard('/inventory/report', 'Reporte stock', 'Resumen de existencias', 'inventory')}
                    </>
                  ))
                )}

                {showWarehousesMenu && (
                  renderMobileMenuSection('almacenes', 'Almacenes', 'warehouse', (
                    <>
                      {hasPermission('warehouses:read') && renderMobileMenuLinkCard('/warehouses', 'Almacenes', 'Tiendas y bodegas', 'warehouse')}
                      {hasPermission('transfers:read') && renderMobileMenuLinkCard('/transfers', 'Traslados', 'Mover existencias', 'warehouse')}
                      {(isAdmin || isWarehouseRole) && renderMobileMenuLinkCard('/shipments', 'Despachos', 'Asignar entregas', 'warehouse')}
                      {hasPermission('shelves:read') && renderMobileMenuLinkCard('/shelves', 'Ubicaciones', 'Estantes y zonas', 'warehouse')}
                    </>
                  ))
                )}

                {showReportsMenu && (
                  renderMobileMenuSection('reportes', 'Reportes', 'reports', (
                    <>
                      {hasPermission('sales:read') &&
                        (user?.role === 'ADMIN'
                          ? renderMobileMenuLinkCard('/sales', 'Historial ventas', 'Ventas registradas', 'reports')
                          : renderMobileMenuLinkCard('/my-sales', 'Mis ventas', 'Historial personal', 'reports'))}
                      {canAccessCash && !isAdmin && renderMobileMenuLinkCard('/my-collections', 'Mis cobros', 'Ventas cobradas por ti', 'reports')}
                      {hasPermission('credits:read') && renderMobileMenuLinkCard('/credit-reports', 'Créditos', 'Reporte de cobros', 'reports')}
                      {(hasPermission('cash:view') || hasPermission('cash:close')) &&
                        renderMobileMenuLinkCard('/cash-history', 'Cierres caja', 'Historial de cierres', 'reports')}
                    </>
                  ))
                )}

                {showSystemMenu && renderMobileMenuSection('sistema', 'Sistema', 'settings', (
                  <>
                    {hasPermission('config:read') && renderMobileMenuLinkCard('/config', 'Config', 'Ajustes del sistema', 'settings')}
                    {hasPermission('logs:read') && renderMobileMenuLinkCard('/logs', 'Logs', 'Registro de eventos', 'settings')}
                    {hasPermission('users:read') && renderMobileMenuLinkCard('/users', 'Usuarios', 'Accesos y cuentas', 'settings')}
                    {hasPermission('roles:read') && renderMobileMenuLinkCard('/roles', 'Roles', 'Permisos del sistema', 'settings')}
                  </>
                ))}
              </div>

              <div className="mobile-menu-session">
                <div className="mobile-menu-session-info">
                  <span className="mobile-menu-card-icon">{renderMobileMenuIcon('user')}</span>
                  <div>
                    <div className="mobile-menu-session-name">{user?.name}</div>
                    <div className="mobile-menu-session-role">{user?.role}</div>
                  </div>
                </div>
                <button type="button" className="mobile-menu-session-logout" onClick={() => { logout(); closeMobileMenu() }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path>
                      <path d="M16 17l5-5-5-5"></path>
                      <path d="M21 12H9"></path>
                    </svg>
                    <span>Salir</span>
                  </span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      <main className="main">
        <Outlet />
      </main>
    </div>
  )
}
