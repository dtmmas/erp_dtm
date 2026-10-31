import { useState, useEffect } from 'react'
import { api } from '../api'
import { getWarehouseHighlightStyle } from '../utils/warehouseHighlight'

interface Role {
  id: number
  name: string
}

interface Warehouse {
  id: number
  name: string
}

interface User {
  id: number
  name: string
  email: string
  role_id: number
  role_name: string
  can_sell?: number
  is_driver?: number
  warehouse_id?: number | null
  warehouse_name?: string | null
  active: number
}

export default function Users() {
  const [users, setUsers] = useState<User[]>([])
  const [roles, setRoles] = useState<Role[]>([])
  const [warehouses, setWarehouses] = useState<Warehouse[]>([])
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [editingUser, setEditingUser] = useState<User | null>(null)
  const [savingUser, setSavingUser] = useState(false)
  
  const [formData, setFormData] = useState({
    name: '',
    email: '',
    password: '',
    role_id: 0,
    warehouse_id: 0,
    can_sell: true,
    is_driver: false,
    active: true
  })

  useEffect(() => {
    fetchUsers()
    fetchRoles()
    fetchWarehouses()
  }, [])

  const fetchUsers = async () => {
    try {
      const { data } = await api.get('/users')
      setUsers(data)
    } catch (err) {
      console.error(err)
    }
  }

  const fetchRoles = async () => {
    try {
      const { data } = await api.get('/roles')
      setRoles(data)
    } catch (err) {
      console.error(err)
    }
  }

  const fetchWarehouses = async () => {
    try {
      const { data } = await api.get('/warehouses')
      setWarehouses(data)
    } catch (err) {
      console.error(err)
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (savingUser) return
    try {
      setSavingUser(true)
      const payload: any = { ...formData, active: formData.active }
      if (!payload.password) delete payload.password

      if (editingUser) {
        await api.put(`/users/${editingUser.id}`, payload)
      } else {
        await api.post('/users', payload)
      }
      setIsModalOpen(false)
      fetchUsers()
    } catch (err: any) {
      alert(err.response?.data?.error || 'Error saving user')
    } finally {
      setSavingUser(false)
    }
  }

  const openModal = (user?: User) => {
    if (user) {
      setEditingUser(user)
      setFormData({
        name: user.name,
        email: user.email,
        password: '',
        role_id: user.role_id,
        warehouse_id: Number(user.warehouse_id || 0),
        can_sell: Number(user.can_sell ?? 1) === 1,
        is_driver: Number(user.is_driver ?? 0) === 1,
        active: user.active === 1
      })
    } else {
      setEditingUser(null)
      setFormData({
        name: '',
        email: '',
        password: '',
        role_id: roles[0]?.id || 0,
        warehouse_id: warehouses[0]?.id || 0,
        can_sell: true,
        is_driver: false,
        active: true
      })
    }
    setIsModalOpen(true)
  }

  const handleDelete = async (id: number) => {
    if (!confirm('Are you sure you want to delete this user?')) return
    try {
      await api.delete(`/users/${id}`)
      fetchUsers()
    } catch (err) {
      alert('Cannot delete user')
    }
  }

  return (
    <div style={{ padding: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <h2 style={{ margin: 0 }}>Gestión de Usuarios</h2>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button className="primary-btn" onClick={() => openModal()}>Nuevo Usuario</button>
        </div>
      </div>

      <div style={{ border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead style={{ background: 'var(--modal)' }}>
            <tr>
              <th style={{ textAlign: 'left', padding: 8 }}>Nombre</th>
              <th style={{ textAlign: 'left', padding: 8 }}>Email</th>
              <th style={{ textAlign: 'left', padding: 8 }}>Rol</th>
              <th style={{ textAlign: 'left', padding: 8 }}>Tienda</th>
              <th style={{ textAlign: 'left', padding: 8 }}>POS</th>
              <th style={{ textAlign: 'left', padding: 8 }}>Chofer</th>
              <th style={{ textAlign: 'left', padding: 8 }}>Estado</th>
              <th style={{ textAlign: 'left', padding: 8 }}>Acciones</th>
            </tr>
          </thead>
          <tbody>
            {users.map(user => (
              <tr key={user.id} style={{ borderBottom: '1px solid var(--border)' }}>
                <td style={{ padding: 8, fontWeight: 500 }}>{user.name}</td>
                <td style={{ padding: 8 }}>{user.email}</td>
                <td style={{ padding: 8 }}>{user.role_name}</td>
                <td style={{ padding: 8 }}>
                  {user.warehouse_name ? <span className="warehouse-highlight" style={getWarehouseHighlightStyle(user.warehouse_name)}>{user.warehouse_name}</span> : 'Sin asignar'}
                </td>
                <td style={{ padding: 8 }}>
                  <span style={{
                    padding: '2px 8px',
                    borderRadius: 10,
                    fontSize: 11,
                    background: Number(user.can_sell ?? 1) === 1 ? '#ECFDF5' : '#FEF3C7',
                    color: Number(user.can_sell ?? 1) === 1 ? '#065F46' : '#92400E',
                    fontWeight: 600,
                    border: Number(user.can_sell ?? 1) === 1 ? '1px solid #34D399' : '1px solid #FCD34D'
                  }}>
                    {Number(user.can_sell ?? 1) === 1 ? 'Habilitado' : 'Bloqueado'}
                  </span>
                </td>
                <td style={{ padding: 8 }}>
                  <span style={{
                    padding: '2px 8px',
                    borderRadius: 10,
                    fontSize: 11,
                    background: Number(user.is_driver ?? 0) === 1 ? '#EFF6FF' : '#F3F4F6',
                    color: Number(user.is_driver ?? 0) === 1 ? '#1D4ED8' : '#374151',
                    fontWeight: 700,
                    border: Number(user.is_driver ?? 0) === 1 ? '1px solid #93C5FD' : '1px solid #D1D5DB'
                  }}>
                    {Number(user.is_driver ?? 0) === 1 ? 'Sí' : 'No'}
                  </span>
                </td>
                <td style={{ padding: 8 }}>
                  <span style={{ 
                    padding: '2px 8px', 
                    borderRadius: 10, 
                    fontSize: 11,
                    background: user.active ? '#ECFDF5' : '#FEE2E2',
                    color: user.active ? '#065F46' : '#991B1B',
                    fontWeight: 600,
                    border: user.active ? '1px solid #34D399' : '1px solid #FCA5A5'
                  }}>
                    {user.active ? 'Activo' : 'Inactivo'}
                  </span>
                </td>
                <td style={{ padding: 8 }}>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button onClick={() => openModal(user)} className="icon-btn primary" title="Editar">
                      <svg viewBox="0 0 24 24" width="18" height="18"><path d="M3 17.25V21h3.75L17.81 9.94a1 1 0 0 0 0-1.41l-3.34-3.34a1 1 0 0 0-1.41 0L3 16.59z" fill="currentColor"/></svg>
                    </button>
                    <button onClick={() => handleDelete(user.id)} className="icon-btn danger" title="Eliminar">
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

      {isModalOpen && (
        <div className="modal-overlay">
          <div className="modal">
            <div className="modal-header">
              <h2 style={{ margin: 0 }}>{editingUser ? 'Editar Usuario' : 'Nuevo Usuario'}</h2>
              <button onClick={() => setIsModalOpen(false)} className="close-btn" disabled={savingUser}>&times;</button>
            </div>
            <form onSubmit={handleSubmit}>
              <div style={{ padding: '10px 0' }}>
                <div style={{ marginBottom: 12 }}>
                  <label>Nombre</label>
                  <input
                    type="text"
                    value={formData.name}
                    onChange={e => setFormData({ ...formData, name: e.target.value })}
                    required
                  />
                </div>
                <div style={{ marginBottom: 12 }}>
                  <label>Email</label>
                  <input
                    type="email"
                    value={formData.email}
                    onChange={e => setFormData({ ...formData, email: e.target.value })}
                    required
                  />
                </div>
                <div style={{ marginBottom: 12 }}>
                  <label>Contraseña {editingUser && '(Dejar en blanco para mantener)'}</label>
                  <input
                    type="password"
                    value={formData.password}
                    onChange={e => setFormData({ ...formData, password: e.target.value })}
                    required={!editingUser}
                  />
                </div>
                <div style={{ marginBottom: 12 }}>
                  <label>Rol</label>
                  <select
                    value={formData.role_id}
                    onChange={e => setFormData({ ...formData, role_id: Number(e.target.value) })}
                    required
                  >
                    {roles.map(r => (
                      <option key={r.id} value={r.id}>{r.name}</option>
                    ))}
                  </select>
                </div>
                <div style={{ marginBottom: 12 }}>
                  <label>Tienda / Almacén</label>
                  <select
                    value={formData.warehouse_id}
                    onChange={e => setFormData({ ...formData, warehouse_id: Number(e.target.value) })}
                  >
                    <option value={0}>Sin asignar</option>
                    {warehouses.map(w => (
                      <option key={w.id} value={w.id}>{w.name}</option>
                    ))}
                  </select>
                </div>
                <div style={{ marginBottom: 12 }}>
                  <label className="flex items-center space-x-2" style={{ flexDirection: 'row', gap: '8px', cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={formData.can_sell}
                      onChange={e => setFormData({ ...formData, can_sell: e.target.checked })}
                      style={{ width: 'auto' }}
                    />
                    <span className="text-sm font-medium">Puede vender / usar POS</span>
                  </label>
                  <div style={{ color: 'var(--muted)', fontSize: 12, marginTop: 4 }}>
                    Recomendado para administradores con tienda asignada o usuarios operativos de ventas.
                  </div>
                </div>
                <div style={{ marginBottom: 12 }}>
                  <label className="flex items-center space-x-2" style={{ flexDirection: 'row', gap: '8px', cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={formData.is_driver}
                      onChange={e => setFormData({ ...formData, is_driver: e.target.checked })}
                      style={{ width: 'auto' }}
                    />
                    <span className="text-sm font-medium">Es chofer (Entregas)</span>
                  </label>
                  <div style={{ color: 'var(--muted)', fontSize: 12, marginTop: 4 }}>
                    Solo usuarios marcados como chofer podrán asignarse a despachos.
                  </div>
                </div>
                {editingUser && (
                  <div style={{ marginBottom: 12 }}>
                    <label className="flex items-center space-x-2" style={{ flexDirection: 'row', gap: '8px', cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={formData.active}
                        onChange={e => setFormData({ ...formData, active: e.target.checked })}
                        style={{ width: 'auto' }}
                      />
                      <span className="text-sm font-medium">Activo</span>
                    </label>
                  </div>
                )}
              </div>

              <div className="modal-footer">
                <button type="button" onClick={() => setIsModalOpen(false)} disabled={savingUser} style={{ background: 'transparent', border: '1px solid var(--border)', padding: '8px 16px', borderRadius: 8, color: 'var(--text)' }}>
                  Cancelar
                </button>
                <button type="submit" className="primary-btn" disabled={savingUser}>
                  {savingUser ? 'Guardando...' : 'Guardar'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
