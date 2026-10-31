import { useEffect, useMemo, useState } from 'react'
import { api, getSupplierPendingPurchases, getSupplierPayments, paySupplier } from '../api'
import { useConfigStore } from '../store/config'
import { useAuthStore } from '../store/auth'
import { formatMoney } from '../utils/currency'

interface Supplier { id: number; name: string }
interface PendingPurchase {
  id: number
  docNo?: string | null
  createdAt: string
  dueDate?: string | null
  total: number
  paidAmount: number
  balanceDue: number
  paymentStatus: string
}
interface SupplierPaymentRecord {
  id: number
  supplierId: number
  amount: number
  paymentMethod: string
  reference?: string | null
  notes?: string | null
  documentPath?: string | null
  paidAt: string
  userName?: string | null
  allocations: Array<{
    purchaseId: number
    purchasePaymentId?: number | null
    amount: number
    docNo?: string | null
    createdAt: string
    dueDate?: string | null
  }>
}

function getPaymentMethodLabel(method?: string) {
  if (method === 'CARD') return 'Tarjeta'
  if (method === 'DEPOSIT') return 'Deposito'
  return 'Efectivo'
}

export default function Suppliers() {
  const [items, setItems] = useState<Supplier[]>([])
  const [query, setQuery] = useState('')
  const [usage, setUsage] = useState<Record<number, number>>({})
  const [loading, setLoading] = useState(false)
  const [showCreate, setShowCreate] = useState(false)
  const [name, setName] = useState('')
  const [view, setView] = useState<'grid' | 'list'>('grid')
  const [showEdit, setShowEdit] = useState(false)
  const [editTarget, setEditTarget] = useState<Supplier | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Supplier | null>(null)
  const [paymentTarget, setPaymentTarget] = useState<Supplier | null>(null)
  const [paymentModalOpen, setPaymentModalOpen] = useState(false)
  const [pendingPurchases, setPendingPurchases] = useState<PendingPurchase[]>([])
  const [supplierPayments, setSupplierPayments] = useState<SupplierPaymentRecord[]>([])
  const [totalPending, setTotalPending] = useState(0)
  const [loadingPaymentData, setLoadingPaymentData] = useState(false)
  const [processingPayment, setProcessingPayment] = useState(false)
  const [paymentAmount, setPaymentAmount] = useState('')
  const [paymentMethod, setPaymentMethod] = useState<'CASH' | 'CARD' | 'DEPOSIT'>('CASH')
  const [paymentReference, setPaymentReference] = useState('')
  const [paymentNotes, setPaymentNotes] = useState('')
  const [paymentFile, setPaymentFile] = useState<File | null>(null)
  const [isMobileViewport, setIsMobileViewport] = useState(false)
  const config = useConfigStore(s => s.config)
  const { hasPermission } = useAuthStore()

  const load = async () => {
    const { data } = await api.get('/suppliers')
    const sorted = [...data].sort((a: Supplier, b: Supplier) => a.name.localeCompare(b.name))
    setItems(sorted)
    try {
      const entries = await Promise.all(sorted.map(async (s: Supplier) => {
        const { data } = await api.get(`/suppliers/${s.id}/usage`)
        return [s.id, data?.count || 0] as const
      }))
      setUsage(Object.fromEntries(entries))
    } catch {}
  }
  useEffect(() => { load() }, [])
  useEffect(() => {
    const mediaQuery = window.matchMedia('(max-width: 768px)')
    const syncViewport = () => setIsMobileViewport(mediaQuery.matches)
    syncViewport()
    mediaQuery.addEventListener('change', syncViewport)
    return () => mediaQuery.removeEventListener('change', syncViewport)
  }, [])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return items
    return items.filter(s => s.name.toLowerCase().includes(q))
  }, [items, query])

  const normalizedPaymentAmount = useMemo(() => {
    const parsed = Number(paymentAmount || 0)
    if (!Number.isFinite(parsed) || parsed <= 0) return 0
    return Math.min(totalPending, Math.max(0, parsed))
  }, [paymentAmount, totalPending])

  const allocationPreview = useMemo(() => {
    let remaining = normalizedPaymentAmount
    return pendingPurchases.map(purchase => {
      const applied = remaining > 0 ? Math.min(remaining, Number(purchase.balanceDue || 0)) : 0
      remaining = Math.max(0, remaining - applied)
      return {
        ...purchase,
        applied,
        resultingBalance: Math.max(0, Number(purchase.balanceDue || 0) - applied),
      }
    }).filter(item => item.applied > 0)
  }, [pendingPurchases, normalizedPaymentAmount])

  const startCreate = () => { setName(''); setShowCreate(true) }
  const cancelCreate = () => { setShowCreate(false); setName('') }
  const saveCreate = async () => {
    const trimmed = name.trim()
    if (!trimmed) return
    if (items.some(x => x.name.toLowerCase() === trimmed.toLowerCase())) {
      alert('Ya existe un proveedor con ese nombre')
      return
    }
    setLoading(true)
    try {
      await api.post('/suppliers', { name: trimmed })
      setName('')
      setShowCreate(false)
      await load()
      alert('Proveedor creado correctamente')
    } catch (err: any) {
      const msg = err?.response?.data?.error || 'No se pudo crear el proveedor.'
      alert(msg)
    } finally {
      setLoading(false)
    }
  }

  const startEdit = (s: Supplier) => {
    setEditTarget(s)
    setName(s.name)
    setShowEdit(true)
  }

  const cancelEdit = () => {
    setShowEdit(false)
    setEditTarget(null)
    setName('')
  }

  const saveEdit = async () => {
    if (!editTarget) return
    const trimmed = name.trim()
    if (!trimmed) return
    if (items.some(x => x.id !== editTarget.id && x.name.toLowerCase() === trimmed.toLowerCase())) {
      alert('Ya existe un proveedor con ese nombre')
      return
    }
    try {
      setLoading(true)
      await api.put(`/suppliers/${editTarget.id}`, { name: trimmed })
      setShowEdit(false)
      setEditTarget(null)
      setName('')
      await load()
      alert('Proveedor actualizado correctamente')
    } catch (err: any) {
      const msg = err?.response?.data?.error || 'No se pudo actualizar el proveedor.'
      alert(msg)
    } finally {
      setLoading(false)
    }
  }

  const removeSupplier = async (id: number) => {
    const target = items.find(s => s.id === id) || null
    setDeleteTarget(target)
  }

  const closePaymentModal = () => {
    setPaymentModalOpen(false)
    setPaymentTarget(null)
    setPendingPurchases([])
    setSupplierPayments([])
    setTotalPending(0)
    setLoadingPaymentData(false)
    setProcessingPayment(false)
    setPaymentAmount('')
    setPaymentMethod('CASH')
    setPaymentReference('')
    setPaymentNotes('')
    setPaymentFile(null)
  }

  const loadSupplierPaymentData = async (supplier: Supplier) => {
    const [pendingData, paymentsData] = await Promise.all([
      getSupplierPendingPurchases(supplier.id),
      getSupplierPayments(supplier.id),
    ])
    setPendingPurchases(pendingData.purchases || [])
    setTotalPending(Number(pendingData.totals?.totalPending || 0))
    setSupplierPayments(paymentsData || [])
  }

  const openPaymentModal = async (supplier: Supplier) => {
    setPaymentTarget(supplier)
    setPaymentModalOpen(true)
    setLoadingPaymentData(true)
    setPaymentAmount('')
    setPaymentMethod('CASH')
    setPaymentReference('')
    setPaymentNotes('')
    setPaymentFile(null)
    try {
      await loadSupplierPaymentData(supplier)
    } catch (err: any) {
      const msg = err?.response?.data?.error || 'No se pudo cargar la informacion del proveedor.'
      alert(msg)
      closePaymentModal()
    } finally {
      setLoadingPaymentData(false)
    }
  }

  const handleSupplierPayment = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!paymentTarget) return
    if (normalizedPaymentAmount <= 0) {
      alert('Ingrese un monto valido')
      return
    }
    if (normalizedPaymentAmount - totalPending > 0.009) {
      alert('El monto excede el saldo pendiente del proveedor')
      return
    }
    if ((paymentMethod === 'CARD' || paymentMethod === 'DEPOSIT') && !paymentReference.trim()) {
      alert('Ingrese referencia para pagos con tarjeta o deposito')
      return
    }

    setProcessingPayment(true)
    try {
      const formData = new FormData()
      formData.append('amount', String(normalizedPaymentAmount))
      formData.append('paymentMethod', paymentMethod)
      if (paymentReference.trim()) formData.append('reference', paymentReference.trim())
      if (paymentNotes.trim()) formData.append('notes', paymentNotes.trim())
      if (paymentFile) formData.append('document', paymentFile)

      await paySupplier(paymentTarget.id, formData)
      await loadSupplierPaymentData(paymentTarget)
      await load()
      setPaymentAmount('')
      setPaymentMethod('CASH')
      setPaymentReference('')
      setPaymentNotes('')
      setPaymentFile(null)
      alert('Abono global registrado correctamente')
    } catch (err: any) {
      const msg = err?.response?.data?.error || 'No se pudo registrar el abono global.'
      alert(msg)
    } finally {
      setProcessingPayment(false)
    }
  }

  const confirmDelete = async () => {
    if (!deleteTarget) return
    try {
      setLoading(true)
      await api.delete(`/suppliers/${deleteTarget.id}`)
      await load()
      setDeleteTarget(null)
    } catch (err: any) {
      const msg = err?.response?.data?.error || 'No se pudo eliminar el proveedor.'
      alert(msg)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={{ padding: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <h2 style={{ margin: 0 }}>Proveedores</h2>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input placeholder="Buscar..." value={query} onChange={e => setQuery(e.target.value)} style={{ width: 280 }} />
          <button className="primary-btn" onClick={startCreate}>Nuevo</button>
          <div className="view-toggle">
            <button
              className={`toggle-btn ${view === 'grid' ? 'active' : ''}`}
              onClick={() => setView('grid')}
              aria-label="Vista grid"
              title="Vista grid"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <path d="M3 3h8v8H3V3zm10 0h8v8h-8V3zM3 13h8v8H3v-8zm10 0h8v8h-8v-8z" />
              </svg>
            </button>
            <button
              className={`toggle-btn ${view === 'list' ? 'active' : ''}`}
              onClick={() => setView('list')}
              aria-label="Vista lista"
              title="Vista lista"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <path d="M3 13h2v-2H3v2zm0 4h2v-2H3v2zm0-8h2V7H3v2zm4 4h14v-2H7v2zm0 4h14v-2H7v2zM7 7v2h14V7H7z" />
              </svg>
            </button>
          </div>
        </div>
      </div>

      {view === 'grid' ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 20 }}>
          {filtered.map(s => (
            <div key={s.id} style={{ border: '1px solid #334155', borderRadius: 12, padding: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ fontWeight: 600, marginBottom: 6 }}>{s.name}</div>
              <div style={{ fontSize: 13, color: '#9ca3af', marginTop: 4 }}>{usage[s.id] ?? 0} compra(s)</div>
              <div style={{ display: 'flex', gap: 10, marginTop: 'auto', alignItems: 'center', flexWrap: 'wrap' }}>
                {hasPermission('purchases:write') && (
                  <button className="btn-secondary" onClick={() => openPaymentModal(s)}>
                    Abonar
                  </button>
                )}
                <button className="icon-btn primary" title="Editar" aria-label="Editar" onClick={() => startEdit(s)}>
                  <svg viewBox="0 0 24 24" width="18" height="18"><path d="M3 17.25V21h3.75L17.81 9.94a1 1 0 0 0 0-1.41l-3.34-3.34a1 1 0 0 0-1.41 0L3 16.59z" fill="currentColor"/></svg>
                </button>
                <button className="icon-btn danger" title="Eliminar" aria-label="Eliminar" onClick={() => removeSupplier(s.id)} disabled={(usage[s.id] ?? 0) > 0}>
                  <svg viewBox="0 0 24 24" width="18" height="18">
                    <path d="M3 6h18" stroke="currentColor" strokeWidth="2"/>
                    <path d="M8 6V4h8v2" stroke="currentColor" strokeWidth="2"/>
                    <path d="M19 6l-1 14H6L5 6" stroke="currentColor" strokeWidth="2"/>
                    <path d="M10 11v6M14 11v6" stroke="currentColor" strokeWidth="2"/>
                  </svg>
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div style={{ border: '1px solid #334155', borderRadius: 10, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead style={{ background: '#0b1220' }}>
              <tr>
                <th style={{ textAlign: 'left', padding: 8 }}>Nombre</th>
                <th style={{ textAlign: 'left', padding: 8 }}>Uso</th>
                <th style={{ textAlign: 'left', padding: 8 }}>Acciones</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(s => (
                <tr key={s.id}>
                  <td style={{ padding: 8 }}>{s.name}</td>
                  <td style={{ padding: 8 }}>{usage[s.id] ?? 0} compra(s)</td>
                  <td style={{ padding: 8 }}>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {hasPermission('purchases:write') && (
                        <button className="btn-secondary" onClick={() => openPaymentModal(s)}>
                          Abonar
                        </button>
                      )}
                      <button className="icon-btn primary" title="Editar" aria-label="Editar" onClick={() => startEdit(s)}>
                        <svg viewBox="0 0 24 24" width="18" height="18"><path d="M3 17.25V21h3.75L17.81 9.94a1 1 0 0 0 0-1.41l-3.34-3.34a1 1 0 0 0-1.41 0L3 16.59z" fill="currentColor"/></svg>
                      </button>
                      <button className="icon-btn danger" title="Eliminar" aria-label="Eliminar" onClick={() => removeSupplier(s.id)} disabled={(usage[s.id] ?? 0) > 0}>
                        <svg viewBox="0 0 24 24" width="18" height="18">
                          <path d="M3 6h18" stroke="currentColor" strokeWidth="2"/>
                          <path d="M8 6V4h8v2" stroke="currentColor" strokeWidth="2"/>
                          <path d="M19 6l-1 14H6L5 6" stroke="currentColor" strokeWidth="2"/>
                          <path d="M10 11v6M14 11v6" stroke="currentColor" strokeWidth="2"/>
                        </svg>
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showCreate && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ width: 420, background: 'var(--modal)', border: '1px solid var(--border)', borderRadius: 12, padding: 16 }}>
            <h3 style={{ margin: 0, marginBottom: 12 }}>Nuevo proveedor</h3>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 10 }}>
              <div>
                <label>Nombre</label>
                <input value={name} onChange={e => setName(e.target.value)} />
              </div>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
              <button onClick={cancelCreate}>Cancelar</button>
              <button className="primary-btn" onClick={saveCreate} disabled={loading}>{loading ? 'Guardando...' : 'Crear'}</button>
            </div>
          </div>
        </div>
      )}

      {showEdit && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ width: 420, background: 'var(--modal)', border: '1px solid var(--border)', borderRadius: 12, padding: 16 }}>
            <h3 style={{ margin: 0, marginBottom: 12 }}>Editar proveedor</h3>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 10 }}>
              <div>
                <label>Nombre</label>
                <input value={name} onChange={e => setName(e.target.value)} />
              </div>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
              <button onClick={cancelEdit}>Cancelar</button>
              <button className="primary-btn" onClick={saveEdit} disabled={loading}>{loading ? 'Guardando...' : 'Guardar'}</button>
            </div>
          </div>
        </div>
      )}

      {deleteTarget && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ width: 420, background: 'var(--modal)', border: '1px solid var(--border)', borderRadius: 12, padding: 16 }}>
            <h3 style={{ margin: 0, marginBottom: 12 }}>Confirmar eliminación</h3>
            <div style={{ marginBottom: 12 }}>
              Esta acción eliminará el proveedor <strong>{deleteTarget.name}</strong> de forma permanente. ¿Confirmar?
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button onClick={() => setDeleteTarget(null)} disabled={loading}>Cancelar</button>
              <button className="danger" onClick={confirmDelete} disabled={loading}>Eliminar</button>
            </div>
          </div>
        </div>
      )}

      {paymentModalOpen && paymentTarget && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: isMobileViewport ? 'flex-end' : 'center', justifyContent: 'center', padding: isMobileViewport ? 0 : 16, zIndex: 120 }}>
          <form onSubmit={handleSupplierPayment} style={{ width: isMobileViewport ? '100%' : 980, maxWidth: '100%', maxHeight: isMobileViewport ? '92vh' : '86vh', overflow: 'auto', background: 'var(--modal)', border: '1px solid var(--border)', borderRadius: isMobileViewport ? '18px 18px 0 0' : 16, padding: isMobileViewport ? 16 : 20, display: 'grid', gap: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: isMobileViewport ? 'stretch' : 'center', flexDirection: isMobileViewport ? 'column' : 'row', gap: 10 }}>
              <div>
                <h3 style={{ margin: 0 }}>Abono Global a Proveedor</h3>
                <div style={{ color: 'var(--muted)', fontSize: 13, marginTop: 4 }}>
                  {paymentTarget.name}
                </div>
              </div>
              <div style={{ fontWeight: 700, color: Number(totalPending || 0) > 0 ? '#f59e0b' : '#16a34a' }}>
                Pendiente total: {formatMoney(Number(totalPending || 0), config?.currency)}
              </div>
            </div>

            {loadingPaymentData ? (
              <div style={{ padding: 24, textAlign: 'center', color: 'var(--muted)' }}>Cargando facturas pendientes...</div>
            ) : (
              <>
                <div style={{ display: 'grid', gridTemplateColumns: isMobileViewport ? '1fr' : '1.05fr 1fr', gap: 16 }}>
                  <div style={{ border: '1px solid var(--border)', borderRadius: 14, padding: 14, background: 'var(--bg)', display: 'grid', gap: 12 }}>
                    <div>
                      <div style={{ fontWeight: 700, marginBottom: 4 }}>Registrar abono</div>
                      <div style={{ color: 'var(--muted)', fontSize: 12 }}>
                        El sistema aplicará el monto automáticamente a las facturas con vencimiento más próximo.
                      </div>
                    </div>

                    <div>
                      <label style={{ display: 'block', marginBottom: 6, fontWeight: 700 }}>Monto a abonar</label>
                      <input type="number" min="0" step="0.01" value={paymentAmount} onChange={e => setPaymentAmount(e.target.value)} style={{ width: '100%', padding: 10, borderRadius: 10, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)' }} />
                    </div>

                    <div>
                      <label style={{ display: 'block', marginBottom: 6, fontWeight: 700 }}>Metodo</label>
                      <select value={paymentMethod} onChange={e => setPaymentMethod(e.target.value as 'CASH' | 'CARD' | 'DEPOSIT')} style={{ width: '100%', padding: 10, borderRadius: 10, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)' }}>
                        <option value="CASH">Efectivo</option>
                        <option value="CARD">Tarjeta</option>
                        <option value="DEPOSIT">Deposito</option>
                      </select>
                    </div>

                    <div>
                      <label style={{ display: 'block', marginBottom: 6, fontWeight: 700 }}>Referencia</label>
                      <input type="text" value={paymentReference} onChange={e => setPaymentReference(e.target.value)} placeholder={paymentMethod === 'CASH' ? 'Opcional' : 'Requerido'} style={{ width: '100%', padding: 10, borderRadius: 10, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)' }} />
                    </div>

                    <div>
                      <label style={{ display: 'block', marginBottom: 6, fontWeight: 700 }}>Nota</label>
                      <textarea value={paymentNotes} onChange={e => setPaymentNotes(e.target.value)} rows={3} placeholder="Observación general del abono" style={{ width: '100%', padding: 10, borderRadius: 10, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', resize: 'vertical' }} />
                    </div>

                    <div>
                      <label style={{ display: 'block', marginBottom: 6, fontWeight: 700 }}>Comprobante</label>
                      <input type="file" accept="image/*,.pdf" onChange={e => setPaymentFile(e.target.files?.[0] || null)} style={{ width: '100%', padding: 10, borderRadius: 10, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)' }} />
                      <div style={{ color: 'var(--muted)', fontSize: 12, marginTop: 6, wordBreak: 'break-word' }}>
                        {paymentFile ? `Archivo seleccionado: ${paymentFile.name}` : 'Puedes adjuntar un comprobante del abono global.'}
                      </div>
                    </div>

                    <div style={{ borderRadius: 12, background: 'var(--modal)', border: '1px solid var(--border)', padding: 12 }}>
                      <div style={{ fontWeight: 700, marginBottom: 8 }}>Vista previa de aplicación</div>
                      {allocationPreview.length === 0 ? (
                        <div style={{ color: 'var(--muted)', fontSize: 13 }}>
                          Ingresa un monto para ver cómo se distribuirá el abono.
                        </div>
                      ) : (
                        <div style={{ display: 'grid', gap: 8 }}>
                          {allocationPreview.map(item => (
                            <div key={item.id} style={{ display: 'grid', gap: 2, padding: 10, borderRadius: 10, background: 'var(--bg)', border: '1px solid var(--border)' }}>
                              <div style={{ fontWeight: 700 }}>Compra #{item.id}{item.docNo ? ` · ${item.docNo}` : ''}</div>
                              <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                                {item.dueDate ? `Vence ${new Date(item.dueDate).toLocaleDateString()}` : `Sin vencimiento`} · Pendiente actual {formatMoney(Number(item.balanceDue), config?.currency)}
                              </div>
                              <div style={{ fontSize: 13 }}>
                                Aplica {formatMoney(Number(item.applied), config?.currency)} · Queda {formatMoney(Number(item.resultingBalance), config?.currency)}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>

                  <div style={{ border: '1px solid var(--border)', borderRadius: 14, padding: 14, background: 'var(--bg)', display: 'grid', gap: 14 }}>
                    <div>
                      <div style={{ fontWeight: 700, marginBottom: 4 }}>Facturas pendientes</div>
                      <div style={{ color: 'var(--muted)', fontSize: 12 }}>
                        Ordenadas por vencimiento, que es la misma regla que usará el sistema al repartir el pago.
                      </div>
                    </div>

                    <div style={{ display: 'grid', gap: 8, maxHeight: 260, overflow: 'auto' }}>
                      {pendingPurchases.length === 0 ? (
                        <div style={{ color: 'var(--muted)', textAlign: 'center', padding: 18, border: '1px dashed var(--border)', borderRadius: 12 }}>
                          Este proveedor no tiene facturas pendientes.
                        </div>
                      ) : pendingPurchases.map(purchase => (
                        <div key={purchase.id} style={{ padding: 12, borderRadius: 12, border: '1px solid var(--border)', background: 'var(--modal)' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'flex-start' }}>
                            <div>
                              <div style={{ fontWeight: 700 }}>Compra #{purchase.id}{purchase.docNo ? ` · ${purchase.docNo}` : ''}</div>
                              <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                                {purchase.dueDate ? `Vence ${new Date(purchase.dueDate).toLocaleDateString()}` : 'Sin fecha de vencimiento'}
                              </div>
                            </div>
                            <div style={{ textAlign: 'right', fontWeight: 700, color: '#f59e0b' }}>
                              {formatMoney(Number(purchase.balanceDue), config?.currency)}
                            </div>
                          </div>
                          <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6 }}>
                            Total {formatMoney(Number(purchase.total), config?.currency)} · Pagado {formatMoney(Number(purchase.paidAmount), config?.currency)}
                          </div>
                        </div>
                      ))}
                    </div>

                    <div>
                      <div style={{ fontWeight: 700, marginBottom: 8 }}>Historial de abonos globales</div>
                      <div style={{ display: 'grid', gap: 8, maxHeight: 260, overflow: 'auto' }}>
                        {supplierPayments.length === 0 ? (
                          <div style={{ color: 'var(--muted)', textAlign: 'center', padding: 18, border: '1px dashed var(--border)', borderRadius: 12 }}>
                            Aún no hay abonos globales registrados para este proveedor.
                          </div>
                        ) : supplierPayments.map(payment => (
                          <div key={payment.id} style={{ padding: 12, borderRadius: 12, border: '1px solid var(--border)', background: 'var(--modal)', display: 'grid', gap: 6 }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'flex-start' }}>
                              <div>
                                <div style={{ fontWeight: 700 }}>{formatMoney(Number(payment.amount || 0), config?.currency)}</div>
                                <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                                  {new Date(payment.paidAt).toLocaleString()} · {getPaymentMethodLabel(payment.paymentMethod)}
                                </div>
                              </div>
                              {payment.documentPath && (
                                <a href={payment.documentPath} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)', fontWeight: 700 }}>
                                  Ver comprobante
                                </a>
                              )}
                            </div>
                            {payment.reference && <div style={{ fontSize: 12 }}><strong>Referencia:</strong> {payment.reference}</div>}
                            {payment.notes && <div style={{ fontSize: 12 }}><strong>Nota:</strong> {payment.notes}</div>}
                            <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                              Registrado por: {payment.userName || '-'}
                            </div>
                            <div style={{ display: 'grid', gap: 4 }}>
                              {payment.allocations.map(allocation => (
                                <div key={`${payment.id}_${allocation.purchaseId}_${allocation.purchasePaymentId || 0}`} style={{ fontSize: 12, padding: 8, borderRadius: 8, background: 'var(--bg)' }}>
                                  Compra #{allocation.purchaseId}{allocation.docNo ? ` · ${allocation.docNo}` : ''} · Aplicado {formatMoney(Number(allocation.amount || 0), config?.currency)}{allocation.dueDate ? ` · Vence ${new Date(allocation.dueDate).toLocaleDateString()}` : ''}
                                </div>
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>

                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, flexDirection: isMobileViewport ? 'column' : 'row' }}>
                  <button type="button" className="btn-secondary" onClick={closePaymentModal}>
                    Cerrar
                  </button>
                  <button type="submit" className="btn-primary" disabled={processingPayment || pendingPurchases.length === 0}>
                    {processingPayment ? 'Guardando...' : 'Guardar Abono Global'}
                  </button>
                </div>
              </>
            )}
          </form>
        </div>
      )}
    </div>
  )
}
