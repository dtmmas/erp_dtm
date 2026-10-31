import { useEffect, useRef, useState } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import Login from './pages/Login'
import Dashboard from './pages/Dashboard'
import Products from './pages/Products'
import ProtectedRoute from './components/ProtectedRoute'
import Layout from './components/Layout'
import { useConfigStore } from './store/config'
import RoleGuard from './components/RoleGuard'
import Config from './pages/Config'
import Categories from './pages/Categories'
import Brands from './pages/Brands'
import Suppliers from './pages/Suppliers'
import Units from './pages/Units'
import Departments from './pages/Departments'
import Shelves from './pages/Shelves'
import POS from './pages/POS'
import Customers from './pages/Customers'
import Sales from './pages/Sales'
import MySalesReport from './pages/MySalesReport'
import MyCollectionsReport from './pages/MyCollectionsReport'
import Credits from './pages/Credits'
import CreditReports from './pages/CreditReports'
import Logs from './pages/Logs'
import Roles from './pages/Roles'
import Users from './pages/Users'
import Purchases from './pages/Purchases'
import PurchaseCreate from './pages/PurchaseCreate'
import PurchaseDetails from './pages/PurchaseDetails'
import PermissionGuard from './components/PermissionGuard'
import Warehouses from './pages/Warehouses'
import InventoryMovements from './pages/InventoryMovements'
import InventoryReport from './pages/InventoryReport'
import Transfers from './pages/Transfers'
import CashRegister from './pages/CashRegister'
import CashHistory from './pages/CashHistory'
import ShipmentsAdmin from './pages/ShipmentsAdmin'
import MyShipments from './pages/MyShipments'
import NoAccess from './pages/NoAccess'
import { formatCompanyName } from './utils/text'
import AlertHost from './components/AlertHost'
import { useAuthStore } from './store/auth'
import { THEME_COLOR_OPTIONS, useThemeStore } from './store/theme'

function RootLanding() {
  const user = useAuthStore(s => s.user)
  const hasPermission = useAuthStore(s => s.hasPermission)
  const canSell = useAuthStore(s => s.canSell)
  const isAdmin = String(user?.role || '').toUpperCase() === 'ADMIN'

  if (isAdmin) return <Navigate to="/dashboard" replace />
  if (hasPermission('products:read')) return <Navigate to="/products" replace />
  if (canSell()) return <Navigate to="/pos" replace />
  if (hasPermission('cash:view') || hasPermission('cash:open') || hasPermission('cash:movements') || hasPermission('cash:close')) {
    return <Navigate to="/cash-register" replace />
  }
  return <Navigate to="/no-access" replace />
}

