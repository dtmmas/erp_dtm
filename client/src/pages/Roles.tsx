import { useEffect, useMemo, useState } from 'react'
import { api } from '../api'

interface Permission {
  id: number
  code: string
  description: string
}

interface Role {
  id: number
  name: string
  description: string
  permissions: string[]
}

const GROUP_LABELS: Record<string, string> = {
  users: 'Usuarios',
  roles: 'Roles',
  products: 'Productos',
  categories: 'Categorías',
  brands: 'Marcas',
  suppliers: 'Proveedores',
  departments: 'Departamentos',
  shelves: 'Ubicaciones',
  warehouses: 'Almacenes',
  units: 'Unidades',
  customers: 'Clientes',
  sales: 'Ventas',
  credits: 'Créditos',
  config: 'Configuración',
  reports: 'Reportes',
  purchases: 'Compras',
  logs: 'Logs',
  inventory: 'Inventario',
  transfers: 'Traslados',
  pos: 'POS',
  cash: 'Caja',
}

const ACTION_ORDER = ['read', 'write', 'create', 'cancel', 'open', 'close', 'movements', 'access', 'change_price', 'manual_price']

function getPermissionGroup(code: string) {
  const [group] = String(code || '').split(':')
  return group || 'other'
}

function getPermissionActionWeight(code: string) {
  const parts = String(code || '').split(':').slice(1)
  const normalized = parts.join(':')
  const index = ACTION_ORDER.indexOf(normalized)
  return index >= 0 ? index : ACTION_ORDER.length
}

