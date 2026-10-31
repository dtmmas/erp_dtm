import { useEffect, useRef, useState } from 'react'
import { getMyCollectionsReport, getSaleDetails } from '../api'
import { useConfigStore } from '../store/config'
import { formatDate, formatDateTime } from '../utils/date'
import { formatMoney as formatCurrency, formatNumber } from '../utils/currency'

interface Collection {
  id: number
  doc_no: string
  total: number
  created_at: string
  paid_at?: string | null
  payment_method: string
  customer_name?: string
  received_amount?: number
  change_amount?: number
  reference_number?: string
  is_credit?: number
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

interface CollectionDetail extends Collection {
  items: SaleItem[]
  customer_document?: string
  customer_address?: string
  customer_phone?: string
}

interface ReportSummary {
  records: number
  collectedTotal: number
  creditTotal: number
  cancelledCount: number
}

type PeriodMode = 'all' | 'day' | 'month' | 'year' | 'range'
type PaymentFilter = 'ALL' | 'CASH' | 'CARD' | 'DEPOSIT' | 'CREDIT'
type StatusFilter = 'ACTIVE' | 'CANCELLED' | 'ALL'

const EMPTY_SUMMARY: ReportSummary = {
  records: 0,
  collectedTotal: 0,
  creditTotal: 0,
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
  if (method === 'CASH') return 'Efectivo'
  if (method === 'CARD') return 'Tarjeta'
  if (method === 'DEPOSIT') return 'Depósito'
  if (method === 'CREDIT' || isCredit) return 'Crédito'
  return method || 'N/D'
}

function getStatusLabel(collection: Pick<Collection, 'status' | 'payment_method' | 'is_credit'>) {
  if (collection.status === 'CANCELLED') return 'CANCELADO'
  if (collection.payment_method === 'CREDIT' || collection.is_credit) return 'CRÉDITO'
  return 'COBRADO'
}

export default function MyCollectionsReport() {
  const today = new Date()
  const todayString = formatInputDate(today)
  const currentMonth = `${today.getFullYear()}-${pad2(today.getMonth() + 1)}`

  const [collections, setCollections] = useState<Collection[]>([])
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
    label: `${todayString} | Método: Todos | Estado: Activas`,
  })
  const [selectedCollection, setSelectedCollection] = useState<CollectionDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [isModalOpen, setIsModalOpen] = useState(false)
  const iframeRef = useRef<HTMLIFrameElement>(null)

  const config = useConfigStore(s => s.config)

  useEffect(() => {
    loadCollections()
  }, [pagination.offset, appliedFilters])

  async function loadCollections() {
    setLoading(true)
    try {
      const res = await getMyCollectionsReport({
        limit: pagination.limit,
        offset: pagination.offset,
        search: appliedFilters.search,
        startDate: appliedFilters.startDate || undefined,
        endDate: appliedFilters.endDate || undefined,
        paymentMethod: appliedFilters.paymentMethod !== 'ALL' ? appliedFilters.paymentMethod : undefined,
        statusFilter: appliedFilters.statusFilter,
      })
      setCollections(res.data)
      setPagination(prev => ({ ...prev, total: res.pagination.total }))
      setSummary(res.summary ?? EMPTY_SUMMARY)
    } catch (error) {
      console.error('Error loading my collections:', error)
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
      label: `${label} | Método: ${paymentFilter === 'ALL' ? 'Todos' : getPaymentMethodLabel(paymentFilter)} | Estado: ${statusFilter === 'ACTIVE' ? 'Activas' : statusFilter === 'CANCELLED' ? 'Canceladas' : 'Todas'}`,
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
      label: `${todayString} | Método: Todos | Estado: Activas`,
    })
  }

  async function handleViewDetails(saleId: number) {
    setDetailLoading(true)
    setIsModalOpen(true)
    try {
      const data = await getSaleDetails(saleId)
      setSelectedCollection(data)
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
          <h2 style={{ margin: 0 }}>Mis Cobros</h2>
          <div style={{ color: 'var(--muted)', fontSize: 13, marginTop: 6 }}>
            Muestra las ventas que cobraste o registraste en caja. Periodo: {appliedFilters.label}
          </div>
        </div>
        <form onSubmit={applyFilters} className="page-toolbar-actions" style={{ width: '100%' }}>
          <input
            type="text"
            placeholder="Buscar por Doc / Cliente / ID / Vendedor"
            value={searchInput}
            onChange={e => setSearchInput(e.target.value)}
            style={{ padding: '8px 12px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg)', color: 'inherit', minWidth: 220, maxWidth: '100%' }}
          />
          <select value={paymentFilter} onChange={e => setPaymentFilter(e.target.value as PaymentFilter)} style={{ padding: '8px 12px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg)', color: 'inherit' }}>
            <option value="ALL">Todos</option>
            <option value="CASH">Efectivo</option>
            <option value="DEPOSIT">Depósito</option>
            <option value="CARD">Tarjeta</option>
            <option value="CREDIT">Crédito</option>
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
          <div style={{ color: 'var(--muted)', fontSize: 13, marginBottom: 6 }}>Total cobrado</div>
          <div style={{ fontWeight: 700, fontSize: 22 }}>{formatMoney(summary.collectedTotal)}</div>
        </div>
        <div style={{ background: 'var(--modal)', border: '1px solid var(--border)', borderRadius: 12, padding: 16 }}>
          <div style={{ color: 'var(--muted)', fontSize: 13, marginBottom: 6 }}>Créditos registrados</div>
          <div style={{ fontWeight: 700, fontSize: 22 }}>{formatMoney(summary.creditTotal)}</div>
        </div>
        <div style={{ background: 'var(--modal)', border: '1px solid var(--border)', borderRadius: 12, padding: 16 }}>
          <div style={{ color: 'var(--muted)', fontSize: 13, marginBottom: 6 }}>Operaciones</div>
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
              <th style={{ padding: 12, textAlign: 'left' }}>Cobrado</th>
              <th style={{ padding: 12, textAlign: 'left' }}>Cliente</th>
              <th style={{ padding: 12, textAlign: 'left' }}>Vendedor</th>
              <th style={{ padding: 12, textAlign: 'left' }}>Método</th>
              <th style={{ padding: 12, textAlign: 'center' }}>Estado</th>
              <th style={{ padding: 12, textAlign: 'right' }}>Total</th>
              <th style={{ padding: 12, textAlign: 'center' }}>Acciones</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={8} style={{ padding: 24, textAlign: 'center', color: 'var(--muted)' }}>Cargando...</td></tr>
            ) : collections.length === 0 ? (
              <tr><td colSpan={8} style={{ padding: 24, textAlign: 'center', color: 'var(--muted)' }}>No se encontraron cobros</td></tr>
            ) : (
              collections.map(collection => (
                <tr key={collection.id} style={{ borderBottom: '1px solid var(--border)' }}>
                  <td style={{ padding: 12 }}>#{collection.id}</td>
                  <td style={{ padding: 12 }}>
                    <div>{formatDateTime(collection.paid_at || collection.created_at)}</div>
                    <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>
                      Venta: {formatDateTime(collection.created_at)}
                    </div>
                  </td>
                  <td style={{ padding: 12 }}>{collection.customer_name || 'General'}</td>
                  <td style={{ padding: 12 }}>{collection.seller_name || 'SIN VENDEDOR'}</td>
                  <td style={{ padding: 12 }}>{getPaymentMethodLabel(collection.payment_method, collection.is_credit)}</td>
                  <td style={{ padding: 12, textAlign: 'center' }}>{getStatusLabel(collection)}</td>
                  <td style={{ padding: 12, textAlign: 'right', fontWeight: 600 }}>{formatMoney(collection.total)}</td>
                  <td style={{ padding: 12, textAlign: 'center' }}>
                    <button onClick={() => handleViewDetails(collection.id)} className="icon-btn primary" title="Ver detalles">Ver</button>
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
              <h3 style={{ margin: 0 }}>Detalle de Cobro #{selectedCollection?.id}</h3>
              <button onClick={() => setIsModalOpen(false)} className="icon-btn" title="Cerrar">Cerrar</button>
            </div>
            {detailLoading || !selectedCollection ? (
              <p style={{ textAlign: 'center', color: 'var(--muted)', padding: 20 }}>Cargando detalles...</p>
            ) : (
              <div>
                <div className="responsive-form-grid" style={{ marginBottom: 24, background: 'var(--bg)', padding: 16, borderRadius: 8, border: '1px solid var(--border)' }}>
                  <div><strong style={{ display: 'block', fontSize: 13, color: 'var(--muted)', marginBottom: 2 }}>Fecha cobro</strong>{formatDate(selectedCollection.paid_at || selectedCollection.created_at)}</div>
                  <div><strong style={{ display: 'block', fontSize: 13, color: 'var(--muted)', marginBottom: 2 }}>Fecha venta</strong>{formatDate(selectedCollection.created_at)}</div>
                  <div><strong style={{ display: 'block', fontSize: 13, color: 'var(--muted)', marginBottom: 2 }}>Cliente</strong>{selectedCollection.customer_name || 'General'}</div>
                  <div><strong style={{ display: 'block', fontSize: 13, color: 'var(--muted)', marginBottom: 2 }}>Vendedor</strong>{selectedCollection.seller_name || 'SIN VENDEDOR'}</div>
                  <div><strong style={{ display: 'block', fontSize: 13, color: 'var(--muted)', marginBottom: 2 }}>Método Pago</strong>{getPaymentMethodLabel(selectedCollection.payment_method, selectedCollection.is_credit)}</div>
                  <div><strong style={{ display: 'block', fontSize: 13, color: 'var(--muted)', marginBottom: 2 }}>Total</strong><span style={{ fontWeight: 600, fontSize: 16 }}>{formatMoney(selectedCollection.total)}</span></div>
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
                      {selectedCollection.items.map(item => (
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
