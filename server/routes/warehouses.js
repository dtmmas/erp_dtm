import express from 'express'
import { authMiddleware, getUserWarehouseId, isAdminUser, roleMiddleware } from '../auth.js'
import { getPool } from '../db.js'

const router = express.Router()

function userHasPermission(user, permission) {
  if (isAdminUser(user)) return true
  return Array.isArray(user?.permissions) && user.permissions.includes(permission)
}

async function ensureWarehousesTable(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS warehouses (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(120) NOT NULL UNIQUE,
    type ENUM('ALMACEN','TIENDA') NOT NULL DEFAULT 'ALMACEN',
    address VARCHAR(255),
    contract_phone VARCHAR(60),
    contract_facebook VARCHAR(120),
    status ENUM('ACTIVO','INACTIVO') NOT NULL DEFAULT 'ACTIVO'
  )`)
}

// Listar almacenes
router.get('/', authMiddleware, async (req, res) => {
  try {
    if (!userHasPermission(req.user, 'warehouses:read')) {
      return res.status(403).json({ error: 'Forbidden: Missing permission warehouses:read' })
    }
    const pool = await getPool()
    await ensureWarehousesTable(pool)
    const isAdmin = isAdminUser(req.user)
    const userWarehouseId = getUserWarehouseId(req.user)
    const mode = String(req.query.mode || '').toLowerCase()

    let rows = []
    if (isAdmin) {
      ;[rows] = await pool.query('SELECT id, name, type, address, contract_phone, contract_facebook, status FROM warehouses ORDER BY name ASC')
    } else if (mode === 'transfer' && userWarehouseId) {
      ;[rows] = await pool.query(
        'SELECT id, name, type, address, contract_phone, contract_facebook, status FROM warehouses WHERE status = "ACTIVO" ORDER BY name ASC'
      )
    } else if (userWarehouseId) {
      ;[rows] = await pool.query(
        'SELECT id, name, type, address, contract_phone, contract_facebook, status FROM warehouses WHERE id = ? LIMIT 1',
        [userWarehouseId]
      )
    }

    return res.json(rows)
  } catch (err) {
    console.error('Warehouses GET error:', err)
    return res.status(500).json({ error: 'Server error' })
  }
})

// Crear almacén
router.post('/', authMiddleware, roleMiddleware(['ADMIN','ALMACEN']), async (req, res) => {
  try {
    let { name, type, address, contract_phone, contract_facebook, status } = req.body
    name = (name || '').trim()
    if (!name) return res.status(400).json({ error: 'Nombre requerido' })
    
    const pool = await getPool()
    await ensureWarehousesTable(pool)
    
    const [exists] = await pool.query('SELECT id FROM warehouses WHERE LOWER(name) = LOWER(?) LIMIT 1', [name])
    if (Array.isArray(exists) && exists.length > 0) {
      return res.status(409).json({ error: 'Ya existe un almacén con ese nombre' })
    }
    
    const [result] = await pool.query(
      'INSERT INTO warehouses (name, type, address, contract_phone, contract_facebook, status) VALUES (?, ?, ?, ?, ?, ?)',
      [name, type || 'ALMACEN', address || null, contract_phone || null, contract_facebook || null, status || 'ACTIVO']
    )
    return res.status(201).json({ id: result.insertId, name, type, address, contract_phone, contract_facebook, status })
  } catch (err) {
    console.error('Warehouses POST error:', err)
    return res.status(500).json({ error: 'Server error' })
  }
})

// Actualizar almacén
router.put('/:id', authMiddleware, roleMiddleware(['ADMIN','ALMACEN']), async (req, res) => {
  try {
    const id = Number(req.params.id)
    let { name, type, address, contract_phone, contract_facebook, status } = req.body
    name = (name || '').trim()
    if (!name) return res.status(400).json({ error: 'Nombre requerido' })
    
    const pool = await getPool()
    await ensureWarehousesTable(pool)
    
    const [exists] = await pool.query('SELECT id FROM warehouses WHERE LOWER(name) = LOWER(?) AND id <> ? LIMIT 1', [name, id])
    if (Array.isArray(exists) && exists.length > 0) {
      return res.status(409).json({ error: 'Ya existe un almacén con ese nombre' })
    }
    
    await pool.query(
      'UPDATE warehouses SET name = ?, type = ?, address = ?, contract_phone = ?, contract_facebook = ?, status = ? WHERE id = ?',
      [name, type || 'ALMACEN', address || null, contract_phone || null, contract_facebook || null, status || 'ACTIVO', id]
    )
    return res.json({ id, name, type, address, contract_phone, contract_facebook, status })
  } catch (err) {
    console.error('Warehouses PUT error:', err)
    return res.status(500).json({ error: 'Server error' })
  }
})

// Eliminar almacén
router.delete('/:id', authMiddleware, roleMiddleware(['ADMIN','ALMACEN']), async (req, res) => {
  try {
    const id = Number(req.params.id)
    const pool = await getPool()
    await ensureWarehousesTable(pool)
    await pool.query('DELETE FROM warehouses WHERE id = ?', [id])
    return res.json({ ok: true })
  } catch (err) {
    console.error('Warehouses DELETE error:', err)
    return res.status(500).json({ error: 'Server error' })
  }
})

export default router