export default function Roles() {
  const [roles, setRoles] = useState<Role[]>([])
  const [permissions, setPermissions] = useState<Permission[]>([])
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [editingRole, setEditingRole] = useState<Role | null>(null)
  const [savingRole, setSavingRole] = useState(false)
  
  const [formData, setFormData] = useState({
    name: '',
    description: '',
    permissions: [] as string[]
  })

  const groupedPermissions = useMemo(() => {
    const groups = new Map<string, Permission[]>()

    for (const permission of permissions) {
      const groupKey = getPermissionGroup(permission.code)
      if (!groups.has(groupKey)) groups.set(groupKey, [])
      groups.get(groupKey)?.push(permission)
    }

    return Array.from(groups.entries())
      .sort(([groupA], [groupB]) => {
        const labelA = GROUP_LABELS[groupA] || groupA
        const labelB = GROUP_LABELS[groupB] || groupB
        return labelA.localeCompare(labelB, 'es')
      })
      .map(([groupKey, groupPermissions]) => ({
        key: groupKey,
        label: GROUP_LABELS[groupKey] || groupKey.toUpperCase(),
        permissions: [...groupPermissions].sort((a, b) => {
          const actionDiff = getPermissionActionWeight(a.code) - getPermissionActionWeight(b.code)
          if (actionDiff !== 0) return actionDiff
          return a.description.localeCompare(b.description, 'es')
        }),
      }))
  }, [permissions])

  useEffect(() => {
    fetchRoles()
    fetchPermissions()
  }, [])

  const fetchRoles = async () => {
    try {
      const { data } = await api.get('/roles')
      setRoles(data)
    } catch (err) {
      console.error(err)
    }
  }

  const fetchPermissions = async () => {
    try {
      const { data } = await api.get('/roles/permissions')
      setPermissions(data)
    } catch (err) {
      console.error(err)
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (savingRole) return
    try {
      setSavingRole(true)
      if (editingRole) {
        await api.put(`/roles/${editingRole.id}`, formData)
      } else {
        await api.post('/roles', formData)
      }
      setIsModalOpen(false)
      fetchRoles()
    } catch (err) {
      console.error(err)
      alert((err as any)?.response?.data?.error || 'No se pudo guardar el rol')
    } finally {
      setSavingRole(false)
    }
  }

  const openModal = (role?: Role) => {
    if (role) {
      setEditingRole(role)
      setFormData({
        name: role.name,
        description: role.description,
        permissions: role.permissions || []
      })
    } else {
      setEditingRole(null)
      setFormData({ name: '', description: '', permissions: [] })
    }
    setIsModalOpen(true)
  }

  const togglePermission = (code: string) => {
    setFormData(prev => {
      const perms = prev.permissions.includes(code)
        ? prev.permissions.filter(p => p !== code)
        : [...prev.permissions, code]
      return { ...prev, permissions: perms }
    })
  }

  const setGroupPermissions = (codes: string[], enabled: boolean) => {
    setFormData(prev => {
      if (enabled) {
        return { ...prev, permissions: Array.from(new Set([...prev.permissions, ...codes])) }
      }
      return { ...prev, permissions: prev.permissions.filter(code => !codes.includes(code)) }
    })
  }
  
  const handleDelete = async (id: number) => {
    if (!confirm('Are you sure?')) return
    try {
      await api.delete(`/roles/${id}`)
      fetchRoles()
    } catch (err) {
      alert('Cannot delete role')
    }
  }

  return (
    <div style={{ padding: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <h2 style={{ margin: 0 }}>Roles y Permisos</h2>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button className="primary-btn" onClick={() => openModal()}>Nuevo Rol</button>
        </div>
      </div>

      <div style={{ border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead style={{ background: 'var(--modal)' }}>
            <tr>
              <th style={{ textAlign: 'left', padding: 8 }}>Rol</th>
              <th style={{ textAlign: 'left', padding: 8 }}>Descripción</th>
              <th style={{ textAlign: 'left', padding: 8 }}>Permisos</th>
              <th style={{ textAlign: 'left', padding: 8 }}>Acciones</th>
            </tr>
          </thead>
          <tbody>
            {roles.map(role => (
              <tr key={role.id} style={{ borderBottom: '1px solid var(--border)' }}>
                <td style={{ padding: 8, fontWeight: 600 }}>{role.name}</td>
                <td style={{ padding: 8 }}>{role.description}</td>
                <td style={{ padding: 8 }}>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                    {role.permissions?.slice(0, 5).map(p => (
                      <span key={p} style={{ fontSize: 11, padding: '2px 6px', border: '1px solid var(--border)', borderRadius: 10 }}>{p}</span>
                    ))}
                    {role.permissions?.length > 5 && <span style={{ fontSize: 11, color: 'var(--muted)' }}>+{role.permissions.length - 5}</span>}
                  </div>
                </td>
                <td style={{ padding: 8 }}>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button onClick={() => openModal(role)} className="icon-btn primary" title="Editar">
                      <svg viewBox="0 0 24 24" width="18" height="18"><path d="M3 17.25V21h3.75L17.81 9.94a1 1 0 0 0 0-1.41l-3.34-3.34a1 1 0 0 0-1.41 0L3 16.59z" fill="currentColor"/></svg>
                    </button>
                    {role.name !== 'ADMIN' && (
                      <button onClick={() => handleDelete(role.id)} className="icon-btn danger" title="Eliminar">
                        <svg viewBox="0 0 24 24" width="18" height="18">
                          <path d="M3 6h18" stroke="currentColor" strokeWidth="2"/>
                          <path d="M8 6V4h8v2" stroke="currentColor" strokeWidth="2"/>
                          <path d="M19 6l-1 14H6L5 6" stroke="currentColor" strokeWidth="2"/>
                          <path d="M10 11v6M14 11v6" stroke="currentColor" strokeWidth="2"/>
                        </svg>
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {isModalOpen && (
        <div className="modal-overlay">
          <div className="modal" style={{ maxWidth: '900px', width: '900px' }}>
            <div className="modal-header">
              <h2 style={{ margin: 0 }}>{editingRole ? 'Editar Rol' : 'Nuevo Rol'}</h2>
              <button onClick={() => setIsModalOpen(false)} className="close-btn" disabled={savingRole}>&times;</button>
            </div>
            <form onSubmit={handleSubmit}>
              <div style={{ padding: '10px 0' }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginBottom: '1rem' }}>
                  <div>
                    <label>Nombre *</label>
                    <input
                      type="text"
                      value={formData.name}
                      onChange={e => setFormData({ ...formData, name: e.target.value })}
                      required
                    />
                  </div>
                  <div>
                    <label>Descripción</label>
                    <input
                      type="text"
                      value={formData.description}
                      onChange={e => setFormData({ ...formData, description: e.target.value })}
                    />
                  </div>
                </div>

                <div>
                  <label>Permisos</label>
                  <div style={{ 
                    border: '1px solid var(--border)', 
                    padding: '1rem', 
                    borderRadius: '8px', 
                    maxHeight: '400px', 
                    overflowY: 'auto',
                    background: 'var(--bg)'
                  }}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                      {groupedPermissions.map(group => (
                        <section key={group.key} style={{ border: '1px solid var(--border)', borderRadius: 10, background: 'var(--modal)', padding: 12 }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 10, flexWrap: 'wrap' }}>
                            <div style={{ fontWeight: 700, color: 'var(--text)' }}>
                              {group.label}
                            </div>
                            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                              <button
                                type="button"
                                onClick={() => setGroupPermissions(group.permissions.map(permission => permission.code), true)}
                                style={{ background: 'transparent', border: '1px solid var(--border)', borderRadius: 8, padding: '6px 10px', color: 'var(--text)', cursor: 'pointer', fontSize: 12, fontWeight: 600 }}
                              >
                                Seleccionar todo
                              </button>
                              <button
                                type="button"
                                onClick={() => setGroupPermissions(group.permissions.map(permission => permission.code), false)}
                                style={{ background: 'transparent', border: '1px solid var(--border)', borderRadius: 8, padding: '6px 10px', color: 'var(--muted)', cursor: 'pointer', fontSize: 12, fontWeight: 600 }}
                              >
                                Quitar todo
                              </button>
                            </div>
                          </div>
                          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(250px, 1fr))', gap: '0.5rem' }}>
                            {group.permissions.map(perm => (
                              <label key={perm.id} style={{ display: 'flex', alignItems: 'flex-start', gap: '8px', cursor: 'pointer', padding: '4px', borderRadius: '4px' }}>
                                <input
                                  type="checkbox"
                                  checked={formData.permissions.includes(perm.code)}
                                  onChange={() => togglePermission(perm.code)}
                                  style={{ marginTop: '4px', width: 'auto' }}
                                />
                                <div>
                                  <div style={{ fontWeight: 500, fontSize: '0.9rem' }}>{perm.description}</div>
                                  <div style={{ fontSize: '0.75rem', color: 'var(--muted)' }}>{perm.code}</div>
                                </div>
                              </label>
                            ))}
                          </div>
                        </section>
                      ))}
                    </div>
                  </div>
                </div>
              </div>

              <div className="modal-footer">
                <button type="button" onClick={() => setIsModalOpen(false)} disabled={savingRole} style={{ background: 'transparent', border: '1px solid var(--border)', padding: '8px 16px', borderRadius: 8, color: 'var(--text)' }}>
                  Cancelar
                </button>
                <button type="submit" className="primary-btn" disabled={savingRole}>
                  {savingRole ? 'Guardando...' : 'Guardar'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
