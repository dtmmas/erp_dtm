import express from 'express'
import fs from 'fs'
import multer from 'multer'
import path from 'path'
import { authMiddleware, getUserWarehouseId, isAdminUser, canUserSell, hasExplicitUserPermission, hasUserPermission } from '../auth.js'
import { getPool } from '../db.js'
import { computeSha256, guessFrequencyLabel, renderCreditContractHtml } from '../services/credit_contracts.js'
import { registerMovement } from '../services/inventory.js'
import { projectRoot, uploadsDir } from '../paths.js'

const router = express.Router()

// #region debug-point credit-installment-mismatch-config
let __dbgUrl = null
try {
  const raw = fs.readFileSync(path.join(projectRoot, '.dbg', 'credit-installment-mismatch.env'), 'utf-8')
  for (const line of raw.split('\n')) {
    const [k, ...rest] = line.trim().split('=')
    if (!k) continue
    const v = rest.join('=').trim()
    if (k === 'DEBUG_SERVER_URL') __dbgUrl = v
  }
} catch {}

async function __dbgReport(event) {
  if (!__dbgUrl) return
  try {
    await fetch(__dbgUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: 'credit-installment-mismatch',
        at: new Date().toISOString(),
        ...event,
      }),
    })
  } catch {}
}
// #endregion debug-point credit-installment-mismatch-config

const paymentDocumentStorage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadsDir)
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9)
    const ext = path.extname(file.originalname)
    cb(null, file.fieldname + '-' + uniqueSuffix + ext)
  }
})

const uploadPaymentDocument = multer({
  storage: paymentDocumentStorage,
  fileFilter: (req, file, cb) => {
    const mime = String(file?.mimetype || '').toLowerCase()
    if (mime.startsWith('image/')) return cb(null, true)
    return cb(new Error('Archivo inválido. Debe ser una imagen.'))
  },
})

async function columnExists(db, table, column) {
  const [rows] = await db.query(`SHOW COLUMNS FROM \`${table}\` LIKE ?`, [column])
  return Array.isArray(rows) && rows.length > 0
}

async function fkExists(db, table, fkName) {
  const [rows] = await db.query(
    `SELECT COUNT(*) AS c
     FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = ?
       AND CONSTRAINT_NAME = ?
       AND CONSTRAINT_TYPE = 'FOREIGN KEY'`,
    [table, fkName]
  )
  return Number(rows?.[0]?.c || 0) > 0
}

function createHttpError(statusCode, message) {
  const error = new Error(message)
  error.statusCode = statusCode
  return error
}

function roundMoney(value) {
  return Math.round(Number(value || 0) * 100) / 100
}

