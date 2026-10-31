import dotenv from 'dotenv'
import mysql from 'mysql2/promise'

dotenv.config()

async function migrateRBAC() {
  const host = process.env.DB_HOST || 'localhost'
  const port = Number(process.env.DB_PORT || 3306)
  const user = process.env.DB_USER || 'root'
  const password = process.env.DB_PASSWORD || ''
  const database = process.env.DB_NAME || 'dtmpos'

  console.log('Connecting to DB...')
  const conn = await mysql.createConnection({ host, port, user, password, database })

  // 1. Create permissions table
  await conn.query(`CREATE TABLE IF NOT EXISTS permissions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    code VARCHAR(64) NOT NULL UNIQUE,
    description VARCHAR(255)
  )`)
  console.log('Ensured permissions table')

  // 2. Create roles table
  await conn.query(`CREATE TABLE IF NOT EXISTS roles (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(64) NOT NULL UNIQUE,
    description VARCHAR(255)
  )`)
  // Check if description exists (in case table existed)
  try {
    await conn.query('ALTER TABLE roles ADD COLUMN description VARCHAR(255)')
  } catch (e) {
    if (e.code !== 'ER_DUP_FIELDNAME') console.log('Role description col check:', e.message)
  }
  console.log('Ensured roles table')

  // 3. Create role_permissions table
  await conn.query(`CREATE TABLE IF NOT EXISTS role_permissions (
    role_id INT NOT NULL,
    permission_id INT NOT NULL,
    PRIMARY KEY (role_id, permission_id),
    FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE,
    FOREIGN KEY (permission_id) REFERENCES permissions(id) ON DELETE CASCADE
  )`)
  console.log('Ensured role_permissions table')

  // 4. Seed Permissions
  const permissions = [
    { code: 'users:read', desc: 'Ver usuarios' },
    { code: 'users:write', desc: 'Crear/Editar usuarios' },
    { code: 'roles:read', desc: 'Ver roles' },
    { code: 'roles:write', desc: 'Crear/Editar roles' },
    { code: 'products:read', desc: 'Ver productos' },
    { code: 'products:write', desc: 'Crear/Editar productos' },
    { code: 'categories:read', desc: 'Ver categorías' },
    { code: 'categories:write', desc: 'Crear/Editar categorías' },
    { code: 'brands:read', desc: 'Ver marcas' },
    { code: 'brands:write', desc: 'Crear/Editar marcas' },
    { code: 'suppliers:read', desc: 'Ver proveedores' },
    { code: 'suppliers:write', desc: 'Crear/Editar proveedores' },
    { code: 'departments:read', desc: 'Ver departamentos' },
    { code: 'departments:write', desc: 'Crear/Editar departamentos' },
    { code: 'shelves:read', desc: 'Ver estanterías' },
    { code: 'shelves:write', desc: 'Crear/Editar estanterías' },
    { code: 'warehouses:read', desc: 'Ver almacenes' },
    { code: 'warehouses:write', desc: 'Crear/Editar almacenes' },
    { code: 'units:read', desc: 'Ver unidades' },
    { code: 'units:write', desc: 'Crear/Editar unidades' },
    { code: 'customers:read', desc: 'Ver clientes' },
    { code: 'customers:write', desc: 'Crear/Editar clientes' },
    { code: 'sales:read', desc: 'Ver historial de ventas' },
    { code: 'sales:create', desc: 'Realizar ventas (POS)' },
    { code: 'sales:cancel', desc: 'Anular ventas' },
    { code: 'credits:read', desc: 'Reporte de créditos' },
    { code: 'credits:write', desc: 'Gestión de créditos' },
    { code: 'config:read', desc: 'Ver configuración' },
    { code: 'config:write', desc: 'Editar configuración' },
    { code: 'reports:read', desc: 'Ver reportes' },
  ]

  for (const p of permissions) {
    await conn.query('INSERT IGNORE INTO permissions (code, description) VALUES (?, ?)', [p.code, p.desc])
  }
  console.log('Seeded permissions')

  // 5. Seed Roles and Assign Permissions
  const roles = [
    { name: 'ADMIN', desc: 'Administrador total' },
    { name: 'CAJERO', desc: 'Cajero punto de venta' },
    { name: 'VENDEDOR', desc: 'Vendedor con acceso a POS sin operaciones de caja' },
    { name: 'ALMACEN', desc: 'Encargado de inventario' },
  ]

  for (const r of roles) {
    await conn.query('INSERT IGNORE INTO roles (name, description) VALUES (?, ?)', [r.name, r.desc])
  }
  console.log('Seeded roles')

  // Helper to get ID
  const getRoleId = async (name) => {
    const [rows] = await conn.query('SELECT id FROM roles WHERE name = ?', [name])
    return rows[0]?.id
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
    if (!roleId) return
    const permIds = await getPermIds(permCodes)
    for (const pid of permIds) {
      await conn.query('INSERT IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)', [roleId, pid])
    }
  }

  // Admin: All
  await assignPerms('ADMIN', 'ALL')

  // Cajero
  await assignPerms('CAJERO', [
    'sales:create', 'sales:read', 'customers:read', 'customers:write', 
    'products:read', 'credits:read', 'credits:write'
  ])

  // Vendedor
  await assignPerms('VENDEDOR', [
    'pos:access',
    'sales:create',
    'sales:read',
    'customers:read',
    'customers:write',
    'products:read'
  ])

  // Almacen
  await assignPerms('ALMACEN', [
    'products:read', 'products:write',
    'categories:read', 'categories:write',
    'brands:read', 'brands:write',
    'suppliers:read', 'suppliers:write',
    'departments:read', 'departments:write',
    'shelves:read', 'shelves:write',
    'warehouses:read', 'warehouses:write',
    'units:read', 'units:write',
    'config:read'
  ])
  
  console.log('Assigned permissions to roles')

  // 6. Update users table
  // Check if role_id exists
  const [cols] = await conn.query(`SELECT COUNT(*) AS c FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'users' AND COLUMN_NAME = 'role_id'`, [database])
  if (cols[0].c === 0) {
    await conn.query('ALTER TABLE users ADD COLUMN role_id INT')
    await conn.query('ALTER TABLE users ADD CONSTRAINT fk_users_role FOREIGN KEY (role_id) REFERENCES roles(id)')
    console.log('Added role_id to users')
  }

  // Migrate existing users
  // Assuming 'role' column exists and has string values 'ADMIN', 'CAJERO', 'ALMACEN'
  const [users] = await conn.query("SELECT id, role FROM users WHERE role_id IS NULL AND role IS NOT NULL")
  for (const u of users) {
    const roleId = await getRoleId(u.role) // u.role is likely 'ADMIN', 'CAJERO' etc.
    if (roleId) {
      await conn.query('UPDATE users SET role_id = ? WHERE id = ?', [roleId, u.id])
    }
  }
  console.log(`Migrated ${users.length} users to role_id`)

  // Optional: Drop old role column? Maybe later. For now keep it but ignore it.

  conn.end()
}

migrateRBAC().catch(console.error)
