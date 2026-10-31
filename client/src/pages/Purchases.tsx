import React, { useEffect, useState } from 'react'
import { api, getSuppliers } from '../api'
import { useConfigStore } from '../store/config'
import { useNavigate } from 'react-router-dom'
import { useAuthStore } from '../store/auth'
import { formatMoney } from '../utils/currency'

interface SupplierOption {
  id: number
  name: string
}

interface Purchase {
  id: number
  supplier_id: number | null
  supplier_name: string | null
  user_id: number | null
  user_name: string | null
  doc_no: string | null
  total: number
  status: string
  payment_type: string
  payment_status: string
  payment_method: string
  paid_amount: number
  balance_due: number
  due_date?: string | null
  created_at: string
  notes: string | null
}

interface PurchaseSummary {
  totalRecords: number
  totalAmount: number
  totalPaid: number
  totalBalanceDue: number
}

function getPaymentStatusStyles(status?: string) {
  const normalized = String(status || '').toUpperCase()
  if (normalized === 'PAID') {
    return { label: 'PAGADO', background: 'rgba(34, 197, 94, 0.14)', color: '#16a34a' }
  }
  if (normalized === 'PARTIAL') {
    return { label: 'ABONADO', background: 'rgba(245, 158, 11, 0.14)', color: '#d97706' }
  }
  return { label: 'POR PAGAR', background: 'rgba(239, 68, 68, 0.14)', color: '#dc2626' }
}

function getPaymentTypeLabel(type?: string) {
  return String(type || '').toUpperCase() === 'CREDIT' ? 'Credito' : 'Contado'
}

