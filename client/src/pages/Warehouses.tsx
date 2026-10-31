import { useEffect, useState } from 'react'
import { api } from '../api'

interface Warehouse {
  id: number
  name: string
  type: 'ALMACEN' | 'TIENDA'
  address: string
  contract_phone?: string
  contract_facebook?: string
  status: 'ACTIVO' | 'INACTIVO'
}

export default function Warehouses() {
  const [items, setItems] = useState<Warehouse[]>([])
  const [loading, setLoading] = useState(false)
  const [showCreate, setShowCreate] = useState(false)
  const [showEdit, setShowEdit] = useState(false)
  const [editTarget, setEditTarget] = useState<Warehouse | null>(null)
  const [isMobileViewport, setIsMobileViewport] = useState(false)

  // Form states
  const [formData, setFormData] = useState({
    name: '',
    type: 'ALMACEN' as 'ALMACEN' | 'TIENDA',
    address: '',
    contract_phone: '',
    contract_facebook: '',
    status: 'ACTIVO' as 'ACTIVO' | 'INACTIVO'
  })

  const load = async () => {
    try {
      const { data } = await api.get('/warehouses')
      setItems(data)
    } catch (err) {
      console.error(err)
    }
  }

  useEffect(() => { load() }, [])

  useEffect(() => {
    const mediaQuery = window.matchMedia('(max-width: 768px)')
    const syncViewport = () => setIsMobileViewport(mediaQuery.matches)
    syncViewport()
    mediaQuery.addEventListener('change', syncViewport)
    return () => mediaQuery.removeEventListener('change', syncViewport)
  }, [])

  const resetForm = () => {
    setFormData({ name: '', type: 'ALMACEN', address: '', contract_phone: '', contract_facebook: '', status: 'ACTIVO' })
  }

  const startCreate = () => {
    resetForm()
    setShowCreate(true)
  }

  const startEdit = (w: Warehouse) => {
    setEditTarget(w)
    setFormData({
      name: w.name,
      type: w.type,
      address: w.address || '',
      contract_phone: w.contract_phone || '',
      contract_facebook: w.contract_facebook || '',
      status: w.status
    })
    setShowEdit(true)
  }

  const saveCreate = async () => {
    if (!formData.name.trim()) return alert('Nombre requerido')
    
    setLoading(true)
    try {
      await api.post('/warehouses', formData)
      setShowCreate(false)
      await load()
      alert('Almacén creado correctamente')
    } catch (err: any) {
      alert(err?.response?.data?.error || 'Error al crear')
    } finally {
      setLoading(false)
    }
  }

  const saveEdit = async () => {
    if (!editTarget) return
    if (!formData.name.trim()) return alert('Nombre requerido')
    
    setLoading(true)
    try {
      await api.put(`/warehouses/${editTarget.id}`, formData)
      setShowEdit(false)
      setEditTarget(null)
      await load()
      alert('Almacén actualizado correctamente')
    } catch (err: any) {
      alert(err?.response?.data?.error || 'Error al actualizar')
    } finally {
      setLoading(false)
    }
  }

  const handleDelete = async (id: number) => {
    if (!window.confirm('¿Seguro de eliminar este almacén?')) return
    try {
      await api.delete(`/warehouses/${id}`)
      await load()
    } catch (err: any) {
      alert(err?.response?.data?.error || 'Error al eliminar')
    }
  }

  return (
    <div className="page-container" style={{ padding: isMobileViewport ? 14 : 20 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: isMobileViewport ? 'stretch' : 'center', flexDirection: isMobileViewport ? 'column' : 'row', gap: 12, marginBottom: 20 }}>
        <h2>Almacenes y Tiendas</h2>
        <button className="primary-btn" onClick={startCreate} style={{ width: isMobileViewport ? '100%' : 'auto' }}>Nuevo Almacén</button>
      </div>

      {isMobileViewport ? (
        <div style={{ display: 'grid', gap: 12 }}>
          {items.length === 0 ? (
            <div style={{ padding: 24, textAlign: 'center', color: 'var(--muted)', border: '1px solid var(--border)', borderRadius: 12, background: 'var(--surface)' }}>
              No hay almacenes o tiendas registrados
            </div>
          ) : (
            items.map(w => (
              <div key={w.id} style={{ border: '1px solid var(--border)', borderRadius: 14, background: 'linear-gradient(180deg, var(--surface), var(--modal))', padding: 14, display: 'grid', gap: 12, boxShadow: '0 10px 24px rgba(15, 23, 42, 0.05)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'flex-start' }}>
                  <div>
                    <div style={{ fontWeight: 800, fontSize: '1rem', lineHeight: 1.3 }}>{w.name}</div>
                    <div style={{ marginTop: 6 }}>
                      <span style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        padding: '5px 10px',
                        borderRadius: 999,
                        background: w.type === 'TIENDA' ? '#e3f2fd' : '#f3e5f5',
                        color: w.type === 'TIENDA' ? '#1565c0' : '#7b1fa2',
                        fontSize: 12,
                        fontWeight: 700,
                        border: `1px solid ${w.type === 'TIENDA' ? '#bbdefb' : '#e1bee7'}`
                      }}>
                        {w.type === 'TIENDA' ? 'TIENDA' : 'ALMACEN'}
                      </span>
                    </div>
                  </div>
                  <span style={{
                    padding: '5px 10px',
                    borderRadius: 999,
                    background: w.status === 'ACTIVO' ? 'rgba(34, 197, 94, 0.12)' : 'rgba(239, 68, 68, 0.12)',
                    color: w.status === 'ACTIVO' ? '#16a34a' : '#dc2626',
                    fontSize: 12,
                    fontWeight: 800,
                    border: `1px solid ${w.status === 'ACTIVO' ? 'rgba(34, 197, 94, 0.24)' : 'rgba(239, 68, 68, 0.24)'}`
                  }}>
                    {w.status}
                  </span>
                </div>

                <div style={{ display: 'grid', gap: 6 }}>
                  <div style={{ fontSize: 12, color: 'var(--muted)', fontWeight: 700 }}>Dirección</div>
                  <div style={{ fontSize: '0.95rem', lineHeight: 1.45, color: 'var(--text)' }}>{w.address || 'Sin dirección registrada'}</div>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                  <button className="icon-btn" onClick={() => startEdit(w)} style={{ width: '100%', justifyContent: 'center', padding: '0 16px' }}>
                    Editar
                  </button>
                  <button className="icon-btn danger" onClick={() => handleDelete(w.id)} style={{ width: '100%', justifyContent: 'center', padding: '0 16px' }}>
                    Eliminar
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      ) : (
      <div style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead style={{ background: 'var(--surface)' }}>
            <tr>
              <th style={{ padding: 12, textAlign: 'left' }}>Nombre</th>
              <th style={{ padding: 12, textAlign: 'left' }}>Tipo</th>
              <th style={{ padding: 12, textAlign: 'left' }}>Dirección</th>
              <th style={{ padding: 12, textAlign: 'left' }}>Estado</th>
              <th style={{ padding: 12, textAlign: 'left' }}>Acciones</th>
            </tr>
          </thead>
          <tbody>
            {items.map(w => (
              <tr key={w.id} style={{ borderTop: '1px solid var(--border)' }}>
                <td style={{ padding: 12 }}>{w.name}</td>
                <td style={{ padding: 12 }}>
                  <span style={{ 
                    padding: '4px 8px', 
                    borderRadius: 4, 
                    background: w.type === 'TIENDA' ? '#e3f2fd' : '#f3e5f5',
                    color: w.type === 'TIENDA' ? '#1565c0' : '#7b1fa2',
                    fontSize: 12,
                    fontWeight: 600
                  }}>
                    {w.type}
                  </span>
                </td>
                <td style={{ padding: 12 }}>{w.address || '-'}</td>
                <td style={{ padding: 12 }}>
                  <span style={{ color: w.status === 'ACTIVO' ? 'green' : 'red' }}>
                    {w.status}
                  </span>
                </td>
                <td style={{ padding: 12 }}>
                  <button className="icon-btn" onClick={() => startEdit(w)} style={{ marginRight: 8 }}>✏️</button>
                  <button className="icon-btn danger" onClick={() => handleDelete(w.id)}>🗑️</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      )}

      {(showCreate || showEdit) && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: isMobileViewport ? 'flex-end' : 'center', justifyContent: 'center', zIndex: 1000, padding: isMobileViewport ? 0 : 16 }}>
          <div style={{ background: 'var(--modal)', padding: isMobileViewport ? 16 : 24, borderRadius: isMobileViewport ? '18px 18px 0 0' : 12, width: isMobileViewport ? '100%' : 400, maxWidth: isMobileViewport ? '100%' : 400, maxHeight: isMobileViewport ? '88vh' : undefined, overflowY: isMobileViewport ? 'auto' : 'visible', border: '1px solid var(--border)' }}>
            <h3>{showCreate ? 'Nuevo Almacén' : 'Editar Almacén'}</h3>
            
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 16 }}>
              <div>
                <label style={{ display: 'block', marginBottom: 4 }}>Nombre</label>
                <input 
                  value={formData.name} 
                  onChange={e => setFormData({...formData, name: e.target.value})}
                  style={{ width: '100%', padding: 8 }}
                />
              </div>

              <div>
                <label style={{ display: 'block', marginBottom: 4 }}>Tipo</label>
                <select 
                  value={formData.type}
                  onChange={e => setFormData({...formData, type: e.target.value as any})}
                  style={{ width: '100%', padding: 8 }}
                >
                  <option value="ALMACEN">ALMACÉN (Bodega)</option>
                  <option value="TIENDA">TIENDA (Punto de Venta)</option>
                </select>
              </div>

              <div>
                <label style={{ display: 'block', marginBottom: 4 }}>Dirección</label>
                <input 
                  value={formData.address} 
                  onChange={e => setFormData({...formData, address: e.target.value})}
                  style={{ width: '100%', padding: 8 }}
                />
              </div>

              <div>
                <label style={{ display: 'block', marginBottom: 4 }}>CEL (Contratos)</label>
                <input 
                  value={formData.contract_phone} 
                  onChange={e => setFormData({...formData, contract_phone: e.target.value})}
                  style={{ width: '100%', padding: 8 }}
                />
              </div>

              <div>
                <label style={{ display: 'block', marginBottom: 4 }}>Facebook (Contratos)</label>
                <input 
                  value={formData.contract_facebook} 
                  onChange={e => setFormData({...formData, contract_facebook: e.target.value})}
                  style={{ width: '100%', padding: 8 }}
                />
              </div>

              <div>
                <label style={{ display: 'block', marginBottom: 4 }}>Estado</label>
                <select 
                  value={formData.status}
                  onChange={e => setFormData({...formData, status: e.target.value as any})}
                  style={{ width: '100%', padding: 8 }}
                >
                  <option value="ACTIVO">ACTIVO</option>
                  <option value="INACTIVO">INACTIVO</option>
                </select>
              </div>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', flexDirection: isMobileViewport ? 'column' : 'row', gap: 10, marginTop: 24 }}>
              <button onClick={() => { setShowCreate(false); setShowEdit(false); }} style={{ width: isMobileViewport ? '100%' : 'auto' }}>Cancelar</button>
              <button className="primary-btn" onClick={showCreate ? saveCreate : saveEdit} style={{ width: isMobileViewport ? '100%' : 'auto' }} disabled={loading}>
                {loading ? 'Guardando...' : 'Guardar'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