function ThemeFab() {
  const theme = useThemeStore(s => s.theme)
  const mode = useThemeStore(s => s.mode)
  const color = useThemeStore(s => s.color)
  const setMode = useThemeStore(s => s.setMode)
  const setColor = useThemeStore(s => s.setColor)
  const [open, setOpen] = useState(false)
  const scopeRef = useRef<HTMLDivElement | null>(null)

  const currentThemeOption = THEME_COLOR_OPTIONS.find((option) => option.value === color) ?? THEME_COLOR_OPTIONS[0]

  useEffect(() => {
    if (!open) return
    const onMouseDown = (event: MouseEvent) => {
      const target = event.target as Node | null
      if (!target) return
      if (scopeRef.current && !scopeRef.current.contains(target)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  const renderThemePalette = () => (
    <div className="theme-color-picker" aria-label="Selector de color del tema">
      {THEME_COLOR_OPTIONS.map((option) => (
        <button
          key={option.value}
          type="button"
          className={`theme-color-btn${color === option.value ? ' active' : ''}`}
          onClick={() => setColor(option.value)}
          aria-label={`Usar tema ${option.label}`}
          title={`Tema ${option.label}`}
        >
          <span className="theme-color-dot" style={{ background: option.preview }} />
          <span className="theme-color-name">{option.label}</span>
        </button>
      ))}
    </div>
  )

  return (
    <div className="theme-fab" ref={scopeRef}>
      {open && (
        <div className="theme-fab-menu" role="dialog" aria-label="Opciones de tema">
          <div className="theme-fab-section">
            <div className="theme-fab-title">Modo</div>
            <div className="view-toggle theme-fab-toggle" aria-label="Selector de modo de tema">
              <button
                type="button"
                className={`toggle-btn theme-fab-icon-toggle ${mode === 'light' ? 'active' : ''}`}
                onClick={() => setMode('light')}
                aria-label="Tema claro"
                title="Claro"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M12 2v2"></path>
                  <path d="M12 20v2"></path>
                  <path d="m4.93 4.93 1.41 1.41"></path>
                  <path d="m17.66 17.66 1.41 1.41"></path>
                  <path d="M2 12h2"></path>
                  <path d="M20 12h2"></path>
                  <path d="m6.34 17.66-1.41 1.41"></path>
                  <path d="m19.07 4.93-1.41 1.41"></path>
                  <circle cx="12" cy="12" r="4"></circle>
                </svg>
              </button>
              <button
                type="button"
                className={`toggle-btn theme-fab-icon-toggle ${mode === 'dark' ? 'active' : ''}`}
                onClick={() => setMode('dark')}
                aria-label="Tema oscuro"
                title="Oscuro"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M12 3a6.5 6.5 0 1 0 9.2 9.2A7.5 7.5 0 1 1 12 3z"></path>
                </svg>
              </button>
            </div>
          </div>

          <div className="theme-fab-section">
            <div className="theme-fab-title">Color</div>
            {renderThemePalette()}
          </div>
        </div>
      )}
      <button
        type="button"
        className="theme-fab-trigger"
        onClick={() => setOpen((prev) => !prev)}
        aria-label="Abrir opciones de tema"
        aria-expanded={open}
      >
        <span className="theme-fab-dot" style={{ background: currentThemeOption.preview }} aria-hidden="true" />
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M14.7 6.3a2.5 2.5 0 0 0-3.5 0L3 14.5V21h6.5l8.2-8.2a2.5 2.5 0 0 0 0-3.5z"></path>
          <path d="m12.5 7.5 4 4"></path>
        </svg>
        {theme === 'dark' ? (
          <svg className="theme-fab-mode-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 3a6.5 6.5 0 1 0 9.2 9.2A7.5 7.5 0 1 1 12 3z"></path>
          </svg>
        ) : (
          <svg className="theme-fab-mode-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="4"></circle>
            <path d="M12 2v2"></path>
            <path d="M12 20v2"></path>
            <path d="m4.93 4.93 1.41 1.41"></path>
            <path d="m17.66 17.66 1.41 1.41"></path>
            <path d="M2 12h2"></path>
            <path d="M20 12h2"></path>
            <path d="m6.34 17.66-1.41 1.41"></path>
            <path d="m19.07 4.93-1.41 1.41"></path>
          </svg>
        )}
      </button>
    </div>
  )
}

export default function App() {
  const fetchConfig = useConfigStore(s => s.fetchConfig)
  const config = useConfigStore(s => s.config)
  const canSell = useAuthStore(s => s.canSell)

  useEffect(() => { fetchConfig() }, [fetchConfig])
  useEffect(() => {
    document.title = formatCompanyName(config?.name)
  }, [config?.name])

  return (
    <>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route
          path="/pos"
          element={
            <ProtectedRoute>
              {canSell() ? <POS /> : <Navigate to="/" />}
            </ProtectedRoute>
          }
        />
        <Route
          path="/quotations"
          element={
            <ProtectedRoute>
              {canSell() ? <POS mode="quote" /> : <Navigate to="/" />}
            </ProtectedRoute>
          }
        />
        <Route path="/" element={<ProtectedRoute><Layout /></ProtectedRoute>}>
          <Route index element={<RootLanding />} />
          <Route path="no-access" element={<NoAccess />} />
          <Route path="dashboard" element={<RoleGuard roles={['ADMIN']}><Dashboard /></RoleGuard>} />
          <Route path="products" element={<PermissionGuard permission="products:read"><Products /></PermissionGuard>} />
          <Route path="categories" element={<PermissionGuard permission="categories:read"><Categories /></PermissionGuard>} />
          <Route path="brands" element={<PermissionGuard permission="brands:read"><Brands /></PermissionGuard>} />
          <Route path="suppliers" element={<PermissionGuard permission="suppliers:read"><Suppliers /></PermissionGuard>} />
          <Route path="departments" element={<PermissionGuard permission="departments:read"><Departments /></PermissionGuard>} />
          <Route path="shelves" element={<PermissionGuard permission="shelves:read"><Shelves /></PermissionGuard>} />
          <Route path="warehouses" element={<PermissionGuard permission="warehouses:read"><Warehouses /></PermissionGuard>} />
          <Route path="transfers" element={<PermissionGuard permission="transfers:read"><Transfers /></PermissionGuard>} />
          <Route path="shipments" element={<RoleGuard roles={['ADMIN','ALMACEN']}><ShipmentsAdmin /></RoleGuard>} />
          <Route path="my-shipments" element={<PermissionGuard permission="shipments:my:read"><MyShipments /></PermissionGuard>} />
          <Route path="inventory" element={<PermissionGuard permission="inventory:read"><InventoryMovements /></PermissionGuard>} />
          <Route path="inventory/report" element={<PermissionGuard permission="inventory:read"><InventoryReport /></PermissionGuard>} />
          <Route path="customers" element={<PermissionGuard permission="customers:read"><Customers /></PermissionGuard>} />
          <Route path="credits" element={<PermissionGuard permission="credits:write"><Credits /></PermissionGuard>} />
          <Route path="sales" element={<PermissionGuard permission="sales:read"><RoleGuard roles={['ADMIN']}><Sales /></RoleGuard></PermissionGuard>} />
          <Route path="my-sales" element={<PermissionGuard permission="sales:read"><MySalesReport /></PermissionGuard>} />
          <Route path="my-collections" element={<PermissionGuard permission={["cash:view", "cash:open", "cash:movements", "cash:close"]}><MyCollectionsReport /></PermissionGuard>} />
          <Route path="purchases" element={<PermissionGuard permission="purchases:read"><Purchases /></PermissionGuard>} />
          <Route path="purchases/new" element={<PermissionGuard permission="purchases:write"><PurchaseCreate /></PermissionGuard>} />
          <Route path="purchases/:id" element={<PermissionGuard permission="purchases:read"><PurchaseDetails /></PermissionGuard>} />
          <Route path="credit-reports" element={<PermissionGuard permission="credits:read"><CreditReports /></PermissionGuard>} />
          <Route path="cash-register" element={<PermissionGuard permission={["cash:view", "cash:open", "cash:movements", "cash:close"]}><CashRegister /></PermissionGuard>} />
          <Route path="cash-history" element={<PermissionGuard permission={["cash:view", "cash:close", "sales:read"]}><CashHistory /></PermissionGuard>} />
          <Route path="units" element={<PermissionGuard permission="units:read"><Units /></PermissionGuard>} />
          <Route path="config" element={<PermissionGuard permission="config:read"><Config /></PermissionGuard>} />
          <Route path="logs" element={<PermissionGuard permission="logs:read"><Logs /></PermissionGuard>} />
          
          {/* New Role Management Routes */}
          <Route path="roles" element={<PermissionGuard permission="roles:read"><Roles /></PermissionGuard>} />
          <Route path="users" element={<PermissionGuard permission="users:read"><Users /></PermissionGuard>} />
        </Route>
        <Route path="*" element={<Navigate to="/" />} />
      </Routes>
      <AlertHost />
      <ThemeFab />
    </>
  )
}
