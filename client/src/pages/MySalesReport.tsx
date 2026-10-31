import { useEffect, useRef, useState } from 'react'
import { getMySalesReport, getSaleDetails } from '../api'
import { useConfigStore } from '../store/config'
import { formatDate, formatDateTime } from '../utils/date'
import { formatMoney as formatCurrency, formatNumber } from '../utils/currency'

interface Sale {
  id: number
  doc_no: string
  total: number
  created_at: string
  credit_fully_paid_at?: string | null
  payment_method: string
  customer_name?: string
  received_amount?: number
  change_amount?: number
  reference_number?: string
  is_credit?: number
  credit_fully_paid?: number
  status?: string
  cancellation_reason?: string
  seller_name?: string | null
}

interface SaleItem {
  id: number
  product_name: string
  sku?: string
  quantity: number
  unit_price: number
  total: number
}

interface SaleDetail extends Sale {
  items: SaleItem[]
  customer_document?: string
  customer_address?: string
  customer_phone?: string
}

interface ReportSummary {
  records: number
  netTotal: number
  cancelledCount: number
}

type PeriodMode = 'all' | 'day' | 'month' | 'year' | 'range'
type PaymentFilter = 'NON_CREDIT' | 'CASH' | 'CARD' | 'DEPOSIT' | 'CREDIT' | 'CREDIT_PAID' | 'REALIZED' | 'ALL'
type StatusFilter = 'ACTIVE' | 'CANCELLED' | 'ALL'

const EMPTY_SUMMARY: ReportSummary = {
  records: 0,
  netTotal: 0,
  cancelledCount: 0,
}

function pad2(value: number) {
  return String(value).padStart(2, '0')
}

