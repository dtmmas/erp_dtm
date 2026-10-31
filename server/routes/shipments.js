import express from 'express'
import multer from 'multer'
import path from 'path'
import { authMiddleware, permissionMiddleware, roleMiddleware, getUserWarehouseId, isAdminUser } from '../auth.js'
import { uploadsDir } from '../paths.js'
import { getPool } from '../db.js'

const router = express.Router()

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase() || '.jpg'
    const safeExt = ['.jpg', '.jpeg', '.png', '.webp'].includes(ext) ? ext : '.jpg'
    cb(null, `shipment_${Date.now()}_${Math.random().toString(16).slice(2)}${safeExt}`)
  },
})

function fileFilter(req, file, cb) {
  const mime = String(file.mimetype || '').toLowerCase()
  if (mime.startsWith('image/')) return cb(null, true)
  return cb(new Error('Only image uploads are allowed'))
}

const upload = multer({ storage, fileFilter, limits: { fileSize: 10 * 1024 * 1024 } })

function isAdminOrWarehouse(user) {
  const role = String(user?.role || '').toUpperCase()
  return role === 'ADMIN' || role === 'ALMACEN'
}

function isWarehouseUser(user) {
  return String(user?.role || '').toUpperCase() === 'ALMACEN'
}

function requireUserWarehouseId(user) {
  const warehouseId = getUserWarehouseId(user)
  if (!warehouseId) {
    const err = new Error('Usuario sin almacén asignado')
    err.statusCode = 403
    throw err
  }
  return warehouseId
}

function assertShipmentWarehouseAccess(user, shipment) {
  if (isAdminUser(user)) return
  if (!isWarehouseUser(user)) return
  const warehouseId = requireUserWarehouseId(user)
  const fromId = Number(shipment?.from_warehouse_id || 0)
  const toId = Number(shipment?.to_warehouse_id || 0)
  if (fromId === warehouseId || toId === warehouseId) return
  const err = new Error('No autorizado para este almacén')
  err.statusCode = 403
  throw err
}

function shipmentsMyRead(req, res, next) {
  if (isAdminOrWarehouse(req.user)) return next()
  return permissionMiddleware('shipments:my:read')(req, res, next)
}

function shipmentsMyWrite(req, res, next) {
  if (isAdminOrWarehouse(req.user)) return next()
  return permissionMiddleware('shipments:my:write')(req, res, next)
}

async function getShipmentOrThrow(conn, shipmentId) {
  const [rows] = await conn.query('SELECT * FROM shipments WHERE id = ?', [shipmentId])
  const shipment = rows?.[0] || null
  if (!shipment) {
    const err = new Error('Envío no encontrado')
    err.statusCode = 404
    throw err
  }
  return shipment
}

function normalizeNumber(val, defaultValue = 0) {
  const n = Number(val)
  return Number.isFinite(n) ? n : defaultValue
}