function formatDateOnly(date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function addDays(date, days) {
  const next = new Date(date)
  next.setDate(next.getDate() + days)
  return next
}

function parseDateOnly(value) {
  const raw = String(value || '').trim()
  if (!raw) return null
  const date = raw.length >= 10 ? new Date(`${raw.slice(0, 10)}T12:00:00`) : new Date(raw)
  if (Number.isNaN(date.getTime())) return null
  return formatDateOnly(date)
}

function getDefaultCreditInstallments(total) {
  return [
    {
      amount: roundMoney(total),
      dueDate: formatDateOnly(addDays(new Date(), 30)),
    },
  ]
}

function normalizeCreditInstallments(rawInstallments, total, options = {}) {
  const requireExplicit = Boolean(options.requireExplicit)
  const expectedTotal = roundMoney(total)
  if (!Number.isFinite(expectedTotal) || expectedTotal <= 0) {
    throw createHttpError(400, 'El total del crédito no es válido')
  }

  if (!Array.isArray(rawInstallments) || rawInstallments.length === 0) {
    if (requireExplicit) {
      throw createHttpError(400, 'Debes definir las cuotas del crédito antes de guardar la venta')
    }
    return getDefaultCreditInstallments(expectedTotal)
  }

  if (rawInstallments.length > 60) {
    throw createHttpError(400, 'No puedes registrar más de 60 cuotas')
  }

  const installments = rawInstallments.map((installment, index) => {
    const amount = roundMoney(installment?.amount)
    const dueDate = parseDateOnly(installment?.dueDate || installment?.due_date)

    if (!Number.isFinite(amount) || amount <= 0) {
      throw createHttpError(400, `La cuota #${index + 1} debe tener un monto válido`)
    }

    if (!dueDate) {
      throw createHttpError(400, `La cuota #${index + 1} debe tener una fecha de vencimiento válida`)
    }

    return { amount, dueDate }
  })

  const plannedTotal = roundMoney(installments.reduce((sum, installment) => sum + installment.amount, 0))
  if (Math.abs(plannedTotal - expectedTotal) > 0.01) {
    throw createHttpError(400, 'La suma de las cuotas no coincide con el total del crédito')
  }

  return installments
}

async function createInstallments(conn, saleId, installments) {
  for (const installment of installments) {
    await conn.query(
      'INSERT INTO installments (sale_id, due_date, amount, paid) VALUES (?, ?, ?, 0)',
      [saleId, installment.dueDate, installment.amount]
    )
  }
}

async function ensureSalesSchema(db) {
  const hasSalesUserId = await columnExists(db, 'sales', 'user_id')
  if (!hasSalesUserId) {
    await db.query('ALTER TABLE sales ADD COLUMN user_id INT NULL')
  }

  if (!(await fkExists(db, 'sales', 'fk_sales_user'))) {
    try {
      await db.query(`
        ALTER TABLE sales
        ADD CONSTRAINT fk_sales_user
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
      `)
    } catch (error) {
      console.warn(`Skipped fk_sales_user: ${error.message}`)
    }
  }

  const hasSalesWarehouseId = await columnExists(db, 'sales', 'warehouse_id')
  if (!hasSalesWarehouseId) {
    await db.query('ALTER TABLE sales ADD COLUMN warehouse_id INT NULL')
  }

  if (!(await fkExists(db, 'sales', 'fk_sales_warehouse'))) {
    try {
      await db.query(`
        ALTER TABLE sales
        ADD CONSTRAINT fk_sales_warehouse
        FOREIGN KEY (warehouse_id) REFERENCES warehouses(id) ON DELETE SET NULL
      `)
    } catch (error) {
      console.warn(`Skipped fk_sales_warehouse: ${error.message}`)
    }
  }

  if (!(await columnExists(db, 'sales', 'status'))) {
    await db.query(`ALTER TABLE sales ADD COLUMN status VARCHAR(20) DEFAULT 'COMPLETED'`)
  }

  if (!(await columnExists(db, 'sales', 'cancellation_reason'))) {
    await db.query('ALTER TABLE sales ADD COLUMN cancellation_reason TEXT NULL')
  }

  if (!(await columnExists(db, 'sales', 'paid_by_user_id'))) {
    await db.query('ALTER TABLE sales ADD COLUMN paid_by_user_id INT NULL')
  }

  if (!(await fkExists(db, 'sales', 'fk_sales_paid_by_user'))) {
    try {
      await db.query(`
        ALTER TABLE sales
        ADD CONSTRAINT fk_sales_paid_by_user
        FOREIGN KEY (paid_by_user_id) REFERENCES users(id) ON DELETE SET NULL
      `)
    } catch (error) {
      console.warn(`Skipped fk_sales_paid_by_user: ${error.message}`)
    }
  }

  if (!(await columnExists(db, 'sales', 'paid_at'))) {
    await db.query('ALTER TABLE sales ADD COLUMN paid_at DATETIME NULL')
  }

  if (!(await columnExists(db, 'sales', 'payment_document_url'))) {
    await db.query('ALTER TABLE sales ADD COLUMN payment_document_url VARCHAR(255) NULL')
  }

  if (!(await columnExists(db, 'sales', 'pending_payment_method'))) {
    await db.query('ALTER TABLE sales ADD COLUMN pending_payment_method VARCHAR(20) NULL')
  }

  if (!(await columnExists(db, 'sales', 'pending_reference_number'))) {
    await db.query('ALTER TABLE sales ADD COLUMN pending_reference_number VARCHAR(160) NULL')
  }

  if (!(await columnExists(db, 'sales', 'pending_down_payment_amount'))) {
    await db.query('ALTER TABLE sales ADD COLUMN pending_down_payment_amount DECIMAL(12,2) NULL')
  }

  if (!(await columnExists(db, 'sales', 'pending_down_payment_method'))) {
    await db.query('ALTER TABLE sales ADD COLUMN pending_down_payment_method VARCHAR(20) NULL')
  }

  if (!(await columnExists(db, 'sales', 'pending_down_payment_reference'))) {
    await db.query('ALTER TABLE sales ADD COLUMN pending_down_payment_reference VARCHAR(160) NULL')
  }

  // Completa ventas históricas usando primero inventory_movements y luego caja.
  await db.query(`
    UPDATE sales s
    LEFT JOIN (
      SELECT reference_id AS sale_id, MAX(user_id) AS user_id
      FROM inventory_movements
      WHERE type = 'SALE'
        AND reference_id IS NOT NULL
        AND user_id IS NOT NULL
      GROUP BY reference_id
    ) sale_inventory_user ON sale_inventory_user.sale_id = s.id
    SET s.user_id = sale_inventory_user.user_id
    WHERE (s.user_id IS NULL OR s.user_id = 0)
      AND sale_inventory_user.user_id IS NOT NULL
  `)

  await db.query(`
    UPDATE sales s
    LEFT JOIN (
      SELECT cm.ref_id AS sale_id, MAX(cs.opened_by) AS opened_by
      FROM cash_movements cm
      JOIN cashbox_shifts cs ON cs.id = cm.shift_id
      WHERE cm.ref_type = 'SALE' AND cm.ref_id IS NOT NULL
      GROUP BY cm.ref_id
    ) sale_shift ON sale_shift.sale_id = s.id
    SET s.user_id = sale_shift.opened_by
    WHERE (s.user_id IS NULL OR s.user_id = 0)
      AND sale_shift.opened_by IS NOT NULL
  `)

  await db.query(`
    UPDATE sales s
    LEFT JOIN (
      SELECT reference_id AS sale_id, MAX(warehouse_id) AS warehouse_id
      FROM inventory_movements
      WHERE type = 'SALE'
        AND reference_id IS NOT NULL
        AND warehouse_id IS NOT NULL
      GROUP BY reference_id
    ) sale_inventory_warehouse ON sale_inventory_warehouse.sale_id = s.id
    SET s.warehouse_id = sale_inventory_warehouse.warehouse_id
    WHERE (s.warehouse_id IS NULL OR s.warehouse_id = 0)
      AND sale_inventory_warehouse.warehouse_id IS NOT NULL
  `)

  await db.query(`
    UPDATE sales s
    LEFT JOIN users u ON u.id = s.user_id
    SET s.warehouse_id = u.warehouse_id
    WHERE (s.warehouse_id IS NULL OR s.warehouse_id = 0)
      AND u.warehouse_id IS NOT NULL
  `)

  await db.query(`
    UPDATE sales
    SET paid_by_user_id = COALESCE(paid_by_user_id, user_id),
        paid_at = COALESCE(paid_at, created_at)
    WHERE COALESCE(status, 'COMPLETED') = 'COMPLETED'
      AND (paid_by_user_id IS NULL OR paid_at IS NULL)
  `)

  if (!(await columnExists(db, 'sale_items', 'original_unit_price'))) {
    await db.query('ALTER TABLE sale_items ADD COLUMN original_unit_price DECIMAL(10,2) NULL')
  }

  if (!(await columnExists(db, 'sale_items', 'price_source'))) {
    await db.query("ALTER TABLE sale_items ADD COLUMN price_source VARCHAR(30) NULL DEFAULT 'BASE'")
  }

  if (!(await columnExists(db, 'sale_items', 'unit_cost_snapshot'))) {
    await db.query('ALTER TABLE sale_items ADD COLUMN unit_cost_snapshot DECIMAL(12,2) NULL')
  }

  if (!(await columnExists(db, 'sale_items', 'total_cost_snapshot'))) {
    await db.query('ALTER TABLE sale_items ADD COLUMN total_cost_snapshot DECIMAL(12,2) NULL')
  }

  if (!(await columnExists(db, 'sale_items', 'serial'))) {
    await db.query('ALTER TABLE sale_items ADD COLUMN serial VARCHAR(100) NULL')
  }

  if (!(await columnExists(db, 'sale_items', 'imei'))) {
    await db.query('ALTER TABLE sale_items ADD COLUMN imei VARCHAR(50) NULL')
  }

  if (!(await columnExists(db, 'sale_items', 'batch_no'))) {
    await db.query('ALTER TABLE sale_items ADD COLUMN batch_no VARCHAR(100) NULL')
  }

  if (!(await columnExists(db, 'sale_items', 'expiry_date'))) {
    await db.query('ALTER TABLE sale_items ADD COLUMN expiry_date DATE NULL')
  }

  await db.query(`
    UPDATE sale_items si
    JOIN products p ON p.id = si.product_id
    SET si.unit_cost_snapshot = COALESCE(si.unit_cost_snapshot, p.avg_cost, p.cost, 0),
        si.total_cost_snapshot = COALESCE(si.total_cost_snapshot, si.quantity * COALESCE(si.unit_cost_snapshot, p.avg_cost, p.cost, 0))
    WHERE si.unit_cost_snapshot IS NULL OR si.total_cost_snapshot IS NULL
  `)
}

async function buildSalesContext(db) {
  await ensureSalesSchema(db)
  const hasSalesUserId = await columnExists(db, 'sales', 'user_id')

  return {
    hasSalesUserId,
    sellerIdExpr: hasSalesUserId
      ? 'COALESCE(s.user_id, sale_inventory_user.user_id, sale_shift.opened_by)'
      : 'COALESCE(sale_inventory_user.user_id, sale_shift.opened_by)',
    sellerNameExpr: hasSalesUserId
      ? "COALESCE(su.name, iu.name, cu.name, 'SIN USUARIO')"
      : "COALESCE(iu.name, cu.name, 'SIN USUARIO')",
    sellerJoin: hasSalesUserId
      ? `
        LEFT JOIN users su ON su.id = s.user_id
        LEFT JOIN users iu ON iu.id = sale_inventory_user.user_id
      `
      : 'LEFT JOIN users iu ON iu.id = sale_inventory_user.user_id',
    baseJoins: `
      LEFT JOIN customers c ON s.customer_id = c.id
      LEFT JOIN warehouses sw ON sw.id = s.warehouse_id
      LEFT JOIN (
        SELECT i.sale_id,
               MIN(i.paid) AS credit_fully_paid,
               CASE
                 WHEN MIN(i.paid) = 1 THEN COALESCE(MAX(i.paid_at), MAX(cp.last_paid_at))
                 ELSE NULL
               END AS credit_fully_paid_at
        FROM installments i
        LEFT JOIN (
          SELECT installment_id, MAX(paid_at) AS last_paid_at
          FROM credit_payments
          GROUP BY installment_id
        ) cp ON cp.installment_id = i.id
        GROUP BY i.sale_id
      ) i ON i.sale_id = s.id
      LEFT JOIN (
        SELECT si.sale_id,
               COALESCE(SUM(COALESCE(si.total_cost_snapshot, si.quantity * COALESCE(si.unit_cost_snapshot, p.avg_cost, p.cost, 0))), 0) AS cost_total,
               COALESCE(SUM(si.total - COALESCE(si.total_cost_snapshot, si.quantity * COALESCE(si.unit_cost_snapshot, p.avg_cost, p.cost, 0))), 0) AS profit
        FROM sale_items si
        JOIN products p ON p.id = si.product_id
        GROUP BY si.sale_id
      ) calc ON calc.sale_id = s.id
      LEFT JOIN (
        SELECT reference_id AS sale_id, MAX(user_id) AS user_id
        FROM inventory_movements
        WHERE type = 'SALE'
          AND reference_id IS NOT NULL
          AND user_id IS NOT NULL
        GROUP BY reference_id
      ) sale_inventory_user ON sale_inventory_user.sale_id = s.id
      LEFT JOIN (
        SELECT cm.ref_id AS sale_id, MAX(cs.opened_by) AS opened_by
        FROM cash_movements cm
        JOIN cashbox_shifts cs ON cs.id = cm.shift_id
        WHERE cm.ref_type = 'SALE' AND cm.ref_id IS NOT NULL
        GROUP BY cm.ref_id
      ) sale_shift ON sale_shift.sale_id = s.id
      LEFT JOIN users cu ON cu.id = sale_shift.opened_by
    `,
  }
}

function getSalesFilters(req, context, forceUserId = null) {
  const search = (req.query.search || '').toString().trim()
  const startDate = (req.query.startDate || '').toString().slice(0, 10)
  const endDate = (req.query.endDate || '').toString().slice(0, 10)
  const paymentMethod = (req.query.paymentMethod || '').toString().trim().toUpperCase()
  const statusFilter = (req.query.statusFilter || 'ACTIVE').toString().trim().toUpperCase()
  const requestedUserId = Number(req.query.userId || 0)
  const requestedWarehouseId = Number(req.query.warehouseId || 0)
  const isAdmin = isAdminUser(req.user)
  const effectiveUserId = forceUserId || (isAdmin ? requestedUserId : Number(req.user?.id || 0))
  const userWarehouseId = getUserWarehouseId(req.user)
  const effectiveWarehouseId = isAdmin ? requestedWarehouseId : Number(userWarehouseId || 0)
  const isPaidCreditFilter = paymentMethod === 'CREDIT_PAID'
  const isRealizedFilter = paymentMethod === 'REALIZED'
  const dateFieldExpr = isPaidCreditFilter ? 'DATE(i.credit_fully_paid_at)' : 'DATE(s.created_at)'
  const where = []
  const params = []

  if (!isAdmin && !userWarehouseId) {
    where.push('1 = 0')
  }

  if (search) {
    where.push(`(s.doc_no LIKE ? OR c.name LIKE ? OR s.id = ? OR ${context.sellerNameExpr} LIKE ?)`)
    params.push(`%${search}%`, `%${search}%`, Number(search) || 0, `%${search}%`)
  }
  if (startDate) {
    if (isRealizedFilter) {
      where.push(`(
        (
          COALESCE(s.payment_method, '') IN ('CASH', 'CARD', 'DEPOSIT', 'TRANSFER')
          AND COALESCE(s.is_credit, 0) = 0
          AND DATE(s.created_at) >= ?
        )
        OR (
          (s.payment_method = 'CREDIT' OR COALESCE(s.is_credit, 0) = 1)
          AND COALESCE(i.credit_fully_paid, 0) = 1
          AND i.credit_fully_paid_at IS NOT NULL
          AND DATE(i.credit_fully_paid_at) >= ?
        )
      )`)
      params.push(startDate, startDate)
    } else {
      where.push(`${dateFieldExpr} >= ?`)
      params.push(startDate)
    }
  }
  if (endDate) {
    if (isRealizedFilter) {
      where.push(`(
        (
          COALESCE(s.payment_method, '') IN ('CASH', 'CARD', 'DEPOSIT', 'TRANSFER')
          AND COALESCE(s.is_credit, 0) = 0
          AND DATE(s.created_at) <= ?
        )
        OR (
          (s.payment_method = 'CREDIT' OR COALESCE(s.is_credit, 0) = 1)
          AND COALESCE(i.credit_fully_paid, 0) = 1
          AND i.credit_fully_paid_at IS NOT NULL
          AND DATE(i.credit_fully_paid_at) <= ?
        )
      )`)
      params.push(endDate, endDate)
    } else {
      where.push(`${dateFieldExpr} <= ?`)
      params.push(endDate)
    }
  }
  if (effectiveUserId > 0) {
    where.push(`${context.sellerIdExpr} = ?`)
    params.push(effectiveUserId)
  }
  if (effectiveWarehouseId > 0) {
    where.push('s.warehouse_id = ?')
    params.push(effectiveWarehouseId)
  }
  if (statusFilter === 'CANCELLED') {
    where.push(`COALESCE(s.status, 'COMPLETED') = 'CANCELLED'`)
  } else if (statusFilter === 'PENDING_PAYMENT') {
    where.push(`COALESCE(s.status, 'COMPLETED') = 'PENDING_PAYMENT'`)
  } else if (statusFilter === 'COMPLETED') {
    where.push(`COALESCE(s.status, 'COMPLETED') = 'COMPLETED'`)
  } else if (statusFilter !== 'ALL') {
    where.push(`COALESCE(s.status, 'COMPLETED') <> 'CANCELLED'`)
  }
  if (paymentMethod === 'NON_CREDIT') {
    where.push(`(COALESCE(s.payment_method, '') <> 'CREDIT' AND COALESCE(s.is_credit, 0) = 0)`)
  } else if (paymentMethod === 'CREDIT') {
    where.push(`(s.payment_method = 'CREDIT' OR COALESCE(s.is_credit, 0) = 1)`)
  } else if (paymentMethod === 'CREDIT_PAID') {
    where.push(`(s.payment_method = 'CREDIT' OR COALESCE(s.is_credit, 0) = 1)`)
    where.push('COALESCE(i.credit_fully_paid, 0) = 1')
    where.push('i.credit_fully_paid_at IS NOT NULL')
  } else if (paymentMethod === 'REALIZED') {
    where.push(`(
      (
        COALESCE(s.payment_method, '') IN ('CASH', 'CARD', 'DEPOSIT', 'TRANSFER')
        AND COALESCE(s.is_credit, 0) = 0
      )
      OR (
        (s.payment_method = 'CREDIT' OR COALESCE(s.is_credit, 0) = 1)
        AND COALESCE(i.credit_fully_paid, 0) = 1
        AND i.credit_fully_paid_at IS NOT NULL
      )
    )`)
  } else if (['CASH', 'CARD', 'DEPOSIT', 'TRANSFER'].includes(paymentMethod)) {
    where.push('s.payment_method = ?')
    params.push(paymentMethod)
  }

  return {
    whereClause: where.length ? `WHERE ${where.join(' AND ')}` : '',
    params,
    orderByClause: isPaidCreditFilter
      ? 'ORDER BY i.credit_fully_paid_at DESC, s.created_at DESC'
      : isRealizedFilter
        ? `ORDER BY
             CASE
               WHEN (s.payment_method = 'CREDIT' OR COALESCE(s.is_credit, 0) = 1)
                 AND COALESCE(i.credit_fully_paid, 0) = 1
                 AND i.credit_fully_paid_at IS NOT NULL
               THEN i.credit_fully_paid_at
               ELSE s.created_at
             END DESC,
             s.created_at DESC`
        : 'ORDER BY s.created_at DESC',
  }
}

function buildSalesSelect(context, canSeeProfit) {
  return `
    SELECT s.*, c.name AS customer_name,
           i.credit_fully_paid,
           i.credit_fully_paid_at,
           sw.name AS warehouse_name,
           ${canSeeProfit ? 'COALESCE(calc.cost_total, 0)' : 'NULL'} AS cost_total,
           ${canSeeProfit ? "CASE WHEN s.status = 'CANCELLED' THEN 0 ELSE COALESCE(calc.profit, 0) END" : 'NULL'} AS profit,
           ${context.sellerIdExpr} AS seller_id,
           ${context.sellerNameExpr} AS seller_name
    FROM sales s
    ${context.baseJoins}
    ${context.sellerJoin}
  `
}

function canAccessCashReports(user) {
  return hasUserPermission(user, 'cash:view')
    || hasUserPermission(user, 'cash:open')
    || hasUserPermission(user, 'cash:movements')
    || hasUserPermission(user, 'cash:close')
}

function getCollectedSalesFilters(req, context, collectorUserId) {
  const search = (req.query.search || '').toString().trim()
  const startDate = (req.query.startDate || '').toString().slice(0, 10)
  const endDate = (req.query.endDate || '').toString().slice(0, 10)
  const paymentMethod = (req.query.paymentMethod || '').toString().trim().toUpperCase()
  const statusFilter = (req.query.statusFilter || 'ACTIVE').toString().trim().toUpperCase()
  const where = [
    's.paid_by_user_id = ?',
    's.paid_at IS NOT NULL',
    `COALESCE(s.status, 'COMPLETED') <> 'PENDING_PAYMENT'`,
  ]
  const params = [collectorUserId]

  if (search) {
    where.push(`(s.doc_no LIKE ? OR c.name LIKE ? OR s.id = ? OR ${context.sellerNameExpr} LIKE ?)`)
    params.push(`%${search}%`, `%${search}%`, Number(search) || 0, `%${search}%`)
  }

  if (startDate) {
    where.push('DATE(s.paid_at) >= ?')
    params.push(startDate)
  }

  if (endDate) {
    where.push('DATE(s.paid_at) <= ?')
    params.push(endDate)
  }

  if (statusFilter === 'CANCELLED') {
    where.push(`COALESCE(s.status, 'COMPLETED') = 'CANCELLED'`)
  } else if (statusFilter === 'ACTIVE') {
    where.push(`COALESCE(s.status, 'COMPLETED') <> 'CANCELLED'`)
  }

  if (paymentMethod === 'CREDIT') {
    where.push(`(s.payment_method = 'CREDIT' OR COALESCE(s.is_credit, 0) = 1)`)
  } else if (['CASH', 'CARD', 'DEPOSIT', 'TRANSFER'].includes(paymentMethod)) {
    where.push('s.payment_method = ?')
    params.push(paymentMethod)
  }

  return {
    whereClause: `WHERE ${where.join(' AND ')}`,
    params,
    orderByClause: 'ORDER BY s.paid_at DESC, s.created_at DESC',
  }
}

// Listar ventas (historial)
router.get('/', authMiddleware, async (req, res) => {
  try {
    const limit = Math.max(1, Number(req.query.limit || 50))
    const offset = Math.max(0, Number(req.query.offset || 0))
    const pool = await getPool()
    await ensureSalesSchema(pool)
    const context = await buildSalesContext(pool)
    const canSeeProfit = req.user?.role === 'ADMIN'
    const { whereClause, params, orderByClause } = getSalesFilters(req, context)
    const query = `
      ${buildSalesSelect(context, canSeeProfit)}
      ${whereClause}
      ${orderByClause}
      LIMIT ? OFFSET ?
    `
    const rowsParams = [...params, limit, offset]
    const [rows] = await pool.query(query, rowsParams)

    const countQuery = `
      SELECT COUNT(*) AS total
      FROM sales s
      ${context.baseJoins}
      ${context.sellerJoin}
      ${whereClause}
    `
    const [countRows] = await pool.query(countQuery, params)
    const totalRecords = Number(countRows?.[0]?.total || 0)

    const [summaryRows] = await pool.query(
      `
        SELECT COUNT(*) AS records,
               COALESCE(SUM(s.total), 0) AS gross_total,
               COALESCE(SUM(CASE WHEN s.status = 'CANCELLED' THEN 0 ELSE s.total END), 0) AS net_total,
               COALESCE(SUM(CASE WHEN s.status = 'CANCELLED' THEN 0 ELSE COALESCE(calc.profit, 0) END), 0) AS total_profit,
               COALESCE(SUM(CASE WHEN s.status = 'CANCELLED' THEN 1 ELSE 0 END), 0) AS cancelled_count
        FROM sales s
        ${context.baseJoins}
        ${context.sellerJoin}
        ${whereClause}
      `,
      params
    )

    const [summaryByMethodRows] = await pool.query(
      `
        SELECT
          CASE
            WHEN s.payment_method = 'CREDIT' OR COALESCE(s.is_credit, 0) = 1 THEN 'CREDIT'
            ELSE COALESCE(s.payment_method, 'N/D')
          END AS payment_method,
          COALESCE(SUM(CASE WHEN s.status = 'CANCELLED' THEN 0 ELSE s.total END), 0) AS net_total
        FROM sales s
        ${context.baseJoins}
        ${context.sellerJoin}
        ${whereClause}
        GROUP BY
          CASE
            WHEN s.payment_method = 'CREDIT' OR COALESCE(s.is_credit, 0) = 1 THEN 'CREDIT'
            ELSE COALESCE(s.payment_method, 'N/D')
          END
      `,
      params
    )

    const byUserRows = canSeeProfit
      ? (await pool.query(
          `
            SELECT ${context.sellerIdExpr} AS user_id,
                   ${context.sellerNameExpr} AS user_name,
                   COUNT(*) AS sales_count,
                   COALESCE(SUM(s.total), 0) AS gross_total,
                   COALESCE(SUM(CASE WHEN s.status = 'CANCELLED' THEN 0 ELSE s.total END), 0) AS total,
                   COALESCE(SUM(CASE WHEN s.status = 'CANCELLED' THEN 0 ELSE COALESCE(calc.profit, 0) END), 0) AS profit,
                   COALESCE(SUM(CASE WHEN s.status = 'CANCELLED' THEN 1 ELSE 0 END), 0) AS cancelled_count
            FROM sales s
            ${context.baseJoins}
            ${context.sellerJoin}
            ${whereClause}
            GROUP BY ${context.sellerIdExpr}, ${context.sellerNameExpr}
            ORDER BY total DESC, sales_count DESC, user_name ASC
          `,
          params
        ))[0]
      : []

    return res.json({
      data: rows,
      pagination: {
        total: totalRecords,
        limit,
        offset,
      },
      summary: {
        records: Number(summaryRows?.[0]?.records || 0),
        grossTotal: Number(summaryRows?.[0]?.gross_total || 0),
        netTotal: Number(summaryRows?.[0]?.net_total || 0),
        totalProfit: canSeeProfit ? Number(summaryRows?.[0]?.total_profit || 0) : 0,
        cancelledCount: Number(summaryRows?.[0]?.cancelled_count || 0),
        byMethod: Object.fromEntries(
          (summaryByMethodRows || []).map(row => [
            row.payment_method || 'N/D',
            Number(row.net_total || 0),
          ])
        ),
      },
      byUser: (byUserRows || []).map(row => ({
        userId: row.user_id ? Number(row.user_id) : null,
        userName: row.user_name || 'SIN USUARIO',
        salesCount: Number(row.sales_count || 0),
        grossTotal: Number(row.gross_total || 0),
        total: Number(row.total || 0),
        profit: Number(row.profit || 0),
        cancelledCount: Number(row.cancelled_count || 0),
      })),
    })
  } catch (err) {
    console.error('Sales list error:', err)
    res.status(500).json({ error: 'Server error' })
  }
})

router.get('/my-report', authMiddleware, async (req, res) => {
  try {
    const limit = Math.max(1, Number(req.query.limit || 50))
    const offset = Math.max(0, Number(req.query.offset || 0))
    const pool = await getPool()
    await ensureSalesSchema(pool)
    const context = await buildSalesContext(pool)
    const { whereClause, params, orderByClause } = getSalesFilters(req, context, Number(req.user?.id || 0))
    const query = `
      ${buildSalesSelect(context, false)}
      ${whereClause}
      ${orderByClause}
      LIMIT ? OFFSET ?
    `
    const [rows] = await pool.query(query, [...params, limit, offset])
    const [countRows] = await pool.query(
      `
        SELECT COUNT(*) AS total
        FROM sales s
        ${context.baseJoins}
        ${context.sellerJoin}
        ${whereClause}
      `,
      params
    )
    const [summaryRows] = await pool.query(
      `
        SELECT COUNT(*) AS records,
               COALESCE(SUM(CASE WHEN s.status = 'CANCELLED' THEN 0 ELSE s.total END), 0) AS net_total,
               COALESCE(SUM(CASE WHEN s.status = 'CANCELLED' THEN 1 ELSE 0 END), 0) AS cancelled_count
        FROM sales s
        ${context.baseJoins}
        ${context.sellerJoin}
        ${whereClause}
      `,
      params
    )

    return res.json({
      data: rows,
      pagination: {
        total: Number(countRows?.[0]?.total || 0),
        limit,
        offset,
      },
      summary: {
        records: Number(summaryRows?.[0]?.records || 0),
        netTotal: Number(summaryRows?.[0]?.net_total || 0),
        cancelledCount: Number(summaryRows?.[0]?.cancelled_count || 0),
      },
    })
  } catch (err) {
    console.error('My sales report error:', err)
    return res.status(500).json({ error: 'Server error' })
  }
})

router.get('/my-collections', authMiddleware, async (req, res) => {
  try {
    if (!canAccessCashReports(req.user)) {
      return res.status(403).json({ error: 'No tienes permisos para ver tu historial de cobros' })
    }

    const limit = Math.max(1, Number(req.query.limit || 50))
    const offset = Math.max(0, Number(req.query.offset || 0))
    const pool = await getPool()
    await ensureSalesSchema(pool)
    const context = await buildSalesContext(pool)
    const { whereClause, params, orderByClause } = getCollectedSalesFilters(req, context, Number(req.user?.id || 0))
    const query = `
      ${buildSalesSelect(context, false)}
      ${whereClause}
      ${orderByClause}
      LIMIT ? OFFSET ?
    `
    const [rows] = await pool.query(query, [...params, limit, offset])
    const [countRows] = await pool.query(
      `
        SELECT COUNT(*) AS total
        FROM sales s
        ${context.baseJoins}
        ${context.sellerJoin}
        ${whereClause}
      `,
      params
    )
    const [summaryRows] = await pool.query(
      `
        SELECT COUNT(*) AS records,
               COALESCE(SUM(CASE
                 WHEN COALESCE(s.status, 'COMPLETED') = 'CANCELLED'
                   OR (s.payment_method = 'CREDIT' OR COALESCE(s.is_credit, 0) = 1)
                 THEN 0
                 ELSE s.total
               END), 0) AS collected_total,
               COALESCE(SUM(CASE
                 WHEN COALESCE(s.status, 'COMPLETED') = 'CANCELLED'
                   OR NOT (s.payment_method = 'CREDIT' OR COALESCE(s.is_credit, 0) = 1)
                 THEN 0
                 ELSE s.total
               END), 0) AS credit_total,
               COALESCE(SUM(CASE WHEN COALESCE(s.status, 'COMPLETED') = 'CANCELLED' THEN 1 ELSE 0 END), 0) AS cancelled_count
        FROM sales s
        ${context.baseJoins}
        ${context.sellerJoin}
        ${whereClause}
      `,
      params
    )

    return res.json({
      data: rows,
      pagination: {
        total: Number(countRows?.[0]?.total || 0),
        limit,
        offset,
      },
      summary: {
        records: Number(summaryRows?.[0]?.records || 0),
        collectedTotal: Number(summaryRows?.[0]?.collected_total || 0),
        creditTotal: Number(summaryRows?.[0]?.credit_total || 0),
        cancelledCount: Number(summaryRows?.[0]?.cancelled_count || 0),
      },
    })
  } catch (err) {
    console.error('My collections report error:', err)
    return res.status(500).json({ error: 'Server error' })
  }
})

function isImageDataUrl(value) {
  if (typeof value !== 'string') return false
  const trimmed = value.trim()
  if (!trimmed.startsWith('data:')) return false
  if (!trimmed.includes(';base64,')) return false
  return true
}

function normalizeSignatureDataUrl(value) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  if (raw.startsWith('data:image/')) return raw
  const lower = raw.toLowerCase()
  if (lower.startsWith('data:application/octet-stream;base64,')) {
    return `data:image/png;base64,${raw.slice(raw.indexOf(',') + 1)}`
  }
  if (lower.startsWith('data:;base64,')) {
    return `data:image/png;base64,${raw.slice(raw.indexOf(',') + 1)}`
  }
  if (lower.startsWith('data:') && lower.includes(';base64,')) {
    return `data:image/png;base64,${raw.slice(raw.indexOf(',') + 1)}`
  }
  return raw
}

