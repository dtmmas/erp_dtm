import express from 'express'
import { authMiddleware, getUserWarehouseId, isAdminUser, roleMiddleware } from '../auth.js'
import { getPool } from '../db.js'
import { registerMovement } from '../services/inventory.js'

const router = express.Router()

function userHasPermission(user, permission) {
  if (isAdminUser(user)) return true
  return Array.isArray(user?.permissions) && user.permissions.includes(permission)
}

// Helper to check numeric validity
function isValidNumber(n) {
  return typeof n === 'number' && !isNaN(n) && n > 0
}

function normalizeTrackedValue(value) {
  return String(value || '').trim().toUpperCase()
}

function findTrackedValueMatch(allowedValues, requestedValue) {
  const target = normalizeTrackedValue(requestedValue)
  if (!target) return null
  return (allowedValues || []).find(value => normalizeTrackedValue(value) === target) || null
}

async function ensureTransferItemsDestinationTypeColumn(conn) {
  const [rows] = await conn.query(`SHOW COLUMNS FROM transfer_items LIKE 'destination_movement_type'`)
  if (!Array.isArray(rows) || rows.length === 0) {
    await conn.query(`ALTER TABLE transfer_items ADD COLUMN destination_movement_type VARCHAR(20) NULL AFTER quantity`)
  }
}

async function ensureTransferItemsTrackedColumns(conn) {
  const trackedColumns = [
    { name: 'batch_no', definition: 'VARCHAR(100) NULL AFTER destination_movement_type' },
    { name: 'imei', definition: 'VARCHAR(100) NULL AFTER batch_no' },
    { name: 'serial', definition: 'VARCHAR(100) NULL AFTER imei' }
  ]

  for (const column of trackedColumns) {
    const [rows] = await conn.query(`SHOW COLUMNS FROM transfer_items LIKE ?`, [column.name])
    if (!Array.isArray(rows) || rows.length === 0) {
      await conn.query(`ALTER TABLE transfer_items ADD COLUMN ${column.name} ${column.definition}`)
    }
  }
}

function resolveDestinationMovementType(mode, destinationStockQty) {
  const normalizedMode = String(mode || 'AUTO').toUpperCase()
  if (normalizedMode === 'TRANSFER') {
    return 'TRANSFER_IN'
  }
  return Number(destinationStockQty || 0) > 0 ? 'TRANSFER_IN' : 'INITIAL'
}

async function getAllowedTrackedValues(conn, { productId, warehouseId, table, valueColumn }) {
  const [[stockRow]] = await conn.query(
    'SELECT quantity FROM product_warehouse_stock WHERE product_id = ? AND warehouse_id = ? LIMIT 1',
    [productId, warehouseId]
  )
  const stockQty = Math.max(0, Number(stockRow?.quantity || 0))

  const [rows] = await conn.query(
    `SELECT ${valueColumn} AS tracked_value
     FROM ${table}
     WHERE product_id = ? AND warehouse_id = ? AND status = "AVAILABLE"
     ORDER BY id ASC`,
    [productId, warehouseId]
  )

  return (rows || [])
    .map(row => row.tracked_value)
    .filter(Boolean)
    .slice(0, stockQty)
}

// GET /transfers - List all transfers
router.get('/', authMiddleware, async (req, res) => {
  try {
    if (!userHasPermission(req.user, 'transfers:read')) {
      return res.status(403).json({ error: 'Forbidden: Missing permission transfers:read' })
    }
    const pool = await getPool()
    await ensureTransferItemsDestinationTypeColumn(pool)
    await ensureTransferItemsTrackedColumns(pool)
    const { limit = 50, offset = 0 } = req.query

    const isAdmin = isAdminUser(req.user)
    const userWarehouseId = getUserWarehouseId(req.user)
    const whereClause = !isAdmin
      ? (userWarehouseId ? 'WHERE t.destination_warehouse_id = ?' : 'WHERE 1 = 0')
      : ''
    const params = !isAdmin
      ? (userWarehouseId ? [userWarehouseId, Number(limit), Number(offset)] : [Number(limit), Number(offset)])
      : [Number(limit), Number(offset)]

    const [rows] = await pool.query(`
      SELECT t.*, 
             ws.name as source_warehouse_name,
             wd.name as destination_warehouse_name,
             u.name as created_by_user,
             (SELECT COUNT(*) FROM transfer_items ti WHERE ti.transfer_id = t.id) as item_count,
             (SELECT SUM(quantity) FROM transfer_items ti WHERE ti.transfer_id = t.id) as total_quantity,
             (SELECT GROUP_CONCAT(DISTINCT COALESCE(ti.destination_movement_type, 'TRANSFER_IN') ORDER BY COALESCE(ti.destination_movement_type, 'TRANSFER_IN') SEPARATOR ',')
              FROM transfer_items ti
              WHERE ti.transfer_id = t.id) as destination_movement_summary
      FROM transfers t
      JOIN warehouses ws ON t.source_warehouse_id = ws.id
      JOIN warehouses wd ON t.destination_warehouse_id = wd.id
      LEFT JOIN users u ON t.user_id = u.id
      ${whereClause}
      ORDER BY t.created_at DESC
      LIMIT ? OFFSET ?
    `, params)
    
    return res.json(rows)
  } catch (err) {
    console.error('Transfers GET error:', err)
    return res.status(500).json({ error: 'Server error' })
  }
})