function formatInputDate(date: Date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

function getMonthBounds(value: string) {
  const [yearRaw, monthRaw] = value.split('-')
  const year = Number(yearRaw)
  const month = Number(monthRaw)
  if (!year || !month) return { startDate: '', endDate: '', label: 'Todas las fechas' }
  const lastDay = new Date(year, month, 0).getDate()
  return {
    startDate: `${year}-${pad2(month)}-01`,
    endDate: `${year}-${pad2(month)}-${pad2(lastDay)}`,
    label: `Mes ${pad2(month)}/${year}`,
  }
}

function getYearBounds(value: string) {
  const year = Number(value)
  if (!year) return { startDate: '', endDate: '', label: 'Todas las fechas' }
  return {
    startDate: `${year}-01-01`,
    endDate: `${year}-12-31`,
    label: `Año ${year}`,
  }
}

function getDateRangeLabel(startDate: string, endDate: string) {
  if (startDate && endDate) return `${startDate} a ${endDate}`
  if (startDate) return `Desde ${startDate}`
  if (endDate) return `Hasta ${endDate}`
  return 'Todas las fechas'
}

function getPaymentMethodLabel(method?: string, isCredit?: number) {
  if (method === 'PENDING') return 'Por cobrar en caja'
  if (method === 'CASH') return 'Efectivo'
  if (method === 'CARD') return 'Tarjeta'
  if (method === 'DEPOSIT') return 'Depósito'
  if (method === 'CREDIT' || isCredit) return 'Crédito'
  return method || 'N/D'
}

function getPaymentFilterLabel(filter: PaymentFilter) {
  if (filter === 'NON_CREDIT') return 'Sin crédito'
  if (filter === 'CASH') return 'Efectivo'
  if (filter === 'CARD') return 'Tarjeta'
  if (filter === 'DEPOSIT') return 'Depósito'
  if (filter === 'CREDIT') return 'Crédito'
  if (filter === 'CREDIT_PAID') return 'Crédito liquidado'
  if (filter === 'REALIZED') return 'Cobrado + liquidados'
  return 'Todos'
}

function getStatusFilterLabel(filter: StatusFilter) {
  if (filter === 'ACTIVE') return 'Activas'
  if (filter === 'CANCELLED') return 'Canceladas'
  return 'Todas'
}

function isCreditSale(sale?: Pick<Sale, 'payment_method' | 'is_credit'> | null) {
  return sale?.payment_method === 'CREDIT' || Boolean(sale?.is_credit)
}

function getSaleStatusLabel(sale: Pick<Sale, 'status' | 'payment_method' | 'is_credit' | 'credit_fully_paid'>, filter: PaymentFilter) {
  if (sale.status === 'CANCELLED') return 'CANCELADO'
  if (sale.status === 'PENDING_PAYMENT') return 'POR COBRAR'
  if (filter === 'CREDIT_PAID') return 'LIQUIDADO'
  if (filter === 'REALIZED' && isCreditSale(sale)) return 'LIQUIDADO'
  if (isCreditSale(sale) && !sale.credit_fully_paid) return 'PENDIENTE'
  if (isCreditSale(sale)) return 'LIQUIDADO'
  return 'PAGADO'
}

export default function MySalesReport() {
  const today = new Date()
  const todayString = formatInputDate(today)
  const currentMonth = `${today.getFullYear()}-${pad2(today.getMonth() + 1)}`
  const defaultMonthRange = getMonthBounds(currentMonth)

  const [sales, setSales] = useState<Sale[]>([])
  const [loading, setLoading] = useState(false)
  const [summary, setSummary] = useState<ReportSummary>(EMPTY_SUMMARY)
  const [pagination, setPagination] = useState({ total: 0, limit: 20, offset: 0 })
  const [searchInput, setSearchInput] = useState('')
  const [periodMode, setPeriodMode] = useState<PeriodMode>('day')
  const [selectedDay, setSelectedDay] = useState(todayString)
  const [selectedMonth, setSelectedMonth] = useState(currentMonth)
  const [selectedYear, setSelectedYear] = useState(String(today.getFullYear()))
  const [rangeStart, setRangeStart] = useState(todayString)
  const [rangeEnd, setRangeEnd] = useState(todayString)
  const [paymentFilter, setPaymentFilter] = useState<PaymentFilter>('ALL')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('ACTIVE')
  const [appliedFilters, setAppliedFilters] = useState({
    search: '',
    startDate: todayString,
    endDate: todayString,
    paymentMethod: 'ALL' as PaymentFilter,
    statusFilter: 'ACTIVE' as StatusFilter,
    label: `${todayString} | Método: ${getPaymentFilterLabel('ALL')} | Estado: ${getStatusFilterLabel('ACTIVE')}`,
  })
  const [selectedSale, setSelectedSale] = useState<SaleDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [isModalOpen, setIsModalOpen] = useState(false)
  const iframeRef = useRef<HTMLIFrameElement>(null)

  const config = useConfigStore(s => s.config)

  useEffect(() => {
    loadSales()
  }, [pagination.offset, appliedFilters])

  async function loadSales() {
    setLoading(true)
    try {
      const res = await getMySalesReport({
        limit: pagination.limit,
        offset: pagination.offset,
        search: appliedFilters.search,
        startDate: appliedFilters.startDate || undefined,
        endDate: appliedFilters.endDate || undefined,
        paymentMethod: appliedFilters.paymentMethod !== 'ALL' ? appliedFilters.paymentMethod : undefined,
        statusFilter: appliedFilters.statusFilter,
      })
      setSales(res.data)
      setPagination(prev => ({ ...prev, total: res.pagination.total }))
      setSummary(res.summary ?? EMPTY_SUMMARY)
    } catch (error) {
      console.error('Error loading my sales:', error)
      setSummary(EMPTY_SUMMARY)
    } finally {
      setLoading(false)
    }
  }

  function applyFilters(e?: React.FormEvent) {
    e?.preventDefault()

    let nextStartDate = ''
    let nextEndDate = ''
    let label = 'Todas las fechas'

    if (periodMode === 'day') {
      nextStartDate = selectedDay
      nextEndDate = selectedDay
      label = selectedDay || 'Día seleccionado'
    } else if (periodMode === 'month') {
      const monthRange = getMonthBounds(selectedMonth)
      nextStartDate = monthRange.startDate
      nextEndDate = monthRange.endDate
      label = monthRange.label
    } else if (periodMode === 'year') {
      const yearRange = getYearBounds(selectedYear)
      nextStartDate = yearRange.startDate
      nextEndDate = yearRange.endDate
      label = yearRange.label
    } else if (periodMode === 'range') {
      nextStartDate = rangeStart
      nextEndDate = rangeEnd
      label = getDateRangeLabel(rangeStart, rangeEnd)
    }

    setPagination(prev => ({ ...prev, offset: 0 }))
    setAppliedFilters({
      search: searchInput.trim(),
      startDate: nextStartDate,
      endDate: nextEndDate,
      paymentMethod: paymentFilter,
      statusFilter,
      label: `${label} | Método: ${getPaymentFilterLabel(paymentFilter)} | Estado: ${getStatusFilterLabel(statusFilter)}`,
    })
  }

  function resetFilters() {
    setSearchInput('')
    setPaymentFilter('ALL')
    setStatusFilter('ACTIVE')
    setPeriodMode('day')
    setSelectedDay(todayString)
    setSelectedMonth(currentMonth)
    setSelectedYear(String(today.getFullYear()))
    setRangeStart(todayString)
    setRangeEnd(todayString)
    setPagination(prev => ({ ...prev, offset: 0 }))
    setAppliedFilters({
      search: '',
      startDate: todayString,
      endDate: todayString,
      paymentMethod: 'ALL',
      statusFilter: 'ACTIVE',
      label: `${todayString} | Método: ${getPaymentFilterLabel('ALL')} | Estado: ${getStatusFilterLabel('ACTIVE')}`,
    })
  }

  async function handleViewDetails(saleId: number) {
    setDetailLoading(true)
    setIsModalOpen(true)
    try {
      const data = await getSaleDetails(saleId)
      setSelectedSale(data)
    } catch (error) {
      console.error('Error details:', error)
      alert('Error cargando detalles')
      setIsModalOpen(false)
    } finally {
      setDetailLoading(false)
    }
  }

  const totalPages = Math.ceil(pagination.total / pagination.limit)
  const currentPage = Math.floor(pagination.offset / pagination.limit) + 1
  const formatMoney = (value?: number) => formatCurrency(Number(value || 0), config?.currency)

  return (
    <div className="page-shell">
      <iframe ref={iframeRef} style={{ position: 'absolute', width: 0, height: 0, border: 'none', visibility: 'hidden' }} />

      <div className="page-toolbar" style={{ marginBottom: 20 }}>
        <div>
          <h2 style={{ margin: 0 }}>Mi Reporte de Ventas</h2>
          <div style={{ color: 'var(--muted)', fontSize: 13, marginTop: 6 }}>
            Solo muestra tus ventas. No incluye utilidades. Periodo: {appliedFilters.label}
          </div>
        </div>
        <form onSubmit={applyFilters} className="page-toolbar-actions" style={{ width: '100%' }}>
          <input
            type="text"
            placeholder="Buscar por Doc / Cliente / ID"
            value={searchInput}
            onChange={e => setSearchInput(e.target.value)}
            style={{ padding: '8px 12px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg)', color: 'inherit', minWidth: 220, maxWidth: '100%' }}
          />
          <select value={paymentFilter} onChange={e => setPaymentFilter(e.target.value as PaymentFilter)} style={{ padding: '8px 12px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg)', color: 'inherit' }}>
            <option value="ALL">Todos</option>
            <option value="NON_CREDIT">Sin crédito</option>
            <option value="CASH">Efectivo</option>
            <option value="DEPOSIT">Depósito</option>
            <option value="CARD">Tarjeta</option>
            <option value="CREDIT">Crédito</option>
            <option value="CREDIT_PAID">Crédito liquidado</option>
            <option value="REALIZED">Efectivo/Depósito/Tarjeta + Créditos liquidados</option>
          </select>
          <select value={statusFilter} onChange={e => setStatusFilter(e.target.value as StatusFilter)} style={{ padding: '8px 12px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg)', color: 'inherit' }}>
            <option value="ACTIVE">Activas</option>
            <option value="CANCELLED">Canceladas</option>
            <option value="ALL">Todas</option>
          </select>
          <select value={periodMode} onChange={e => setPeriodMode(e.target.value as PeriodMode)} style={{ padding: '8px 12px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg)', color: 'inherit' }}>
            <option value="all">Todas las fechas</option>
            <option value="day">Día</option>
            <option value="month">Mes</option>
            <option value="year">Año</option>
            <option value="range">Rango</option>
          </select>
          {periodMode === 'day' && <input type="date" value={selectedDay} onChange={e => setSelectedDay(e.target.value)} style={{ padding: '8px 12px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg)', color: 'inherit' }} />}
          {periodMode === 'month' && <input type="month" value={selectedMonth} onChange={e => setSelectedMonth(e.target.value)} style={{ padding: '8px 12px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg)', color: 'inherit' }} />}
          {periodMode === 'year' && <input type="number" min="2020" max="2100" step="1" value={selectedYear} onChange={e => setSelectedYear(e.target.value)} style={{ padding: '8px 12px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg)', color: 'inherit', width: 120 }} />}
          {periodMode === 'range' && (
            <>
              <input type="date" value={rangeStart} onChange={e => setRangeStart(e.target.value)} style={{ padding: '8px 12px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg)', color: 'inherit' }} />
              <input type="date" value={rangeEnd} onChange={e => setRangeEnd(e.target.value)} style={{ padding: '8px 12px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg)', color: 'inherit' }} />
            </>
          )}
          <button type="submit" className="primary-btn">Filtrar</button>
          <button type="button" className="secondary-btn" onClick={resetFilters}>Limpiar</button>
        </form>
      </div>

      <div className="responsive-form-grid" style={{ marginBottom: 20 }}>
        <div style={{ background: 'var(--modal)', border: '1px solid var(--border)', borderRadius: 12, padding: 16 }}>
          <div style={{ color: 'var(--muted)', fontSize: 13, marginBottom: 6 }}>Total vendido</div>
          <div style={{ fontWeight: 700, fontSize: 22 }}>{formatMoney(summary.netTotal)}</div>
        </div>
        <div style={{ background: 'var(--modal)', border: '1px solid var(--border)', borderRadius: 12, padding: 16 }}>
          <div style={{ color: 'var(--muted)', fontSize: 13, marginBottom: 6 }}>Ventas registradas</div>
          <div style={{ fontWeight: 700, fontSize: 22 }}>{summary.records}</div>
        </div>
        <div style={{ background: 'var(--modal)', border: '1px solid var(--border)', borderRadius: 12, padding: 16 }}>
          <div style={{ color: 'var(--muted)', fontSize: 13, marginBottom: 6 }}>Canceladas</div>
          <div style={{ fontWeight: 700, fontSize: 22, color: summary.cancelledCount ? '#ef4444' : 'inherit' }}>{summary.cancelledCount}</div>
        </div>
      </div>

      <div className="table-scroll" style={{ background: 'var(--modal)', borderRadius: 12, border: '1px solid var(--border)' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border)' }}>
              <th style={{ padding: 12, textAlign: 'left' }}>ID</th>
              <th style={{ padding: 12, textAlign: 'left' }}>Fecha</th>
              <th style={{ padding: 12, textAlign: 'left' }}>Cliente</th>
              <th style={{ padding: 12, textAlign: 'left' }}>Método</th>
              <th style={{ padding: 12, textAlign: 'center' }}>Estado</th>
              <th style={{ padding: 12, textAlign: 'right' }}>Total</th>
              <th style={{ padding: 12, textAlign: 'center' }}>Acciones</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={7} style={{ padding: 24, textAlign: 'center', color: 'var(--muted)' }}>Cargando...</td></tr>
            ) : sales.length === 0 ? (
              <tr><td colSpan={7} style={{ padding: 24, textAlign: 'center', color: 'var(--muted)' }}>No se encontraron ventas</td></tr>
            ) : (
              sales.map(sale => (
                <tr key={sale.id} style={{ borderBottom: '1px solid var(--border)' }}>
                  <td style={{ padding: 12 }}>#{sale.id}</td>
                  <td style={{ padding: 12 }}>
                    <div>{formatDateTime((appliedFilters.paymentMethod === 'CREDIT_PAID' || (appliedFilters.paymentMethod === 'REALIZED' && isCreditSale(sale))) ? (sale.credit_fully_paid_at || sale.created_at) : sale.created_at)}</div>
                    {isCreditSale(sale) && sale.credit_fully_paid_at && (
                      <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>
                        Liquidado: {formatDateTime(sale.credit_fully_paid_at)}
                      </div>
                    )}
                  </td>
                  <td style={{ padding: 12 }}>{sale.customer_name || 'General'}</td>
                  <td style={{ padding: 12 }}>{getPaymentMethodLabel(sale.payment_method, sale.is_credit)}</td>
                  <td style={{ padding: 12, textAlign: 'center' }}>
                    {getSaleStatusLabel(sale, appliedFilters.paymentMethod)}
                  </td>
                  <td style={{ padding: 12, textAlign: 'right', fontWeight: 600 }}>{formatMoney(sale.total)}</td>
                  <td style={{ padding: 12, textAlign: 'center' }}>
                    <button onClick={() => handleViewDetails(sale.id)} className="icon-btn primary" title="Ver detalles">Ver</button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div style={{ marginTop: 20, display: 'flex', justifyContent: 'center', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <button className="icon-btn" disabled={pagination.offset === 0} onClick={() => setPagination(prev => ({ ...prev, offset: prev.offset - prev.limit }))} style={{ opacity: pagination.offset === 0 ? 0.5 : 1 }}>Anterior</button>
        <span style={{ color: 'var(--muted)' }}>Página {currentPage} de {totalPages || 1}</span>
        <button className="icon-btn" disabled={pagination.offset + pagination.limit >= pagination.total} onClick={() => setPagination(prev => ({ ...prev, offset: prev.offset + prev.limit }))} style={{ opacity: pagination.offset + pagination.limit >= pagination.total ? 0.5 : 1 }}>Siguiente</button>
      </div>

      {isModalOpen && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div className="responsive-modal" style={{ background: 'var(--modal)', border: '1px solid var(--border)', borderRadius: 12, padding: 24, width: '90%', maxWidth: 700, maxHeight: '90vh', overflowY: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 20, alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <h3 style={{ margin: 0 }}>Detalle de Venta #{selectedSale?.id}</h3>
              <button onClick={() => setIsModalOpen(false)} className="icon-btn" title="Cerrar">Cerrar</button>
            </div>
            {detailLoading || !selectedSale ? (
              <p style={{ textAlign: 'center', color: 'var(--muted)', padding: 20 }}>Cargando detalles...</p>
            ) : (
              <div>
                <div className="responsive-form-grid" style={{ marginBottom: 24, background: 'var(--bg)', padding: 16, borderRadius: 8, border: '1px solid var(--border)' }}>
                  <div><strong style={{ display: 'block', fontSize: 13, color: 'var(--muted)', marginBottom: 2 }}>Fecha</strong>{formatDate(selectedSale.created_at)}</div>
                  <div><strong style={{ display: 'block', fontSize: 13, color: 'var(--muted)', marginBottom: 2 }}>Cliente</strong>{selectedSale.customer_name || 'General'}</div>
                  <div><strong style={{ display: 'block', fontSize: 13, color: 'var(--muted)', marginBottom: 2 }}>Método Pago</strong>{getPaymentMethodLabel(selectedSale.payment_method, selectedSale.is_credit)}</div>
                  <div><strong style={{ display: 'block', fontSize: 13, color: 'var(--muted)', marginBottom: 2 }}>Total</strong><span style={{ fontWeight: 600, fontSize: 16 }}>{formatMoney(selectedSale.total)}</span></div>
                  <div><strong style={{ display: 'block', fontSize: 13, color: 'var(--muted)', marginBottom: 2 }}>Responsable</strong>{selectedSale.seller_name || 'SIN USUARIO'}</div>
                </div>

                <div className="table-scroll" style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden', marginBottom: 24 }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead style={{ background: 'var(--bg)' }}>
                      <tr style={{ borderBottom: '1px solid var(--border)' }}>
                        <th style={{ padding: '10px 16px', textAlign: 'left', fontSize: 13 }}>Producto</th>
                        <th style={{ padding: '10px 16px', textAlign: 'right', fontSize: 13 }}>Cant.</th>
                        <th style={{ padding: '10px 16px', textAlign: 'right', fontSize: 13 }}>Precio</th>
                        <th style={{ padding: '10px 16px', textAlign: 'right', fontSize: 13 }}>Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {selectedSale.items.map(item => (
                        <tr key={item.id} style={{ borderBottom: '1px solid var(--border)' }}>
                          <td style={{ padding: '10px 16px' }}>{item.product_name}</td>
                          <td style={{ padding: '10px 16px', textAlign: 'right' }}>{item.quantity}</td>
                          <td style={{ padding: '10px 16px', textAlign: 'right' }}>{formatNumber(Number(item.unit_price))}</td>
                          <td style={{ padding: '10px 16px', textAlign: 'right' }}>{formatNumber(Number(item.total))}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