async function ensureCreditContractsSchema(conn) {
  await conn.query(`CREATE TABLE IF NOT EXISTS credit_contracts (
    id INT AUTO_INCREMENT PRIMARY KEY,
    sale_id INT NOT NULL,
    customer_id INT NOT NULL,
    warehouse_id INT NOT NULL,
    template_version VARCHAR(20) NOT NULL DEFAULT 'v1',
    html LONGTEXT NOT NULL,
    data_json LONGTEXT NOT NULL,
    sha256 CHAR(64) NOT NULL,
    buyer_signature_data LONGTEXT NULL,
    buyer_signed_at DATETIME NULL,
    created_by_user_id INT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NULL
  )`)
  await conn.query(`CREATE TABLE IF NOT EXISTS credit_contract_references (
    id INT AUTO_INCREMENT PRIMARY KEY,
    contract_id INT NOT NULL,
    ref_no INT NOT NULL,
    name VARCHAR(160) NULL,
    phone VARCHAR(60) NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`)
}

function validateCreditContractPayload(payload) {
  const customer = payload?.customer || {}
  const requiredMissing = []
  const phone = String(customer.phone || '').trim()
  const age = String(customer.age ?? '').trim()
  const nationality = String(customer.nationality || '').trim()
  const civilStatus = String(customer.civilStatus || '').trim()
  const occupation = String(customer.occupation || '').trim()
  const address = String(customer.address || '').trim()
  const municipality = String(customer.municipality || '').trim()
  const department = String(customer.department || '').trim()
  const dpi = String(customer.dpi || '').trim()
  const buyerSignatureData = normalizeSignatureDataUrl(payload?.buyerSignatureData)

  if (!phone) requiredMissing.push('Teléfono del cliente')
  if (!age) requiredMissing.push('Edad del cliente')
  if (!nationality) requiredMissing.push('Nacionalidad')
  if (!civilStatus) requiredMissing.push('Estado civil')
  if (!occupation) requiredMissing.push('Profesión u oficio')
  if (!address) requiredMissing.push('Dirección del cliente')
  if (!municipality) requiredMissing.push('Municipio')
  if (!department) requiredMissing.push('Departamento')
  if (!dpi) requiredMissing.push('DPI')
  if (!buyerSignatureData) requiredMissing.push('Firma del comprador')

  if (!buyerSignatureData || !isImageDataUrl(buyerSignatureData) || !buyerSignatureData.startsWith('data:image/')) {
    return { ok: false, error: 'Firma inválida' }
  }
  if (requiredMissing.length > 0) {
    return { ok: false, error: `Campos obligatorios faltantes: ${requiredMissing.join(', ')}` }
  }

  const refs = Array.isArray(payload?.references) ? payload.references : []
  const refTarget = 4
  const references = []
  for (let i = 0; i < Math.max(refTarget, refs.length); i++) {
    const r = refs[i] || {}
    references.push({ no: i + 1, name: String(r.name || '').trim(), phone: String(r.phone || '').trim() })
  }

  return {
    ok: true,
    value: {
      customer: {
        phone,
        age,
        nationality,
        civilStatus,
        occupation,
        address,
        municipality,
        department,
        dpi,
      },
      warrantyTime: String(payload?.warrantyTime || '').trim(),
      references,
      buyerSignatureData,
    },
  }
}

