import express from 'express'
import multer from 'multer'
import path from 'path'
import { authMiddleware, hasUserPermission } from '../auth.js'
import { getPool } from '../db.js'
import { uploadsDir } from '../paths.js'

const router = express.Router()
const schemaCache = new Map()

function normalizeDocumentUrl(value) {
  if (!value || typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null

  if (trimmed.startsWith('/uploads/')) return trimmed
  if (trimmed.startsWith('uploads/')) return `/${trimmed}`

  try {
    const parsed = new URL(trimmed)
    if (parsed.pathname.startsWith('/uploads/')) {
      return `${parsed.pathname}${parsed.search || ''}${parsed.hash || ''}`
    }
  } catch {
    if (trimmed.includes('/uploads/')) {
      return trimmed.slice(trimmed.indexOf('/uploads/'))
    }
  }

  return trimmed
}

async function getExistingColumns(pool, table, columns) {
  const cacheKey = `${table}:${columns.sort().join(',')}`
  const cached = schemaCache.get(cacheKey)
  if (cached) return cached

  const placeholders = columns.map(() => '?').join(', ')
  const [rows] = await pool.query(
    `SELECT COLUMN_NAME
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = ?
       AND COLUMN_NAME IN (${placeholders})`,
    [table, ...columns]
  )

  const existing = new Set(rows.map(row => row.COLUMN_NAME))
  schemaCache.set(cacheKey, existing)
  return existing
}

async function getCreditPaymentsSchema(pool) {
  return getExistingColumns(pool, 'credit_payments', [
    'payment_type',
    'payment_method',
    'reference',
    'document_url',
    'received_by',
    'paid_at',
    'user_id',
  ])
}

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadsDir)
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9)
    const ext = path.extname(file.originalname)
    cb(null, file.fieldname + '-' + uniqueSuffix + ext)
  }
})

const upload = multer({ storage: storage })

function canManageCredits(user) {
  return hasUserPermission(user, 'credits:write')
}

function canViewCreditReports(user) {
  return hasUserPermission(user, 'credits:read')
}

function diffDays(a, b) {
  const ms = 24 * 60 * 60 * 1000
  const start = new Date(a)
  const end = new Date(b)
  start.setHours(12, 0, 0, 0)
  end.setHours(12, 0, 0, 0)
  return Math.floor((end.getTime() - start.getTime()) / ms)
}

function computePenalty(dueDate, asOfDate, options = {}) {
  const daily = Number(options.daily || 25)
  const graceDays = Number(options.graceDays || 5)
  const daysLate = diffDays(dueDate, asOfDate) - graceDays
  if (daysLate <= 0) return 0
  return Math.max(0, Math.round(daysLate * daily * 100) / 100)
}