router.get('/', authMiddleware, roleMiddleware(['ADMIN', 'ALMACEN']), async (req, res) => {
  try {
    const pool = await getPool()
    const { status, type, driverUserId, search } = req.query || {}
    const where = []
    const params = []

    if (!isAdminUser(req.user)) {
      const warehouseId = requireUserWarehouseId(req.user)
      where.push('(s.from_warehouse_id = ? OR s.to_warehouse_id = ?)')
      params.push(warehouseId, warehouseId)
    }

    if (status) {
      where.push('s.status = ?')
      params.push(String(status))
    }
    if (type) {
      where.push('s.type = ?')
      params.push(String(type))
    }
    if (driverUserId) {
      where.push('s.driver_user_id = ?')
      params.push(Number(driverUserId))
    }
    if (search) {
      where.push('(COALESCE(c.name, \'\') LIKE ? OR COALESCE(sa.doc_no, \'\') LIKE ? OR CAST(s.id AS CHAR) LIKE ?)')
      const q = `%${String(search)}%`
      params.push(q, q, q)
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const [rows] = await pool.query(
      `
      SELECT
        s.*,
        COALESCE(c.name, '') AS customer_name,
        COALESCE(sa.doc_no, '') AS sale_doc_no,
        COALESCE(u.name, '') AS driver_name,
        COALESCE(v.plate, '') AS vehicle_plate,
        COALESCE(wf.name, '') AS from_warehouse_name,
        COALESCE(wt.name, '') AS to_warehouse_name
      FROM shipments s
      LEFT JOIN customers c ON c.id = s.customer_id
      LEFT JOIN sales sa ON sa.id = s.source_sale_id
      LEFT JOIN users u ON u.id = s.driver_user_id
      LEFT JOIN vehicles v ON v.id = s.vehicle_id
      LEFT JOIN warehouses wf ON wf.id = s.from_warehouse_id
      LEFT JOIN warehouses wt ON wt.id = s.to_warehouse_id
      ${whereSql}
      ORDER BY s.id DESC
      LIMIT 500
      `,
      params
    )
    res.json(rows)
  } catch (err) {
    console.error('List shipments error:', err)
    res.status(500).json({ error: 'Server error' })
  }
})

router.get('/vehicles', authMiddleware, roleMiddleware(['ADMIN', 'ALMACEN']), async (req, res) => {
  try {
    const pool = await getPool()
    const [rows] = await pool.query('SELECT * FROM vehicles ORDER BY active DESC, plate ASC')
    res.json(rows)
  } catch (err) {
    console.error('List vehicles error:', err)
    res.status(500).json({ error: 'Server error' })
  }
})

router.get('/drivers', authMiddleware, roleMiddleware(['ADMIN', 'ALMACEN']), async (req, res) => {
  try {
    const pool = await getPool()
    const [cols] = await pool.query("SHOW COLUMNS FROM users LIKE 'is_driver'")
    const hasIsDriver = Array.isArray(cols) && cols.length > 0
    const [rows] = await pool.query(
      `SELECT id, name, email, active FROM users WHERE COALESCE(active, 1) = 1${hasIsDriver ? ' AND COALESCE(is_driver, 0) = 1' : ''} ORDER BY name ASC`
    )
    res.json(rows)
  } catch (err) {
    console.error('List drivers error:', err)
    res.status(500).json({ error: 'Server error' })
  }
})

router.get('/pending-sales', authMiddleware, roleMiddleware(['ADMIN', 'ALMACEN']), async (req, res) => {
  try {
    const pool = await getPool()
    const params = []
    let whereWarehouse = ''
    if (!isAdminUser(req.user)) {
      const warehouseId = requireUserWarehouseId(req.user)
      whereWarehouse = 'AND COALESCE(s.warehouse_id, 0) = ?'
      params.push(warehouseId)
    }

    const [rows] = await pool.query(
      `
      SELECT
        s.id,
        COALESCE(s.doc_no, '') AS doc_no,
        s.warehouse_id,
        COALESCE(w.name, '') AS warehouse_name,
        s.customer_id,
        COALESCE(c.name, '') AS customer_name,
        COALESCE(c.phone, '') AS customer_phone,
        COALESCE(c.address, '') AS customer_address,
        s.total,
        s.created_at
      FROM sales s
      LEFT JOIN customers c ON c.id = s.customer_id
      LEFT JOIN warehouses w ON w.id = s.warehouse_id
      LEFT JOIN shipments sh ON sh.source_sale_id = s.id AND sh.type = 'SALE_DELIVERY'
      WHERE
        COALESCE(s.status, 'COMPLETED') = 'COMPLETED'
        AND COALESCE(s.is_credit, 0) = 0
        AND COALESCE(s.payment_method, 'CASH') = 'CASH'
        AND sh.id IS NULL
        ${whereWarehouse}
      ORDER BY s.id DESC
      LIMIT 200
      `,
      params
    )
    res.json(rows)
  } catch (err) {
    console.error('Pending sales for shipment error:', err)
    res.status(500).json({ error: 'Server error' })
  }
})

router.post('/vehicles', authMiddleware, roleMiddleware(['ADMIN', 'ALMACEN']), async (req, res) => {
  try {
    const { plate, name, capacity, active } = req.body || {}
    const p = String(plate || '').trim().toUpperCase()
    if (!p) return res.status(400).json({ error: 'Placa requerida' })
    const pool = await getPool()
    const [result] = await pool.query(
      'INSERT INTO vehicles (plate, name, capacity, active, created_at) VALUES (?, ?, ?, ?, NOW())',
      [p, name ? String(name) : null, capacity ? String(capacity) : null, active == null ? 1 : Number(active) ? 1 : 0]
    )
    res.json({ success: true, id: result.insertId })
  } catch (err) {
    console.error('Create vehicle error:', err)
    res.status(400).json({ error: err?.message || 'Error creando vehículo' })
  }
})

router.put('/vehicles/:id', authMiddleware, roleMiddleware(['ADMIN', 'ALMACEN']), async (req, res) => {
  try {
    const id = Number(req.params.id)
    const { plate, name, capacity, active } = req.body || {}
    const p = plate != null ? String(plate).trim().toUpperCase() : null
    const pool = await getPool()
    await pool.query(
      'UPDATE vehicles SET plate = COALESCE(?, plate), name = ?, capacity = ?, active = ? WHERE id = ?',
      [p, name ? String(name) : null, capacity ? String(capacity) : null, active == null ? 1 : Number(active) ? 1 : 0, id]
    )
    res.json({ success: true })
  } catch (err) {
    console.error('Update vehicle error:', err)
    res.status(400).json({ error: err?.message || 'Error actualizando vehículo' })
  }
})

router.get('/my', authMiddleware, shipmentsMyRead, async (req, res) => {
  try {
    const pool = await getPool()
    const userId = req.user.id
    const [rows] = await pool.query(
      `
      SELECT
        s.*,
        COALESCE(c.name, '') AS customer_name,
        COALESCE(sa.doc_no, '') AS sale_doc_no,
        COALESCE(v.plate, '') AS vehicle_plate,
        COALESCE(wf.name, '') AS from_warehouse_name,
        COALESCE(wt.name, '') AS to_warehouse_name
      FROM shipments s
      LEFT JOIN customers c ON c.id = s.customer_id
      LEFT JOIN sales sa ON sa.id = s.source_sale_id
      LEFT JOIN vehicles v ON v.id = s.vehicle_id
      LEFT JOIN warehouses wf ON wf.id = s.from_warehouse_id
      LEFT JOIN warehouses wt ON wt.id = s.to_warehouse_id
      WHERE s.driver_user_id = ?
      ORDER BY s.id DESC
      LIMIT 200
      `,
      [userId]
    )
    res.json(rows)
  } catch (err) {
    console.error('List my shipments error:', err)
    res.status(500).json({ error: 'Server error' })
  }
})

router.get('/:id', authMiddleware, shipmentsMyRead, async (req, res) => {
  try {
    const pool = await getPool()
    const shipmentId = Number(req.params.id)
    const [rows] = await pool.query('SELECT * FROM shipments WHERE id = ?', [shipmentId])
    const shipment = rows?.[0] || null
    if (!shipment) return res.status(404).json({ error: 'Envío no encontrado' })

    const isOwner = Number(shipment.driver_user_id || 0) === Number(req.user.id)
    if (!isOwner && !isAdminOrWarehouse(req.user)) {
      return res.status(403).json({ error: 'No autorizado' })
    }
    if (!isOwner) {
      try {
        assertShipmentWarehouseAccess(req.user, shipment)
      } catch (err) {
        return res.status(err.statusCode || 403).json({ error: err.message || 'No autorizado' })
      }
    }

    const [items] = await pool.query(
      `
      SELECT
        si.*,
        p.name AS product_name
      FROM shipment_items si
      JOIN products p ON p.id = si.product_id
      WHERE si.shipment_id = ?
      ORDER BY si.id ASC
      `,
      [shipmentId]
    )
    const [events] = await pool.query(
      `
      SELECT
        e.*,
        COALESCE(u.name, '') AS created_by_name
      FROM shipment_events e
      LEFT JOIN users u ON u.id = e.created_by_user_id
      WHERE e.shipment_id = ?
      ORDER BY e.id ASC
      `,
      [shipmentId]
    )
    const eventIds = events.map(e => e.id)
    let media = []
    if (eventIds.length) {
      const [m] = await pool.query(
        'SELECT * FROM shipment_event_media WHERE event_id IN (?) ORDER BY id ASC',
        [eventIds]
      )
      media = m
    }
    const [issues] = await pool.query('SELECT * FROM shipment_issues WHERE shipment_id = ? ORDER BY id DESC', [shipmentId])
    const issueIds = issues.map(i => i.id)
    let issueItems = []
    if (issueIds.length) {
      const [ii] = await pool.query(
        `
        SELECT sii.*, p.name AS product_name
        FROM shipment_issue_items sii
        JOIN products p ON p.id = sii.product_id
        WHERE sii.issue_id IN (?)
        ORDER BY sii.id ASC
        `,
        [issueIds]
      )
      issueItems = ii
    }

    res.json({ shipment, items, events, media, issues, issueItems })
  } catch (err) {
    console.error('Get shipment error:', err)
    res.status(500).json({ error: 'Server error' })
  }
})

router.post('/', authMiddleware, async (req, res) => {
  try {
    if (!isAdminOrWarehouse(req.user)) {
      return res.status(403).json({ error: 'No autorizado' })
    }

    const {
      type,
      sourceSaleId,
      sourceTransferId,
      fromWarehouseId,
      toWarehouseId,
      customerId,
      deliveryAddress,
      contactName,
      contactPhone,
      scheduledDate,
      priority,
      driverUserId,
      vehicleId,
      items,
    } = req.body || {}

    const shipmentType = String(type || '').trim()
    if (!shipmentType) return res.status(400).json({ error: 'Tipo requerido' })

    const fromWh = Number(fromWarehouseId)
    if (!fromWh) return res.status(400).json({ error: 'Almacén origen requerido' })

    if (!isAdminUser(req.user)) {
      const userWarehouseId = requireUserWarehouseId(req.user)
      if (fromWh !== userWarehouseId) {
        return res.status(403).json({ error: 'No autorizado para crear envíos desde otro almacén' })
      }
    }

    const pool = await getPool()
    const conn = await pool.getConnection()
    try {
      await conn.beginTransaction()
      const status = driverUserId ? 'ASSIGNED' : 'DRAFT'
      const [result] = await conn.query(
        `
        INSERT INTO shipments (
          type, source_sale_id, source_transfer_id,
          from_warehouse_id, to_warehouse_id,
          customer_id, delivery_address, contact_name, contact_phone,
          driver_user_id, vehicle_id,
          status, scheduled_date, priority,
          created_by_user_id, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
        `,
        [
          shipmentType,
          sourceSaleId ? Number(sourceSaleId) : null,
          sourceTransferId ? Number(sourceTransferId) : null,
          fromWh,
          toWarehouseId ? Number(toWarehouseId) : null,
          customerId ? Number(customerId) : null,
          deliveryAddress ? String(deliveryAddress) : null,
          contactName ? String(contactName) : null,
          contactPhone ? String(contactPhone) : null,
          driverUserId ? Number(driverUserId) : null,
          vehicleId ? Number(vehicleId) : null,
          status,
          scheduledDate ? new Date(scheduledDate) : null,
          priority ? String(priority) : null,
          req.user.id,
        ]
      )
      const shipmentId = result.insertId

      let itemsToInsert = []
      if (sourceSaleId) {
        const [saleItems] = await conn.query(
          'SELECT product_id, quantity FROM sale_items WHERE sale_id = ?',
          [Number(sourceSaleId)]
        )
        itemsToInsert = saleItems.map(r => ({ product_id: r.product_id, qty: r.quantity }))
      } else if (sourceTransferId) {
        const [transferItems] = await conn.query(
          'SELECT product_id, quantity FROM transfer_items WHERE transfer_id = ?',
          [Number(sourceTransferId)]
        )
        itemsToInsert = transferItems.map(r => ({ product_id: r.product_id, qty: r.quantity }))
      } else if (Array.isArray(items)) {
        itemsToInsert = items.map(it => ({ product_id: Number(it.productId), qty: Number(it.qty || 0) }))
      } else if (typeof items === 'string') {
        try {
          const parsed = JSON.parse(items)
          if (Array.isArray(parsed)) itemsToInsert = parsed.map(it => ({ product_id: Number(it.productId), qty: Number(it.qty || 0) }))
        } catch {}
      }

      for (const it of itemsToInsert) {
        if (!it.product_id || !it.qty) continue
        await conn.query(
          `
          INSERT INTO shipment_items (shipment_id, product_id, qty_planned, qty_dispatched, qty_received, qty_missing, qty_damaged)
          VALUES (?, ?, ?, ?, 0, 0, 0)
          `,
          [shipmentId, it.product_id, it.qty, it.qty]
        )
      }

      if (driverUserId) {
        await conn.query(
          'INSERT INTO shipment_events (shipment_id, event_type, notes, created_by_user_id, created_at) VALUES (?, ?, ?, ?, NOW())',
          [shipmentId, 'ASSIGNMENT', 'Asignado al chofer', req.user.id]
        )
      }

      await conn.commit()
      res.json({ success: true, shipmentId })
    } catch (err) {
      await conn.rollback()
      console.error('Create shipment error:', err)
      res.status(400).json({ error: err.message || 'Error creando envío' })
    } finally {
      conn.release()
    }
  } catch (err) {
    console.error('Create shipment fatal:', err)
    res.status(500).json({ error: 'Server error' })
  }
})

router.post('/:id/assign', authMiddleware, roleMiddleware(['ADMIN', 'ALMACEN']), async (req, res) => {
  try {
    const shipmentId = Number(req.params.id)
    const { driverUserId, vehicleId } = req.body || {}
    if (!driverUserId) return res.status(400).json({ error: 'Chofer requerido' })

    const pool = await getPool()
    const conn = await pool.getConnection()
    try {
      await conn.beginTransaction()
      const shipment = await getShipmentOrThrow(conn, shipmentId)
      assertShipmentWarehouseAccess(req.user, shipment)
      const [cols] = await conn.query("SHOW COLUMNS FROM users LIKE 'is_driver'")
      const hasIsDriver = Array.isArray(cols) && cols.length > 0
      if (hasIsDriver) {
        const [drivers] = await conn.query('SELECT id FROM users WHERE id = ? AND COALESCE(active, 1) = 1 AND COALESCE(is_driver, 0) = 1', [Number(driverUserId)])
        if (!drivers?.length) {
          const err = new Error('El usuario seleccionado no está marcado como chofer')
          err.statusCode = 400
          throw err
        }
      }
      await conn.query(
        'UPDATE shipments SET driver_user_id = ?, vehicle_id = ?, status = ?, updated_at = NOW() WHERE id = ?',
        [Number(driverUserId), vehicleId ? Number(vehicleId) : null, 'ASSIGNED', shipmentId]
      )
      await conn.query(
        'INSERT INTO shipment_events (shipment_id, event_type, notes, created_by_user_id, created_at) VALUES (?, ?, ?, ?, NOW())',
        [shipmentId, 'ASSIGNMENT', 'Asignación actualizada', req.user.id]
      )
      await conn.commit()
      res.json({ success: true })
    } catch (err) {
      await conn.rollback()
      res.status(err.statusCode || 400).json({ error: err.message || 'Error asignando' })
    } finally {
      conn.release()
    }
  } catch (err) {
    console.error('Assign shipment error:', err)
    res.status(500).json({ error: 'Server error' })
  }
})

router.post(
  '/:id/event',
  authMiddleware,
  shipmentsMyWrite,
  upload.fields([
    { name: 'photos', maxCount: 10 },
    { name: 'signature', maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      const shipmentId = Number(req.params.id)
      const { eventType, notes, receiverName, receiverDpi, status } = req.body || {}
      const type = String(eventType || '').trim()
      if (!type) return res.status(400).json({ error: 'eventType requerido' })

      const pool = await getPool()
      const conn = await pool.getConnection()
      try {
        await conn.beginTransaction()
        const shipment = await getShipmentOrThrow(conn, shipmentId)
        const isOwner = Number(shipment.driver_user_id || 0) === Number(req.user.id)
        if (!isOwner && !isAdminOrWarehouse(req.user)) {
          const err = new Error('No autorizado')
          err.statusCode = 403
          throw err
        }
        if (!isOwner) assertShipmentWarehouseAccess(req.user, shipment)

        const [evRes] = await conn.query(
          `
          INSERT INTO shipment_events (
            shipment_id, event_type, notes, receiver_name, receiver_dpi, created_by_user_id, created_at
          )
          VALUES (?, ?, ?, ?, ?, ?, NOW())
          `,
          [
            shipmentId,
            type,
            notes ? String(notes) : null,
            receiverName ? String(receiverName) : null,
            receiverDpi ? String(receiverDpi) : null,
            req.user.id,
          ]
        )
        const eventId = evRes.insertId

        const photos = (req.files?.photos || []).map(f => `/uploads/${f.filename}`)
        for (const url of photos) {
          await conn.query(
            'INSERT INTO shipment_event_media (event_id, media_type, url, captured_at, created_at) VALUES (?, ?, ?, NOW(), NOW())',
            [eventId, 'PHOTO', url]
          )
        }

        const signatureFile = Array.isArray(req.files?.signature) ? req.files.signature[0] : null
        if (signatureFile) {
          const url = `/uploads/${signatureFile.filename}`
          await conn.query(
            'INSERT INTO shipment_event_media (event_id, media_type, url, captured_at, created_at) VALUES (?, ?, ?, NOW(), NOW())',
            [eventId, 'SIGNATURE', url]
          )
        }

        const nextStatus = status ? String(status) : null
        if (nextStatus) {
          await conn.query('UPDATE shipments SET status = ?, updated_at = NOW() WHERE id = ?', [nextStatus, shipmentId])
        }

        await conn.commit()
        res.json({ success: true, eventId })
      } catch (err) {
        await conn.rollback()
        res.status(err.statusCode || 400).json({ error: err.message || 'Error registrando evento' })
      } finally {
        conn.release()
      }
    } catch (err) {
      console.error('Shipment event error:', err)
      res.status(500).json({ error: 'Server error' })
    }
  }
)

router.post(
  '/:id/complete',
  authMiddleware,
  shipmentsMyWrite,
  upload.fields([
    { name: 'photos', maxCount: 10 },
    { name: 'signature', maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      const shipmentId = Number(req.params.id)
      const { action, receiverName, receiverDpi, notes, waivePenalty, items } = req.body || {}
      const normalizedAction = String(action || '').trim().toUpperCase()
      if (!['DELIVER', 'RECEIVE'].includes(normalizedAction)) return res.status(400).json({ error: 'Acción inválida' })
      if (!String(receiverName || '').trim()) return res.status(400).json({ error: 'Nombre de quien recibe requerido' })
      if (!String(receiverDpi || '').trim()) return res.status(400).json({ error: 'DPI de quien recibe requerido' })

      const photos = (req.files?.photos || []).map(f => `/uploads/${f.filename}`)
      if (photos.length === 0) return res.status(400).json({ error: 'Debe adjuntar al menos una foto' })

      const signatureFile = Array.isArray(req.files?.signature) ? req.files.signature[0] : null
      if (!signatureFile) return res.status(400).json({ error: 'Firma requerida' })
      const signatureUrl = `/uploads/${signatureFile.filename}`

      let parsedItems = []
      if (Array.isArray(items)) parsedItems = items
      else if (typeof items === 'string') {
        try {
          const parsed = JSON.parse(items)
          if (Array.isArray(parsed)) parsedItems = parsed
        } catch {}
      }

      const pool = await getPool()
      const conn = await pool.getConnection()
      try {
        await conn.beginTransaction()
        const shipment = await getShipmentOrThrow(conn, shipmentId)
        const isOwner = Number(shipment.driver_user_id || 0) === Number(req.user.id)
        if (!isOwner && !isAdminOrWarehouse(req.user)) {
          const err = new Error('No autorizado')
          err.statusCode = 403
          throw err
        }
        if (!isOwner) assertShipmentWarehouseAccess(req.user, shipment)

        const [itemsRows] = await conn.query('SELECT * FROM shipment_items WHERE shipment_id = ? ORDER BY id ASC', [shipmentId])
        const itemsById = new Map(itemsRows.map(r => [Number(r.id), r]))
        const updates = []
        for (const it of parsedItems) {
          const id = Number(it.itemId || it.id || 0)
          if (!id) continue
          if (!itemsById.has(id)) continue
          const received = Math.max(0, normalizeNumber(it.qtyReceived, normalizeNumber(it.qty_received, 0)))
          const damaged = Math.max(0, normalizeNumber(it.qtyDamaged, normalizeNumber(it.qty_damaged, 0)))
          updates.push({ id, received, damaged })
        }

        const issueItems = []
        for (const row of itemsRows) {
          const upd = updates.find(u => u.id === Number(row.id))
          const expected = normalizeNumber(row.qty_dispatched, normalizeNumber(row.qty_planned, 0))
          const received = upd ? upd.received : normalizeNumber(row.qty_received, 0)
          const damaged = upd ? upd.damaged : normalizeNumber(row.qty_damaged, 0)
          const missing = Math.max(0, Math.round((expected - received) * 100) / 100)
          const nextMissing = Math.max(0, Math.round((missing) * 100) / 100)
          const nextDamaged = Math.max(0, Math.round((damaged) * 100) / 100)

          await conn.query(
            'UPDATE shipment_items SET qty_received = ?, qty_missing = ?, qty_damaged = ? WHERE id = ?',
            [received, nextMissing, nextDamaged, row.id]
          )

          if (nextMissing >= 0.01 || nextDamaged >= 0.01) {
            issueItems.push({
              product_id: row.product_id,
              qty_missing: nextMissing,
              qty_damaged: nextDamaged,
            })
          }
        }

        const hasIssues = issueItems.length > 0
        const finalStatus = normalizedAction === 'DELIVER'
          ? (hasIssues ? 'DELIVERED_WITH_ISSUES' : 'DELIVERED')
          : (hasIssues ? 'RECEIVED_WITH_ISSUES' : 'RECEIVED')

        const eventType = normalizedAction === 'DELIVER' ? 'DELIVERED' : 'RECEIVED'
        const [evRes] = await conn.query(
          `
          INSERT INTO shipment_events (
            shipment_id, event_type, notes, receiver_name, receiver_dpi, created_by_user_id, created_at
          )
          VALUES (?, ?, ?, ?, ?, ?, NOW())
          `,
          [shipmentId, eventType, notes ? String(notes) : null, String(receiverName), String(receiverDpi), req.user.id]
        )
        const eventId = evRes.insertId

        for (const url of photos) {
          await conn.query(
            'INSERT INTO shipment_event_media (event_id, media_type, url, captured_at, created_at) VALUES (?, ?, ?, NOW(), NOW())',
            [eventId, 'PHOTO', url]
          )
        }
        await conn.query(
          'INSERT INTO shipment_event_media (event_id, media_type, url, captured_at, created_at) VALUES (?, ?, ?, NOW(), NOW())',
          [eventId, 'SIGNATURE', signatureUrl]
        )

        let issueId = null
        if (hasIssues) {
          const [issRes] = await conn.query(
            'INSERT INTO shipment_issues (shipment_id, status, reason, created_at) VALUES (?, ?, ?, NOW())',
            [shipmentId, 'OPEN', 'Faltantes/daños reportados']
          )
          issueId = issRes.insertId
          for (const it of issueItems) {
            await conn.query(
              'INSERT INTO shipment_issue_items (issue_id, product_id, qty_missing, qty_damaged, created_at) VALUES (?, ?, ?, ?, NOW())',
              [issueId, it.product_id, it.qty_missing, it.qty_damaged]
            )
          }
        }

        await conn.query('UPDATE shipments SET status = ?, updated_at = NOW() WHERE id = ?', [finalStatus, shipmentId])
        await conn.commit()
        res.json({ success: true, eventId, issueId, status: finalStatus })
      } catch (err) {
        await conn.rollback()
        res.status(err.statusCode || 400).json({ error: err.message || 'Error finalizando envío' })
      } finally {
        conn.release()
      }
    } catch (err) {
      console.error('Complete shipment error:', err)
      res.status(500).json({ error: 'Server error' })
    }
  }
)

export default router