async function persistCreditContractForSale(conn, { saleId, customerId, warehouseId, issuerName, issuerUserId, contract, totalCredit, downPayment }) {
  await ensureCreditContractsSchema(conn)

  const [saleRows] = await conn.query(
    `
      SELECT s.id, s.total, s.warehouse_id,
             c.name AS customer_name, c.document AS customer_document,
             w.address AS warehouse_address, w.contract_phone AS warehouse_contract_phone, w.contract_facebook AS warehouse_contract_facebook
      FROM sales s
      LEFT JOIN customers c ON c.id = s.customer_id
      LEFT JOIN warehouses w ON w.id = s.warehouse_id
      WHERE s.id = ?
      LIMIT 1
    `,
    [saleId]
  )
  const sale = saleRows?.[0]
  if (!sale) throw new Error('Venta no encontrada para contrato')

  const branchAddress = String(sale.warehouse_address || '').trim()
  const branchPhone = String(sale.warehouse_contract_phone || '').trim()
  const branchFacebook = String(sale.warehouse_contract_facebook || 'Muebles Yatir.').trim()
  if (!branchAddress) throw new Error('La sucursal no tiene dirección configurada')
  if (!branchPhone) throw new Error('La sucursal no tiene CEL configurado para contratos')

  const now = new Date()
  const issueDay = String(now.getDate()).padStart(2, '0')
  const issueMonth = String(now.getMonth() + 1).padStart(2, '0')
  const issueYear = String(now.getFullYear())

  const [items] = await conn.query(
    `
      SELECT si.total, si.serial, si.imei,
             p.name AS product_name, p.product_code, b.name AS brand_name
      FROM sale_items si
      JOIN products p ON p.id = si.product_id
      LEFT JOIN brands b ON b.id = p.brand_id
      WHERE si.sale_id = ?
      ORDER BY si.id ASC
    `,
    [saleId]
  )

  const itemPayload = (items || []).map((row) => ({
    product: row.product_name || '',
    brand: row.brand_name || '',
    model: row.product_code || '',
    series: row.serial || row.imei || '',
    price: Number(row.total || 0),
  }))

  const [installments] = await conn.query(
    'SELECT id, due_date, amount, paid, paid_at FROM installments WHERE sale_id = ? AND paid = 0 ORDER BY due_date ASC, id ASC',
    [saleId]
  )
  const paymentsCount = Array.isArray(installments) ? installments.length : 0
  const installmentAmount = paymentsCount > 0 ? Number(installments[0].amount || 0) : 0
  const frequency = guessFrequencyLabel(installments || [])

  const installmentsStatus = (installments || []).map((it, index) => ({
    no: index + 1,
    dueDate: String(it.due_date || '').slice(0, 10),
    amount: Number(it.amount || 0),
    status: Number(it.paid || 0) ? 'PAGADA' : 'PENDIENTE',
    paidAt: it.paid_at ? String(it.paid_at).slice(0, 10) : '',
  }))

  const paymentRowsTarget = 14
  const payments = []
  for (let i = 0; i < paymentRowsTarget; i++) payments.push({ date: '', receiptNo: '', amount: '', balance: '' })

  const contractData = {
    saleId,
    warehouseId,
    customerId,
    branchAddress,
    branchPhone,
    branchFacebook,
    customerName: String(sale.customer_name || '').trim(),
    customerPhone: contract.customer.phone,
    customerAge: contract.customer.age,
    customerNationality: contract.customer.nationality,
    customerCivilStatus: contract.customer.civilStatus,
    customerOccupation: contract.customer.occupation,
    customerAddress: contract.customer.address,
    customerMunicipality: contract.customer.municipality,
    customerDepartment: contract.customer.department,
    customerDpi: contract.customer.dpi || String(sale.customer_document || '').trim(),
    issueDay,
    issueMonth,
    issueYear,
    issuerName,
    totalCredit,
    downPayment,
    paymentsCount,
    installmentAmount,
    frequency,
    warrantyTime: contract.warrantyTime,
    buyerSignatureData: contract.buyerSignatureData,
    items: itemPayload,
    installmentsStatus,
    totalPaid: 0,
    remainingBalance: Number(totalCredit || 0),
    isSettled: false,
    settlementDate: '',
    payments,
    references: contract.references,
  }

  const html = renderCreditContractHtml(contractData)
  const sha256 = computeSha256(html)
  const [ins] = await conn.query(
    `
      INSERT INTO credit_contracts (sale_id, customer_id, warehouse_id, template_version, html, data_json, sha256, buyer_signature_data, buyer_signed_at, created_by_user_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?, NOW())
    `,
    [saleId, customerId, warehouseId, 'v1', html, JSON.stringify(contractData), sha256, contract.buyerSignatureData, issuerUserId || null]
  )
  const contractId = ins.insertId
  for (const ref of contract.references || []) {
    await conn.query('INSERT INTO credit_contract_references (contract_id, ref_no, name, phone) VALUES (?, ?, ?, ?)', [
      contractId,
      Number(ref.no),
      ref.name || null,
      ref.phone || null,
    ])
  }

  await conn.query(
    `
      UPDATE customers
      SET phone = ?, address = ?, document = ?, age = ?, nationality = ?, civil_status = ?, occupation = ?, municipality = ?, department = ?
      WHERE id = ?
    `,
    [
      contract.customer.phone || null,
      contract.customer.address || null,
      contract.customer.dpi || null,
      Number.isFinite(Number(contract.customer.age)) ? Number(contract.customer.age) : null,
      contract.customer.nationality || null,
      contract.customer.civilStatus || null,
      contract.customer.occupation || null,
      contract.customer.municipality || null,
      contract.customer.department || null,
      customerId,
    ]
  )

  return { contractId, sha256 }
}

// Crear nueva venta
router.post('/', authMiddleware, async (req, res) => {
  try {
    const { customerId, items, total, isCredit, docNo, paymentMethod, receivedAmount, changeAmount, referenceNumber, sendToCashier, saveAsDraft, creditInstallments, creditContract, downPaymentAmount, downPaymentMethod, downPaymentReference } = req.body
    const canChangePosPrice = hasExplicitUserPermission(req.user, 'pos:change_price')
    const canUseManualPosPrice = hasExplicitUserPermission(req.user, 'pos:manual_price')

    if (!canUserSell(req.user)) {
      return res.status(403).json({ error: 'Tu usuario no tiene habilitadas las ventas en POS' })
    }
    
    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'No hay items en la venta' })
    }

    let requestedPaymentMethod = String(paymentMethod || '').trim().toUpperCase()
    if (requestedPaymentMethod === 'TRANSFER') requestedPaymentMethod = 'DEPOSIT'
    const requestedIsCredit = Boolean(isCredit) || requestedPaymentMethod === 'CREDIT'
    if (requestedIsCredit && !customerId) {
      return res.status(400).json({ error: 'Debes seleccionar un cliente para registrar una venta a crédito' })
    }

    const pool = await getPool()
    const conn = await pool.getConnection()
    const saleWarehouseId = getUserWarehouseId(req.user)

    if (!saleWarehouseId) {
      conn.release()
      return res.status(400).json({ error: 'El usuario no tiene una tienda asignada para vender' })
    }

    try {
      await conn.beginTransaction()
      await ensureSalesSchema(conn)
      const hasSalesUserId = await columnExists(conn, 'sales', 'user_id')
      const createPendingPayment = Boolean(sendToCashier)
      const createDraft = Boolean(saveAsDraft)
      const shouldPrepareCredit = (createPendingPayment || createDraft) && requestedIsCredit
      const plannedDownPaymentAmount = Math.max(0, Math.round(Number(downPaymentAmount || 0) * 100) / 100)
      let plannedDownPaymentMethod = String(downPaymentMethod || '').trim().toUpperCase() || 'CASH'
      if (!['CASH', 'CARD', 'DEPOSIT', 'TRANSFER'].includes(plannedDownPaymentMethod)) plannedDownPaymentMethod = 'CASH'
      if (plannedDownPaymentMethod === 'TRANSFER') plannedDownPaymentMethod = 'DEPOSIT'
      const plannedDownPaymentReference = String(downPaymentReference || '').trim() || null

      if (createPendingPayment && createDraft) {
        await conn.rollback()
        return res.status(400).json({ error: 'La venta no puede ser borrador y enviada a caja al mismo tiempo' })
      }

      if (createPendingPayment || createDraft) {
        if (!customerId) {
          await conn.rollback()
          return res.status(400).json({ error: 'Debes seleccionar un cliente real para guardar el borrador o enviar la venta a caja' })
        }
        const [customerRows] = await conn.query('SELECT id, name FROM customers WHERE id = ? LIMIT 1', [customerId])
        const customer = customerRows?.[0]
        if (!customer || !String(customer.name || '').trim()) {
          await conn.rollback()
          return res.status(400).json({ error: 'Debes seleccionar un cliente real (con nombre)' })
        }
      }

      let shift = null
      if (!createPendingPayment && !createDraft) {
        const [shiftRows] = await conn.query(
          'SELECT id, opened_at, opening_balance FROM cashbox_shifts WHERE opened_by = ? AND closed_at IS NULL ORDER BY id DESC LIMIT 1 FOR UPDATE',
          [req.user.id]
        )
        shift = shiftRows?.[0]
        if (!shift) {
          await conn.rollback()
          return res.status(400).json({ error: 'Caja cerrada. Debes abrir caja para realizar ventas.' })
        }
      }

      const pendingPaymentMethod = requestedIsCredit ? 'CREDIT' : (requestedPaymentMethod || (isCredit ? 'CREDIT' : 'CASH') || 'CASH')
      const finalPaymentMethod = (createPendingPayment || createDraft) ? 'PENDING' : (requestedPaymentMethod || (isCredit ? 'CREDIT' : 'CASH'))
      const finalStatus = createDraft ? 'DRAFT' : (createPendingPayment ? 'PENDING_PAYMENT' : 'COMPLETED')
      const finalIsCredit = (createPendingPayment || createDraft) ? 0 : (isCredit ? 1 : 0)
      const finalPaidByUserId = (createPendingPayment || createDraft) ? null : req.user.id
      const normalizedCreditInstallments = (!createPendingPayment && !createDraft && finalIsCredit)
        ? normalizeCreditInstallments(creditInstallments, total, { requireExplicit: true })
        : []
      const normalizedPlannedCreditInstallments = shouldPrepareCredit
        ? normalizeCreditInstallments(creditInstallments, Math.round(Math.max(0, Number(total || 0) - plannedDownPaymentAmount) * 100) / 100, { requireExplicit: true })
        : []

      let validatedCreditContract = null
      if ((!createPendingPayment && !createDraft && finalIsCredit) || shouldPrepareCredit) {
        const [customerRows] = await conn.query('SELECT id, name FROM customers WHERE id = ? LIMIT 1', [customerId])
        const customer = customerRows?.[0]
        if (!customer || !String(customer.name || '').trim()) {
          await conn.rollback()
          return res.status(400).json({ error: 'Debes seleccionar un cliente real (con nombre) para registrar una venta a crédito o preparar el contrato' })
        }

        const cc = validateCreditContractPayload(creditContract)
        if (!cc.ok) {
          await conn.rollback()
          return res.status(400).json({ error: cc.error })
        }
        validatedCreditContract = cc.value
      }
      if (shouldPrepareCredit) {
        const saleTotal = Math.round(Number(total || 0) * 100) / 100
        if (plannedDownPaymentAmount >= saleTotal - 0.01) {
          await conn.rollback()
          return res.status(400).json({ error: 'El enganche debe ser menor al total de la venta' })
        }
      }

      // 1. Crear Venta
      const saleInsertSql = hasSalesUserId
        ? 'INSERT INTO sales (customer_id, user_id, warehouse_id, doc_no, total, is_credit, payment_method, received_amount, change_amount, reference_number, status, paid_by_user_id, paid_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        : 'INSERT INTO sales (customer_id, warehouse_id, doc_no, total, is_credit, payment_method, received_amount, change_amount, reference_number, status, paid_by_user_id, paid_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      const saleInsertParams = hasSalesUserId
        ? [customerId || null, req.user.id, saleWarehouseId, docNo || null, total, finalIsCredit, finalPaymentMethod, (createPendingPayment || createDraft) ? 0 : (receivedAmount || 0), (createPendingPayment || createDraft) ? 0 : (changeAmount || 0), (createPendingPayment || createDraft) ? null : (referenceNumber || null), finalStatus, finalPaidByUserId, (createPendingPayment || createDraft) ? null : new Date()]
        : [customerId || null, saleWarehouseId, docNo || null, total, finalIsCredit, finalPaymentMethod, (createPendingPayment || createDraft) ? 0 : (receivedAmount || 0), (createPendingPayment || createDraft) ? 0 : (changeAmount || 0), (createPendingPayment || createDraft) ? null : (referenceNumber || null), finalStatus, finalPaidByUserId, (createPendingPayment || createDraft) ? null : new Date()]
      const [saleResult] = await conn.query(saleInsertSql, saleInsertParams)
      const saleId = saleResult.insertId

      if (createPendingPayment || createDraft) {
        await conn.query(
          `
            UPDATE sales
            SET pending_payment_method = ?,
                pending_reference_number = ?,
                pending_down_payment_amount = ?,
                pending_down_payment_method = ?,
                pending_down_payment_reference = ?
            WHERE id = ?
          `,
          [
            pendingPaymentMethod || null,
            ['CARD', 'DEPOSIT'].includes(pendingPaymentMethod) ? (String(referenceNumber || '').trim() || null) : null,
            shouldPrepareCredit ? plannedDownPaymentAmount : null,
            shouldPrepareCredit ? plannedDownPaymentMethod : null,
            shouldPrepareCredit ? plannedDownPaymentReference : null,
            saleId,
          ]
        )
      }

      // 1.1 Si es crédito, crear plan de cuotas
      if (!createPendingPayment && !createDraft && finalIsCredit) {
        await createInstallments(conn, saleId, normalizedCreditInstallments)
      }
      if (shouldPrepareCredit) {
        await createInstallments(conn, saleId, normalizedPlannedCreditInstallments)
      }

      // 2. Procesar items
      for (const item of items) {
        // item: { productId, quantity, price, imei, serial }
        const [productRows] = await conn.query(
          'SELECT price, price2, price3, product_type, avg_cost, cost FROM products WHERE id = ? LIMIT 1',
          [item.productId]
        )
        const productPriceRow = productRows?.[0]
        if (!productPriceRow) {
          throw new Error(`Producto no encontrado: ${item.productId}`)
        }
        const productType = String(productPriceRow.product_type || 'GENERAL').toUpperCase()

        const requestedPrice = Number(item.price)
        const originalUnitPrice = Number(productPriceRow.price || 0)
        const requestedPriceSource = String(item.priceSource || '').trim().toUpperCase()
        const allowedPrices = [
          originalUnitPrice,
          Number(productPriceRow.price2 || 0),
          Number(productPriceRow.price3 || 0),
        ].filter(price => Number.isFinite(price) && price > 0)

        if (requestedPrice <= 0 || !Number.isFinite(requestedPrice)) {
          await conn.rollback()
          return res.status(400).json({ error: 'El precio del item no es valido' })
        }

        let priceSource = 'BASE'

        if (canUseManualPosPrice && requestedPriceSource === 'MANUAL') {
          priceSource = 'MANUAL'
        } else if (!canChangePosPrice) {
          if (Math.abs(requestedPrice - originalUnitPrice) > 0.0001) {
            await conn.rollback()
            return res.status(403).json({ error: 'Tu usuario no tiene permiso para cambiar precios en POS' })
          }
        } else if (!allowedPrices.some(price => Math.abs(price - requestedPrice) <= 0.0001)) {
          if (canUseManualPosPrice) {
            priceSource = 'MANUAL'
          } else {
            await conn.rollback()
            return res.status(400).json({ error: 'El precio seleccionado no es valido para este producto' })
          }
        } else if (Math.abs(requestedPrice - Number(productPriceRow.price2 || 0)) <= 0.0001) {
          priceSource = 'PRICE2'
        } else if (Math.abs(requestedPrice - Number(productPriceRow.price3 || 0)) <= 0.0001) {
          priceSource = 'PRICE3'
        }

        if (requestedPriceSource === 'MANUAL' && !canUseManualPosPrice) {
          await conn.rollback()
          return res.status(403).json({ error: 'Tu usuario no tiene permiso para ingresar precio manual en POS' })
        }

        if (productType === 'SERIAL') {
          if (!item.serial) {
            await conn.rollback()
            return res.status(400).json({ error: `Debes seleccionar la serie exacta para vender el producto ${item.productId}` })
          }
          if (Number(item.quantity) !== 1) {
            await conn.rollback()
            return res.status(400).json({ error: `Los productos con serie solo pueden venderse una unidad por item (${item.productId})` })
          }
        }

        if (productType === 'IMEI') {
          if (!item.imei) {
            await conn.rollback()
            return res.status(400).json({ error: `Debes seleccionar el IMEI exacto para vender el producto ${item.productId}` })
          }
          if (Number(item.quantity) !== 1) {
            await conn.rollback()
            return res.status(400).json({ error: `Los productos con IMEI solo pueden venderse una unidad por item (${item.productId})` })
          }
        }

        const itemTotal = Number(item.price) * Number(item.quantity)
        const unitCostSnapshot = Math.round(Number(productPriceRow.avg_cost ?? productPriceRow.cost ?? 0) * 100) / 100
        const totalCostSnapshot = Math.round(unitCostSnapshot * Number(item.quantity || 0) * 100) / 100
        
        // Insertar sale_item
        await conn.query(
          'INSERT INTO sale_items (sale_id, product_id, quantity, unit_price, total, serial, imei, batch_no, expiry_date, original_unit_price, price_source, unit_cost_snapshot, total_cost_snapshot) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [saleId, item.productId, item.quantity, item.price, itemTotal, item.serial || null, item.imei || null, item.batchNo || null, item.expiryDate || null, originalUnitPrice, priceSource, unitCostSnapshot, totalCostSnapshot]
        )

        if (createDraft) {
          continue
        }

        if (item.serial) {
             const [serialResult] = await conn.query(
               'UPDATE product_serials SET status = "SOLD" WHERE product_id = ? AND serial_no = ? AND warehouse_id = ? AND status = "AVAILABLE"',
               [item.productId, item.serial, saleWarehouseId]
             )
             if (!serialResult.affectedRows) {
               throw new Error(`La serie ${item.serial} no está disponible para la venta en la tienda seleccionada`)
             }
        } else if (item.imei) {
             const [imeiResult] = await conn.query(
               'UPDATE product_imeis SET status = "SOLD" WHERE product_id = ? AND imei = ? AND warehouse_id = ? AND status = "AVAILABLE"',
               [item.productId, item.imei, saleWarehouseId]
             )
             if (!imeiResult.affectedRows) {
               throw new Error(`El IMEI ${item.imei} no está disponible para la venta en la tienda seleccionada`)
             }
        } else if (item.batchNo) {
            // Producto medicinal con lote
             const [batchResult] = await conn.query(
               'UPDATE product_batches SET quantity = quantity - ? WHERE product_id = ? AND batch_no = ? AND warehouse_id = ? AND quantity >= ?',
               [item.quantity, item.productId, item.batchNo, saleWarehouseId, item.quantity]
             )
             if (!batchResult.affectedRows) {
               throw new Error(`El lote ${item.batchNo} no está disponible para la venta en la tienda seleccionada`)
             }
        }

        // Registrar movimiento de inventario (SALE)
        // Esto actualiza product_warehouse_stock y crea entrada en inventory_movements
        await registerMovement({
            productId: item.productId,
            warehouseId: saleWarehouseId, // Tienda
            type: 'SALE',
            quantity: item.quantity,
            referenceId: saleId,
            userId: req.user?.id,
            notes: `Venta #${saleResult.insertId}`
        }, conn)
      }

      if (!createPendingPayment && !createDraft && finalIsCredit && validatedCreditContract) {
        await persistCreditContractForSale(conn, {
          saleId,
          customerId: Number(customerId),
          warehouseId: Number(saleWarehouseId),
          issuerName: String(req.user?.name || '').trim() || 'SISTEMA',
          issuerUserId: req.user?.id || null,
          contract: validatedCreditContract,
          totalCredit: Number(total || 0),
          downPayment: 0,
        })
      }

      if ((createPendingPayment || createDraft) && requestedIsCredit && validatedCreditContract) {
        await persistCreditContractForSale(conn, {
          saleId,
          customerId: Number(customerId),
          warehouseId: Number(saleWarehouseId),
          issuerName: String(req.user?.name || '').trim() || 'SISTEMA',
          issuerUserId: req.user?.id || null,
          contract: validatedCreditContract,
          totalCredit: Number(total || 0),
          downPayment: plannedDownPaymentAmount,
        })
      }

      if (!createPendingPayment && !createDraft && finalPaymentMethod === 'CASH') {
        await conn.query(
          'INSERT INTO cash_movements (shift_id, type, concept, amount, ref_type, ref_id) VALUES (?, "IN", ?, ?, "SALE", ?)',
          [shift.id, `Venta #${saleId}`, total, saleId]
        )
      }

      await conn.commit()
      res.json({ success: true, saleId, status: finalStatus })

    } catch (err) {
      await conn.rollback()
      console.error('Error creando venta:', err)
      res.status(err?.statusCode || 500).json({ error: err?.message || 'Error al procesar la venta' })
    } finally {
      conn.release()
    }

  } catch (err) {
    console.error('Sales POST error:', err)
    res.status(500).json({ error: 'Server error' })
  }
})

