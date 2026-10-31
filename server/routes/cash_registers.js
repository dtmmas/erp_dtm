import express from 'express'
import { authMiddleware, hasUserPermission, isAdminUser } from '../auth.js'
import { getPool } from '../db.js'

const router = express.Router()
const schemaCache = new Map()

async function getOpenShift(pool) {
  const [rows] = await pool.query(
    'SELECT * FROM cashbox_shifts WHERE closed_at IS NULL ORDER BY id DESC LIMIT 1'
  )
  return rows[0]
}

async function getOpenShiftForUser(pool, userId) {
  const [rows] = await pool.query(
    'SELECT * FROM cashbox_shifts WHERE opened_by = ? AND closed_at IS NULL ORDER BY id DESC LIMIT 1',
    [userId]
  )
  return rows[0]
}

function resolveTargetUserId(req) {
  const requested = Number(req.query.userId || 0)
  if (req.user.role === 'ADMIN' && requested > 0) return requested
  return req.user.id
}

function canAccessCashModule(user) {
  return isAdminUser(user)
    || hasUserPermission(user, 'cash:view')
    || hasUserPermission(user, 'cash:open')
    || hasUserPermission(user, 'cash:movements')
    || hasUserPermission(user, 'cash:close')
}

async function columnExists(pool, table, column) {
  const cacheKey = `${table}.${column}`
  if (schemaCache.has(cacheKey)) return schemaCache.get(cacheKey)

  const [rows] = await pool.query(
    `SELECT COUNT(*) AS c
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = ?
       AND COLUMN_NAME = ?`,
    [table, column]
  )

  const exists = Number(rows?.[0]?.c || 0) > 0
  schemaCache.set(cacheKey, exists)
  return exists
}

async function ensureSalesPaymentSchema(pool) {
  if (!(await columnExists(pool, 'sales', 'status'))) {
    await pool.query(`ALTER TABLE sales ADD COLUMN status VARCHAR(20) DEFAULT 'COMPLETED'`)
  }
  if (!(await columnExists(pool, 'sales', 'paid_by_user_id'))) {
    await pool.query('ALTER TABLE sales ADD COLUMN paid_by_user_id INT NULL')
  }
  if (!(await columnExists(pool, 'sales', 'paid_at'))) {
    await pool.query('ALTER TABLE sales ADD COLUMN paid_at DATETIME NULL')
  }
}

async function getCreditPaymentsByMethod(pool, { shiftId, userId, startAt, endAt = null }) {
  const hasPaymentUserId = await columnExists(pool, 'credit_payments', 'user_id')

  if (!hasPaymentUserId) {
    const [rows] = await pool.query(
      `
        SELECT 'CASH' AS payment_method, COALESCE(SUM(amount), 0) AS total_amount
        FROM cash_movements
        WHERE shift_id = ?
          AND ref_type = 'CREDIT_PAYMENT'
          AND type = 'IN'
      `,
      [shiftId]
    )
    return rows || []
  }

  const where = ['cp.user_id = ?', 'cp.paid_at >= ?']
  const params = [userId, startAt]
  if (endAt) {
    where.push('cp.paid_at <= ?')
    params.push(endAt)
  }

  const [rows] = await pool.query(
    `
      SELECT
        COALESCE(cp.payment_method, 'CASH') AS payment_method,
        COALESCE(SUM(cp.amount), 0) AS total_amount
      FROM credit_payments cp
      WHERE ${where.join(' AND ')}
      GROUP BY COALESCE(cp.payment_method, 'CASH')
    `,
    params
  )

  return rows || []
}

