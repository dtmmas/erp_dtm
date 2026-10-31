import React, { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { api, getPurchasePayments, payPurchase } from '../api'
import { useConfigStore } from '../store/config'
import { formatMoney } from '../utils/currency'
import { getWarehouseHighlightStyle } from '../utils/warehouseHighlight'
import { useAuthStore } from '../store/auth'

interface PurchaseItem {
  id: number
  product_id: number
  product_name: string
  product_code: string
  quantity: number
  unit_cost: number
  total_cost: number
  serials?: string
}

interface Purchase {
  id: number
  supplier_name: string
  user_name: string
  warehouse_name?: string
  doc_no: string
  total: number
  status: string
  payment_type: string
  payment_status: string
  payment_method: string
  paid_amount: number
  balance_due: number
  due_date?: string | null
  created_at: string
  notes: string
  items: PurchaseItem[]
}

interface PurchasePayment {
  id: number
  purchase_id: number
  amount: number
  payment_method: string
  reference?: string | null
  notes?: string | null
  document_path?: string | null
  paid_at: string
  user_name?: string | null
}

function getPaymentMethodLabel(method?: string) {
  if (method === 'CARD') return 'Tarjeta'
  if (method === 'DEPOSIT') return 'Deposito'
  return 'Efectivo'
}

function getPaymentStatusMeta(status?: string) {
  const normalized = String(status || '').toUpperCase()
  if (normalized === 'PAID') {
    return { label: 'PAGADO', background: 'rgba(34, 197, 94, 0.14)', color: '#16a34a' }
  }
  if (normalized === 'PARTIAL') {
    return { label: 'ABONADO', background: 'rgba(245, 158, 11, 0.14)', color: '#d97706' }
  }
  return { label: 'POR PAGAR', background: 'rgba(239, 68, 68, 0.14)', color: '#dc2626' }
}

export default function PurchaseDetails() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [purchase, setPurchase] = useState<Purchase | null>(null)
  const [payments, setPayments] = useState<PurchasePayment[]>([])
  const [loading, setLoading] = useState(true)
  const [isMobileViewport, setIsMobileViewport] = useState(false)
  const [paymentModalOpen, setPaymentModalOpen] = useState(false)
  const [paymentAmount, setPaymentAmount] = useState('')
  const [paymentMethod, setPaymentMethod] = useState('CASH')
  const [paymentReference, setPaymentReference] = useState('')
  const [paymentNotes, setPaymentNotes] = useState('')
  const [paymentFile, setPaymentFile] = useState<File | null>(null)
  const [processingPayment, setProcessingPayment] = useState(false)
  const config = useConfigStore(s => s.config)
  const { hasPermission } = useAuthStore()

  useEffect(() => {
    loadPurchase()
  }, [id])

  useEffect(() => {
    const mediaQuery = window.matchMedia('(max-width: 768px)')
    const syncViewport = () => setIsMobileViewport(mediaQuery.matches)
    syncViewport()
    mediaQuery.addEventListener('change', syncViewport)
    return () => mediaQuery.removeEventListener('change', syncViewport)
  }, [])

  async function loadPurchase() {
    try {
      const [{ data }, paymentRows] = await Promise.all([
        api.get(`/purchases/${id}`),
        id ? getPurchasePayments(id) : Promise.resolve([]),
      ])
      setPurchase(data)
      setPayments(paymentRows)
    } catch (err) {
      console.error(err)
      alert('Error cargando detalles de la compra')
      navigate('/purchases')
    } finally {
      setLoading(false)
    }
  }

  function openPaymentModal() {
    if (!purchase) return
    setPaymentAmount(String(Number(purchase.balance_due || 0).toFixed(2)))
    setPaymentMethod('CASH')
    setPaymentReference('')
    setPaymentNotes('')
    setPaymentFile(null)
    setPaymentModalOpen(true)
  }

  function closePaymentModal() {
    setPaymentModalOpen(false)
    setPaymentAmount('')
    setPaymentMethod('CASH')
    setPaymentReference('')
    setPaymentNotes('')
    setPaymentFile(null)
  }

  async function handleRegisterPayment(e: React.FormEvent) {
    e.preventDefault()
    if (!purchase || !id) return

    const amount = Number(paymentAmount || 0)
    if (!Number.isFinite(amount) || amount <= 0) {
      alert('Monto invalido')
      return
    }
    if (amount - Number(purchase.balance_due || 0) > 0.009) {
      alert('El monto excede el saldo pendiente')
      return
    }
    if ((paymentMethod === 'CARD' || paymentMethod === 'DEPOSIT') && !paymentReference.trim()) {
      alert('Ingrese referencia para pagos con tarjeta o deposito')
      return
    }

    setProcessingPayment(true)
    try {
      const formData = new FormData()
      formData.append('amount', String(amount))
      formData.append('paymentMethod', paymentMethod)
      if (paymentReference.trim()) formData.append('reference', paymentReference.trim())
      if (paymentNotes.trim()) formData.append('notes', paymentNotes.trim())
      if (paymentFile) formData.append('document', paymentFile)

      await payPurchase(id, formData)
      await loadPurchase()
      closePaymentModal()
      alert('Abono registrado correctamente')
    } catch (err: any) {
      console.error(err)
      alert(err.response?.data?.error || 'Error registrando abono')
    } finally {
      setProcessingPayment(false)
    }
  }

  if (loading) return <div style={{ padding: 20 }}>Cargando...</div>
  if (!purchase) return null
  const paymentMeta = getPaymentStatusMeta(purchase.payment_status)
  const canPay = hasPermission('purchases:write') && Number(purchase.balance_due || 0) > 0

  return (
    <div style={{ padding: isMobileViewport ? 14 : 20, maxWidth: 1000, margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: isMobileViewport ? 'stretch' : 'center', flexDirection: isMobileViewport ? 'column' : 'row', gap: 12, marginBottom: 20 }}>
        <h1>Detalle de Compra #{purchase.id}</h1>
        <button className="btn-secondary" onClick={() => navigate('/purchases')}>Volver</button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: isMobileViewport ? '1fr' : '1fr 1fr', gap: 20, marginBottom: 20, padding: isMobileViewport ? 14 : 20, backgroundColor: 'var(--modal)', borderRadius: 8, border: '1px solid var(--border)' }}>
        <div>
          <p><strong>Fecha:</strong> {new Date(purchase.created_at).toLocaleString()}</p>
          <p><strong>Proveedor:</strong> {purchase.supplier_name}</p>
          <p><strong>Usuario:</strong> {purchase.user_name}</p>
          <p><strong>Almacén Destino:</strong> <span className="warehouse-highlight" style={getWarehouseHighlightStyle(purchase.warehouse_name || 'Tienda Principal')}>{purchase.warehouse_name || 'Tienda Principal'}</span></p>
        </div>
        <div>
          <p><strong>Doc No:</strong> {purchase.doc_no || '-'}</p>
          <p><strong>Estado:</strong> {purchase.status}</p>
          <p><strong>Tipo de pago:</strong> {purchase.payment_type === 'CREDIT' ? 'Credito por pagar' : 'Contado'}</p>
          <p><strong>Metodo:</strong> {getPaymentMethodLabel(purchase.payment_method)}</p>
          <p><strong>Pago:</strong> <span style={{ padding: '4px 8px', borderRadius: 999, background: paymentMeta.background, color: paymentMeta.color, fontWeight: 700 }}>{paymentMeta.label}</span></p>
          <p><strong>Pagado:</strong> {formatMoney(Number(purchase.paid_amount || 0), config?.currency)}</p>
          <p><strong>Pendiente:</strong> <span style={{ color: Number(purchase.balance_due || 0) > 0 ? '#f59e0b' : '#16a34a', fontWeight: 700 }}>{formatMoney(Number(purchase.balance_due || 0), config?.currency)}</span></p>
          {purchase.due_date && Number(purchase.balance_due || 0) > 0 && <p><strong>Vence:</strong> {new Date(purchase.due_date).toLocaleDateString()}</p>}
          <p><strong>Notas:</strong> {purchase.notes || '-'}</p>
        </div>
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: isMobileViewport ? 'stretch' : 'center', flexDirection: isMobileViewport ? 'column' : 'row', gap: 12, marginBottom: 20 }}>
        <h3 style={{ margin: 0 }}>Historial de Pagos al Proveedor</h3>
        {canPay && (
          <button className="btn-primary" onClick={openPaymentModal}>
            + Registrar Abono
          </button>
        )}
      </div>

      {isMobileViewport ? (
        <div style={{ display: 'grid', gap: 12, marginBottom: 20 }}>
          {payments.length === 0 ? (
            <div style={{ border: '1px solid var(--border)', borderRadius: 12, backgroundColor: 'var(--modal)', padding: 14, textAlign: 'center', color: 'var(--muted)' }}>
              No hay pagos registrados para esta compra.
            </div>
          ) : payments.map(payment => (
            <div key={payment.id} style={{ border: '1px solid var(--border)', borderRadius: 12, backgroundColor: 'var(--modal)', padding: 14, display: 'grid', gap: 8 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                <div>
                  <div style={{ fontWeight: 700 }}>{formatMoney(Number(payment.amount || 0), config?.currency)}</div>
                  <div style={{ fontSize: 12, color: 'var(--muted)' }}>{new Date(payment.paid_at).toLocaleString()}</div>
                </div>
                <span style={{ padding: '4px 8px', borderRadius: 999, border: '1px solid var(--border)' }}>{getPaymentMethodLabel(payment.payment_method)}</span>
              </div>
              {payment.reference && <div><strong>Referencia:</strong> {payment.reference}</div>}
              {payment.notes && <div><strong>Nota:</strong> {payment.notes}</div>}
              {payment.document_path && (
                <a href={payment.document_path} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)', fontWeight: 700 }}>
                  Ver comprobante
                </a>
              )}
              <div><strong>Registrado por:</strong> {payment.user_name || '-'}</div>
            </div>
          ))}
        </div>
      ) : (
        <div style={{ border: '1px solid var(--border)', borderRadius: 8, backgroundColor: 'var(--modal)', overflow: 'hidden', marginBottom: 20 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ backgroundColor: 'var(--surface)' }}>
                <th style={{ padding: 12, textAlign: 'left', borderBottom: '1px solid var(--border)' }}>Fecha</th>
                <th style={{ padding: 12, textAlign: 'right', borderBottom: '1px solid var(--border)' }}>Monto</th>
                <th style={{ padding: 12, textAlign: 'left', borderBottom: '1px solid var(--border)' }}>Metodo</th>
                <th style={{ padding: 12, textAlign: 'left', borderBottom: '1px solid var(--border)' }}>Referencia</th>
                <th style={{ padding: 12, textAlign: 'left', borderBottom: '1px solid var(--border)' }}>Nota</th>
                <th style={{ padding: 12, textAlign: 'left', borderBottom: '1px solid var(--border)' }}>Usuario</th>
              </tr>
            </thead>
            <tbody>
              {payments.length === 0 ? (
                <tr>
                  <td colSpan={6} style={{ padding: 20, textAlign: 'center', color: 'var(--muted)' }}>
                    No hay pagos registrados para esta compra.
                  </td>
                </tr>
              ) : payments.map(payment => (
                <tr key={payment.id} style={{ borderBottom: '1px solid var(--border)' }}>
                  <td style={{ padding: 12 }}>{new Date(payment.paid_at).toLocaleString()}</td>
                  <td style={{ padding: 12, textAlign: 'right', fontWeight: 700 }}>{formatMoney(Number(payment.amount || 0), config?.currency)}</td>
                  <td style={{ padding: 12 }}>{getPaymentMethodLabel(payment.payment_method)}</td>
                  <td style={{ padding: 12 }}>{payment.reference || '-'}</td>
                  <td style={{ padding: 12 }}>
                    <div>{payment.notes || '-'}</div>
                    {payment.document_path && (
                      <a href={payment.document_path} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)', fontWeight: 700 }}>
                        Ver comprobante
                      </a>
                    )}
                  </td>
                  <td style={{ padding: 12 }}>{payment.user_name || '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {isMobileViewport ? (
        <div style={{ display: 'grid', gap: 12 }}>
          {purchase.items.map(item => (
            <div key={item.id} style={{ border: '1px solid var(--border)', borderRadius: 12, backgroundColor: 'var(--modal)', padding: 14, display: 'grid', gap: 10 }}>
              <div>
                <div style={{ fontWeight: 'bold' }}>{item.product_name}</div>
                <div style={{ fontSize: '0.85rem', color: 'var(--muted)' }}>{item.product_code}</div>
              </div>
              {item.serials && (
                <div style={{ fontSize: '0.8rem', color: 'var(--text)', whiteSpace: 'pre-wrap', backgroundColor: 'var(--bg)', padding: 8, borderRadius: 8, border: '1px solid var(--border)' }}>
                  <strong>Series/IMEIs:</strong><br />
                  {item.serials}
                </div>
              )}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 8 }}>
                <div><div style={{ fontSize: 11, color: 'var(--muted)' }}>Cantidad</div><div style={{ fontWeight: 700 }}>{item.quantity}</div></div>
                <div><div style={{ fontSize: 11, color: 'var(--muted)' }}>Costo Unit.</div><div style={{ fontWeight: 700 }}>{formatMoney(Number(item.unit_cost), config?.currency)}</div></div>
                <div><div style={{ fontSize: 11, color: 'var(--muted)' }}>Total</div><div style={{ fontWeight: 700 }}>{formatMoney(Number(item.total_cost), config?.currency)}</div></div>
              </div>
            </div>
          ))}
          <div style={{ border: '1px solid var(--border)', borderRadius: 12, backgroundColor: 'var(--modal)', padding: 14, textAlign: 'right', fontWeight: 'bold', fontSize: '1.1rem', color: 'var(--accent)' }}>
            Total: {formatMoney(Number(purchase.total), config?.currency)}
          </div>
        </div>
      ) : (
      <div style={{ border: '1px solid var(--border)', borderRadius: 8, backgroundColor: 'var(--modal)', overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ backgroundColor: 'var(--surface)' }}>
              <th style={{ padding: 12, textAlign: 'left', borderBottom: '1px solid var(--border)' }}>Producto</th>
              <th style={{ padding: 12, textAlign: 'center', borderBottom: '1px solid var(--border)' }}>Cantidad</th>
              <th style={{ padding: 12, textAlign: 'right', borderBottom: '1px solid var(--border)' }}>Costo Unit.</th>
              <th style={{ padding: 12, textAlign: 'right', borderBottom: '1px solid var(--border)' }}>Total</th>
            </tr>
          </thead>
          <tbody>
            {purchase.items.map(item => (
              <tr key={item.id} style={{ borderBottom: '1px solid var(--border)' }}>
                <td style={{ padding: 12 }}>
                  <div style={{ fontWeight: 'bold' }}>{item.product_name}</div>
                  <div style={{ fontSize: '0.85rem', color: 'var(--muted)' }}>{item.product_code}</div>
                  {item.serials && (
                    <div style={{ marginTop: 4, fontSize: '0.8rem', color: 'var(--text)', whiteSpace: 'pre-wrap', backgroundColor: 'var(--bg)', padding: 4, borderRadius: 4, border: '1px solid var(--border)' }}>
                      <strong>Series/IMEIs:</strong><br/>
                      {item.serials}
                    </div>
                  )}
                </td>
                <td style={{ padding: 12, textAlign: 'center' }}>{item.quantity}</td>
                <td style={{ padding: 12, textAlign: 'right' }}>{formatMoney(Number(item.unit_cost), config?.currency)}</td>
                <td style={{ padding: 12, textAlign: 'right' }}>{formatMoney(Number(item.total_cost), config?.currency)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={3} style={{ padding: 12, textAlign: 'right', fontWeight: 'bold' }}>Total:</td>
              <td style={{ padding: 12, textAlign: 'right', fontWeight: 'bold', fontSize: '1.2rem', color: 'var(--accent)' }}>
                {formatMoney(Number(purchase.total), config?.currency)}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
      )}

      {paymentModalOpen && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', justifyContent: 'center', alignItems: isMobileViewport ? 'flex-end' : 'center', zIndex: 120, padding: isMobileViewport ? 0 : 16 }}>
          <form onSubmit={handleRegisterPayment} style={{ background: 'var(--modal)', padding: isMobileViewport ? 16 : 20, borderRadius: isMobileViewport ? '18px 18px 0 0' : 12, width: isMobileViewport ? '100%' : 520, maxWidth: '100%', display: 'grid', gap: 12 }}>
            <div>
              <h3 style={{ margin: '0 0 6px 0' }}>Registrar Pago a Proveedor</h3>
              <div style={{ color: 'var(--muted)', fontSize: 13 }}>
                Saldo pendiente: {formatMoney(Number(purchase.balance_due || 0), config?.currency)}
              </div>
            </div>
            <div>
              <label style={{ display: 'block', marginBottom: 6, fontWeight: 700 }}>Monto</label>
              <input type="number" min="0" step="0.01" value={paymentAmount} onChange={e => setPaymentAmount(e.target.value)} style={{ width: '100%', padding: 10, borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)' }} />
            </div>
            <div>
              <label style={{ display: 'block', marginBottom: 6, fontWeight: 700 }}>Metodo</label>
              <select value={paymentMethod} onChange={e => setPaymentMethod(e.target.value)} style={{ width: '100%', padding: 10, borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)' }}>
                <option value="CASH">Efectivo</option>
                <option value="CARD">Tarjeta</option>
                <option value="DEPOSIT">Deposito</option>
              </select>
            </div>
            <div>
              <label style={{ display: 'block', marginBottom: 6, fontWeight: 700 }}>Referencia</label>
              <input type="text" value={paymentReference} onChange={e => setPaymentReference(e.target.value)} placeholder={paymentMethod === 'CASH' ? 'Opcional' : 'Requerido'} style={{ width: '100%', padding: 10, borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)' }} />
            </div>
            <div>
              <label style={{ display: 'block', marginBottom: 6, fontWeight: 700 }}>Nota</label>
              <input type="text" value={paymentNotes} onChange={e => setPaymentNotes(e.target.value)} placeholder="Observacion del abono" style={{ width: '100%', padding: 10, borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)' }} />
            </div>
            <div>
              <label style={{ display: 'block', marginBottom: 6, fontWeight: 700 }}>Comprobante</label>
              <input type="file" accept="image/*,.pdf" onChange={e => setPaymentFile(e.target.files?.[0] || null)} style={{ width: '100%', padding: 10, borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)' }} />
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, flexDirection: isMobileViewport ? 'column' : 'row' }}>
              <button type="button" className="btn-secondary" onClick={closePaymentModal}>Cancelar</button>
              <button type="submit" className="btn-primary" disabled={processingPayment}>
                {processingPayment ? 'Guardando...' : 'Guardar Abono'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  )
}