router.get('/drafts', authMiddleware, async (req, res) => {
  try {
    if (!canUserSell(req.user)) {
      return res.status(403).json({ error: 'Tu usuario no tiene habilitadas las ventas en POS' })
    }

    const pool = await getPool()
    await ensureSalesSchema(pool)

    const isAdmin = isAdminUser(req.user)
    const userWarehouseId = getUserWarehouseId(req.user)
    if (!isAdmin && !userWarehouseId) {
      return res.json({ items: [] })
    }

    const limit = Math.max(1, Math.min(200, Number(req.query.limit || 100)))
    const onlyMine = String(req.query.onlyMine || '1') !== '0'

    const where = []
    const params = []

    where.push(`s.status = 'DRAFT'`)
    where.push(`s.payment_method = 'PENDING'`)

    if (!isAdmin) {
      where.push('s.warehouse_id = ?')
      params.push(Number(userWarehouseId))
      if (onlyMine) {
        where.push('s.user_id = ?')
        params.push(Number(req.user.id))
      }
    } else if (Number(req.query.warehouseId || 0) > 0) {
      where.push('s.warehouse_id = ?')
      params.push(Number(req.query.warehouseId))
    }

    const [rows] = await pool.query(
      `
        SELECT
          s.id,
          s.total,
          s.doc_no,
          s.customer_id,
          s.user_id,
          s.warehouse_id,
          s.created_at,
          c.name AS customer_name,
          u.name AS seller_name
        FROM sales s
        LEFT JOIN customers c ON c.id = s.customer_id
        LEFT JOIN users u ON u.id = s.user_id
        WHERE ${where.join(' AND ')}
        ORDER BY s.id DESC
        LIMIT ?
      `,
      [...params, limit]
    )

    return res.json({ items: rows || [] })
  } catch (err) {
    console.error('Sales drafts GET error:', err)
    return res.status(500).json({ error: 'Server error' })
  }
})

router.put('/:id/draft', authMiddleware, async (req, res) => {
  try {
    if (!canUserSell(req.user)) {
      return res.status(403).json({ error: 'Tu usuario no tiene habilitadas las ventas en POS' })
    }

    const saleId = Number(req.params.id)
    const { customerId, items, total, docNo } = req.body || {}

    if (!Number.isFinite(saleId) || saleId <= 0) {
      return res.status(400).json({ error: 'Venta inválida' })
    }
    if (!customerId) {
      return res.status(400).json({ error: 'Debes seleccionar un cliente real' })
    }
    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'No hay items en la venta' })
    }

    const canChangePosPrice = hasExplicitUserPermission(req.user, 'pos:change_price')
    const canUseManualPosPrice = hasExplicitUserPermission(req.user, 'pos:manual_price')

    const pool = await getPool()
    const conn = await pool.getConnection()

    try {
      await conn.beginTransaction()
      await ensureSalesSchema(conn)

      const isAdmin = isAdminUser(req.user)
      const userWarehouseId = getUserWarehouseId(req.user)
      if (!isAdmin && !userWarehouseId) {
        await conn.rollback()
        return res.status(403).json({ error: 'El usuario no tiene una tienda asignada para vender' })
      }

      const where = !isAdmin ? ' AND warehouse_id = ? AND user_id = ?' : ''
      const params = !isAdmin ? [saleId, Number(userWarehouseId), Number(req.user.id)] : [saleId]
      const [saleRows] = await conn.query(`SELECT * FROM sales WHERE id = ?${where} FOR UPDATE`, params)
      const sale = saleRows?.[0]
      if (!sale) {
        await conn.rollback()
        return res.status(404).json({ error: 'Venta no encontrada' })
      }
      if (String(sale.status || '').toUpperCase() !== 'DRAFT') {
        await conn.rollback()
        return res.status(400).json({ error: 'Solo puedes editar ventas en borrador' })
      }

      const [customerRows] = await conn.query('SELECT id, name FROM customers WHERE id = ? LIMIT 1', [customerId])
      const customer = customerRows?.[0]
      if (!customer || !String(customer.name || '').trim()) {
        await conn.rollback()
        return res.status(400).json({ error: 'Debes seleccionar un cliente real (con nombre)' })
      }

      await conn.query(
        'UPDATE sales SET customer_id = ?, doc_no = ?, total = ? WHERE id = ?',
        [customerId, docNo || null, Number(total || 0), saleId]
      )

      await conn.query('DELETE FROM sale_items WHERE sale_id = ?', [saleId])

      for (const item of items) {
        const [productRows] = await conn.query(
          'SELECT price, price2, price3, product_type, avg_cost, cost FROM products WHERE id = ? LIMIT 1',
          [item.productId]
        )
        const productPriceRow = productRows?.[0]
        if (!productPriceRow) {
          throw new Error(`Producto no encontrado: ${item.productId}`)
        }
        const productType = String(productPriceRow.product_type || 'GENERAL').toUpperCase()

        const requestedPrice = Number(item.price)
        const originalUnitPrice = Number(productPriceRow.price || 0)
        const requestedPriceSource = String(item.priceSource || '').trim().toUpperCase()
        const allowedPrices = [
          originalUnitPrice,
          Number(productPriceRow.price2 || 0),
          Number(productPriceRow.price3 || 0),
        ].filter(price => Number.isFinite(price) && price > 0)

        if (requestedPrice <= 0 || !Number.isFinite(requestedPrice)) {
          throw new Error('El precio del item no es válido')
        }

        let priceSource = 'BASE'

        if (canUseManualPosPrice && requestedPriceSource === 'MANUAL') {
          priceSource = 'MANUAL'
        } else if (!canChangePosPrice) {
          if (Math.abs(requestedPrice - originalUnitPrice) > 0.0001) {
            const err = new Error('Tu usuario no tiene permiso para cambiar precios en POS')
            err.statusCode = 403
            throw err
          }
        } else if (!allowedPrices.some(price => Math.abs(price - requestedPrice) <= 0.0001)) {
          if (canUseManualPosPrice) {
            priceSource = 'MANUAL'
          } else {
            throw new Error('El precio seleccionado no es válido para este producto')
          }
        } else if (Math.abs(requestedPrice - Number(productPriceRow.price2 || 0)) <= 0.0001) {
          priceSource = 'PRICE2'
        } else if (Math.abs(requestedPrice - Number(productPriceRow.price3 || 0)) <= 0.0001) {
          priceSource = 'PRICE3'
        }

        if (requestedPriceSource === 'MANUAL' && !canUseManualPosPrice) {
          const err = new Error('Tu usuario no tiene permiso para ingresar precio manual en POS')
          err.statusCode = 403
          throw err
        }

        if (productType === 'SERIAL') {
          if (!item.serial) {
            throw new Error(`Debes seleccionar la serie exacta para vender el producto ${item.productId}`)
          }
          if (Number(item.quantity) !== 1) {
            throw new Error(`Los productos con serie solo pueden venderse una unidad por item (${item.productId})`)
          }
        }

        if (productType === 'IMEI') {
          if (!item.imei) {
            throw new Error(`Debes seleccionar el IMEI exacto para vender el producto ${item.productId}`)
          }
          if (Number(item.quantity) !== 1) {
            throw new Error(`Los productos con IMEI solo pueden venderse una unidad por item (${item.productId})`)
          }
        }

        const itemTotal = Number(item.price) * Number(item.quantity)
        const unitCostSnapshot = Math.round(Number(productPriceRow.avg_cost ?? productPriceRow.cost ?? 0) * 100) / 100
        const totalCostSnapshot = Math.round(unitCostSnapshot * Number(item.quantity || 0) * 100) / 100

        await conn.query(
          'INSERT INTO sale_items (sale_id, product_id, quantity, unit_price, total, serial, imei, batch_no, expiry_date, original_unit_price, price_source, unit_cost_snapshot, total_cost_snapshot) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [saleId, item.productId, item.quantity, item.price, itemTotal, item.serial || null, item.imei || null, item.batchNo || null, item.expiryDate || null, originalUnitPrice, priceSource, unitCostSnapshot, totalCostSnapshot]
        )
      }

      await conn.commit()
      return res.json({ success: true, saleId })
    } catch (err) {
      await conn.rollback()
      console.error('Sale draft update error:', err)
      return res.status(err?.statusCode || 500).json({ error: err?.message || 'Error al guardar el borrador' })
    } finally {
      conn.release()
    }
  } catch (err) {
    console.error('Sale draft PUT error:', err)
    return res.status(500).json({ error: 'Server error' })
  }
})