// Listar créditos pendientes
router.get('/', authMiddleware, async (req, res) => {
  try {
    if (!canManageCredits(req.user) && !canViewCreditReports(req.user)) {
      return res.status(403).json({ error: 'No tienes permisos para consultar créditos' })
    }
    const search = (req.query.search || '').toString().trim()
    const status = (req.query.status || '').toString().trim() // 'PENDING', 'PAID'
    const startDate = (req.query.startDate || '').toString().trim()
    const endDate = (req.query.endDate || '').toString().trim()
    
    const pool = await getPool()
    const salesColumns = await getExistingColumns(pool, 'sales', ['status'])
    const installmentsColumns = await getExistingColumns(pool, 'installments', ['penalty_waived'])
    const paymentColumns = await getCreditPaymentsSchema(pool)
    const salesStatusFilter = salesColumns.has('status')
      ? `COALESCE(s.status, 'COMPLETED') != 'CANCELLED'`
      : '1 = 1'
    const principalPaidExpr = paymentColumns.has('payment_type')
      ? `(SELECT COALESCE(SUM(cp.amount), 0) FROM credit_payments cp WHERE cp.installment_id = i.id AND (cp.payment_type IS NULL OR cp.payment_type IN ('INSTALLMENT','DOWN_PAYMENT')))`
      : `(SELECT COALESCE(SUM(amount), 0) FROM credit_payments cp WHERE cp.installment_id = i.id)`
    const penaltyPaidExpr = paymentColumns.has('payment_type')
      ? `(SELECT COALESCE(SUM(cp.amount), 0) FROM credit_payments cp WHERE cp.installment_id = i.id AND cp.payment_type = 'PENALTY')`
      : '0'
    const penaltyAccruedExpr = `
      CASE
        WHEN i.paid = 1 THEN 0
        WHEN CURDATE() <= DATE_ADD(i.due_date, INTERVAL 5 DAY) THEN 0
        ${installmentsColumns.has('penalty_waived') ? `WHEN COALESCE(i.penalty_waived, 0) = 1 THEN 0` : ''}
        ELSE GREATEST(0, (DATEDIFF(CURDATE(), i.due_date) - 5) * 25)
      END
    `
    
    let query = `
      SELECT 
        i.id, 
        i.sale_id, 
        i.due_date, 
        i.amount as total_amount, 
        i.paid,
        s.doc_no, 
        s.total AS sale_total,
        s.created_at as sale_date,
        c.name as customer_name,
        (
          SELECT COUNT(*)
          FROM installments i2
          WHERE i2.sale_id = i.sale_id
        ) AS installments_count,
        (
          SELECT COUNT(*)
          FROM installments i2
          WHERE i2.sale_id = i.sale_id
            AND i2.id <= i.id
        ) AS installment_number,
        ${principalPaidExpr} as paid_amount,
        ${penaltyPaidExpr} as penalty_paid_amount,
        ${penaltyAccruedExpr} as penalty_accrued,
        GREATEST(0, (${penaltyAccruedExpr}) - (${penaltyPaidExpr})) as penalty_due
        ${installmentsColumns.has('penalty_waived') ? ', COALESCE(i.penalty_waived, 0) as penalty_waived' : ''}
      FROM installments i 
      JOIN sales s ON i.sale_id = s.id 
      LEFT JOIN customers c ON s.customer_id = c.id 
      WHERE ${salesStatusFilter}
    `
    
    const params = []

    if (search) {
      query += ` AND (c.name LIKE ? OR s.doc_no LIKE ? OR s.id = ?)`
      params.push(`%${search}%`, `%${search}%`, search)
    }

    if (status === 'PENDING' || status === 'PENDIENTE') {
      query += ` AND i.paid = 0`
    } else if (status === 'PAID' || status === 'PAGADO' || status === 'PAGADOS') {
      query += ` AND i.paid = 1`
    }

    if (startDate) {
      query += ` AND DATE(s.created_at) >= ?`
      params.push(startDate)
    }

    if (endDate) {
      query += ` AND DATE(s.created_at) <= ?`
      params.push(endDate)
    }

    query += ` ORDER BY i.paid ASC, i.due_date ASC`

    const [rows] = await pool.query(query, params)
    res.json(rows)
  } catch (err) {
    console.error('Credits list error:', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// Listar historial de pagos por venta (todas las cuotas)
router.get('/sale/:saleId/payments', authMiddleware, async (req, res) => {
  try {
    if (!canManageCredits(req.user)) {
      return res.status(403).json({ error: 'No tienes permisos para gestionar créditos' })
    }

    const saleId = Number(req.params.saleId || 0)
    if (!saleId) {
      return res.status(400).json({ error: 'Venta inválida' })
    }

    const pool = await getPool()
    const columns = await getCreditPaymentsSchema(pool)

    const [rows] = await pool.query(
      `SELECT 
         cp.id,
         cp.amount,
         ${columns.has('payment_type') ? `COALESCE(cp.payment_type, 'INSTALLMENT')` : `'INSTALLMENT'`} as payment_type,
         ${columns.has('payment_method') ? `COALESCE(cp.payment_method, 'CASH')` : `'CASH'`} as payment_method,
         ${columns.has('reference') ? 'cp.reference' : 'NULL'} as reference,
         ${columns.has('paid_at') ? 'cp.paid_at' : 'CURRENT_TIMESTAMP'} as created_at,
         ${columns.has('received_by') ? 'cp.received_by' : 'NULL'} as received_by,
         ${columns.has('document_url') ? 'cp.document_url' : 'NULL'} as document_url,
         i.id as installment_id,
         i.due_date as installment_due_date,
         i.amount as installment_amount,
         i.installment_number
       FROM credit_payments cp
       JOIN (
         SELECT
           i.*,
           ROW_NUMBER() OVER (PARTITION BY i.sale_id ORDER BY i.due_date ASC, i.id ASC) as installment_number
         FROM installments i
       ) i ON i.id = cp.installment_id
       WHERE i.sale_id = ?
       ORDER BY ${columns.has('paid_at') ? 'cp.paid_at' : 'cp.id'} DESC, cp.id DESC`,
      [saleId]
    )

    return res.json(rows.map(row => ({
      ...row,
      document_url: normalizeDocumentUrl(row.document_url),
    })))
  } catch (err) {
    console.error('Payments history by sale error:', err)
    return res.status(500).json({ error: 'Server error' })
  }
})

// Listar historial de pagos de un crédito
router.get('/:id/payments', authMiddleware, async (req, res) => {
  try {
    if (!canManageCredits(req.user)) {
      return res.status(403).json({ error: 'No tienes permisos para gestionar créditos' })
    }
    const installmentId = req.params.id
    const pool = await getPool()
    const columns = await getCreditPaymentsSchema(pool)
    
    const [rows] = await pool.query(
      `SELECT 
         id,
         amount,
         ${columns.has('payment_type') ? `COALESCE(payment_type, 'INSTALLMENT')` : `'INSTALLMENT'`} as payment_type,
         ${columns.has('payment_method') ? `COALESCE(payment_method, 'CASH')` : `'CASH'`} as payment_method,
         ${columns.has('reference') ? 'reference' : 'NULL'} as reference,
         ${columns.has('paid_at') ? 'paid_at' : 'CURRENT_TIMESTAMP'} as created_at,
         ${columns.has('received_by') ? 'received_by' : 'NULL'} as received_by,
         ${columns.has('document_url') ? 'document_url' : 'NULL'} as document_url
       FROM credit_payments 
       WHERE installment_id = ? 
       ORDER BY ${columns.has('paid_at') ? 'paid_at' : 'id'} DESC, id DESC`,
      [installmentId]
    )
    
    res.json(rows.map(row => ({
      ...row,
      document_url: normalizeDocumentUrl(row.document_url),
    })))
  } catch (err) {
    console.error('Payments history error:', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// Registrar pago
router.post('/pay', authMiddleware, upload.single('document'), async (req, res) => {
  try {
    if (!canManageCredits(req.user)) {
      return res.status(403).json({ error: 'No tienes permisos para gestionar créditos' })
    }
    const { installmentId, amount, paymentMethod, reference, responsible, paymentDate, waivePenalty } = req.body
    const documentUrl = req.file ? `/uploads/${req.file.filename}` : null
    
    if (!installmentId || !amount || Number(amount) <= 0) {
      return res.status(400).json({ error: 'Datos inválidos' })
    }

    if ((paymentMethod === 'CARD' || paymentMethod === 'DEPOSIT') && !reference) {
      return res.status(400).json({ error: 'Referencia requerida para Tarjeta/Depósito' })
    }

    // Determinar fecha de pago
    let finalPaymentDate = new Date()
    if (paymentMethod !== 'CASH' && paymentDate) {
      finalPaymentDate = new Date(paymentDate)
    }

    const pool = await getPool()
    const paymentColumns = await getCreditPaymentsSchema(pool)
    const conn = await pool.getConnection()

    try {
      await conn.beginTransaction()
      const installmentsColumns = await getExistingColumns(conn, 'installments', ['penalty_waived', 'penalty_waived_at', 'penalty_waived_by_user_id'])

      // 1. Verificar deuda actual
      const [rows] = await conn.query(
        `SELECT 
          i.id, i.amount, i.paid, i.sale_id, i.due_date
          ${installmentsColumns.has('penalty_waived') ? ', COALESCE(i.penalty_waived, 0) as penalty_waived' : ''},
          COALESCE(s.status, 'COMPLETED') as sale_status,
          ${paymentColumns.has('payment_type')
            ? `(SELECT COALESCE(SUM(cp.amount), 0) FROM credit_payments cp WHERE cp.installment_id = i.id AND (cp.payment_type IS NULL OR cp.payment_type IN ('INSTALLMENT','DOWN_PAYMENT'))) as paid_so_far`
            : `(SELECT COALESCE(SUM(amount), 0) FROM credit_payments cp WHERE cp.installment_id = i.id) as paid_so_far`
          },
          ${paymentColumns.has('payment_type')
            ? `(SELECT COALESCE(SUM(cp.amount), 0) FROM credit_payments cp WHERE cp.installment_id = i.id AND cp.payment_type = 'PENALTY') as penalty_paid_so_far`
            : '0 as penalty_paid_so_far'
          }
         FROM installments i 
         JOIN sales s ON s.id = i.sale_id
         WHERE i.id = ? FOR UPDATE`,
        [installmentId]
      )

      if (rows.length === 0) {
        throw new Error('Cuota no encontrada')
      }

      const installment = rows[0]
      if (installment.paid) {
        throw new Error('Esta cuota ya está pagada')
      }
      if (installment.sale_status === 'CANCELLED') {
        throw new Error('No se puede registrar pagos a una venta cancelada')
      }

      const currentDebt = Number(installment.amount) - Number(installment.paid_so_far)
      if (Number(amount) > currentDebt) {
        throw new Error(`El monto excede la deuda pendiente (${currentDebt})`)
      }

      const requestWaivePenalty = String(waivePenalty || '').trim().toLowerCase()
      const shouldWaivePenalty = requestWaivePenalty === '1' || requestWaivePenalty === 'true' || requestWaivePenalty === 'yes'
      const penaltyAlreadyWaived = installmentsColumns.has('penalty_waived') ? Number(installment.penalty_waived || 0) === 1 : false
      const penaltyAccrued = (penaltyAlreadyWaived || shouldWaivePenalty)
        ? 0
        : computePenalty(installment.due_date, finalPaymentDate, { daily: 25, graceDays: 5 })
      const penaltyPaidSoFar = Number(installment.penalty_paid_so_far || 0)
      const penaltyDueNow = Math.max(0, Math.round((penaltyAccrued - penaltyPaidSoFar) * 100) / 100)

      if (shouldWaivePenalty && installmentsColumns.has('penalty_waived')) {
        await conn.query(
          'UPDATE installments SET penalty_waived = 1, penalty_waived_at = NOW(), penalty_waived_by_user_id = ? WHERE id = ?',
          [req.user.id, installmentId]
        )
      }

      const finalPaymentMethod = paymentMethod || 'CASH'
      let activeShift = null
      if (finalPaymentMethod === 'CASH') {
        const [shiftRows] = await conn.query(
          'SELECT id FROM cashbox_shifts WHERE opened_by = ? AND closed_at IS NULL ORDER BY id DESC LIMIT 1 FOR UPDATE',
          [req.user.id]
        )
        activeShift = shiftRows?.[0] || null
        if (!activeShift) {
          throw new Error('Caja cerrada. Debes abrir caja para registrar cobros en efectivo.')
        }
      }

      // 2. Registrar pago
      const insertColumns = ['installment_id', 'amount']
      const insertValues = [installmentId, amount]

      if (paymentColumns.has('payment_method')) {
        insertColumns.push('payment_method')
        insertValues.push(finalPaymentMethod)
      }
      if (paymentColumns.has('payment_type')) {
        insertColumns.push('payment_type')
        insertValues.push('INSTALLMENT')
      }
      if (paymentColumns.has('reference')) {
        insertColumns.push('reference')
        insertValues.push(reference || null)
      }
      if (paymentColumns.has('document_url')) {
        insertColumns.push('document_url')
        insertValues.push(documentUrl)
      }
      if (paymentColumns.has('received_by')) {
        insertColumns.push('received_by')
        insertValues.push(responsible || null)
      }
      if (paymentColumns.has('paid_at')) {
        insertColumns.push('paid_at')
        insertValues.push(finalPaymentDate)
      }
      if (paymentColumns.has('user_id')) {
        insertColumns.push('user_id')
        insertValues.push(req.user.id)
      }

      const [result] = await conn.query(
        `INSERT INTO credit_payments (${insertColumns.join(', ')}) VALUES (${insertColumns.map(() => '?').join(', ')})`,
        insertValues
      )
      const paymentId = result.insertId

      let penaltyPaymentId = null
      if (paymentColumns.has('payment_type') && penaltyDueNow > 0 && !penaltyAlreadyWaived && !shouldWaivePenalty) {
        const pColumns = ['installment_id', 'amount']
        const pValues = [installmentId, penaltyDueNow]
        if (paymentColumns.has('payment_method')) {
          pColumns.push('payment_method')
          pValues.push(finalPaymentMethod)
        }
        pColumns.push('payment_type')
        pValues.push('PENALTY')
        if (paymentColumns.has('reference')) {
          pColumns.push('reference')
          pValues.push(reference || null)
        }
        if (paymentColumns.has('document_url')) {
          pColumns.push('document_url')
          pValues.push(documentUrl)
        }
        if (paymentColumns.has('received_by')) {
          pColumns.push('received_by')
          pValues.push(responsible || null)
        }
        if (paymentColumns.has('paid_at')) {
          pColumns.push('paid_at')
          pValues.push(finalPaymentDate)
        }
        if (paymentColumns.has('user_id')) {
          pColumns.push('user_id')
          pValues.push(req.user.id)
        }
        const [pRes] = await conn.query(
          `INSERT INTO credit_payments (${pColumns.join(', ')}) VALUES (${pColumns.map(() => '?').join(', ')})`,
          pValues
        )
        penaltyPaymentId = pRes.insertId
      }

      if (finalPaymentMethod === 'CASH') {
        const cashAmount = Number(amount) + (penaltyPaymentId ? penaltyDueNow : 0)
        await conn.query(
          'INSERT INTO cash_movements (shift_id, type, concept, amount, ref_type, ref_id, created_at) VALUES (?, "IN", ?, ?, "CREDIT_PAYMENT", ?, ?)',
          [activeShift.id, `Abono de crédito venta #${installment.sale_id}`, cashAmount, paymentId, finalPaymentDate]
        )
      }

      // 3. Verificar si se completó el pago
      const newPaidAmount = Number(installment.paid_so_far) + Number(amount)
      // Usamos un pequeño margen por errores de punto flotante
      if (Math.abs(newPaidAmount - Number(installment.amount)) < 0.01) {
        await conn.query(
          'UPDATE installments SET paid = 1, paid_at = ? WHERE id = ?',
          [finalPaymentDate, installmentId]
        )
      }

      await conn.commit()
      res.json({ success: true, paymentId })

    } catch (err) {
      await conn.rollback()
      console.error('Error registrando pago:', err)
      res.status(400).json({ error: err.message || 'Error al registrar pago' })
    } finally {
      conn.release()
    }

  } catch (err) {
    console.error('Credit pay error:', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// Registrar pago global por venta (repartir a cuotas)
router.post('/pay-sale', authMiddleware, upload.single('document'), async (req, res) => {
  try {
    if (!canManageCredits(req.user)) {
      return res.status(403).json({ error: 'No tienes permisos para gestionar créditos' })
    }

    const { saleId, amount, paymentMethod, reference, responsible, paymentDate, waivePenalty } = req.body
    const documentUrl = req.file ? `/uploads/${req.file.filename}` : null

    const numericSaleId = Number(saleId || 0)
    const numericAmount = Number(amount || 0)
    if (!numericSaleId || !numericAmount || numericAmount <= 0) {
      return res.status(400).json({ error: 'Datos inválidos' })
    }

    if ((paymentMethod === 'CARD' || paymentMethod === 'DEPOSIT') && !reference) {
      return res.status(400).json({ error: 'Referencia requerida para Tarjeta/Depósito' })
    }

    const finalPaymentMethod = String(paymentMethod || 'CASH').trim().toUpperCase()
    if (!['CASH', 'CARD', 'DEPOSIT', 'TRANSFER'].includes(finalPaymentMethod)) {
      return res.status(400).json({ error: 'Método de pago inválido' })
    }

    let finalPaymentDate = new Date()
    if (finalPaymentMethod !== 'CASH' && paymentDate) {
      finalPaymentDate = new Date(paymentDate)
    }

    const requestWaivePenalty = String(waivePenalty || '').trim().toLowerCase()
    const waiveAllPenalties = requestWaivePenalty === '1' || requestWaivePenalty === 'true' || requestWaivePenalty === 'yes'

    const pool = await getPool()
    const paymentColumns = await getCreditPaymentsSchema(pool)
    const installmentsColumns = await getExistingColumns(pool, 'installments', ['penalty_waived', 'penalty_waived_at', 'penalty_waived_by_user_id'])

    if (!paymentColumns.has('payment_type')) {
      return res.status(400).json({ error: 'El sistema no está actualizado para penalizaciones. Ejecuta migraciones.' })
    }

    const conn = await pool.getConnection()
    try {
      await conn.beginTransaction()

      let activeShift = null
      if (finalPaymentMethod === 'CASH') {
        const [shiftRows] = await conn.query(
          'SELECT id FROM cashbox_shifts WHERE opened_by = ? AND closed_at IS NULL ORDER BY id DESC LIMIT 1 FOR UPDATE',
          [req.user.id]
        )
        activeShift = shiftRows?.[0] || null
        if (!activeShift) {
          throw new Error('Caja cerrada. Debes abrir caja para registrar cobros en efectivo.')
        }
      }

      const [rows] = await conn.query(
        `SELECT
          i.id,
          i.sale_id,
          i.due_date,
          i.amount,
          i.paid
          ${installmentsColumns.has('penalty_waived') ? ', COALESCE(i.penalty_waived, 0) as penalty_waived' : ''},
          (SELECT COALESCE(SUM(cp.amount), 0)
           FROM credit_payments cp
           WHERE cp.installment_id = i.id
             AND (cp.payment_type IS NULL OR cp.payment_type IN ('INSTALLMENT','DOWN_PAYMENT'))) as paid_so_far,
          (SELECT COALESCE(SUM(cp.amount), 0)
           FROM credit_payments cp
           WHERE cp.installment_id = i.id
             AND cp.payment_type = 'PENALTY') as penalty_paid_so_far
         FROM installments i
         JOIN sales s ON s.id = i.sale_id
         WHERE i.sale_id = ?
           AND COALESCE(s.status, 'COMPLETED') != 'CANCELLED'
         ORDER BY i.due_date ASC, i.id ASC
         FOR UPDATE`,
        [numericSaleId]
      )

      if (!rows?.length) {
        throw new Error('No se encontraron cuotas para esta venta')
      }

      const installments = rows.map(r => ({
        id: Number(r.id),
        due_date: r.due_date,
        amount: Number(r.amount || 0),
        paid: Number(r.paid || 0),
        paid_so_far: Number(r.paid_so_far || 0),
        penalty_paid_so_far: Number(r.penalty_paid_so_far || 0),
        penalty_waived: installmentsColumns.has('penalty_waived') ? Number(r.penalty_waived || 0) : 0,
      }))

      const principalDueTotal = installments.reduce((sum, it) => sum + Math.max(0, it.amount - it.paid_so_far), 0)
      const penaltyDueTotal = installments.reduce((sum, it) => {
        if (it.paid === 1) return sum
        if (it.penalty_waived === 1 || waiveAllPenalties) return sum
        const accrued = computePenalty(it.due_date, finalPaymentDate, { daily: 25, graceDays: 5 })
        const due = Math.max(0, Math.round((accrued - it.penalty_paid_so_far) * 100) / 100)
        return sum + due
      }, 0)

      const totalDue = Math.round((principalDueTotal + penaltyDueTotal) * 100) / 100
      if (numericAmount > totalDue + 0.01) {
        throw new Error(`El monto excede la deuda pendiente (${totalDue.toFixed(2)})`)
      }

      let remaining = Math.round(numericAmount * 100) / 100
      const paymentIds = []
      const allocations = []
      let principalApplied = 0
      let penaltyApplied = 0

      for (const it of installments) {
        if (remaining <= 0.00001) break
        if (it.paid === 1) continue

        const principalPending = Math.max(0, Math.round((it.amount - it.paid_so_far) * 100) / 100)
        let penaltyDueNow = 0
        if (!(it.penalty_waived === 1 || waiveAllPenalties)) {
          const accrued = computePenalty(it.due_date, finalPaymentDate, { daily: 25, graceDays: 5 })
          penaltyDueNow = Math.max(0, Math.round((accrued - it.penalty_paid_so_far) * 100) / 100)
        }

        if (waiveAllPenalties && penaltyDueNow > 0 && installmentsColumns.has('penalty_waived') && it.penalty_waived !== 1) {
          await conn.query(
            'UPDATE installments SET penalty_waived = 1, penalty_waived_at = NOW(), penalty_waived_by_user_id = ? WHERE id = ?',
            [req.user.id, it.id]
          )
          penaltyDueNow = 0
        }

        if (penaltyDueNow > 0 && remaining > 0.00001) {
          const payPenalty = Math.min(remaining, penaltyDueNow)
          const pColumns = ['installment_id', 'amount', 'payment_type']
          const pValues = [it.id, payPenalty, 'PENALTY']
          if (paymentColumns.has('payment_method')) {
            pColumns.push('payment_method')
            pValues.push(finalPaymentMethod)
          }
          if (paymentColumns.has('reference')) {
            pColumns.push('reference')
            pValues.push(reference || null)
          }
          if (paymentColumns.has('document_url')) {
            pColumns.push('document_url')
            pValues.push(documentUrl)
          }
          if (paymentColumns.has('received_by')) {
            pColumns.push('received_by')
            pValues.push(responsible || null)
          }
          if (paymentColumns.has('paid_at')) {
            pColumns.push('paid_at')
            pValues.push(finalPaymentDate)
          }
          if (paymentColumns.has('user_id')) {
            pColumns.push('user_id')
            pValues.push(req.user.id)
          }
          const [pRes] = await conn.query(
            `INSERT INTO credit_payments (${pColumns.join(', ')}) VALUES (${pColumns.map(() => '?').join(', ')})`,
            pValues
          )
          const pId = pRes.insertId
          paymentIds.push(pId)
          allocations.push({ installmentId: it.id, paymentType: 'PENALTY', amount: payPenalty, paymentId: pId })
          penaltyApplied = Math.round((penaltyApplied + payPenalty) * 100) / 100
          remaining = Math.round((remaining - payPenalty) * 100) / 100
        }

        if (principalPending > 0 && remaining > 0.00001) {
          const payPrincipal = Math.min(remaining, principalPending)
          const iColumns = ['installment_id', 'amount', 'payment_type']
          const iValues = [it.id, payPrincipal, 'INSTALLMENT']
          if (paymentColumns.has('payment_method')) {
            iColumns.push('payment_method')
            iValues.push(finalPaymentMethod)
          }
          if (paymentColumns.has('reference')) {
            iColumns.push('reference')
            iValues.push(reference || null)
          }
          if (paymentColumns.has('document_url')) {
            iColumns.push('document_url')
            iValues.push(documentUrl)
          }
          if (paymentColumns.has('received_by')) {
            iColumns.push('received_by')
            iValues.push(responsible || null)
          }
          if (paymentColumns.has('paid_at')) {
            iColumns.push('paid_at')
            iValues.push(finalPaymentDate)
          }
          if (paymentColumns.has('user_id')) {
            iColumns.push('user_id')
            iValues.push(req.user.id)
          }
          const [iRes] = await conn.query(
            `INSERT INTO credit_payments (${iColumns.join(', ')}) VALUES (${iColumns.map(() => '?').join(', ')})`,
            iValues
          )
          const iId = iRes.insertId
          paymentIds.push(iId)
          allocations.push({ installmentId: it.id, paymentType: 'INSTALLMENT', amount: payPrincipal, paymentId: iId })
          principalApplied = Math.round((principalApplied + payPrincipal) * 100) / 100
          remaining = Math.round((remaining - payPrincipal) * 100) / 100

          const newPaid = Math.round((it.paid_so_far + payPrincipal) * 100) / 100
          if (Math.abs(newPaid - it.amount) < 0.01) {
            await conn.query('UPDATE installments SET paid = 1, paid_at = ? WHERE id = ?', [finalPaymentDate, it.id])
          }
          it.paid_so_far = newPaid
        }
      }

      const totalApplied = Math.round((numericAmount - remaining) * 100) / 100
      if (totalApplied < numericAmount - 0.01) {
        throw new Error('No se pudo aplicar el monto completo. Verifica cuotas pendientes.')
      }

      const firstPaymentId = paymentIds[0] || null
      if (finalPaymentMethod === 'CASH' && firstPaymentId) {
        await conn.query(
          'INSERT INTO cash_movements (shift_id, type, concept, amount, ref_type, ref_id, created_at) VALUES (?, "IN", ?, ?, "CREDIT_PAYMENT", ?, ?)',
          [activeShift.id, `Pago crédito venta #${numericSaleId}`, totalApplied, firstPaymentId, finalPaymentDate]
        )
      }

      await conn.commit()
      return res.json({
        success: true,
        paymentIds,
        allocations,
        totalApplied,
        penaltyApplied,
        principalApplied,
      })
    } catch (err) {
      await conn.rollback()
      console.error('Error registrando pago global:', err)
      return res.status(400).json({ error: err.message || 'Error al registrar pago' })
    } finally {
      conn.release()
    }
  } catch (err) {
    console.error('Credit pay sale error:', err)
    return res.status(500).json({ error: 'Server error' })
  }
})

export default router
