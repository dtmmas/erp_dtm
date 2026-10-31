import dotenv from 'dotenv'
import mysql from 'mysql2/promise'

dotenv.config()

async function updateRolesV2() {
  const host = process.env.DB_HOST || 'localhost'
  const port = Number(process.env.DB_PORT || 3306)
  const user = process.env.DB_USER || 'root'
  const password = process.env.DB_PASSWORD || ''
  const database = process.env.DB_NAME || 'dtmpos'

  console.log('Connecting to DB...')
  const conn = await mysql.createConnection({ host, port, user, password, database })

  // 1. Add new permissions
  const newPermissions = [
    { code: 'inventory:read', desc: 'Ver movimientos de inventario' },
    { code: 'inventory:write', desc: 'Realizar ajustes de inventario' },
    { code: 'transfers:read', desc: 'Ver transferencias entre almacenes' },
    { code: 'transfers:write', desc: 'Realizar transferencias' },
    { code: 'pos:access', desc: 'Acceso al Punto de Venta (POS)' },
    { code: 'pos:change_price', desc: 'Cambiar precio en POS' },
    { code: 'pos:manual_price', desc: 'Ingresar precio manual en POS' }
  ]

  for (const p of newPermissions) {
    try {
      await conn.query('INSERT IGNORE INTO permissions (code, description) VALUES (?, ?)', [p.code, p.desc])
      console.log(`Added permission: ${p.code}`)
    } catch (e) {
      console.error(`Error adding ${p.code}:`, e.message)
    }
  }

  // Helper to get ID
  const getRoleId = async (roleCode) => {
    // Try to find by code first (if column exists), then by name
    try {
        const [rows] = await conn.query('SELECT id FROM roles WHERE code = ?', [roleCode])
        if (rows.length > 0) return rows[0].id
    } catch (e) {
        // code column might not exist
    }
    
    // Fallback to name (and handle mapped names if necessary)
    const [rows] = await conn.query('SELECT id FROM roles WHERE name = ?', [roleCode])
    if (rows.length > 0) return rows[0].id
    
    // Try mapped names if direct match fails
    const map = {
        'ADMIN': 'Administrador',
        'CAJERO': 'Cajero',
        'VENDEDOR': 'Vendedor',
        'ALMACEN': 'Almacén'
    }
    if (map[roleCode]) {
        const [rows2] = await conn.query('SELECT id FROM roles WHERE name = ?', [map[roleCode]])
        if (rows2.length > 0) return rows2[0].id
    }
    
    return null
  }

  const getPermIds = async (codes) => {
    if (codes === 'ALL') {
      const [rows] = await conn.query('SELECT id FROM permissions')
      return rows.map(r => r.id)
    }
    const [rows] = await conn.query('SELECT id FROM permissions WHERE code IN (?)', [codes])
    return rows.map(r => r.id)
  }

  const assignPerms = async (roleName, permCodes) => {
    const roleId = await getRoleId(roleName)
    if (!roleId) {
        console.log(`Role ${roleName} not found, skipping assignment`)
        return
    }
    
    // Clear existing permissions for this role to ensure clean state
    await conn.query('DELETE FROM role_permissions WHERE role_id = ?', [roleId])
    console.log(`Cleared permissions for ${roleName}`)

    if (permCodes === 'ALL') {
        const [rows] = await conn.query('SELECT id FROM permissions')
        const permIds = rows.map(r => r.id)
        for (const pid of permIds) {
            await conn.query('INSERT IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)', [roleId, pid])
        }
        console.log(`Assigned ALL permissions to ${roleName}`)
    } else {
        const permIds = await getPermIds(permCodes)
        for (const pid of permIds) {
            await conn.query('INSERT IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)', [roleId, pid])
        }
        console.log(`Assigned ${permIds.length} permissions to ${roleName}`)
    }
  }

  // 2. Reorganize Roles

  try {
    await conn.query(
      'INSERT IGNORE INTO roles (code, name, description) VALUES (?, ?, ?)',
      ['VENDEDOR', 'Vendedor', 'Vendedor con acceso a POS sin operaciones de caja']
    )
  } catch (e) {
    await conn.query(
      'INSERT IGNORE INTO roles (name, description) VALUES (?, ?)',
      ['Vendedor', 'Vendedor con acceso a POS sin operaciones de caja']
    )
  }

  // ADMIN: All permissions
  await assignPerms('ADMIN', 'ALL')

  // CAJERO: Focused on Sales and POS
  // Removed: inventory write access, config, heavy management
  await assignPerms('CAJERO', [
    'pos:access',
    'pos:change_price', // Allowed to select price levels
    'sales:create', 
    'sales:read', 
    'sales:cancel', // Can cancel own sales (usually)
    'customers:read', 
    'customers:write', // Can create new customers at POS
    'products:read', 
    'credits:read', 
    'credits:write', // Manage credit payments
    'cash:open',
    'cash:close',
    'cash:movements',
    'cash:view'
  ])

  // VENDEDOR: POS y registro de ventas sin caja
  await assignPerms('VENDEDOR', [
    'pos:access',
    'sales:create',
    'sales:read',
    'customers:read',
    'customers:write',
    'products:read'
  ])

  // ALMACEN: Focused on Inventory, Purchases, Catalog
  // Added: inventory adjustments, transfers, purchases
  // Removed: sales creation (POS)
  await assignPerms('ALMACEN', [
    'products:read', 'products:write',
    'categories:read', 'categories:write',
    'brands:read', 'brands:write',
    'suppliers:read', 'suppliers:write',
    'departments:read', 'departments:write',
    'shelves:read', 'shelves:write',
    'warehouses:read', 'warehouses:write', // Can manage warehouse locations
    'units:read', 'units:write',
    'config:read', // View config but not edit
    'purchases:read', 'purchases:write',
    'inventory:read', 'inventory:write',
    'transfers:read', 'transfers:write'
  ])
  
  await conn.end()
  console.log('Role reorganization complete.')
}

updateRolesV2().catch(console.error)