// GET /transfers/:id - Get details
router.get('/:id', authMiddleware, async (req, res) => {
  try {
    if (!userHasPermission(req.user, 'transfers:read')) {
      return res.status(403).json({ error: 'Forbidden: Missing permission transfers:read' })
    }
    const id = Number(req.params.id)
    const pool = await getPool()
    await ensureTransferItemsDestinationTypeColumn(pool)
    await ensureTransferItemsTrackedColumns(pool)
    const isAdmin = isAdminUser(req.user)
    const userWarehouseId = getUserWarehouseId(req.user)
    const whereClause = !isAdmin
      ? (userWarehouseId ? 'AND t.destination_warehouse_id = ?' : 'AND 1 = 0')
      : ''
    const params = !isAdmin
      ? (userWarehouseId ? [id, userWarehouseId] : [id])
      : [id]
    
    const [rows] = await pool.query(`
      SELECT t.*, 
             ws.name as source_warehouse_name,
             wd.name as destination_warehouse_name,
             u.name as created_by_user
      FROM transfers t
      JOIN warehouses ws ON t.source_warehouse_id = ws.id
      JOIN warehouses wd ON t.destination_warehouse_id = wd.id
      LEFT JOIN users u ON t.user_id = u.id
      WHERE t.id = ?
      ${whereClause}
    `, params)
    
    if (rows.length === 0) return res.status(404).json({ error: 'Transfer not found' })
    const transfer = rows[0]
    
    const [items] = await pool.query(`
      SELECT ti.*, p.name as product_name, p.sku, p.product_code, p.description, p.image_url
      FROM transfer_items ti
      JOIN products p ON ti.product_id = p.id
      WHERE ti.transfer_id = ?
    `, [id])
    
    return res.json({ ...transfer, items })
  } catch (err) {
    console.error('Transfers GET details error:', err)
    return res.status(500).json({ error: 'Server error' })
  }
})