async function getClosedShifts(pool, { start, end, limit }) {
  const where = ['s.closed_at IS NOT NULL']
  const params = []

  if (start) {
    where.push('s.closed_at >= ?')
    params.push(`${String(start).slice(0, 10)} 00:00:00`)
  }
  if (end) {
    where.push('s.closed_at <= ?')
    params.push(`${String(end).slice(0, 10)} 23:59:59`)
  }

  const [rows] = await pool.query(
    `
      SELECT
        s.id,
        s.opened_by,
        u1.name AS opened_by_name,
        s.closed_by,
        u2.name AS closed_by_name,
        s.opening_balance,
        s.closing_balance,
        s.opened_at,
        s.closed_at,
        (
          SELECT COALESCE(SUM(amount), 0)
          FROM cash_movements m
          WHERE m.shift_id = s.id
            AND m.ref_type = 'SALE'
            AND m.type = 'IN'
        ) AS sales_cash,
        (
          SELECT COALESCE(SUM(amount), 0)
          FROM cash_movements m
          WHERE m.shift_id = s.id
            AND m.ref_type = 'MANUAL'
            AND m.type = 'IN'
        ) AS movements_in,
        (
          SELECT COALESCE(SUM(amount), 0)
          FROM cash_movements m
          WHERE m.shift_id = s.id
            AND m.ref_type = 'MANUAL'
            AND m.type = 'OUT'
        ) AS movements_out
      FROM cashbox_shifts s
      LEFT JOIN users u1 ON u1.id = s.opened_by
      LEFT JOIN users u2 ON u2.id = s.closed_by
      WHERE ${where.join(' AND ')}
      ORDER BY s.closed_at DESC
      LIMIT ?
    `,
    [...params, Math.max(1, Number(limit || 200))]
  )

  const items = []
  for (const r of rows || []) {
    const creditPaymentRows = await getCreditPaymentsByMethod(pool, {
      shiftId: r.id,
      userId: r.opened_by,
      startAt: r.opened_at,
      endAt: r.closed_at,
    })
    const creditPaymentsByMethod = Object.fromEntries(
      (creditPaymentRows || []).map(row => [row.payment_method || 'CASH', Number(row.total_amount || 0)])
    )
    const creditPaymentsCash = Number(creditPaymentsByMethod.CASH || 0)
    const opening = Number(r.opening_balance || 0)
    const closing = Number(r.closing_balance || 0)
    const salesCash = Number(r.sales_cash || 0)
    const movementsIn = Number(r.movements_in || 0)
    const movementsOut = Number(r.movements_out || 0)
    const expected = opening + salesCash + creditPaymentsCash + movementsIn - movementsOut
    const difference = closing - expected
    items.push({
      id: r.id,
      openedBy: r.opened_by,
      openedByName: r.opened_by_name || '',
      closedBy: r.closed_by,
      closedByName: r.closed_by_name || '',
      openingBalance: opening,
      closingBalance: closing,
      openedAt: r.opened_at,
      closedAt: r.closed_at,
      salesCash,
      creditPaymentsByMethod,
      creditPaymentsCash,
      movementsIn,
      movementsOut,
      expected,
      difference,
    })
  }

  return items
}