router.post('/:id/send-to-cashier', authMiddleware, async (req, res) => {
  try {
    if (!canUserSell(req.user)) {
      return res.status(403).json({ error: 'Tu usuario no tiene habilitadas las ventas en POS' })
    }

    const saleId = Number(req.params.id)
    if (!Number.isFinite(saleId) || saleId <= 0) {
      return res.status(400).json({ error: 'Venta inválida' })
    }

    const pool = await getPool()
    const conn = await pool.getConnection()
    const isAdmin = isAdminUser(req.user)
    const userWarehouseId = getUserWarehouseId(req.user)

    if (!isAdmin && !userWarehouseId) {
      conn.release()
      return res.status(400).json({ error: 'El usuario no tiene una tienda asignada para vender' })
    }

    try {
      await conn.beginTransaction()
      await ensureSalesSchema(conn)

      const where = !isAdmin ? ' AND warehouse_id = ? AND user_id = ?' : ''
      const params = !isAdmin ? [saleId, Number(userWarehouseId), Number(req.user?.id || 0)] : [saleId]

      const [saleRows] = await conn.query(`SELECT * FROM sales WHERE id = ?${where} FOR UPDATE`, params)
      const sale = saleRows?.[0]
      if (!sale) {
        await conn.rollback()
        return res.status(404).json({ error: 'Venta no encontrada' })
      }

      const saleWarehouseId = Number(sale.warehouse_id || 0)
      if (!saleWarehouseId) {
        await conn.rollback()
        return res.status(400).json({ error: 'La venta no tiene tienda asignada' })
      }

      if (String(sale.status || '').toUpperCase() !== 'DRAFT') {
        await conn.rollback()
        return res.status(400).json({ error: 'Solo puedes enviar a caja ventas en borrador' })
      }

      const [customerRows] = await conn.query('SELECT id, name FROM customers WHERE id = ? LIMIT 1', [sale.customer_id])
      const customer = customerRows?.[0]
      if (!customer || !String(customer.name || '').trim()) {
        await conn.rollback()
        return res.status(400).json({ error: 'Debes seleccionar un cliente real (con nombre) para enviar la venta a caja' })
      }

      const [items] = await conn.query('SELECT * FROM sale_items WHERE sale_id = ? ORDER BY id ASC', [saleId])
      if (!Array.isArray(items) || items.length === 0) {
        await conn.rollback()
        return res.status(400).json({ error: 'El borrador no tiene items' })
      }

      for (const item of items) {
        const [productRows] = await conn.query(
          'SELECT product_type FROM products WHERE id = ? LIMIT 1',
          [item.product_id]
        )
        const product = productRows?.[0]
        if (!product) {
          throw new Error(`Producto no encontrado: ${item.product_id}`)
        }
        const productType = String(product.product_type || 'GENERAL').toUpperCase()

        if (productType === 'SERIAL') {
          if (!item.serial) {
            await conn.rollback()
            return res.status(400).json({ error: `Debes seleccionar la serie exacta para vender el producto ${item.product_id}` })
          }
          if (Number(item.quantity) !== 1) {
            await conn.rollback()
            return res.status(400).json({ error: `Los productos con serie solo pueden venderse una unidad por item (${item.product_id})` })
          }
          const [serialResult] = await conn.query(
            'UPDATE product_serials SET status = "SOLD" WHERE product_id = ? AND serial_no = ? AND warehouse_id = ? AND status = "AVAILABLE"',
            [item.product_id, item.serial, saleWarehouseId]
          )
          if (!serialResult.affectedRows) {
            throw new Error(`La serie ${item.serial} no está disponible para la venta en la tienda seleccionada`)
          }
        }

        if (productType === 'IMEI') {
          if (!item.imei) {
            await conn.rollback()
            return res.status(400).json({ error: `Debes seleccionar el IMEI exacto para vender el producto ${item.product_id}` })
          }
          if (Number(item.quantity) !== 1) {
            await conn.rollback()
            return res.status(400).json({ error: `Los productos con IMEI solo pueden venderse una unidad por item (${item.product_id})` })
          }
          const [imeiResult] = await conn.query(
            'UPDATE product_imeis SET status = "SOLD" WHERE product_id = ? AND imei = ? AND warehouse_id = ? AND status = "AVAILABLE"',
            [item.product_id, item.imei, saleWarehouseId]
          )
          if (!imeiResult.affectedRows) {
            throw new Error(`El IMEI ${item.imei} no está disponible para la venta en la tienda seleccionada`)
          }
        }

        if (item.batch_no) {
          const [batchResult] = await conn.query(
            'UPDATE product_batches SET quantity = quantity - ? WHERE product_id = ? AND batch_no = ? AND warehouse_id = ? AND quantity >= ?',
            [item.quantity, item.product_id, item.batch_no, saleWarehouseId, item.quantity]
          )
          if (!batchResult.affectedRows) {
            throw new Error(`El lote ${item.batch_no} no está disponible para la venta en la tienda seleccionada`)
          }
        }

        await registerMovement({
          productId: item.product_id,
          warehouseId: saleWarehouseId,
          type: 'SALE',
          quantity: item.quantity,
          referenceId: saleId,
          userId: req.user?.id,
          notes: `Venta #${saleId}`
        }, conn)
      }

      await conn.query(
        "UPDATE sales SET status = 'PENDING_PAYMENT', payment_method = 'PENDING', is_credit = 0, received_amount = 0, change_amount = 0, reference_number = NULL, paid_by_user_id = NULL, paid_at = NULL WHERE id = ?",
        [saleId]
      )

      await conn.commit()
      return res.json({ success: true, saleId, status: 'PENDING_PAYMENT' })
    } catch (err) {
      await conn.rollback()
      console.error('Sale send-to-cashier error:', err)
      return res.status(err?.statusCode || 500).json({ error: err?.message || 'Error al enviar la venta a caja' })
    } finally {
      conn.release()
    }
  } catch (err) {
    console.error('Sale send-to-cashier POST error:', err)
    return res.status(500).json({ error: 'Server error' })
  }
})

router.get('/pending-payment', authMiddleware, async (req, res) => {
  try {
    if (
      !hasUserPermission(req.user, 'cash:view')
      && !hasUserPermission(req.user, 'cash:open')
      && !hasUserPermission(req.user, 'cash:movements')
      && !hasUserPermission(req.user, 'cash:close')
    ) {
      return res.status(403).json({ error: 'No tienes permisos para consultar ventas pendientes de cobro' })
    }

    const pool = await getPool()
    await ensureSalesSchema(pool)

    let warehouseId = getUserWarehouseId(req.user)

    if (isAdminUser(req.user)) {
      const requestedWarehouseId = Number(req.query.warehouseId || 0)
      const requestedUserId = Number(req.query.userId || 0)
      if (requestedWarehouseId > 0) {
        warehouseId = requestedWarehouseId
      } else if (requestedUserId > 0) {
        const [userRows] = await pool.query('SELECT warehouse_id FROM users WHERE id = ? LIMIT 1', [requestedUserId])
        const resolvedWarehouseId = Number(userRows?.[0]?.warehouse_id || 0)
        warehouseId = resolvedWarehouseId > 0 ? resolvedWarehouseId : null
      }
    }

    if (!warehouseId) {
      return res.json({ items: [] })
    }

    const limit = Math.max(1, Math.min(200, Number(req.query.limit || 100)))
    const [rows] = await pool.query(
      `
        SELECT
          s.id,
          s.doc_no,
          s.total,
          s.created_at,
          s.pending_payment_method,
          s.pending_reference_number,
          s.pending_down_payment_amount,
          s.pending_down_payment_method,
          s.pending_down_payment_reference,
          c.name AS customer_name,
          u.name AS seller_name,
          COUNT(si.id) AS items_count
        FROM sales s
        LEFT JOIN customers c ON c.id = s.customer_id
        LEFT JOIN users u ON u.id = s.user_id
        LEFT JOIN sale_items si ON si.sale_id = s.id
        WHERE s.warehouse_id = ?
          AND COALESCE(s.status, 'COMPLETED') = 'PENDING_PAYMENT'
        GROUP BY s.id, s.doc_no, s.total, s.created_at, s.pending_payment_method, s.pending_reference_number, s.pending_down_payment_amount, s.pending_down_payment_method, s.pending_down_payment_reference, c.name, u.name
        ORDER BY s.created_at ASC, s.id ASC
        LIMIT ?
      `,
      [warehouseId, limit]
    )

    return res.json({
      items: (rows || []).map(row => ({
        id: Number(row.id),
        docNo: row.doc_no || '',
        total: Number(row.total || 0),
        createdAt: row.created_at,
        pendingPaymentMethod: row.pending_payment_method || null,
        pendingReferenceNumber: row.pending_reference_number || null,
        pendingDownPaymentAmount: row.pending_down_payment_amount != null ? Number(row.pending_down_payment_amount) : null,
        pendingDownPaymentMethod: row.pending_down_payment_method || null,
        pendingDownPaymentReference: row.pending_down_payment_reference || null,
        customerName: row.customer_name || 'SIN CLIENTE',
        sellerName: row.seller_name || 'SIN VENDEDOR',
        itemsCount: Number(row.items_count || 0),
      })),
    })
  } catch (err) {
    console.error('Pending payment sales error:', err)
    return res.status(500).json({ error: 'Server error' })
  }
})

