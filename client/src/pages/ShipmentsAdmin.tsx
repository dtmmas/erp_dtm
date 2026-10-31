import { useEffect, useMemo, useState } from 'react'
import { api, assignShipment, createShipment, getDrivers, getPendingShipmentSales, getShipments, getVehicles } from '../api'
import { useAuthStore } from '../store/auth'
import { formatDateTime } from '../utils/date'
import { shipmentStatusLabel, shipmentTypeLabel } from '../utils/shipments'

type ShipmentRow = any

type Warehouse = { id: number; name: string }
type Driver = { id: number; name: string; email?: string }
type Vehicle = { id: number; plate: string; name?: string; active?: number }
type PendingSale = {
  id: number
  doc_no: string
  warehouse_id: number | null
  warehouse_name: string
  customer_id: number | null
  customer_name: string
  customer_phone: string
  customer_address: string
  total: string | number
  created_at: string
}

export default function ShipmentsAdmin() {
  const user = useAuthStore(s => s.user)
  const [shipments, setShipments] = useState<ShipmentRow[]>([])
  const [warehouses, setWarehouses] = useState<Warehouse[]>([])
  const [drivers, setDrivers] = useState<Driver[]>([])
  const [vehicles, setVehicles] = useState<Vehicle[]>([])
  const [pendingSales, setPendingSales] = useState<PendingSale[]>([])
  const [statusFilter, setStatusFilter] = useState('')
  const [typeFilter, setTypeFilter] = useState('')
  const [search, setSearch] = useState('')
  const [creating, setCreating] = useState(false)

  const [createType, setCreateType] = useState<'SALE_DELIVERY' | 'STORE_TRANSFER'>('SALE_DELIVERY')
  const [createSaleId, setCreateSaleId] = useState('')
  const [createTransferId, setCreateTransferId] = useState('')
  const [createFromWarehouseId, setCreateFromWarehouseId] = useState('')
  const [createToWarehouseId, setCreateToWarehouseId] = useState('')
  const [createCustomerId, setCreateCustomerId] = useState('')
  const [createDeliveryAddress, setCreateDeliveryAddress] = useState('')
  const [createContactName, setCreateContactName] = useState('')
  const [createContactPhone, setCreateContactPhone] = useState('')

  const isAdminOrWarehouse = useMemo(() => {
    const r = String(user?.role || '').toUpperCase()
    return r === 'ADMIN' || r === 'ALMACEN'
  }, [user?.role])

  const isWarehouseRole = useMemo(() => String(user?.role || '').toUpperCase() === 'ALMACEN', [user?.role])
  const userWarehouseId = user?.warehouseId ? Number(user.warehouseId) : null
  const originWarehouses = useMemo(() => {
    if (isWarehouseRole && userWarehouseId) return warehouses.filter(w => Number(w.id) === userWarehouseId)
    return warehouses
  }, [warehouses, isWarehouseRole, userWarehouseId])

  async function loadAll() {
    const [sh, wh, dr, ve, ps] = await Promise.all([
      getShipments({ status: statusFilter || undefined, type: typeFilter || undefined, search: search || undefined }),
      api.get('/warehouses').then(r => r.data as Warehouse[]).catch(() => []),
      getDrivers().catch(() => []),
      getVehicles().catch(() => []),
      getPendingShipmentSales().catch(() => []),
    ])
    setShipments(sh)
    setWarehouses(wh)
    setDrivers(dr)
    setVehicles(ve.filter(v => Number(v.active || 1) === 1))
    setPendingSales(ps)
  }

  useEffect(() => {
    if (!isWarehouseRole) return
    if (!userWarehouseId) return
    setCreateFromWarehouseId(String(userWarehouseId))
  }, [isWarehouseRole, userWarehouseId])

  useEffect(() => {
    if (!isAdminOrWarehouse) return
    loadAll()
  }, [isAdminOrWarehouse])

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault()
    await loadAll()
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    const fromWarehouse = isWarehouseRole && userWarehouseId ? String(userWarehouseId) : createFromWarehouseId
    if (!fromWarehouse) return alert('Selecciona almacén origen')
    if (createType === 'SALE_DELIVERY' && !createDeliveryAddress.trim()) return alert('Dirección de entrega requerida')
    if (createType === 'SALE_DELIVERY' && !createContactName.trim()) return alert('Nombre de contacto requerido')
    setCreating(true)
    try {
      const payload: any = {
        type: createType,
        fromWarehouseId: Number(fromWarehouse),
      }
      if (createToWarehouseId) payload.toWarehouseId = Number(createToWarehouseId)
      if (createCustomerId) payload.customerId = Number(createCustomerId)
      if (createDeliveryAddress) payload.deliveryAddress = createDeliveryAddress
      if (createContactName) payload.contactName = createContactName
      if (createContactPhone) payload.contactPhone = createContactPhone
      if (createSaleId) payload.sourceSaleId = Number(createSaleId)
      if (createTransferId) payload.sourceTransferId = Number(createTransferId)
      const res = await createShipment(payload)
      alert(`Envío creado #${res.shipmentId}`)
      setCreateSaleId('')
      setCreateTransferId('')
      setCreateCustomerId('')
      setCreateDeliveryAddress('')
      setCreateContactName('')
      setCreateContactPhone('')
      await loadAll()
    } catch (err: any) {
      alert(err?.response?.data?.error || 'Error creando envío')
    } finally {
      setCreating(false)
    }
  }

  async function handleAssign(shipmentId: number, driverUserId: number, vehicleId?: number | null) {
    try {
      await assignShipment(shipmentId, { driverUserId, vehicleId })
      await loadAll()
    } catch (err: any) {
      alert(err?.response?.data?.error || 'Error asignando')
    }
  }

  function loadSaleToForm(row: PendingSale) {
    setCreateType('SALE_DELIVERY')
    setCreateSaleId(String(row.id))
    setCreateTransferId('')
    setCreateCustomerId(row.customer_id ? String(row.customer_id) : '')
    setCreateDeliveryAddress(row.customer_address || '')
    setCreateContactName(row.customer_name || '')
    setCreateContactPhone(row.customer_phone || '')
    if (!isWarehouseRole) {
      const wid = row.warehouse_id ? String(row.warehouse_id) : ''
      if (wid) setCreateFromWarehouseId(wid)
    }
    document.getElementById('create-shipment-form')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  if (!isAdminOrWarehouse) {
    return (
      <div className="page-shell">
        <h2>Despachos</h2>
        <div>No autorizado</div>
      </div>
    )
  }

  return (
    <div className="page-shell">
      <div className="page-toolbar" style={{ marginBottom: 20 }}>
        <h2 style={{ margin: 0 }}>Despachos / Logística</h2>
        <form onSubmit={handleSearch} className="page-toolbar-actions" style={{ flex: 1, justifyContent: 'flex-end', gap: 10 }}>
          <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} style={{ minWidth: 170 }}>
            <option value="">Todos</option>
            <option value="SALE_DELIVERY">Entrega</option>
            <option value="STORE_TRANSFER">Traslado</option>
          </select>
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} style={{ minWidth: 170 }}>
            <option value="">Todos</option>
            <option value="DRAFT">Borrador</option>
            <option value="ASSIGNED">Asignado</option>
            <option value="PICKED_UP">Retirado</option>
            <option value="IN_TRANSIT">En ruta</option>
            <option value="DELIVERED">Entregado</option>
            <option value="DELIVERED_WITH_ISSUES">Entregado con faltantes</option>
            <option value="RECEIVED">Recibido</option>
            <option value="RECEIVED_WITH_ISSUES">Recibido con faltantes</option>
          </select>
          <input
            type="text"
            placeholder="Buscar cliente / doc / #"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ flex: 1, maxWidth: 360 }}
          />
          <button type="submit" className="primary-btn">Filtrar</button>
        </form>
      </div>

      <div style={{ border: '1px solid var(--border)', borderRadius: 12, padding: 14, marginBottom: 18 }}>
        <div style={{ fontWeight: 900, marginBottom: 12 }}>Ventas pagadas pendientes de despacho</div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 980 }}>
            <thead>
              <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--border)' }}>
                <th style={{ padding: 10 }}>Venta</th>
                <th style={{ padding: 10 }}>Documento</th>
                <th style={{ padding: 10 }}>Bodega</th>
                <th style={{ padding: 10 }}>Cliente</th>
                <th style={{ padding: 10 }}>Dirección</th>
                <th style={{ padding: 10 }}>Total</th>
                <th style={{ padding: 10 }}>Fecha</th>
                <th style={{ padding: 10 }}>Acción</th>
              </tr>
            </thead>
            <tbody>
              {pendingSales.length === 0 ? (
                <tr>
                  <td colSpan={8} style={{ padding: 12, opacity: 0.8 }}>No hay ventas pendientes de despacho</td>
                </tr>
              ) : (
                pendingSales.map((row) => (
                  <tr key={row.id} style={{ borderBottom: '1px solid var(--border)' }}>
                    <td style={{ padding: 10, whiteSpace: 'nowrap' }}>#{row.id}</td>
                    <td style={{ padding: 10, whiteSpace: 'nowrap' }}>{row.doc_no || ''}</td>
                    <td style={{ padding: 10, whiteSpace: 'nowrap' }}>{row.warehouse_name || row.warehouse_id || ''}</td>
                    <td style={{ padding: 10, whiteSpace: 'nowrap' }}>{row.customer_name || row.customer_id || ''}</td>
                    <td style={{ padding: 10, minWidth: 220 }}>{row.customer_address || ''}</td>
                    <td style={{ padding: 10, whiteSpace: 'nowrap', fontWeight: 800 }}>{String(row.total ?? '')}</td>
                    <td style={{ padding: 10, whiteSpace: 'nowrap' }}>{row.created_at ? formatDateTime(row.created_at) : ''}</td>
                    <td style={{ padding: 10 }}>
                      <button type="button" className="primary-btn" onClick={() => loadSaleToForm(row)} style={{ whiteSpace: 'nowrap' }}>
                        Crear despacho
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div style={{ border: '1px solid var(--border)', borderRadius: 12, padding: 14, marginBottom: 18 }}>
        <div id="create-shipment-form" style={{ fontWeight: 900, marginBottom: 12 }}>Crear envío</div>
        <form onSubmit={handleCreate} style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 12 }}>
          <div>
            <label style={{ display: 'block', fontWeight: 700, marginBottom: 6 }}>Tipo</label>
            <select value={createType} onChange={(e) => setCreateType(e.target.value as any)} style={{ width: '100%' }}>
              <option value="SALE_DELIVERY">Entrega a domicilio (venta)</option>
              <option value="STORE_TRANSFER">Traslado tienda/bodega</option>
            </select>
          </div>
          <div>
            <label style={{ display: 'block', fontWeight: 700, marginBottom: 6 }}>Origen</label>
            <select value={isWarehouseRole && userWarehouseId ? String(userWarehouseId) : createFromWarehouseId} onChange={(e) => setCreateFromWarehouseId(e.target.value)} style={{ width: '100%' }} disabled={Boolean(isWarehouseRole && userWarehouseId)}>
              <option value="">Selecciona...</option>
              {originWarehouses.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
          </div>
          <div>
            <label style={{ display: 'block', fontWeight: 700, marginBottom: 6 }}>Destino (para traslado)</label>
            <select value={createToWarehouseId} onChange={(e) => setCreateToWarehouseId(e.target.value)} style={{ width: '100%' }}>
              <option value="">(No aplica)</option>
              {warehouses.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
          </div>
          <div>
            <label style={{ display: 'block', fontWeight: 700, marginBottom: 6 }}>Venta ID (opcional)</label>
            <input value={createSaleId} onChange={(e) => setCreateSaleId(e.target.value)} type="number" style={{ width: '100%' }} />
          </div>
          <div>
            <label style={{ display: 'block', fontWeight: 700, marginBottom: 6 }}>Traslado ID (opcional)</label>
            <input value={createTransferId} onChange={(e) => setCreateTransferId(e.target.value)} type="number" style={{ width: '100%' }} />
          </div>
          <div>
            <label style={{ display: 'block', fontWeight: 700, marginBottom: 6 }}>Cliente ID (opcional)</label>
            <input value={createCustomerId} onChange={(e) => setCreateCustomerId(e.target.value)} type="number" style={{ width: '100%' }} />
          </div>
          <div style={{ gridColumn: 'span 2' }}>
            <label style={{ display: 'block', fontWeight: 700, marginBottom: 6 }}>Dirección de entrega (domicilio)</label>
            <input value={createDeliveryAddress} onChange={(e) => setCreateDeliveryAddress(e.target.value)} type="text" style={{ width: '100%' }} />
          </div>
          <div>
            <label style={{ display: 'block', fontWeight: 700, marginBottom: 6 }}>Nombre de contacto</label>
            <input value={createContactName} onChange={(e) => setCreateContactName(e.target.value)} type="text" style={{ width: '100%' }} />
          </div>
          <div>
            <label style={{ display: 'block', fontWeight: 700, marginBottom: 6 }}>Teléfono</label>
            <input value={createContactPhone} onChange={(e) => setCreateContactPhone(e.target.value)} type="text" style={{ width: '100%' }} />
          </div>
          <div style={{ gridColumn: 'span 2', display: 'flex', justifyContent: 'flex-end' }}>
            <button type="submit" className="primary-btn" disabled={creating}>
              {creating ? 'Creando...' : 'Crear'}
            </button>
          </div>
        </form>
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 980 }}>
          <thead>
            <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--border)' }}>
              <th style={{ padding: 10 }}>#</th>
              <th style={{ padding: 10 }}>Tipo</th>
              <th style={{ padding: 10 }}>Estado</th>
              <th style={{ padding: 10 }}>Origen</th>
              <th style={{ padding: 10 }}>Destino</th>
              <th style={{ padding: 10 }}>Cliente</th>
              <th style={{ padding: 10 }}>Chofer</th>
              <th style={{ padding: 10 }}>Vehículo</th>
              <th style={{ padding: 10 }}>Creado</th>
              <th style={{ padding: 10 }}>Asignar</th>
            </tr>
          </thead>
          <tbody>
            {shipments.map((s) => {
              const typeLabel = shipmentTypeLabel(s.type)
              const statusLabel = shipmentStatusLabel(s.status)
              return (
                <tr key={s.id} style={{ borderBottom: '1px solid var(--border)' }}>
                  <td style={{ padding: 10, whiteSpace: 'nowrap' }}>#{s.id}</td>
                  <td style={{ padding: 10, whiteSpace: 'nowrap' }}>{typeLabel}{s.sale_doc_no ? ` (${s.sale_doc_no})` : ''}</td>
                  <td style={{ padding: 10, whiteSpace: 'nowrap', fontWeight: 800 }}>{statusLabel}</td>
                  <td style={{ padding: 10, whiteSpace: 'nowrap' }}>{s.from_warehouse_name || s.from_warehouse_id}</td>
                  <td style={{ padding: 10, whiteSpace: 'nowrap' }}>{s.to_warehouse_name || (s.to_warehouse_id || '')}</td>
                  <td style={{ padding: 10, whiteSpace: 'nowrap' }}>{s.customer_name || s.customer_id || ''}</td>
                  <td style={{ padding: 10, whiteSpace: 'nowrap' }}>{s.driver_name || (s.driver_user_id || '')}</td>
                  <td style={{ padding: 10, whiteSpace: 'nowrap' }}>{s.vehicle_plate || (s.vehicle_id || '')}</td>
                  <td style={{ padding: 10, whiteSpace: 'nowrap' }}>{s.created_at ? formatDateTime(s.created_at) : ''}</td>
                  <td style={{ padding: 10 }}>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <select
                        defaultValue={s.driver_user_id || ''}
                        onChange={(e) => {
                          const next = Number(e.target.value || 0)
                          ;(s as any)._driver = next || null
                        }}
                        style={{ minWidth: 170 }}
                      >
                        <option value="">Chofer...</option>
                        {drivers.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
                      </select>
                      <select
                        defaultValue={s.vehicle_id || ''}
                        onChange={(e) => {
                          const next = Number(e.target.value || 0)
                          ;(s as any)._vehicle = next || null
                        }}
                        style={{ minWidth: 140 }}
                      >
                        <option value="">Vehículo...</option>
                        {vehicles.map(v => <option key={v.id} value={v.id}>{v.plate}</option>)}
                      </select>
                      <button
                        type="button"
                        className="primary-btn"
                        onClick={() => {
                          const d = Number((s as any)._driver || s.driver_user_id || 0)
                          if (!d) return alert('Selecciona un chofer')
                          const v = (s as any)._vehicle != null ? Number((s as any)._vehicle) : (s.vehicle_id ? Number(s.vehicle_id) : null)
                          handleAssign(Number(s.id), d, v)
                        }}
                        style={{ whiteSpace: 'nowrap' }}
                      >
                        Guardar
                      </button>
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