export default function Purchases() {
  const [purchases, setPurchases] = useState<Purchase[]>([])
  const [suppliers, setSuppliers] = useState<SupplierOption[]>([])
  const [loading, setLoading] = useState(false)
  const [search, setSearch] = useState('')
  const [paymentStatusFilter, setPaymentStatusFilter] = useState<'ALL' | 'PAID' | 'PARTIAL' | 'PENDING'>('ALL')
  const [supplierFilter, setSupplierFilter] = useState<string>('ALL')
  const [startDateFilter, setStartDateFilter] = useState('')
  const [endDateFilter, setEndDateFilter] = useState('')
  const [summary, setSummary] = useState<PurchaseSummary>({
    totalRecords: 0,
    totalAmount: 0,
    totalPaid: 0,
    totalBalanceDue: 0,
  })
  const [page, setPage] = useState(0)
  const [totalRecords, setTotalRecords] = useState(0)
  const [isMobileViewport, setIsMobileViewport] = useState(false)
  const limit = 50
  
  const config = useConfigStore(s => s.config)
  const navigate = useNavigate()
  const { hasPermission } = useAuthStore()

  useEffect(() => {
    loadPurchases()
  }, [page, search, paymentStatusFilter, supplierFilter, startDateFilter, endDateFilter])

  useEffect(() => {
    loadSuppliers()
  }, [])

  useEffect(() => {
    const mediaQuery = window.matchMedia('(max-width: 768px)')
    const syncViewport = () => setIsMobileViewport(mediaQuery.matches)
    syncViewport()
    mediaQuery.addEventListener('change', syncViewport)
    return () => mediaQuery.removeEventListener('change', syncViewport)
  }, [])

  async function loadPurchases() {
    setLoading(true)
    try {
      const { data } = await api.get('/purchases', {
        params: {
          limit,
          offset: page * limit,
          search,
          paymentStatus: paymentStatusFilter === 'ALL' ? undefined : paymentStatusFilter,
          supplierId: supplierFilter === 'ALL' ? undefined : Number(supplierFilter),
          startDate: startDateFilter || undefined,
          endDate: endDateFilter || undefined,
        }
      })
      setPurchases(data.data)
      setTotalRecords(data.pagination.total)
      setSummary({
        totalRecords: Number(data.summary?.totalRecords || 0),
        totalAmount: Number(data.summary?.totalAmount || 0),
        totalPaid: Number(data.summary?.totalPaid || 0),
        totalBalanceDue: Number(data.summary?.totalBalanceDue || 0),
      })
    } catch (err) {
      console.error(err)
    } finally {
      setLoading(false)
    }
  }

  async function loadSuppliers() {
    try {
      const data = await getSuppliers()
      setSuppliers(Array.isArray(data) ? data : [])
    } catch (err) {
      console.error(err)
    }
  }

  function clearFilters() {
    setSearch('')
    setPaymentStatusFilter('ALL')
    setSupplierFilter('ALL')
    setStartDateFilter('')
    setEndDateFilter('')
    setPage(0)
  }

  return (
    <div className="page-shell" style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div className="page-toolbar" style={{ marginBottom: 20 }}>
        <h1 style={{ margin: 0 }}>Compras</h1>
        {hasPermission('purchases:write') && (
          <button 
            className="btn-primary"
            onClick={() => navigate('/purchases/new')}
            style={{ display: 'flex', alignItems: 'center', gap: 8 }}
          >
            <span style={{ fontSize: '1.2rem' }}>+</span> Nueva Compra
          </button>
        )}
      </div>

      <div style={{ 
        display: 'flex', 
        flexWrap: 'wrap',
        gap: 16, 
        marginBottom: 20, 
        backgroundColor: 'var(--modal)', 
        padding: 16, 
        borderRadius: 8,
        border: '1px solid var(--border)' 
      }}>
        <input 
          type="text" 
          placeholder="Buscar por doc, proveedor, ID..." 
          value={search}
          onChange={e => { setSearch(e.target.value); setPage(0) }}
          style={{ flex: 1, minWidth: isMobileViewport ? '100%' : 280, padding: 8, borderRadius: 4, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)' }}
        />
        <select
          value={paymentStatusFilter}
          onChange={e => { setPaymentStatusFilter(e.target.value as 'ALL' | 'PAID' | 'PARTIAL' | 'PENDING'); setPage(0) }}
          style={{ minWidth: isMobileViewport ? '100%' : 200, padding: 8, borderRadius: 4, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)' }}
        >
          <option value="ALL">Todos los pagos</option>
          <option value="PAID">Pagado</option>
          <option value="PARTIAL">Abonado</option>
          <option value="PENDING">Por pagar</option>
        </select>
        <select
          value={supplierFilter}
          onChange={e => { setSupplierFilter(e.target.value); setPage(0) }}
          style={{ minWidth: isMobileViewport ? '100%' : 240, padding: 8, borderRadius: 4, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)' }}
        >
          <option value="ALL">Todos los proveedores</option>
          {suppliers.map(s => (
            <option key={s.id} value={String(s.id)}>{s.name}</option>
          ))}
        </select>
        <input
          type="date"
          value={startDateFilter}
          onChange={e => { setStartDateFilter(e.target.value); setPage(0) }}
          style={{ minWidth: isMobileViewport ? '100%' : 170, padding: 8, borderRadius: 4, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)' }}
          aria-label="Fecha desde"
        />
        <input
          type="date"
          value={endDateFilter}
          onChange={e => { setEndDateFilter(e.target.value); setPage(0) }}
          style={{ minWidth: isMobileViewport ? '100%' : 170, padding: 8, borderRadius: 4, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)' }}
          aria-label="Fecha hasta"
        />
        <button
          type="button"
          className="btn-secondary"
          onClick={clearFilters}
          style={{ width: isMobileViewport ? '100%' : 'auto' }}
        >
          Limpiar filtros
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: isMobileViewport ? 'repeat(2, minmax(0, 1fr))' : 'repeat(4, minmax(0, 1fr))', gap: 12, marginBottom: 20 }}>
        <div style={{ border: '1px solid var(--border)', borderRadius: 12, backgroundColor: 'var(--modal)', padding: 14 }}>
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>Registros filtrados</div>
          <div style={{ fontWeight: 800, fontSize: isMobileViewport ? '1rem' : '1.1rem' }}>{summary.totalRecords}</div>
        </div>
        <div style={{ border: '1px solid var(--border)', borderRadius: 12, backgroundColor: 'var(--modal)', padding: 14 }}>
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>Total filtrado</div>
          <div style={{ fontWeight: 800, fontSize: isMobileViewport ? '1rem' : '1.1rem' }}>{formatMoney(summary.totalAmount, config?.currency)}</div>
        </div>
        <div style={{ border: '1px solid var(--border)', borderRadius: 12, backgroundColor: 'var(--modal)', padding: 14 }}>
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>Pagado filtrado</div>
          <div style={{ fontWeight: 800, fontSize: isMobileViewport ? '1rem' : '1.1rem', color: '#22c55e' }}>{formatMoney(summary.totalPaid, config?.currency)}</div>
        </div>
        <div style={{ border: '1px solid var(--border)', borderRadius: 12, backgroundColor: 'var(--modal)', padding: 14 }}>
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>Pendiente filtrado</div>
          <div style={{ fontWeight: 800, fontSize: isMobileViewport ? '1rem' : '1.1rem', color: summary.totalBalanceDue > 0 ? '#f59e0b' : '#22c55e' }}>
            {formatMoney(summary.totalBalanceDue, config?.currency)}
          </div>
        </div>
      </div>

      {isMobileViewport ? (
        <div style={{ display: 'grid', gap: 12, flex: 1 }}>
          {purchases.map(p => {
            const paymentMeta = getPaymentStatusStyles(p.payment_status)
            return (
              <div key={p.id} style={{ border: '1px solid var(--border)', borderRadius: 12, backgroundColor: 'var(--modal)', padding: 14, display: 'grid', gap: 10 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start' }}>
                  <div>
                    <div style={{ fontWeight: 800 }}>#{p.id}</div>
                    <div style={{ fontSize: 12, color: 'var(--muted)' }}>{new Date(p.created_at).toLocaleString()}</div>
                  </div>
                  <span style={{
                    padding: '4px 8px',
                    borderRadius: 999,
                    backgroundColor: paymentMeta.background,
                    color: paymentMeta.color,
                    fontWeight: 'bold',
                    fontSize: '0.75rem'
                  }}>
                    {paymentMeta.label}
                  </span>
                </div>
                <div style={{ display: 'grid', gap: 6, fontSize: 13 }}>
                  <div><strong>Proveedor:</strong> {p.supplier_name || '-'}</div>
                  <div><strong>Documento:</strong> {p.doc_no || '-'}</div>
                  <div><strong>Usuario:</strong> {p.user_name || '-'}</div>
                  <div><strong>Tipo:</strong> {getPaymentTypeLabel(p.payment_type)} · {p.payment_method === 'CASH' ? 'Efectivo' : p.payment_method === 'CARD' ? 'Tarjeta' : 'Deposito'}</div>
                  <div><strong>Pagado:</strong> {formatMoney(Number(p.paid_amount || 0), config?.currency)}</div>
                  <div><strong>Pendiente:</strong> {formatMoney(Number(p.balance_due || 0), config?.currency)}</div>
                  {p.due_date && Number(p.balance_due || 0) > 0 && <div><strong>Vence:</strong> {new Date(p.due_date).toLocaleDateString()}</div>}
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
                  <div style={{ fontWeight: 800, fontSize: '1rem' }}>{formatMoney(Number(p.total), config?.currency)}</div>
                  <button onClick={() => navigate(`/purchases/${p.id}`)} className="icon-btn" title="Ver Detalles">👁️</button>
                </div>
              </div>
            )
          })}
          {purchases.length === 0 && !loading && (
            <div style={{ padding: 24, textAlign: 'center', color: 'var(--muted)', border: '1px solid var(--border)', borderRadius: 8, backgroundColor: 'var(--modal)' }}>
              No hay compras registradas
            </div>
          )}
        </div>
      ) : (
      <div className="table-scroll" style={{ flex: 1, overflow: 'auto', border: '1px solid var(--border)', borderRadius: 8, backgroundColor: 'var(--modal)' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead style={{ position: 'sticky', top: 0, backgroundColor: 'var(--surface)', zIndex: 1 }}>
            <tr>
              <th style={{ padding: 12, textAlign: 'left', borderBottom: '2px solid var(--border)' }}>ID</th>
              <th style={{ padding: 12, textAlign: 'left', borderBottom: '2px solid var(--border)' }}>Fecha</th>
              <th style={{ padding: 12, textAlign: 'left', borderBottom: '2px solid var(--border)' }}>Proveedor</th>
              <th style={{ padding: 12, textAlign: 'left', borderBottom: '2px solid var(--border)' }}>Doc No.</th>
              <th style={{ padding: 12, textAlign: 'left', borderBottom: '2px solid var(--border)' }}>Usuario</th>
              <th style={{ padding: 12, textAlign: 'left', borderBottom: '2px solid var(--border)' }}>Tipo</th>
              <th style={{ padding: 12, textAlign: 'right', borderBottom: '2px solid var(--border)' }}>Total</th>
              <th style={{ padding: 12, textAlign: 'right', borderBottom: '2px solid var(--border)' }}>Pagado</th>
              <th style={{ padding: 12, textAlign: 'right', borderBottom: '2px solid var(--border)' }}>Pendiente</th>
              <th style={{ padding: 12, textAlign: 'center', borderBottom: '2px solid var(--border)' }}>Pago</th>
              <th style={{ padding: 12, textAlign: 'center', borderBottom: '2px solid var(--border)' }}>Acciones</th>
            </tr>
          </thead>
          <tbody>
            {purchases.map(p => (
              (() => {
                const paymentMeta = getPaymentStatusStyles(p.payment_status)
                return (
              <tr key={p.id} style={{ borderBottom: '1px solid var(--border)' }}>
                <td style={{ padding: 12 }}>#{p.id}</td>
                <td style={{ padding: 12 }}>{new Date(p.created_at).toLocaleString()}</td>
                <td style={{ padding: 12 }}>{p.supplier_name || '-'}</td>
                <td style={{ padding: 12 }}>{p.doc_no || '-'}</td>
                <td style={{ padding: 12 }}>{p.user_name || '-'}</td>
                <td style={{ padding: 12 }}>{getPaymentTypeLabel(p.payment_type)}</td>
                <td style={{ padding: 12, textAlign: 'right', fontWeight: 'bold' }}>
                  {formatMoney(Number(p.total), config?.currency)}
                </td>
                <td style={{ padding: 12, textAlign: 'right' }}>{formatMoney(Number(p.paid_amount || 0), config?.currency)}</td>
                <td style={{ padding: 12, textAlign: 'right', color: Number(p.balance_due || 0) > 0 ? '#f59e0b' : 'inherit', fontWeight: 700 }}>
                  {formatMoney(Number(p.balance_due || 0), config?.currency)}
                </td>
                <td style={{ padding: 12, textAlign: 'center' }}>
                  <span style={{ 
                    padding: '4px 8px', 
                    borderRadius: 4, 
                    backgroundColor: paymentMeta.background,
                    color: paymentMeta.color,
                    fontWeight: 'bold',
                    fontSize: '0.8rem'
                  }}>
                    {paymentMeta.label}
                  </span>
                </td>
                <td style={{ padding: 12, textAlign: 'center' }}>
                  <button 
                    onClick={() => navigate(`/purchases/${p.id}`)}
                    className="icon-btn"
                    title="Ver Detalles"
                  >
                    👁️
                  </button>
                </td>
              </tr>
                )
              })()
            ))}
            {purchases.length === 0 && !loading && (
              <tr>
                <td colSpan={10} style={{ padding: 24, textAlign: 'center', color: 'var(--muted)' }}>
                  No hay compras registradas
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      )}
      
      {/* Pagination */}
      <div style={{ display: 'flex', justifyContent: isMobileViewport ? 'stretch' : 'flex-end', alignItems: 'center', gap: 10, marginTop: 10, flexWrap: 'wrap', flexDirection: isMobileViewport ? 'column' : 'row' }}>
        <button 
          disabled={page === 0}
          onClick={() => setPage(p => p - 1)}
          className="btn-secondary"
          style={{ width: isMobileViewport ? '100%' : undefined }}
        >
          Anterior
        </button>
        <span style={{ display: 'flex', alignItems: 'center' }}>
          Página {page + 1} de {Math.ceil(totalRecords / limit) || 1}
        </span>
        <button 
          disabled={(page + 1) * limit >= totalRecords}
          onClick={() => setPage(p => p + 1)}
          className="btn-secondary"
          style={{ width: isMobileViewport ? '100%' : undefined }}
        >
          Siguiente
        </button>
      </div>
    </div>
  )
}