router.post('/:id/collect-payment', authMiddleware, (req, res, next) => {
  uploadPaymentDocument.fields([
    { name: 'document', maxCount: 1 },
    { name: 'downPaymentDocument', maxCount: 1 },
  ])(req, res, (err) => {
    if (err) return res.status(400).json({ error: err?.message || 'Documento inválido' })
    return next()
  })
}, async (req, res) => {
  try {
    // #region debug-point credit-installment-mismatch-start
    await __dbgReport({
      point: 'collect-payment-start',
      saleId: Number(req.params.id || 0),
      bodyKeys: Object.keys(req.body || {}),
      paymentMethod: req.body?.paymentMethod,
      receivedAmount: req.body?.receivedAmount,
      referenceNumber: req.body?.referenceNumber,
      downPaymentAmount: req.body?.downPaymentAmount,
      hasFile: Boolean(req.files?.document?.[0] || req.files?.downPaymentDocument?.[0]),
      creditInstallmentsType: typeof req.body?.creditInstallments,
      creditInstallmentsPreview: typeof req.body?.creditInstallments === 'string'
        ? String(req.body.creditInstallments).slice(0, 160)
        : Array.isArray(req.body?.creditInstallments) ? 'array' : 'other',
    })
    // #endregion debug-point credit-installment-mismatch-start

    if (
      !hasUserPermission(req.user, 'cash:view')
      && !hasUserPermission(req.user, 'cash:open')
      && !hasUserPermission(req.user, 'cash:movements')
      && !hasUserPermission(req.user, 'cash:close')
    ) {
      return res.status(403).json({ error: 'No tienes permisos para cobrar ventas' })
    }

    const saleId = Number(req.params.id || 0)
    const { paymentMethod, receivedAmount, changeAmount, referenceNumber, downPaymentAmount, downPaymentMethod, downPaymentReference } = req.body
    let creditInstallments = req.body?.creditInstallments
    if (typeof creditInstallments === 'string') {
      try {
        creditInstallments = JSON.parse(creditInstallments)
      } catch {
        creditInstallments = null
      }
    }

    if (!saleId) {
      return res.status(400).json({ error: 'Venta inválida' })
    }

    let finalPaymentMethod = String(paymentMethod || '').trim().toUpperCase()
    if (!['CASH', 'CARD', 'DEPOSIT', 'TRANSFER', 'CREDIT'].includes(finalPaymentMethod)) {
      return res.status(400).json({ error: 'Método de pago inválido' })
    }
    if (finalPaymentMethod === 'TRANSFER') {
      finalPaymentMethod = 'DEPOSIT'
    }

    const finalReceivedAmount = Number(receivedAmount || 0)
    const finalChangeAmount = Number(changeAmount || 0)
    const finalReferenceNumber = String(referenceNumber || '').trim() || null
    const paymentDocumentFile = req.files?.document?.[0] || null
    const downPaymentDocumentFile = req.files?.downPaymentDocument?.[0] || null
    const paymentDocumentUrl = paymentDocumentFile?.filename ? `/uploads/${paymentDocumentFile.filename}` : null
    const downPaymentDocumentUrl = downPaymentDocumentFile?.filename ? `/uploads/${downPaymentDocumentFile.filename}` : null
    const finalDownPaymentAmount = Math.max(0, Math.round(Number(downPaymentAmount || 0) * 100) / 100)
    let finalDownPaymentMethod = String(downPaymentMethod || '').trim().toUpperCase() || 'CASH'
    if (!['CASH', 'CARD', 'DEPOSIT', 'TRANSFER'].includes(finalDownPaymentMethod)) {
      finalDownPaymentMethod = 'CASH'
    }
    if (finalDownPaymentMethod === 'TRANSFER') {
      finalDownPaymentMethod = 'DEPOSIT'
    }
    const finalDownPaymentReference = String(downPaymentReference || '').trim() || null

    const pool = await getPool()
    const conn = await pool.getConnection()

    try {
      await conn.beginTransaction()
      await ensureSalesSchema(conn)

      const userWarehouseId = getUserWarehouseId(req.user)
      if (!isAdminUser(req.user) && !userWarehouseId) {
        await conn.rollback()
        return res.status(403).json({ error: 'No tienes una tienda asignada para cobrar ventas' })
      }

      const saleWhere = !isAdminUser(req.user) ? ' AND warehouse_id = ?' : ''
      const saleParams = !isAdminUser(req.user) ? [saleId, userWarehouseId] : [saleId]
      const [saleRows] = await conn.query(`SELECT * FROM sales WHERE id = ?${saleWhere} FOR UPDATE`, saleParams)
      const sale = saleRows?.[0]

      if (!sale) {
        await conn.rollback()
        return res.status(404).json({ error: 'Venta no encontrada' })
      }

      // #region debug-point credit-installment-mismatch-sale-loaded
      await __dbgReport({
        point: 'sale-loaded',
        saleId,
        saleStatus: sale?.status,
        saleTotal: sale?.total,
        saleWarehouseId: sale?.warehouse_id,
        saleCustomerId: sale?.customer_id,
        salePaymentMethod: sale?.payment_method,
        saleIsCredit: sale?.is_credit,
        downPaymentAmount: finalDownPaymentAmount,
      })
      // #endregion debug-point credit-installment-mismatch-sale-loaded

      if (String(sale.status || 'COMPLETED').toUpperCase() !== 'PENDING_PAYMENT') {
        await conn.rollback()
        return res.status(400).json({ error: 'La venta ya fue cobrada o no está pendiente de pago' })
      }

      if ((finalPaymentMethod === 'CARD' || finalPaymentMethod === 'DEPOSIT') && !finalReferenceNumber) {
        await conn.rollback()
        return res.status(400).json({ error: 'Referencia requerida para tarjeta o depósito/transferencia' })
      }

      if (finalPaymentMethod === 'CASH' && finalReceivedAmount < Number(sale.total || 0)) {
        await conn.rollback()
        return res.status(400).json({ error: 'El monto recibido es menor al total de la venta' })
      }

      if (finalPaymentMethod === 'DEPOSIT' && !paymentDocumentUrl) {
        await conn.rollback()
        return res.status(400).json({ error: 'Debes adjuntar la foto del comprobante para depósito/transferencia' })
      }

      if (finalPaymentMethod === 'CREDIT' && !sale.customer_id) {
        await conn.rollback()
        return res.status(400).json({ error: 'Debes asignar un cliente a la venta antes de enviarla a crédito' })
      }
      if (finalPaymentMethod === 'CREDIT') {
        const [cRows] = await conn.query(
          'SELECT id FROM credit_contracts WHERE sale_id = ? AND buyer_signature_data IS NOT NULL AND buyer_signed_at IS NOT NULL LIMIT 1',
          [saleId]
        )
        if (!cRows?.length) {
          await conn.rollback()
          return res.status(400).json({ error: 'Debes generar y firmar el contrato antes de enviar la venta a crédito' })
        }
      }
      if (finalPaymentMethod === 'CREDIT' && finalDownPaymentAmount > 0) {
        if (['CARD', 'DEPOSIT'].includes(finalDownPaymentMethod) && !finalDownPaymentReference) {
          await conn.rollback()
          return res.status(400).json({ error: 'Referencia requerida para el enganche (tarjeta o depósito/transferencia)' })
        }
        if (finalDownPaymentMethod === 'DEPOSIT' && !downPaymentDocumentUrl) {
          await conn.rollback()
          return res.status(400).json({ error: 'Debes adjuntar la foto del comprobante del enganche' })
        }
      }

      const [shiftRows] = await conn.query(
        'SELECT id FROM cashbox_shifts WHERE opened_by = ? AND closed_at IS NULL ORDER BY id DESC LIMIT 1 FOR UPDATE',
        [req.user.id]
      )
      const shift = shiftRows?.[0]
      if (!shift) {
        await conn.rollback()
        return res.status(400).json({ error: 'Caja cerrada. Debes abrir caja para cobrar ventas.' })
      }

      const finalIsCredit = finalPaymentMethod === 'CREDIT' ? 1 : 0

      // #region debug-point credit-installment-mismatch-before-update
      await __dbgReport({
        point: 'before-update-sale',
        saleId,
        finalPaymentMethod,
        finalIsCredit,
        referenceNumber: finalReferenceNumber,
        paymentDocumentUrl,
      })
      // #endregion debug-point credit-installment-mismatch-before-update

      await conn.query(
        `UPDATE sales
         SET is_credit = ?,
             payment_method = ?,
             received_amount = ?,
             change_amount = ?,
             reference_number = ?,
             payment_document_url = ?,
             status = 'COMPLETED',
             paid_by_user_id = ?,
             paid_at = NOW()
         WHERE id = ?`,
        [
          finalIsCredit,
          finalPaymentMethod,
          finalPaymentMethod === 'CASH' ? finalReceivedAmount : 0,
          finalPaymentMethod === 'CASH' ? finalChangeAmount : 0,
          ['CARD', 'DEPOSIT'].includes(finalPaymentMethod) ? finalReferenceNumber : null,
          finalPaymentMethod === 'DEPOSIT' ? paymentDocumentUrl : null,
          req.user.id,
          saleId,
        ]
      )

      if (finalIsCredit) {
        const [installmentRows] = await conn.query('SELECT id FROM installments WHERE sale_id = ? LIMIT 1', [saleId])
        if (!installmentRows?.length) {
          const saleTotal = Math.round(Number(sale.total || 0) * 100) / 100
          if (finalDownPaymentAmount >= saleTotal - 0.01) {
            throw createHttpError(400, 'El enganche debe ser menor al total de la venta')
          }
          const creditBaseTotal = Math.round(Math.max(0, saleTotal - finalDownPaymentAmount) * 100) / 100

          // #region debug-point credit-installment-mismatch-credit-base
          await __dbgReport({
            point: 'credit-base-total',
            saleId,
            saleTotal,
            downPaymentAmount: finalDownPaymentAmount,
            creditBaseTotal,
            installmentsProvidedCount: Array.isArray(creditInstallments) ? creditInstallments.length : null,
          })
          // #endregion debug-point credit-installment-mismatch-credit-base

          const normalizedCreditInstallments = normalizeCreditInstallments(creditInstallments, creditBaseTotal, { requireExplicit: true })

          // #region debug-point credit-installment-mismatch-installments-normalized
          const sumInstallments = Math.round((normalizedCreditInstallments || []).reduce((sum, it) => sum + Number(it.amount || 0), 0) * 100) / 100
          await __dbgReport({
            point: 'installments-normalized',
            saleId,
            creditBaseTotal,
            normalizedCount: normalizedCreditInstallments?.length,
            normalizedSum: sumInstallments,
            diff: Math.round((creditBaseTotal - sumInstallments) * 100) / 100,
            firstDueDate: normalizedCreditInstallments?.[0]?.dueDate || null,
          })
          // #endregion debug-point credit-installment-mismatch-installments-normalized

          await createInstallments(conn, saleId, normalizedCreditInstallments)
        }

        if (finalDownPaymentAmount > 0 && await columnExists(conn, 'credit_payments', 'payment_type')) {
          const [existingDownRows] = await conn.query(
            `
              SELECT cp.id
              FROM credit_payments cp
              JOIN installments i ON i.id = cp.installment_id
              WHERE i.sale_id = ? AND cp.payment_type = 'DOWN_PAYMENT'
              LIMIT 1
            `,
            [saleId]
          )

          if (!existingDownRows?.length) {
            const [engancheInstallmentResult] = await conn.query(
              'INSERT INTO installments (sale_id, due_date, amount, paid, paid_at) VALUES (?, CURDATE(), ?, 1, NOW())',
              [saleId, finalDownPaymentAmount]
            )
            const engancheInstallmentId = engancheInstallmentResult.insertId

            const paymentInsertColumns = ['installment_id', 'amount']
            const paymentInsertValues = [engancheInstallmentId, finalDownPaymentAmount]
            if (await columnExists(conn, 'credit_payments', 'payment_method')) {
              paymentInsertColumns.push('payment_method')
              paymentInsertValues.push(finalDownPaymentMethod)
            }
            paymentInsertColumns.push('payment_type')
            paymentInsertValues.push('DOWN_PAYMENT')
            if (await columnExists(conn, 'credit_payments', 'reference')) {
              paymentInsertColumns.push('reference')
              paymentInsertValues.push(finalDownPaymentReference)
            }
            if (await columnExists(conn, 'credit_payments', 'document_url')) {
              paymentInsertColumns.push('document_url')
              paymentInsertValues.push(finalDownPaymentMethod === 'DEPOSIT' ? downPaymentDocumentUrl : null)
            }
            if (await columnExists(conn, 'credit_payments', 'received_by')) {
              paymentInsertColumns.push('received_by')
              paymentInsertValues.push(req.user?.name || null)
            }
            if (await columnExists(conn, 'credit_payments', 'paid_at')) {
              paymentInsertColumns.push('paid_at')
              paymentInsertValues.push(new Date())
            }
            if (await columnExists(conn, 'credit_payments', 'user_id')) {
              paymentInsertColumns.push('user_id')
              paymentInsertValues.push(req.user.id)
            }

            const [enganchePaymentResult] = await conn.query(
              `INSERT INTO credit_payments (${paymentInsertColumns.join(', ')}) VALUES (${paymentInsertColumns.map(() => '?').join(', ')})`,
              paymentInsertValues
            )
            const enganchePaymentId = enganchePaymentResult.insertId

            if (finalDownPaymentMethod === 'CASH') {
              await conn.query(
                'INSERT INTO cash_movements (shift_id, type, concept, amount, ref_type, ref_id) VALUES (?, "IN", ?, ?, "CREDIT_PAYMENT", ?)',
                [shift.id, `Enganche crédito venta #${saleId}`, finalDownPaymentAmount, enganchePaymentId]
              )
            }
          }
        }
      }

      if (finalPaymentMethod === 'CASH') {
        await conn.query(
          'INSERT INTO cash_movements (shift_id, type, concept, amount, ref_type, ref_id) VALUES (?, "IN", ?, ?, "SALE", ?)',
          [shift.id, `Cobro venta #${saleId}`, sale.total, saleId]
        )
      }

      await conn.commit()
      // #region debug-point credit-installment-mismatch-commit
      await __dbgReport({ point: 'commit', saleId, finalPaymentMethod })
      // #endregion debug-point credit-installment-mismatch-commit
      return res.json({ success: true, saleId })
    } catch (err) {
      await conn.rollback()
      // #region debug-point credit-installment-mismatch-error
      await __dbgReport({
        point: 'error',
        saleId,
        statusCode: err?.statusCode || null,
        message: err?.message || String(err),
      })
      // #endregion debug-point credit-installment-mismatch-error
      return res.status(err?.statusCode || 500).json({ error: err?.message || 'Error al cobrar la venta pendiente' })
    } finally {
      conn.release()
    }
  } catch (err) {
    console.error('Collect pending sale payment error:', err)
    return res.status(500).json({ error: 'Server error' })
  }
})