async function getClosedShiftDetail(pool, shiftId) {
  await ensureSalesPaymentSchema(pool)
  const [rows] = await pool.query(
    `
      SELECT
        s.id,
        s.opened_by,
        u1.name AS opened_by_name,
        s.closed_by,
        u2.name AS closed_by_name,
        s.opening_balance,
        s.closing_balance,
        s.opened_at,
        s.closed_at
      FROM cashbox_shifts s
      LEFT JOIN users u1 ON u1.id = s.opened_by
      LEFT JOIN users u2 ON u2.id = s.closed_by
      WHERE s.id = ? AND s.closed_at IS NOT NULL
      LIMIT 1
    `,
    [shiftId]
  )

  const shift = rows?.[0]
  if (!shift) return null

  const [salesStats] = await pool.query(
    `
      SELECT
        payment_method,
        COALESCE(SUM(total), 0) AS total_sales
      FROM sales
      WHERE COALESCE(status, 'COMPLETED') = 'COMPLETED'
        AND (
          (
            paid_by_user_id = ?
            AND paid_at IS NOT NULL
            AND paid_at >= ?
            AND paid_at <= ?
          )
          OR (
            paid_by_user_id IS NULL
            AND user_id = ?
            AND created_at >= ?
            AND created_at <= ?
          )
        )
      GROUP BY payment_method
    `,
    [shift.opened_by, shift.opened_at, shift.closed_at, shift.opened_by, shift.opened_at, shift.closed_at]
  )

  const [movements] = await pool.query(
    `
      SELECT id, type, amount, concept AS description, ref_type, ref_id, created_at
      FROM cash_movements
      WHERE shift_id = ?
      ORDER BY created_at DESC, id DESC
    `,
    [shift.id]
  )

  const creditPaymentRows = await getCreditPaymentsByMethod(pool, {
    shiftId: shift.id,
    userId: shift.opened_by,
    startAt: shift.opened_at,
    endAt: shift.closed_at,
  })

  const [salesCashRows] = await pool.query(
    `SELECT COALESCE(SUM(amount), 0) AS total
     FROM cash_movements
     WHERE shift_id = ? AND ref_type = 'SALE' AND type = 'IN'`,
    [shift.id]
  )

  let movementsIn = 0
  let movementsOut = 0
  for (const row of movements || []) {
    if (row.ref_type === 'MANUAL' && row.type === 'IN') {
      movementsIn += Number(row.amount || 0)
    }
    if (row.ref_type === 'MANUAL' && row.type === 'OUT') {
      movementsOut += Number(row.amount || 0)
    }
  }

  const salesByMethod = {}
  let totalSales = 0
  for (const row of salesStats || []) {
    salesByMethod[row.payment_method] = Number(row.total_sales || 0)
    totalSales += Number(row.total_sales || 0)
  }

  const creditPaymentsByMethod = Object.fromEntries(
    (creditPaymentRows || []).map(row => [row.payment_method || 'CASH', Number(row.total_amount || 0)])
  )
  const creditPaymentsCash = Number(creditPaymentsByMethod.CASH || 0)

  const openingBalance = Number(shift.opening_balance || 0)
  const closingBalance = Number(shift.closing_balance || 0)
  const salesCash = Number(salesCashRows?.[0]?.total || 0)
  const expected = openingBalance + salesCash + creditPaymentsCash + movementsIn - movementsOut
  const difference = closingBalance - expected

  return {
    id: shift.id,
    openedBy: shift.opened_by,
    openedByName: shift.opened_by_name || '',
    closedBy: shift.closed_by,
    closedByName: shift.closed_by_name || '',
    openingBalance,
    closingBalance,
    openedAt: shift.opened_at,
    closedAt: shift.closed_at,
    salesByMethod,
    totalSales,
    salesCash,
    creditPaymentsByMethod,
    creditPaymentsCash,
    movementsIn,
    movementsOut,
    expected,
    difference,
    movements: (movements || []).map((row) => ({
      id: row.id,
      type: row.type,
      amount: Number(row.amount || 0),
      description: row.description || '',
      refType: row.ref_type || '',
      refId: row.ref_id ?? null,
      createdAt: row.created_at,
    })),
  }
}

