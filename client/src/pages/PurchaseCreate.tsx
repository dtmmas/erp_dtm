import React, { useState, useEffect, useMemo } from 'react'
import { api, getSuppliers, getProducts } from '../api'
import { useConfigStore } from '../store/config'
import { useNavigate } from 'react-router-dom'
import { formatMoney } from '../utils/currency'

interface Product {
  id: number
  name: string
  code?: string
  sku?: string
  productCode?: string
  description?: string
  altName?: string
  genericName?: string
  cost?: number
  avgCost?: number
  lastCost?: number
  stock: number
  productType?: string
}

interface PurchaseItem {
  productId: number
  name: string
  code: string
  quantity: number
  unitCost: number
  productType?: string
  // Medicinal
  batches?: { batchNo: string; expiryDate: string; quantity: number }[]
  // Legacy single batch fields (optional, kept for compatibility if needed temporarily)
  batchNo?: string
  expiryDate?: string
  // IMEI/Serial
  serials?: string // for backend compatibility (payload)
  imeiEntries?: string[] // for UI handling
}

interface Warehouse {
    id: number
    name: string
}

export default function PurchaseCreate() {
  const [suppliers, setSuppliers] = useState<any[]>([])
  const [products, setProducts] = useState<Product[]>([])
  const [warehouses, setWarehouses] = useState<Warehouse[]>([])
  const [loading, setLoading] = useState(false)
  
  // Form State
  const [supplierId, setSupplierId] = useState<number | ''>('')
  const [warehouseId, setWarehouseId] = useState<number | ''>('')
  const [docNo, setDocNo] = useState('')
  const [notes, setNotes] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [paymentFile, setPaymentFile] = useState<File | null>(null)
  const [items, setItems] = useState<PurchaseItem[]>([])
  const [paymentType, setPaymentType] = useState<'CASH' | 'CREDIT'>('CASH')
  const [paymentMethod, setPaymentMethod] = useState<'CASH' | 'CARD' | 'DEPOSIT'>('CASH')
  const [initialPayment, setInitialPayment] = useState('')
  const [dueDate, setDueDate] = useState('')
  const [paymentReference, setPaymentReference] = useState('')
  const [paymentNotes, setPaymentNotes] = useState('')
  
  // Product Search State
  const [isProductModalOpen, setIsProductModalOpen] = useState(false)
  const [productSearch, setProductSearch] = useState('')
  const [debouncedProductSearch, setDebouncedProductSearch] = useState('')
  const [isMobileViewport, setIsMobileViewport] = useState(false)
  
  const navigate = useNavigate()
  const config = useConfigStore(s => s.config)
  const panelPadding = isMobileViewport ? 14 : 20
  const controlPadding = isMobileViewport ? '10px 12px' : 8
  const baseFieldStyle: React.CSSProperties = {
    width: '100%',
    padding: controlPadding,
    borderRadius: 10,
    border: '1px solid var(--border)',
    background: 'var(--bg)',
    color: 'var(--text)',
    minHeight: isMobileViewport ? 44 : undefined,
  }
  const mutedFieldStyle: React.CSSProperties = {
    ...baseFieldStyle,
    background: 'var(--surface)',
  }
  const sectionStyle: React.CSSProperties = {
    padding: panelPadding,
    backgroundColor: 'var(--modal)',
    borderRadius: 12,
    border: '1px solid var(--border)',
    display: 'grid',
    gap: isMobileViewport ? 14 : 16,
  }
  const summaryCardStyle: React.CSSProperties = {
    border: '1px solid var(--border)',
    borderRadius: 12,
    background: 'var(--modal)',
    padding: isMobileViewport ? 12 : 14,
    minWidth: 0,
  }

  useEffect(() => {
    loadData()
  }, [])

  useEffect(() => {
    const mediaQuery = window.matchMedia('(max-width: 768px)')
    const syncViewport = () => setIsMobileViewport(mediaQuery.matches)
    syncViewport()
    mediaQuery.addEventListener('change', syncViewport)
    return () => mediaQuery.removeEventListener('change', syncViewport)
  }, [])

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      setDebouncedProductSearch(productSearch.trim())
    }, 300)

    return () => window.clearTimeout(timeoutId)
  }, [productSearch])

  useEffect(() => {
    if (!isProductModalOpen) return
    let cancelled = false

    const loadProducts = async () => {
      try {
        const response = await getProducts({
          paged: true,
          page: 1,
          limit: 40,
          search: debouncedProductSearch || undefined,
          stockFilter: 'all',
        })
        if (cancelled) return
        const nextProducts = Array.isArray(response?.data) ? response.data : Array.isArray(response) ? response : []
        setProducts(nextProducts)
      } catch (err) {
        if (cancelled) return
        console.error('Error loading purchase products:', err)
        setProducts([])
      }
    }

    void loadProducts()

    return () => {
      cancelled = true
    }
  }, [isProductModalOpen, debouncedProductSearch])

  async function loadData() {
    try {
      const [suppData, whRes] = await Promise.all([
        getSuppliers(),
        api.get('/warehouses')
      ])
      setSuppliers(suppData)
      setWarehouses(whRes.data)
      
      // Default to TIENDA (usually ID 1) or first warehouse
      const tienda = whRes.data.find((w: any) => w.name.toUpperCase() === 'TIENDA' || w.name.toUpperCase() === 'PRINCIPAL')
      if (tienda) {
        setWarehouseId(tienda.id)
      } else if (whRes.data.length > 0) {
        setWarehouseId(whRes.data[0].id)
      }
    } catch (err) {
      console.error('Error loading data:', err)
      alert('Error cargando datos iniciales')
    }
  }

  const filteredProducts = useMemo(() => products, [products])

  function getProductCode(product: Product) {
    return product.productCode || product.code || product.sku || ''
  }

  function getProductIdentifierSummary(product: Product) {
    const code = product.productCode || product.code || ''
    const sku = product.sku || ''
    if (code && sku && code !== sku) {
      return `COD: ${code} | SKU: ${sku}`
    }
    if (code) return `COD: ${code}`
    if (sku) return `SKU: ${sku}`
    return 'Sin codigo'
  }

  async function addItem(product: Product) {
    const existing = items.find(i => i.productId === product.id)

    if (existing) {
        alert('El producto ya está en la lista')
        return
    }

    setItems([...items, {
      productId: product.id,
      name: product.name,
      code: getProductCode(product),
      quantity: 1,
      unitCost: product.lastCost ?? product.avgCost ?? product.cost ?? 0,
      productType: product.productType,
      batches: product.productType === 'MEDICINAL' ? [{ batchNo: '', expiryDate: '', quantity: 1 }] : undefined,
      imeiEntries: (product.productType === 'IMEI' || product.productType === 'SERIAL') ? [''] : undefined,
    }])
    setIsProductModalOpen(false)
    setProductSearch('')
    setDebouncedProductSearch('')
  }

  function updateItem(index: number, field: keyof PurchaseItem, value: any) {
    const newItems = [...items]
    const item = { ...newItems[index], [field]: value }
    
    // Logic for Medicinal Batches: Add single default batch row if empty, but do NOT auto-expand quantity
    if (field === 'quantity' && item.productType === 'MEDICINAL') {
        const currentBatches = item.batches || [];
        if (currentBatches.length === 0) {
            item.batches = [{ batchNo: '', expiryDate: '', quantity: Number(value) }];
        }
        // Do not force batch rows to match quantity automatically. Let user manage them.
    }

    if (field === 'quantity' && (item.productType === 'IMEI' || item.productType === 'SERIAL')) {
        const newQty = Number(value);
        const currentEntries = item.imeiEntries || [];
        
        if (newQty > currentEntries.length) {
            const diff = newQty - currentEntries.length;
            const newLines = Array(diff).fill('');
            item.imeiEntries = [...currentEntries, ...newLines];
        } else if (newQty < currentEntries.length) {
            // Remove from end
            item.imeiEntries = currentEntries.slice(0, newQty);
        }
    }

    newItems[index] = item
    setItems(newItems)
  }

  function updateBatch(itemIndex: number, batchIndex: number, field: string, value: any) {
    const newItems = [...items]
    const item = { ...newItems[itemIndex] }
    if (item.batches) {
        const newBatches = [...item.batches]
        newBatches[batchIndex] = { ...newBatches[batchIndex], [field]: value }
        item.batches = newBatches
        newItems[itemIndex] = item
        setItems(newItems)
    }
  }

  function addBatch(itemIndex: number) {
    const newItems = [...items]
    const item = { ...newItems[itemIndex] }
    if (item.batches) {
        item.batches = [...item.batches, { batchNo: '', expiryDate: '', quantity: 0 }]
        newItems[itemIndex] = item
        setItems(newItems)
    }
  }

  function removeBatch(itemIndex: number, batchIndex: number) {
    const newItems = [...items]
    const item = { ...newItems[itemIndex] }
    if (item.batches && item.batches.length > 1) {
        const newBatches = [...item.batches]
        newBatches.splice(batchIndex, 1)
        item.batches = newBatches
        newItems[itemIndex] = item
        setItems(newItems)
    }
  }

  function updateImeiEntry(itemIndex: number, imeiIndex: number, value: string) {
    const newItems = [...items]
    const item = { ...newItems[itemIndex] }
    if (item.imeiEntries) {
        const newEntries = [...item.imeiEntries]
        newEntries[imeiIndex] = value
        item.imeiEntries = newEntries
        newItems[itemIndex] = item
        setItems(newItems)
    }
  }

  function removeItem(index: number) {
    setItems(items.filter((_, i) => i !== index))
  }

  const total = items.reduce((sum, item) => sum + (item.quantity * item.unitCost), 0)
  const normalizedInitialPayment = useMemo(() => {
    if (paymentType === 'CASH') return total
    const parsed = Number(initialPayment || 0)
    if (!Number.isFinite(parsed)) return 0
    return Math.min(total, Math.max(0, parsed))
  }, [paymentType, initialPayment, total])
  const balanceDue = Math.max(0, total - normalizedInitialPayment)

  async function handleSubmit() {
    if (!supplierId) return alert('Seleccione un proveedor')
    if (items.length === 0) return alert('Agregue productos a la compra')
    if (paymentType === 'CREDIT' && balanceDue > 0 && !dueDate) {
      return alert('Ingrese fecha de vencimiento para compras al credito')
    }
    if ((paymentMethod === 'CARD' || paymentMethod === 'DEPOSIT') && normalizedInitialPayment > 0 && !paymentReference.trim()) {
      return alert('Ingrese referencia para pagos con tarjeta o deposito')
    }

    // Validation for Medicinal products (batches)
    for (const item of items) {
        if (item.productType === 'MEDICINAL') {
            if (!item.batches || item.batches.length === 0) {
                 return alert(`Ingrese lotes para el producto ${item.name}`)
            }
            const batchSum = item.batches.reduce((sum, b) => sum + b.quantity, 0)
            if (batchSum !== item.quantity) {
                 return alert(`La suma de cantidades de los lotes para ${item.name} (${batchSum}) no coincide con la cantidad total (${item.quantity})`)
            }
            for (const batch of item.batches) {
                if (!batch.batchNo || !batch.expiryDate) {
                    return alert(`Complete todos los datos (Lote y Vencimiento) para el producto ${item.name}`)
                }
            }
        }
        
        if (item.productType === 'IMEI' || item.productType === 'SERIAL') {
             const entries = item.imeiEntries || []
             if (entries.length !== item.quantity) {
                 // Should be synced by logic, but just in case
                 return alert(`Cantidad de ${item.productType}s no coincide con la cantidad del producto ${item.name}`)
             }
             if (entries.some(e => !e.trim())) {
                 return alert(`Ingrese todos los ${item.productType}s para el producto ${item.name}`)
             }
        }
    }

    setLoading(true)
    try {
      // Prepare items payload (avoid mutating state)
      const payloadItems = items.map(item => {
        const newItem = { ...item }
        if ((item.productType === 'IMEI' || item.productType === 'SERIAL') && item.imeiEntries) {
            newItem.serials = item.imeiEntries.join('\n')
        }
        return newItem
      })

      const formData = new FormData()
      formData.append('supplierId', String(supplierId))
      if (warehouseId) formData.append('warehouseId', String(warehouseId))
      formData.append('docNo', docNo)
      formData.append('notes', notes)
      formData.append('total', String(total))
      formData.append('paymentType', paymentType)
      formData.append('paymentMethod', paymentMethod)
      formData.append('initialPayment', String(normalizedInitialPayment))
      if (dueDate) formData.append('dueDate', dueDate)
      if (paymentReference.trim()) formData.append('paymentReference', paymentReference.trim())
      if (paymentNotes.trim()) formData.append('paymentNotes', paymentNotes.trim())
      formData.append('items', JSON.stringify(payloadItems))
      if (file) {
        formData.append('document', file)
      }
      if (paymentFile) {
        formData.append('paymentDocument', paymentFile)
      }

      await api.post('/purchases', formData)
      alert('Compra registrada exitosamente')
      navigate('/purchases')
    } catch (err: any) {
      console.error(err)
      alert(err.response?.data?.error || 'Error al registrar compra')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={{ padding: isMobileViewport ? 14 : 20, maxWidth: 1200, margin: '0 auto', height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: isMobileViewport ? 'stretch' : 'center', flexDirection: isMobileViewport ? 'column' : 'row', gap: 12, marginBottom: 20 }}>
        <h1>Nueva Compra</h1>
        <button className="btn-secondary" style={{ width: isMobileViewport ? '100%' : 'auto' }} onClick={() => navigate('/purchases')}>Cancelar</button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: isMobileViewport ? '1fr' : '1.15fr 1fr', gap: 20, marginBottom: 20 }}>
        <section style={sectionStyle}>
          <div>
            <h3 style={{ margin: 0, fontSize: '1rem' }}>Datos de la Compra</h3>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>
              Informacion propia de la factura, proveedor y archivo de la compra.
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: isMobileViewport ? '1fr' : 'repeat(2, minmax(0, 1fr))', gap: 16 }}>
            <div>
              <label style={{ display: 'block', marginBottom: 8, fontWeight: 'bold' }}>Proveedor</label>
              <select
                value={supplierId}
                onChange={e => setSupplierId(Number(e.target.value))}
                style={baseFieldStyle}
              >
                <option value="">Seleccione Proveedor</option>
                {suppliers.map(s => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </div>

            <div>
              <label style={{ display: 'block', marginBottom: 8, fontWeight: 'bold' }}>Almacén Destino (Opcional)</label>
              <select
                value={warehouseId}
                onChange={e => setWarehouseId(e.target.value ? Number(e.target.value) : '')}
                style={baseFieldStyle}
              >
                {warehouses.map(w => (
                  <option key={w.id} value={w.id}>{w.name}</option>
                ))}
              </select>
            </div>

            <div>
              <label style={{ display: 'block', marginBottom: 8, fontWeight: 'bold' }}>N° Documento / Factura</label>
              <input
                type="text"
                value={docNo}
                onChange={e => setDocNo(e.target.value)}
                style={baseFieldStyle}
                placeholder="Ej. F001-12345"
              />
            </div>

            <div>
              <label style={{ display: 'block', marginBottom: 8, fontWeight: 'bold' }}>Documento de Compra (PDF/Img)</label>
              <input
                type="file"
                accept=".pdf,image/*"
                onChange={e => setFile(e.target.files?.[0] || null)}
                style={{ ...baseFieldStyle, padding: isMobileViewport ? 10 : 5 }}
              />
              <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6, wordBreak: 'break-word' }}>
                {file ? `Archivo seleccionado: ${file.name}` : 'Puedes subir factura, orden o imagen del documento.'}
              </div>
            </div>
          </div>

          <div>
            <label style={{ display: 'block', marginBottom: 8, fontWeight: 'bold' }}>Notas</label>
            <textarea
              value={notes}
              onChange={e => setNotes(e.target.value)}
              rows={isMobileViewport ? 3 : 2}
              style={{ ...baseFieldStyle, resize: 'vertical', minHeight: isMobileViewport ? 92 : 74 }}
              placeholder="Observaciones..."
            />
          </div>
        </section>

        <section style={sectionStyle}>
          <div>
            <h3 style={{ margin: 0, fontSize: '1rem' }}>Datos del Pago</h3>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>
              Define si la factura fue al contado o credito, con su abono, referencia y comprobante.
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: isMobileViewport ? '1fr' : 'repeat(2, minmax(0, 1fr))', gap: 16 }}>
            <div>
              <label style={{ display: 'block', marginBottom: 8, fontWeight: 'bold' }}>Tipo de Pago</label>
              <select
                value={paymentType}
                onChange={e => setPaymentType(e.target.value as 'CASH' | 'CREDIT')}
                style={baseFieldStyle}
              >
                <option value="CASH">Contado</option>
                <option value="CREDIT">Credito por pagar</option>
              </select>
            </div>

            <div>
              <label style={{ display: 'block', marginBottom: 8, fontWeight: 'bold' }}>Metodo de Pago</label>
              <select
                value={paymentMethod}
                onChange={e => setPaymentMethod(e.target.value as 'CASH' | 'CARD' | 'DEPOSIT')}
                style={baseFieldStyle}
              >
                <option value="CASH">Efectivo</option>
                <option value="CARD">Tarjeta</option>
                <option value="DEPOSIT">Deposito</option>
              </select>
            </div>

            <div>
              <label style={{ display: 'block', marginBottom: 8, fontWeight: 'bold' }}>
                {paymentType === 'CASH' ? 'Pagado' : 'Abono Inicial'}
              </label>
              <input
                type="number"
                min="0"
                step="0.01"
                value={paymentType === 'CASH' ? total : initialPayment}
                onChange={e => setInitialPayment(e.target.value)}
                disabled={paymentType === 'CASH'}
                style={paymentType === 'CASH' ? mutedFieldStyle : baseFieldStyle}
                placeholder={paymentType === 'CASH' ? 'Se pagara el total' : '0.00'}
              />
            </div>

            <div>
              <label style={{ display: 'block', marginBottom: 8, fontWeight: 'bold' }}>Vence el</label>
              <input
                type="date"
                value={dueDate}
                onChange={e => setDueDate(e.target.value)}
                disabled={paymentType !== 'CREDIT' || balanceDue <= 0}
                style={paymentType !== 'CREDIT' || balanceDue <= 0 ? mutedFieldStyle : baseFieldStyle}
              />
            </div>

            <div>
              <label style={{ display: 'block', marginBottom: 8, fontWeight: 'bold' }}>Referencia</label>
              <input
                type="text"
                value={paymentReference}
                onChange={e => setPaymentReference(e.target.value)}
                style={baseFieldStyle}
                placeholder={paymentMethod === 'CASH' ? 'Opcional' : 'Requerido para tarjeta/deposito'}
              />
            </div>

            <div>
              <label style={{ display: 'block', marginBottom: 8, fontWeight: 'bold' }}>Comprobante de Pago</label>
              <input
                type="file"
                accept="image/*,.pdf"
                disabled={normalizedInitialPayment <= 0}
                onChange={e => setPaymentFile(e.target.files?.[0] || null)}
                style={{ ...(normalizedInitialPayment <= 0 ? mutedFieldStyle : baseFieldStyle), padding: isMobileViewport ? 10 : 5 }}
              />
              <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6, wordBreak: 'break-word' }}>
                {paymentFile ? `Comprobante seleccionado: ${paymentFile.name}` : 'Adjunta el comprobante si se realizo pago o abono.'}
              </div>
            </div>
          </div>

          <div>
            <label style={{ display: 'block', marginBottom: 8, fontWeight: 'bold' }}>Nota de Pago</label>
            <textarea
              value={paymentNotes}
              onChange={e => setPaymentNotes(e.target.value)}
              rows={isMobileViewport ? 3 : 2}
              style={{ ...baseFieldStyle, resize: 'vertical', minHeight: isMobileViewport ? 92 : 74 }}
              placeholder="Ej. abono inicial del proveedor"
            />
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6 }}>
              Sube imagen o PDF del deposito, transferencia o voucher del pago realizado.
            </div>
          </div>
        </section>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: isMobileViewport ? 'repeat(2, minmax(0, 1fr))' : 'repeat(4, minmax(0, 1fr))', gap: 12, marginBottom: 20 }}>
        <div style={summaryCardStyle}>
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>Total Factura</div>
          <div style={{ fontWeight: 800, fontSize: isMobileViewport ? '1rem' : '1.1rem', wordBreak: 'break-word' }}>{formatMoney(total, config?.currency)}</div>
        </div>
        <div style={summaryCardStyle}>
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>Pagado al Registrar</div>
          <div style={{ fontWeight: 800, fontSize: isMobileViewport ? '1rem' : '1.1rem', color: '#22c55e', wordBreak: 'break-word' }}>{formatMoney(normalizedInitialPayment, config?.currency)}</div>
        </div>
        <div style={summaryCardStyle}>
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>Saldo Pendiente</div>
          <div style={{ fontWeight: 800, fontSize: isMobileViewport ? '1rem' : '1.1rem', color: balanceDue > 0 ? '#f59e0b' : '#22c55e', wordBreak: 'break-word' }}>{formatMoney(balanceDue, config?.currency)}</div>
        </div>
        <div style={summaryCardStyle}>
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>Estado de Pago</div>
          <div style={{ fontWeight: 800, fontSize: isMobileViewport ? '0.95rem' : '1.1rem' }}>
            {balanceDue <= 0 ? 'PAGADO' : normalizedInitialPayment > 0 ? 'ABONO PARCIAL' : paymentType === 'CREDIT' ? 'POR PAGAR' : 'PENDIENTE'}
          </div>
        </div>
      </div>

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: isMobileViewport ? 'stretch' : 'center', flexDirection: isMobileViewport ? 'column' : 'row', gap: 12 }}>
          <div>
            <h3 style={{ marginBottom: 4 }}>Detalle de Productos</h3>
            <div style={{ fontSize: 12, color: 'var(--muted)' }}>
              {items.length} {items.length === 1 ? 'producto agregado' : 'productos agregados'}
            </div>
          </div>
          <button className="btn-primary" style={{ width: isMobileViewport ? '100%' : 'auto' }} onClick={() => setIsProductModalOpen(true)}>+ Agregar Producto</button>
        </div>

        {isMobileViewport ? (
          <div style={{ display: 'grid', gap: 12 }}>
            {items.map((item, i) => (
              <div key={item.productId + '_' + i} style={{ border: '1px solid var(--border)', borderRadius: 12, backgroundColor: 'var(--modal)', padding: 14, display: 'grid', gap: 10 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 'bold' }}>{item.name}</div>
                    <div style={{ fontSize: '0.8em', opacity: 0.7, wordBreak: 'break-word' }}>{item.code}</div>
                  </div>
                  <button onClick={() => removeItem(i)} style={{ border: '1px solid rgba(239,68,68,0.25)', background: 'rgba(239,68,68,0.08)', cursor: 'pointer', color: '#ef4444', padding: '8px 10px', borderRadius: 10, minWidth: 42, minHeight: 42 }}>✕</button>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 10 }}>
                  <div>
                    <label style={{ display: 'block', marginBottom: 6 }}>Cantidad</label>
                    <input type="number" min="1" value={item.quantity} onChange={e => updateItem(i, 'quantity', Number(e.target.value))} style={{ ...baseFieldStyle, textAlign: 'center', padding: '10px 8px' }} />
                  </div>
                  <div>
                    <label style={{ display: 'block', marginBottom: 6 }}>Costo Unit.</label>
                    <input type="number" min="0" step="0.01" value={item.unitCost} onChange={e => updateItem(i, 'unitCost', Number(e.target.value))} style={{ ...baseFieldStyle, textAlign: 'right', padding: '10px 8px' }} />
                  </div>
                </div>
                <div style={{ fontWeight: 700, padding: '8px 10px', borderRadius: 10, background: 'var(--surface)' }}>
                  Subtotal: {formatMoney(item.quantity * item.unitCost, config?.currency)}
                </div>
                {item.productType === 'MEDICINAL' && (
                  <div style={{ marginTop: 5 }}>
                    <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 8 }}>Lotes del producto</div>
                    {item.batches?.map((batch, bIdx) => (
                      <div key={bIdx} style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 6, marginBottom: 8 }}>
                        <input placeholder="Lote" value={batch.batchNo} onChange={e => updateBatch(i, bIdx, 'batchNo', e.target.value)} style={{ ...baseFieldStyle, fontSize: '0.9em' }} />
                        <input type="date" value={batch.expiryDate} onChange={e => updateBatch(i, bIdx, 'expiryDate', e.target.value)} style={{ ...baseFieldStyle, fontSize: '0.9em' }} />
                        <div style={{ display: 'flex', gap: 8 }}>
                          <input type="number" placeholder="Cant." value={batch.quantity} onChange={e => updateBatch(i, bIdx, 'quantity', Number(e.target.value))} style={{ ...baseFieldStyle, flex: 1, fontSize: '0.9em' }} />
                          {item.batches && item.batches.length > 1 && <button onClick={() => removeBatch(i, bIdx)} style={{ color: '#ef4444', border: '1px solid rgba(239,68,68,0.25)', background: 'rgba(239,68,68,0.08)', cursor: 'pointer', padding: '0 14px', borderRadius: 10, minHeight: 44 }} title="Eliminar lote">✕</button>}
                        </div>
                      </div>
                    ))}
                    <button onClick={() => addBatch(i)} style={{ fontSize: '0.8em', color: 'var(--primary)', background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline', padding: 0 }}>
                      + Agregar otro lote
                    </button>
                  </div>
                )}
                {(item.productType === 'IMEI' || item.productType === 'SERIAL') && (
                  <div style={{ marginTop: 5 }}>
                    <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 8 }}>
                      {item.productType === 'IMEI' ? 'IMEIs requeridos' : 'Seriales requeridos'}
                    </div>
                    {item.imeiEntries?.map((entry, idx) => (
                      <input key={idx} placeholder={`Ingrese ${item.productType} #${idx + 1}`} value={entry} onChange={e => updateImeiEntry(i, idx, e.target.value)} style={{ ...baseFieldStyle, display: 'block', fontSize: '0.9em', marginBottom: 6 }} />
                    ))}
                  </div>
                )}
              </div>
            ))}
            {items.length === 0 && (
              <div style={{ padding: 20, textAlign: 'center', opacity: 0.5, border: '1px solid var(--border)', borderRadius: 8, backgroundColor: 'var(--modal)' }}>
                No hay productos agregados
              </div>
            )}
          </div>
        ) : (
        <div style={{ flex: 1, overflow: 'auto', border: '1px solid var(--border)', borderRadius: 8, backgroundColor: 'var(--modal)' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead style={{ position: 'sticky', top: 0, background: 'var(--surface)' }}>
              <tr>
                <th style={{ padding: 10, textAlign: 'left', borderBottom: '1px solid var(--border)' }}>Producto</th>
                <th style={{ padding: 10, textAlign: 'center', width: 100, borderBottom: '1px solid var(--border)' }}>Cantidad</th>
                <th style={{ padding: 10, textAlign: 'right', width: 150, borderBottom: '1px solid var(--border)' }}>Costo Unit.</th>
                <th style={{ padding: 10, textAlign: 'right', width: 150, borderBottom: '1px solid var(--border)' }}>Subtotal</th>
                <th style={{ padding: 10, textAlign: 'center', width: 50, borderBottom: '1px solid var(--border)' }}></th>
              </tr>
            </thead>
            <tbody>
              {items.map((item, i) => (
                <tr key={item.productId + '_' + i} style={{ borderBottom: '1px solid var(--border)' }}>
                  <td style={{ padding: 10 }}>
                    <div style={{ fontWeight: 'bold' }}>{item.name}</div>
                    <div style={{ fontSize: '0.8em', opacity: 0.7 }}>{item.code}</div>
                    {/* Extra Fields based on Type */}
                    {item.productType === 'MEDICINAL' && (
                        <div style={{ marginTop: 5 }}>
                            {item.batches?.map((batch, bIdx) => (
                                <div key={bIdx} style={{ display: 'flex', gap: 5, marginBottom: 5, alignItems: 'center' }}>
                                    <input 
                                        placeholder="Lote"
                                        value={batch.batchNo}
                                        onChange={e => updateBatch(i, bIdx, 'batchNo', e.target.value)}
                                        style={{ padding: 4, width: 80, fontSize: '0.9em', borderRadius: 4, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)' }}
                                    />
                                    <input 
                                        type="date"
                                        value={batch.expiryDate}
                                        onChange={e => updateBatch(i, bIdx, 'expiryDate', e.target.value)}
                                        style={{ padding: 4, fontSize: '0.9em', borderRadius: 4, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)' }}
                                    />
                                    <input 
                                        type="number"
                                        placeholder="Cant."
                                        value={batch.quantity}
                                        onChange={e => updateBatch(i, bIdx, 'quantity', Number(e.target.value))}
                                        style={{ padding: 4, width: 60, fontSize: '0.9em', borderRadius: 4, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)' }}
                                    />
                                    {item.batches && item.batches.length > 1 && (
                                        <button 
                                            onClick={() => removeBatch(i, bIdx)} 
                                            style={{ color: 'red', border: 'none', background: 'none', cursor: 'pointer', padding: 4 }}
                                            title="Eliminar lote"
                                        >
                                            ✕
                                        </button>
                                    )}
                                </div>
                            ))}
                            <button 
                                onClick={() => addBatch(i)}
                                style={{ fontSize: '0.8em', color: 'var(--primary)', background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline', padding: 0 }}
                            >
                                + Agregar otro lote
                            </button>
                            {/* Validation Warning */}
                            {item.batches && item.batches.reduce((sum, b) => sum + b.quantity, 0) !== item.quantity && (
                                <div style={{ color: 'orange', fontSize: '0.8em', marginTop: 2 }}>
                                    ⚠ Total lotes ({item.batches.reduce((sum, b) => sum + b.quantity, 0)}) difiere de cantidad ({item.quantity})
                                </div>
                            )}
                        </div>
                    )}
                    {(item.productType === 'IMEI' || item.productType === 'SERIAL') && (
                        <div style={{ marginTop: 5 }}>
                            {item.imeiEntries?.map((entry, idx) => (
                                <input 
                                    key={idx}
                                    placeholder={`Ingrese ${item.productType} #${idx + 1}`}
                                    value={entry}
                                    onChange={e => updateImeiEntry(i, idx, e.target.value)}
                                    style={{ 
                                        display: 'block', 
                                        width: '100%', 
                                        padding: 4, 
                                        fontSize: '0.9em', 
                                        marginBottom: 4,
                                        borderRadius: 4, 
                                        border: '1px solid var(--border)', 
                                        background: 'var(--bg)', 
                                        color: 'var(--text)' 
                                    }}
                                />
                            ))}
                        </div>
                    )}
                  </td>
                  <td style={{ padding: 10, verticalAlign: 'top' }}>
                    <input 
                      type="number" 
                      min="1"
                      value={item.quantity}
                      onChange={e => updateItem(i, 'quantity', Number(e.target.value))}
                      style={{ width: '100%', textAlign: 'center', padding: 4, borderRadius: 4, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)' }}
                    />
                  </td>
                  <td style={{ padding: 10 }}>
                    <input 
                      type="number" 
                      min="0"
                      step="0.01"
                      value={item.unitCost}
                      onChange={e => updateItem(i, 'unitCost', Number(e.target.value))}
                      style={{ width: '100%', textAlign: 'right', padding: 4, borderRadius: 4, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)' }}
                    />
                  </td>
                  <td style={{ padding: 10, textAlign: 'right' }}>
                    {formatMoney(item.quantity * item.unitCost, config?.currency)}
                  </td>
                  <td style={{ padding: 10, textAlign: 'center' }}>
                    <button 
                      onClick={() => removeItem(i)}
                      style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'red' }}
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
              {items.length === 0 && (
                <tr>
                  <td colSpan={5} style={{ padding: 20, textAlign: 'center', opacity: 0.5 }}>
                    No hay productos agregados
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: isMobileViewport ? 'stretch' : 'center', flexDirection: isMobileViewport ? 'column' : 'row', gap: 14, padding: isMobileViewport ? '14px 0 calc(14px + env(safe-area-inset-bottom, 0px))' : 20, borderTop: '1px solid var(--border)', position: isMobileViewport ? 'sticky' : 'static', bottom: 0, background: isMobileViewport ? 'linear-gradient(180deg, rgba(0,0,0,0) 0%, var(--bg) 22%)' : 'transparent' }}>
          <div style={{ fontSize: isMobileViewport ? '1.15rem' : '1.5em', fontWeight: 'bold', textAlign: isMobileViewport ? 'center' : 'right' }}>
            Total: {formatMoney(total, config?.currency)}
          </div>
          <button 
            className="btn-primary" 
            style={{ fontSize: isMobileViewport ? '1rem' : '1.2em', padding: isMobileViewport ? '12px 18px' : '10px 30px', width: isMobileViewport ? '100%' : 'auto', minHeight: isMobileViewport ? 48 : undefined }}
            onClick={handleSubmit}
            disabled={loading}
          >
            {loading ? 'Procesando...' : 'Registrar Compra'}
          </button>
        </div>
      </div>

      {isProductModalOpen && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', justifyContent: 'center', alignItems: isMobileViewport ? 'flex-end' : 'center', zIndex: 100, padding: isMobileViewport ? 0 : 16 }}>
          <div style={{ background: 'var(--modal)', padding: isMobileViewport ? 16 : 20, borderRadius: isMobileViewport ? '18px 18px 0 0' : 8, width: isMobileViewport ? '100%' : 600, maxWidth: isMobileViewport ? '100%' : 600, maxHeight: isMobileViewport ? '88vh' : '80vh', display: 'flex', flexDirection: 'column' }}>
            <div style={{ width: 48, height: 5, borderRadius: 999, background: 'var(--border)', alignSelf: 'center', marginBottom: 12 }} />
            <h3 style={{ marginTop: 0 }}>Buscar Producto</h3>
            <input 
              autoFocus
              type="text" 
              placeholder="Buscar por nombre, SKU, código, descripción, alterno o genérico..." 
              value={productSearch}
              onChange={e => setProductSearch(e.target.value)}
              style={{ ...baseFieldStyle, marginBottom: 10 }}
            />
            <div style={{ fontSize: '0.8em', color: 'var(--muted)', marginBottom: 10 }}>
              Usa las mismas variables del catálogo. Puedes escribir varias palabras en cualquier orden.
            </div>
            <div style={{ flex: 1, overflow: 'auto', border: '1px solid var(--border)', borderRadius: 4 }}>
              {filteredProducts.length === 0 ? (
                <div style={{ padding: 20, textAlign: 'center', color: 'var(--muted)' }}>
                  No se encontraron productos con ese criterio de busqueda.
                </div>
              ) : (
                filteredProducts.map(p => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => addItem(p)}
                    style={{
                      width: '100%',
                      padding: 10,
                      border: 'none',
                      borderBottom: '1px solid var(--border)',
                      cursor: 'pointer',
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      textAlign: 'left',
                      background: 'transparent',
                      color: 'var(--text)'
                    }}
                  >
                    <div>
                      <div style={{ fontWeight: 'bold' }}>{p.name}</div>
                      <div style={{ fontSize: '0.8em', opacity: 0.7 }}>
                        {getProductIdentifierSummary(p)} - Stock: {p.stock}
                      </div>
                    </div>
                    <div style={{ color: 'var(--accent)', fontWeight: 700 }}>+ Agregar</div>
                  </button>
                ))
              )}
            </div>
            <button 
              onClick={() => setIsProductModalOpen(false)} 
              style={{ marginTop: 16, padding: 10, border: 'none', background: 'var(--surface)', cursor: 'pointer', borderRadius: 6, color: 'var(--text)' }}
            >
              Cancelar
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