// POST /transfers - Create new transfer
router.post('/', authMiddleware, roleMiddleware(['ADMIN', 'ALMACEN']), async (req, res) => {
  try {
    const { source_warehouse_id, destination_warehouse_id, destination_entry_mode, items, notes } = req.body

    const sourceWarehouseId = source_warehouse_id || req.body.sourceWarehouseId
    const destinationWarehouseId = destination_warehouse_id || req.body.destinationWarehouseId

    const isAdmin = isAdminUser(req.user)
    const userWarehouseId = getUserWarehouseId(req.user)
    const finalSourceWarehouseId = isAdmin ? Number(sourceWarehouseId) : Number(userWarehouseId || 0)
    const finalDestinationWarehouseId = Number(destinationWarehouseId)

    if (!isAdmin && !userWarehouseId) {
      return res.status(400).json({ error: 'El usuario no tiene una tienda asignada para transferir' })
    }
    if (!finalSourceWarehouseId || !finalDestinationWarehouseId) {
      return res.status(400).json({ error: 'Origen y destino son requeridos' })
    }
    if (!isAdmin && userWarehouseId && Number(sourceWarehouseId) && Number(sourceWarehouseId) !== Number(userWarehouseId)) {
      return res.status(403).json({ error: 'Solo puedes transferir desde tu tienda asignada' })
    }
    if (finalSourceWarehouseId === finalDestinationWarehouseId) {
      return res.status(400).json({ error: 'La tienda origen y destino deben ser diferentes' })
    }
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'La lista de productos esta vacia' })
    }
    if (destination_entry_mode && !['AUTO', 'TRANSFER'].includes(String(destination_entry_mode).toUpperCase())) {
      return res.status(400).json({ error: 'Modo de registro en destino inválido' })
    }
    
    const pool = await getPool()
    const conn = await pool.getConnection()
    
    try {
      await conn.beginTransaction()
      await ensureTransferItemsDestinationTypeColumn(conn)
      await ensureTransferItemsTrackedColumns(conn)

      const [warehouseRows] = await conn.query(
        'SELECT id, status FROM warehouses WHERE id IN (?, ?)',
        [finalSourceWarehouseId, finalDestinationWarehouseId]
      )
      const sourceWarehouse = warehouseRows.find(row => Number(row.id) === finalSourceWarehouseId)
      const destinationWarehouse = warehouseRows.find(row => Number(row.id) === finalDestinationWarehouseId)
      if (!sourceWarehouse || !destinationWarehouse) {
        await conn.rollback()
        return res.status(404).json({ error: 'La tienda origen o destino no existe' })
      }
      if (String(sourceWarehouse.status || '').toUpperCase() !== 'ACTIVO' || String(destinationWarehouse.status || '').toUpperCase() !== 'ACTIVO') {
        await conn.rollback()
        return res.status(400).json({ error: 'Solo se puede transferir entre tiendas activas' })
      }
      
      const [resHeader] = await conn.query(`
        INSERT INTO transfers (source_warehouse_id, destination_warehouse_id, status, user_id, notes)
        VALUES (?, ?, 'COMPLETED', ?, ?)
      `, [finalSourceWarehouseId, finalDestinationWarehouseId, req.user.id, notes || ''])
      
      const transferId = resHeader.insertId
      
      for (const item of items) {
        const productId = item.product_id || item.productId
        const quantity = Number(item.quantity || 0)
        const batchNo = item.batch_no || item.batchNo
        const imei = item.imei
        const serial = item.serial

        if (!isValidNumber(quantity)) continue

        const [[productRow]] = await conn.query(
          'SELECT product_type FROM products WHERE id = ? LIMIT 1',
          [productId]
        )
        if (!productRow) {
          throw new Error(`Producto no encontrado: ${productId}`)
        }
        const productType = String(productRow.product_type || 'GENERAL').toUpperCase()

        if (productType === 'IMEI') {
          if (!imei) {
            throw new Error(`Debes indicar el IMEI exacto para transferir el producto ${productId}`)
          }
          if (quantity !== 1) {
            throw new Error(`Los productos con IMEI solo pueden transferirse de una unidad por item (${productId})`)
          }
        }

        if (productType === 'SERIAL') {
          if (!serial) {
            throw new Error(`Debes indicar la serie exacta para transferir el producto ${productId}`)
          }
          if (quantity !== 1) {
            throw new Error(`Los productos con serie solo pueden transferirse de una unidad por item (${productId})`)
          }
        }

        if (batchNo) {
             const [batchResult] = await conn.query(
               'UPDATE product_batches SET quantity = quantity - ? WHERE product_id = ? AND batch_no = ? AND warehouse_id = ? AND quantity >= ?',
               [quantity, productId, batchNo, finalSourceWarehouseId, quantity]
             )
             if (!batchResult.affectedRows) {
               throw new Error(`Stock insuficiente o lote no disponible para el producto ${productId} en la tienda origen`)
             }
        } else if (imei) {
             const allowedImeis = await getAllowedTrackedValues(conn, {
               productId,
               warehouseId: finalSourceWarehouseId,
               table: 'product_imeis',
               valueColumn: 'imei'
             })
             const matchedImei = findTrackedValueMatch(allowedImeis, imei)
             if (!matchedImei) {
               throw new Error(`IMEI no disponible para transferir en la tienda origen para el producto ${productId}`)
             }
             const [imeiResult] = await conn.query(
               'UPDATE product_imeis SET warehouse_id = ? WHERE product_id = ? AND imei = ? AND warehouse_id = ? AND status = "AVAILABLE"',
               [finalDestinationWarehouseId, productId, matchedImei, finalSourceWarehouseId]
             )
             if (!imeiResult.affectedRows) {
               throw new Error(`IMEI no disponible en la tienda origen para el producto ${productId}`)
             }
        } else if (serial) {
             const allowedSerials = await getAllowedTrackedValues(conn, {
               productId,
               warehouseId: finalSourceWarehouseId,
               table: 'product_serials',
               valueColumn: 'serial_no'
             })
             const matchedSerial = findTrackedValueMatch(allowedSerials, serial)
             if (!matchedSerial) {
               throw new Error(`Serie no disponible para transferir en la tienda origen para el producto ${productId}`)
             }
             const [serialResult] = await conn.query(
               'UPDATE product_serials SET warehouse_id = ? WHERE product_id = ? AND serial_no = ? AND warehouse_id = ? AND status = "AVAILABLE"',
               [finalDestinationWarehouseId, productId, matchedSerial, finalSourceWarehouseId]
             )
             if (!serialResult.affectedRows) {
               throw new Error(`Serie no disponible en la tienda origen para el producto ${productId}`)
             }
        }

        if (batchNo) {
             const [destBatch] = await conn.query('SELECT id, quantity FROM product_batches WHERE product_id = ? AND batch_no = ? AND warehouse_id = ?', [productId, batchNo, finalDestinationWarehouseId])
             
             if (destBatch.length > 0) {
                 await conn.query('UPDATE product_batches SET quantity = quantity + ? WHERE id = ?', [quantity, destBatch[0].id])
             } else {
                 const [srcBatch] = await conn.query('SELECT expiry_date FROM product_batches WHERE product_id = ? AND batch_no = ? AND warehouse_id = ?', [productId, batchNo, finalSourceWarehouseId])
                 let expiry = srcBatch.length > 0 ? srcBatch[0].expiry_date : null

                 if (!expiry) {
                     const [anyBatch] = await conn.query('SELECT expiry_date FROM product_batches WHERE product_id = ? AND batch_no = ? LIMIT 1', [productId, batchNo])
                     if (anyBatch.length > 0) expiry = anyBatch[0].expiry_date
                 }

                 if (expiry) {
                     await conn.query('INSERT INTO product_batches (product_id, batch_no, expiry_date, quantity, warehouse_id) VALUES (?, ?, ?, ?, ?)', 
                         [productId, batchNo, expiry, quantity, finalDestinationWarehouseId])
                 }
             }
        }

        const [[destinationStockRow]] = await conn.query(
          'SELECT quantity FROM product_warehouse_stock WHERE product_id = ? AND warehouse_id = ? LIMIT 1',
          [productId, finalDestinationWarehouseId]
        )
        const destinationMovementType = resolveDestinationMovementType(
          destination_entry_mode,
          Number(destinationStockRow?.quantity || 0)
        )
        const destinationMovementLabel = destinationMovementType === 'INITIAL' ? 'Ingreso inicial por transferencia' : 'Transferencia'

        await conn.query(`
          INSERT INTO transfer_items (transfer_id, product_id, quantity, destination_movement_type, batch_no, imei, serial)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `, [transferId, productId, quantity, destinationMovementType, batchNo || null, imei || null, serial || null])

        await registerMovement({
          productId,
          warehouseId: finalSourceWarehouseId,
          type: 'TRANSFER_OUT',
          quantity: quantity,
          referenceId: transferId, 
          notes: `Transferencia #${transferId} a almacén ${finalDestinationWarehouseId} ${batchNo ? `(Lote: ${batchNo})` : ''} ${imei ? `(IMEI: ${imei})` : ''} ${serial ? `(SN: ${serial})` : ''}`,
          userId: req.user.id
        }, conn)
        
        await registerMovement({
          productId,
          warehouseId: finalDestinationWarehouseId,
          type: destinationMovementType,
          quantity: quantity,
          referenceId: transferId, 
          notes: `${destinationMovementLabel} #${transferId} desde almacén ${finalSourceWarehouseId} ${batchNo ? `(Lote: ${batchNo})` : ''} ${imei ? `(IMEI: ${imei})` : ''} ${serial ? `(SN: ${serial})` : ''}`,
          userId: req.user.id
        }, conn)
      }
      
      await conn.commit()
      return res.json({ success: true, transferId })
      
    } catch (err) {
      await conn.rollback()
      console.error('Transfer Transaction Error:', err)
      if (err.message && err.message.includes('Stock insuficiente')) {
         return res.status(400).json({ error: err.message })
      }
      if (err.message && (
        err.message.includes('lote no disponible') ||
        err.message.includes('IMEI no disponible') ||
        err.message.includes('Serie no disponible') ||
        err.message.includes('Debes indicar el IMEI exacto') ||
        err.message.includes('Debes indicar la serie exacta') ||
        err.message.includes('solo pueden transferirse de una unidad por item')
      )) {
         return res.status(400).json({ error: err.message })
      }
      return res.status(500).json({ error: 'Error processing transfer' })
    } finally {
      conn.release()
    }
    
  } catch (err) {
    console.error('Transfers POST error:', err)
    return res.status(500).json({ error: 'Server error' })
  }
})

export default router