// 1. Get Status (Is Open?)
router.get('/status', authMiddleware, async (req, res) => {
  try {
    if (!canAccessCashModule(req.user)) {
      return res.status(403).json({ error: 'No tienes permisos para ver caja' })
    }
    const pool = await getPool()
    const targetUserId = resolveTargetUserId(req)
    const shift = await getOpenShiftForUser(pool, targetUserId)
    
    if (!shift) {
      return res.json({ isOpen: false, userId: targetUserId })
    }

    return res.json({ 
      isOpen: true, 
      userId: targetUserId,
      registerId: shift.id,
      openingTime: shift.opened_at,
      openingAmount: Number(shift.opening_balance || 0)
    })
  } catch (err) {
    console.error('Cash Status Error:', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// 2. Open Register
router.post('/open', authMiddleware, async (req, res) => {
  try {
    if (!hasUserPermission(req.user, 'cash:open')) {
      return res.status(403).json({ error: 'No tienes permisos para abrir caja' })
    }

    const { openingAmount, notes } = req.body
    const amount = Number(openingAmount)
    
    if (isNaN(amount) || amount < 0) {
      return res.status(400).json({ error: 'Monto inicial inválido' })
    }

    const pool = await getPool()
    const existing = await getOpenShiftForUser(pool, req.user.id)
    
    if (existing) {
      return res.status(400).json({ error: 'Ya tienes una caja abierta' })
    }

    const [result] = await pool.query(
      'INSERT INTO cashbox_shifts (opened_by, opening_balance) VALUES (?, ?)',
      [req.user.id, amount]
    )

    res.json({ success: true, registerId: result.insertId })
  } catch (err) {
    console.error('Cash Open Error:', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// 3. Get Summary (Calculated Totals)
router.get('/summary', authMiddleware, async (req, res) => {
  try {
    if (!canAccessCashModule(req.user)) {
      return res.status(403).json({ error: 'No tienes permisos para ver caja' })
    }
    const pool = await getPool()
    await ensureSalesPaymentSchema(pool)
    const targetUserId = resolveTargetUserId(req)
    const shift = await getOpenShiftForUser(pool, targetUserId)
    
    if (!shift) {
      return res.status(404).json({ error: 'No hay caja abierta' })
    }

    const [salesStats] = await pool.query(`
      SELECT 
        payment_method, 
        SUM(total) as total_sales,
        SUM(CASE WHEN payment_method = 'CASH' THEN received_amount - change_amount ELSE 0 END) as cash_in_hand
      FROM sales 
      WHERE COALESCE(status, 'COMPLETED') = 'COMPLETED'
        AND (
          (
            paid_by_user_id = ?
            AND paid_at IS NOT NULL
            AND paid_at >= ?
          )
          OR (
            paid_by_user_id IS NULL
            AND user_id = ?
            AND created_at >= ?
          )
        )
      GROUP BY payment_method
    `, [targetUserId, shift.opened_at, targetUserId, shift.opened_at])

    const creditPaymentRows = await getCreditPaymentsByMethod(pool, {
      shiftId: shift.id,
      userId: targetUserId,
      startAt: shift.opened_at,
    })

    const [movements] = await pool.query(`
      SELECT type, SUM(amount) as total 
      FROM cash_movements 
      WHERE shift_id = ?
        AND ref_type = 'MANUAL'
      GROUP BY type
    `, [shift.id])

    const [salesCashRows] = await pool.query(
      `SELECT COALESCE(SUM(amount), 0) AS total
       FROM cash_movements
       WHERE shift_id = ? AND ref_type = 'SALE' AND type = 'IN'`,
      [shift.id]
    )

    const salesByMethod = {}
    let totalSales = 0
    let salesCashReal = Number(salesCashRows?.[0]?.total || 0)

    if (Array.isArray(salesStats)) {
      salesStats.forEach(row => {
        salesByMethod[row.payment_method] = Number(row.total_sales)
        totalSales += Number(row.total_sales)
      })
    }

    const creditPaymentsByMethod = Object.fromEntries(
      (creditPaymentRows || []).map(row => [row.payment_method || 'CASH', Number(row.total_amount || 0)])
    )
    const creditPaymentsCash = Number(creditPaymentsByMethod.CASH || 0)

    let movementsIn = 0
    let movementsOut = 0

    if (Array.isArray(movements)) {
      movements.forEach(row => {
        if (row.type === 'IN') movementsIn = Number(row.total)
        if (row.type === 'OUT') movementsOut = Number(row.total)
      })
    }

    const openingAmount = Number(shift.opening_balance || 0)
    const expectedCash = openingAmount + salesCashReal + creditPaymentsCash + movementsIn - movementsOut

    res.json({
      userId: targetUserId,
      registerId: shift.id,
      openingTime: shift.opened_at,
      openingAmount,
      salesByMethod,
      totalSales,
      salesCash: salesCashReal,
      creditPaymentsByMethod,
      creditPaymentsCash,
      movementsIn,
      movementsOut,
      expectedCash
    })

  } catch (err) {
    console.error('Cash Summary Error:', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// 4. Add Movement
router.post('/movements', authMiddleware, async (req, res) => {
  try {
    if (!hasUserPermission(req.user, 'cash:movements')) {
      return res.status(403).json({ error: 'No tienes permisos para registrar movimientos de caja' })
    }

    const { type, amount, description } = req.body
    
    if (!['IN', 'OUT'].includes(type)) return res.status(400).json({ error: 'Tipo inválido' })
    if (!amount || Number(amount) <= 0) return res.status(400).json({ error: 'Monto inválido' })

    const pool = await getPool()
    const shift = await getOpenShiftForUser(pool, req.user.id)
    
    if (!shift) {
      return res.status(400).json({ error: 'No hay caja abierta' })
    }

    await pool.query(
      'INSERT INTO cash_movements (shift_id, type, amount, concept, ref_type) VALUES (?, ?, ?, ?, "MANUAL")',
      [shift.id, type, amount, description || '']
    )

    res.json({ success: true })
  } catch (err) {
    console.error('Cash Movement Error:', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// 5. Get Movements List
router.get('/movements', authMiddleware, async (req, res) => {
  try {
    if (!canAccessCashModule(req.user)) {
      return res.status(403).json({ error: 'No tienes permisos para ver movimientos de caja' })
    }
    const pool = await getPool()
    const targetUserId = resolveTargetUserId(req)
    const shift = await getOpenShiftForUser(pool, targetUserId)
    
    if (!shift) {
      return res.json([])
    }

    const [rows] = await pool.query(
      'SELECT id, type, amount, concept as description, created_at FROM cash_movements WHERE shift_id = ? ORDER BY created_at DESC',
      [shift.id]
    )
    
    res.json(rows)
  } catch (err) {
    console.error('Cash Movements List Error:', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// 6. Close Register
router.post('/close', authMiddleware, async (req, res) => {
  try {
    if (!hasUserPermission(req.user, 'cash:close')) {
      return res.status(403).json({ error: 'No tienes permisos para cerrar caja' })
    }

    const { closingAmount, notes } = req.body
    const finalAmount = Number(closingAmount)

    if (isNaN(finalAmount) || finalAmount < 0) {
      return res.status(400).json({ error: 'Monto de cierre inválido' })
    }

    const pool = await getPool()
    await ensureSalesPaymentSchema(pool)
    const shift = await getOpenShiftForUser(pool, req.user.id)
    
    if (!shift) {
      return res.status(400).json({ error: 'No hay caja abierta' })
    }

    const [salesStats] = await pool.query(`
      SELECT payment_method, SUM(total) as total_sales
      FROM sales 
      WHERE COALESCE(status, 'COMPLETED') = 'COMPLETED'
        AND (
          (
            paid_by_user_id = ?
            AND paid_at IS NOT NULL
            AND paid_at >= ?
          )
          OR (
            paid_by_user_id IS NULL
            AND user_id = ?
            AND created_at >= ?
          )
        )
      GROUP BY payment_method
    `, [req.user.id, shift.opened_at, req.user.id, shift.opened_at])

    const creditPaymentRows = await getCreditPaymentsByMethod(pool, {
      shiftId: shift.id,
      userId: req.user.id,
      startAt: shift.opened_at,
    })

    const [movements] = await pool.query(`
      SELECT type, SUM(amount) as total 
      FROM cash_movements 
      WHERE shift_id = ?
        AND ref_type = 'MANUAL'
      GROUP BY type
    `, [shift.id])

    const [salesCashRows] = await pool.query(
      `SELECT COALESCE(SUM(amount), 0) AS total
       FROM cash_movements
       WHERE shift_id = ? AND ref_type = 'SALE' AND type = 'IN'`,
      [shift.id]
    )

    const salesCash = Number(salesCashRows?.[0]?.total || 0)
    const creditPaymentsByMethod = Object.fromEntries(
      (creditPaymentRows || []).map(row => [row.payment_method || 'CASH', Number(row.total_amount || 0)])
    )
    const creditPaymentsCash = Number(creditPaymentsByMethod.CASH || 0)

    let movementsIn = 0
    let movementsOut = 0
    movements.forEach(row => {
      if (row.type === 'IN') movementsIn = Number(row.total)
      if (row.type === 'OUT') movementsOut = Number(row.total)
    })

    const expected = Number(shift.opening_balance || 0) + salesCash + creditPaymentsCash + movementsIn - movementsOut

    await pool.query(
      `UPDATE cashbox_shifts 
       SET closing_balance = ?, closed_at = NOW(), closed_by = ?
       WHERE id = ?`,
      [finalAmount, req.user.id, shift.id]
    )

    res.json({ 
      success: true, 
      expected, 
      difference: finalAmount - expected,
      creditPaymentsByMethod,
      creditPaymentsCash,
    })
  } catch (err) {
    console.error('Cash Close Error:', err)
    res.status(500).json({ error: 'Server error' })
  }
})

router.get('/history/shifts', authMiddleware, async (req, res) => {
  try {
    if (!canAccessCashModule(req.user)) {
      return res.status(403).json({ error: 'No tienes permisos para ver cierres de caja' })
    }
    const pool = await getPool()
    const start = (req.query.start || '').toString().slice(0, 10)
    const end = (req.query.end || '').toString().slice(0, 10)
    const limit = Number(req.query.limit || 200)
    const all = await getClosedShifts(pool, { start: start || null, end: end || null, limit })
    const items = req.user.role === 'ADMIN' ? all : all.filter(s => s.openedBy === req.user.id)
    res.json({ items })
  } catch (err) {
    console.error('Cash history shifts error:', err)
    res.status(500).json({ error: 'Server error' })
  }
})

router.get('/history/shifts/:id', authMiddleware, async (req, res) => {
  try {
    if (!canAccessCashModule(req.user)) {
      return res.status(403).json({ error: 'No tienes permisos para ver cierres de caja' })
    }
    const pool = await getPool()
    const shiftId = Number(req.params.id || 0)
    if (!shiftId) {
      return res.status(400).json({ error: 'ID de cierre inválido' })
    }

    const detail = await getClosedShiftDetail(pool, shiftId)
    if (!detail) {
      return res.status(404).json({ error: 'Cierre no encontrado' })
    }

    if (req.user.role !== 'ADMIN' && detail.openedBy !== req.user.id) {
      return res.status(403).json({ error: 'No tienes acceso a este cierre' })
    }

    res.json(detail)
  } catch (err) {
    console.error('Cash history shift detail error:', err)
    res.status(500).json({ error: 'Server error' })
  }
})

router.get('/history/summary', authMiddleware, async (req, res) => {
  try {
    const pool = await getPool()
    const start = (req.query.start || '').toString().slice(0, 10)
    const end = (req.query.end || '').toString().slice(0, 10)
    const period = (req.query.period || 'day').toString()

    const all = await getClosedShifts(pool, { start: start || null, end: end || null, limit: 5000 })
    const items = req.user.role === 'ADMIN' ? all : all.filter(s => s.openedBy === req.user.id)

    const keyOf = (d) => {
      const iso = new Date(d).toISOString()
      if (period === 'year') return iso.slice(0, 4)
      if (period === 'month') return iso.slice(0, 7)
      return iso.slice(0, 10)
    }

    const map = new Map()
    for (const s of items) {
      const k = keyOf(s.closedAt)
      const prev = map.get(k) || { period: k, shifts: 0, opening: 0, closing: 0, expected: 0, difference: 0, salesCash: 0, creditPaymentsCash: 0, movementsIn: 0, movementsOut: 0 }
      prev.shifts += 1
      prev.opening += s.openingBalance
      prev.closing += s.closingBalance
      prev.expected += s.expected
      prev.difference += s.difference
      prev.salesCash += s.salesCash
      prev.creditPaymentsCash += Number(s.creditPaymentsCash || 0)
      prev.movementsIn += s.movementsIn
      prev.movementsOut += s.movementsOut
      map.set(k, prev)
    }

    const summary = Array.from(map.values()).sort((a, b) => (a.period < b.period ? 1 : -1))
    res.json({ period, summary })
  } catch (err) {
    console.error('Cash history summary error:', err)
    res.status(500).json({ error: 'Server error' })
  }
})

export default router