// Ventas del día: suma de total por fecha
router.get('/daily', authMiddleware, async (req, res) => {
  try {
    const date = (req.query.date || '').toString().trim()
    const pool = await getPool()
    await ensureSalesSchema(pool)
    const isAdmin = isAdminUser(req.user)
    const warehouseId = getUserWarehouseId(req.user)
    if (!isAdmin && !warehouseId) {
      return res.json({ total: 0 })
    }
    let rows
    if (date) {
      if (isAdmin) {
        ;[rows] = await pool.query(
          "SELECT COALESCE(SUM(total), 0) AS total FROM sales WHERE DATE(created_at) = ? AND COALESCE(status, 'COMPLETED') != 'CANCELLED'",
          [date]
        )
      } else {
        ;[rows] = await pool.query(
          "SELECT COALESCE(SUM(total), 0) AS total FROM sales WHERE DATE(created_at) = ? AND warehouse_id = ? AND COALESCE(status, 'COMPLETED') != 'CANCELLED'",
          [date, warehouseId]
        )
      }
    } else {
      if (isAdmin) {
        ;[rows] = await pool.query(
          "SELECT COALESCE(SUM(total), 0) AS total FROM sales WHERE DATE(created_at) = CURDATE() AND COALESCE(status, 'COMPLETED') != 'CANCELLED'"
        )
      } else {
        ;[rows] = await pool.query(
          "SELECT COALESCE(SUM(total), 0) AS total FROM sales WHERE DATE(created_at) = CURDATE() AND warehouse_id = ? AND COALESCE(status, 'COMPLETED') != 'CANCELLED'",
          [warehouseId]
        )
      }
    }
    const total = Number(rows?.[0]?.total || 0)
    return res.json({ total })
  } catch (err) {
    console.error('Sales daily GET error:', err)
    return res.status(500).json({ error: 'Server error' })
  }
})

// Créditos por vencer: cuotas no pagadas con due_date dentro de un rango
router.get('/credits/upcoming', authMiddleware, async (req, res) => {
  try {
    const days = Math.max(0, Number(req.query.days || 7))
    const pool = await getPool()
    await ensureSalesSchema(pool)
    const isAdmin = isAdminUser(req.user)
    const warehouseId = getUserWarehouseId(req.user)
    if (!isAdmin && !warehouseId) {
      return res.json({ count: 0, days })
    }
    const [rows] = isAdmin
      ? await pool.query(
          'SELECT COUNT(*) AS c FROM installments WHERE paid = 0 AND due_date <= DATE_ADD(CURDATE(), INTERVAL ? DAY)',
          [days]
        )
      : await pool.query(
          `SELECT COUNT(*) AS c
           FROM installments i
           JOIN sales s ON s.id = i.sale_id
           WHERE i.paid = 0 AND i.due_date <= DATE_ADD(CURDATE(), INTERVAL ? DAY)
             AND s.warehouse_id = ?`,
          [days, warehouseId]
        )
    const count = Number(rows?.[0]?.c || 0)
    return res.json({ count, days })
  } catch (err) {
    console.error('Sales upcoming credits GET error:', err)
    return res.status(500).json({ error: 'Server error' })
  }
})

// Resumen de ventas por rango de fechas (inclusive)
router.get('/summary', authMiddleware, async (req, res) => {
  try {
    const start = (req.query.start || '').toString().slice(0, 10)
    const end = (req.query.end || '').toString().slice(0, 10)
    const pool = await getPool()
    await ensureSalesSchema(pool)
    const isAdmin = isAdminUser(req.user)
    const warehouseId = getUserWarehouseId(req.user)
    if (!isAdmin && !warehouseId) {
      return res.json({ total: 0, start: start || null, end: end || null })
    }
    let rows
    if (start && end) {
      if (isAdmin) {
        ;[rows] = await pool.query(
          "SELECT COALESCE(SUM(total), 0) AS total FROM sales WHERE DATE(created_at) BETWEEN ? AND ? AND COALESCE(status, 'COMPLETED') != 'CANCELLED'",
          [start, end]
        )
      } else {
        ;[rows] = await pool.query(
          "SELECT COALESCE(SUM(total), 0) AS total FROM sales WHERE DATE(created_at) BETWEEN ? AND ? AND warehouse_id = ? AND COALESCE(status, 'COMPLETED') != 'CANCELLED'",
          [start, end, warehouseId]
        )
      }
    } else {
      if (isAdmin) {
        ;[rows] = await pool.query(
          "SELECT COALESCE(SUM(total), 0) AS total FROM sales WHERE DATE(created_at) = CURDATE() AND COALESCE(status, 'COMPLETED') != 'CANCELLED'"
        )
      } else {
        ;[rows] = await pool.query(
          "SELECT COALESCE(SUM(total), 0) AS total FROM sales WHERE DATE(created_at) = CURDATE() AND warehouse_id = ? AND COALESCE(status, 'COMPLETED') != 'CANCELLED'",
          [warehouseId]
        )
      }
    }
    const total = Number(rows?.[0]?.total || 0)
    return res.json({ total, start: start || null, end: end || null })
  } catch (err) {
    console.error('Sales summary GET error:', err)
    return res.status(500).json({ error: 'Server error' })
  }
})
// Listado detallado de cuotas próximas a vencer
router.get('/credits/upcoming/list', authMiddleware, async (req, res) => {
  try {
    const days = Math.max(0, Number(req.query.days || 7))
    const limit = Math.max(1, Number(req.query.limit || 10))
    const pool = await getPool()
    await ensureSalesSchema(pool)
    const isAdmin = isAdminUser(req.user)
    const warehouseId = getUserWarehouseId(req.user)
    if (!isAdmin && !warehouseId) {
      return res.json({ days, limit, items: [] })
    }
    const [rows] = isAdmin
      ? await pool.query(
          `SELECT i.id AS installment_id, i.sale_id, i.due_date, i.amount,
                  s.doc_no, s.total AS sale_total,
                  c.name AS customer_name
             FROM installments i
             JOIN sales s ON s.id = i.sale_id
        LEFT JOIN customers c ON c.id = s.customer_id
            WHERE i.paid = 0
              AND i.due_date <= DATE_ADD(CURDATE(), INTERVAL ? DAY)
            ORDER BY i.due_date ASC, i.id ASC
            LIMIT ?`,
          [days, limit]
        )
      : await pool.query(
          `SELECT i.id AS installment_id, i.sale_id, i.due_date, i.amount,
                  s.doc_no, s.total AS sale_total,
                  c.name AS customer_name
             FROM installments i
             JOIN sales s ON s.id = i.sale_id
        LEFT JOIN customers c ON c.id = s.customer_id
            WHERE i.paid = 0
              AND i.due_date <= DATE_ADD(CURDATE(), INTERVAL ? DAY)
              AND s.warehouse_id = ?
            ORDER BY i.due_date ASC, i.id ASC
            LIMIT ?`,
          [days, warehouseId, limit]
        )
    const items = (rows || []).map(r => ({
      id: r.installment_id,
      saleId: r.sale_id,
      dueDate: r.due_date ? String(r.due_date).slice(0, 10) : '',
      amount: Number(r.amount || 0),
      docNo: r.doc_no || '',
      saleTotal: Number(r.sale_total || 0),
      customerName: r.customer_name || 'Sin cliente',
    }))
    return res.json({ days, limit, items })
  } catch (err) {
    console.error('Sales upcoming credits list GET error:', err)
    return res.status(500).json({ error: 'Server error' })
  }
})

// Obtener detalle de una venta
router.get('/:id', authMiddleware, async (req, res) => {
  try {
    const saleId = req.params.id
    const pool = await getPool()
    await ensureSalesSchema(pool)
    const context = await buildSalesContext(pool)
    const canSeeProfit = req.user?.role === 'ADMIN'
    const ownerFilter = canSeeProfit
      ? ''
      : (getUserWarehouseId(req.user) ? ' AND s.warehouse_id = ?' : ' AND 1 = 0')
    const saleParams = canSeeProfit ? [saleId] : [saleId, Number(getUserWarehouseId(req.user) || 0)]
    
    // Venta header
    const [saleRows] = await pool.query(
      `
        SELECT s.*, c.name AS customer_name, c.document AS customer_document, c.address AS customer_address, c.phone AS customer_phone,
               i.credit_fully_paid,
               i.credit_fully_paid_at,
               ${canSeeProfit ? 'COALESCE(calc.cost_total, 0)' : 'NULL'} AS cost_total,
               ${canSeeProfit ? "CASE WHEN s.status = 'CANCELLED' THEN 0 ELSE COALESCE(calc.profit, 0) END" : 'NULL'} AS profit,
               ${context.sellerIdExpr} AS seller_id,
               ${context.sellerNameExpr} AS seller_name
        FROM sales s
        ${context.baseJoins}
        ${context.sellerJoin}
        WHERE s.id = ?${ownerFilter}
      `,
      saleParams
    )
    
    if (saleRows.length === 0) {
      return res.status(404).json({ error: 'Venta no encontrada' })
    }
    const sale = saleRows[0]

    // Items
    const [items] = await pool.query(`
      SELECT si.*, p.name as product_name, p.sku
      FROM sale_items si
      JOIN products p ON si.product_id = p.id
      WHERE si.sale_id = ?
    `, [saleId])

    const [installments] = await pool.query(
      'SELECT id, due_date, amount, paid, paid_at FROM installments WHERE sale_id = ? AND paid = 0 ORDER BY due_date ASC, id ASC',
      [saleId]
    )

    res.json({ ...sale, items, installments: installments || [] })
  } catch (err) {
    console.error('Sale detail error:', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// Cancelar venta
router.post('/:id/cancel', authMiddleware, async (req, res) => {
  try {
    const saleId = req.params.id
    const { reason } = req.body
    
    if (!reason) {
      return res.status(400).json({ error: 'Se requiere un motivo para la cancelación' })
    }

    const pool = await getPool()
    const conn = await pool.getConnection()

    try {
      await conn.beginTransaction()

      const isAdmin = isAdminUser(req.user)
      const userWarehouseId = getUserWarehouseId(req.user)
      if (!isAdmin && !userWarehouseId) {
        await conn.rollback()
        return res.status(403).json({ error: 'No tienes una tienda asignada para cancelar ventas' })
      }

      const saleWhere = !isAdmin ? ' AND warehouse_id = ?' : ''
      const saleParams = !isAdmin ? [saleId, userWarehouseId] : [saleId]
      const [saleRows] = await conn.query(`SELECT * FROM sales WHERE id = ?${saleWhere} FOR UPDATE`, saleParams)
      if (saleRows.length === 0) {
        await conn.rollback()
        return res.status(404).json({ error: 'Venta no encontrada' })
      }

      const sale = saleRows[0]
      if (sale.status === 'CANCELLED') {
        await conn.rollback()
        return res.status(400).json({ error: 'La venta ya está cancelada' })
      }

      // 2. Actualizar estado de venta
      await conn.query(
        'UPDATE sales SET status = ?, cancellation_reason = ? WHERE id = ?',
        ['CANCELLED', reason, saleId]
      )

      // 3. Restaurar stock
      if (String(sale.status || '').toUpperCase() !== 'DRAFT') {
        const [items] = await conn.query('SELECT * FROM sale_items WHERE sale_id = ?', [saleId])
        for (const item of items) {
          if (item.serial) {
            const [serialRestore] = await conn.query(
              'UPDATE product_serials SET status = "AVAILABLE", warehouse_id = ? WHERE product_id = ? AND serial_no = ? AND status = "SOLD"',
              [Number(sale.warehouse_id || getUserWarehouseId(req.user) || 0), item.product_id, item.serial]
            )
            if (!serialRestore.affectedRows) {
              throw new Error(`No se pudo reactivar la serie ${item.serial} al cancelar la venta`)
            }
          } else if (item.imei) {
            const [imeiRestore] = await conn.query(
              'UPDATE product_imeis SET status = "AVAILABLE", warehouse_id = ? WHERE product_id = ? AND imei = ? AND status = "SOLD"',
              [Number(sale.warehouse_id || getUserWarehouseId(req.user) || 0), item.product_id, item.imei]
            )
            if (!imeiRestore.affectedRows) {
              throw new Error(`No se pudo reactivar el IMEI ${item.imei} al cancelar la venta`)
            }
          } else if (item.batch_no) {
            await conn.query(
              'UPDATE product_batches SET quantity = quantity + ? WHERE product_id = ? AND batch_no = ? AND warehouse_id = ?',
              [item.quantity, item.product_id, item.batch_no, Number(sale.warehouse_id || getUserWarehouseId(req.user) || 0)]
            )
          }

          await registerMovement({
              productId: item.product_id,
              warehouseId: Number(sale.warehouse_id || getUserWarehouseId(req.user) || 0),
              type: 'ADJUSTMENT',
              quantity: item.quantity,
              referenceId: saleId,
              userId: req.user?.id,
              notes: `Cancelación Venta #${saleId} - ${reason}`
          }, conn)
        }
      }

      // 4. Si es crédito, anular cuota pendiente
      if (sale.is_credit && String(sale.status || '').toUpperCase() !== 'DRAFT') {
        await conn.query(
          'UPDATE installments SET paid = 1, amount = 0 WHERE sale_id = ?',
          [saleId]
        )
      }

      await conn.commit()
      res.json({ success: true, message: 'Venta cancelada exitosamente' })

    } catch (err) {
      await conn.rollback()
      throw err
    } finally {
      conn.release()
    }

  } catch (err) {
    console.error('Sale cancel error:', err)
    res.status(500).json({ error: 'Server error' })
  }
})

export default router
