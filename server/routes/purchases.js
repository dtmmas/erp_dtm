import express from 'express'
import multer from 'multer'
import path from 'path'
import { authMiddleware } from '../auth.js'
import { getPool } from '../db.js'
import { registerMovement } from '../services/inventory.js'
import { uploadsDir } from '../paths.js'

const router = express.Router()

// Configure Multer for document uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadsDir)
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9)
    const ext = path.extname(file.originalname)
    cb(null, 'doc-' + uniqueSuffix + ext)
  }
})
const upload = multer({ storage: storage })

async function resolvePurchaseMovementType(conn, productId, warehouseId) {
  await conn.query(
    `INSERT INTO product_warehouse_stock (product_id, warehouse_id, quantity)
     VALUES (?, ?, 0)
     ON DUPLICATE KEY UPDATE quantity = quantity`,
    [productId, warehouseId]
  )

  const [rows] = await conn.query(
    `SELECT quantity
     FROM product_warehouse_stock
     WHERE product_id = ? AND warehouse_id = ?
     FOR UPDATE`,
    [productId, warehouseId]
  )

  return Number(rows[0]?.quantity || 0) > 0 ? 'PURCHASE' : 'INITIAL'
}

function roundCurrency(value) {
  return Math.round(Number(value || 0) * 100) / 100
}

function normalizePurchasePaymentType(value) {
  return String(value || '').toUpperCase() === 'CREDIT' ? 'CREDIT' : 'CASH'
}

function normalizePurchasePaymentMethod(value) {
  const method = String(value || '').toUpperCase()
  return ['CASH', 'CARD', 'DEPOSIT'].includes(method) ? method : 'CASH'
}

function buildPurchasePaymentSummary(total, paidAmount, paymentType) {
  const normalizedTotal = roundCurrency(total)
  const normalizedPaid = Math.min(normalizedTotal, Math.max(0, roundCurrency(paidAmount)))
  const balance = roundCurrency(normalizedTotal - normalizedPaid)

  let paymentStatus = 'PENDING'
  if (balance <= 0.009) paymentStatus = 'PAID'
  else if (normalizedPaid > 0) paymentStatus = 'PARTIAL'
  else if (paymentType === 'CASH') paymentStatus = 'PENDING'

  return {
    paidAmount: normalizedPaid,
    balanceDue: Math.max(0, balance),
    paymentStatus,
  }
}

async function syncPurchasePaymentState(conn, purchaseId) {
  const [rows] = await conn.query(
    `SELECT
       p.id,
       p.total,
       COALESCE(p.payment_type, 'CASH') AS payment_type,
       COALESCE(SUM(pp.amount), 0) AS paid_amount
     FROM purchases p
     LEFT JOIN purchase_payments pp ON pp.purchase_id = p.id
     WHERE p.id = ?
     GROUP BY p.id, p.total, p.payment_type
     LIMIT 1`,
    [purchaseId]
  )

  const purchase = rows[0]
  if (!purchase) {
    throw new Error('Compra no encontrada para sincronizar pagos')
  }

  const summary = buildPurchasePaymentSummary(
    purchase.total,
    purchase.paid_amount,
    normalizePurchasePaymentType(purchase.payment_type)
  )

  await conn.query(
    `UPDATE purchases
     SET paid_amount = ?, balance_due = ?, payment_status = ?, paid_at = CASE WHEN ? = 'PAID' THEN COALESCE(paid_at, NOW()) ELSE NULL END
     WHERE id = ?`,
    [summary.paidAmount, summary.balanceDue, summary.paymentStatus, summary.paymentStatus, purchaseId]
  )

  return summary
}

async function registerPurchasePayment(conn, { purchaseId, amount, paymentMethod, reference, notes, userId, documentPath, registerCashMovement = true }) {
  const normalizedAmount = roundCurrency(amount)
  if (normalizedAmount <= 0) {
    return null
  }

  const finalPaymentMethod = normalizePurchasePaymentMethod(paymentMethod)

  const [result] = await conn.query(
    `INSERT INTO purchase_payments (purchase_id, amount, payment_method, reference, notes, user_id, document_path, paid_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NOW())`,
    [
      purchaseId,
      normalizedAmount,
      finalPaymentMethod,
      reference || null,
      notes || null,
      userId || null,
      documentPath || null,
    ]
  )

  if (registerCashMovement && finalPaymentMethod === 'CASH' && userId) {
    const [shiftRows] = await conn.query(
      'SELECT id FROM cashbox_shifts WHERE opened_by = ? AND closed_at IS NULL ORDER BY id DESC LIMIT 1',
      [userId]
    )
    const activeShift = shiftRows?.[0] || null
    if (activeShift) {
      await conn.query(
        'INSERT INTO cash_movements (shift_id, type, concept, amount, ref_type, ref_id, created_at) VALUES (?, "OUT", ?, ?, "PURCHASE", ?, NOW())',
        [activeShift.id, `Pago a proveedor compra #${purchaseId}`, normalizedAmount, purchaseId]
      )
    }
  }

  return {
    id: result.insertId,
    amount: normalizedAmount,
    paymentMethod: finalPaymentMethod,
  }
}

async function getSupplierPendingPurchases(conn, supplierId, { forUpdate = false } = {}) {
  const lockClause = forUpdate ? ' FOR UPDATE' : ''
  const [rows] = await conn.query(
    `SELECT
       p.id,
       p.doc_no,
       p.created_at,
       p.due_date,
       p.total,
       COALESCE(p.paid_amount, 0) AS paid_amount,
       COALESCE(p.balance_due, GREATEST(ROUND(COALESCE(p.total, 0) - COALESCE(p.paid_amount, 0), 2), 0)) AS balance_due,
       COALESCE(p.payment_status, 'PENDING') AS payment_status
     FROM purchases p
     WHERE p.supplier_id = ?
       AND COALESCE(p.balance_due, GREATEST(ROUND(COALESCE(p.total, 0) - COALESCE(p.paid_amount, 0), 2), 0)) > 0.009
     ORDER BY
       CASE WHEN p.due_date IS NULL THEN 1 ELSE 0 END ASC,
       p.due_date ASC,
       p.created_at ASC,
       p.id ASC${lockClause}`,
    [supplierId]
  )

  return rows.map(row => ({
    id: Number(row.id),
    docNo: row.doc_no || null,
    createdAt: row.created_at,
    dueDate: row.due_date || null,
    total: roundCurrency(row.total),
    paidAmount: roundCurrency(row.paid_amount),
    balanceDue: roundCurrency(row.balance_due),
    paymentStatus: row.payment_status || 'PENDING',
  }))
}

async function registerSupplierPayment(conn, { supplierId, amount, paymentMethod, reference, notes, userId, documentPath }) {
  const normalizedSupplierId = Number(supplierId || 0)
  const normalizedAmount = roundCurrency(amount)
  const finalPaymentMethod = normalizePurchasePaymentMethod(paymentMethod)

  if (!normalizedSupplierId || normalizedAmount <= 0) {
    throw new Error('Datos inválidos para el abono global')
  }

  const [supplierRows] = await conn.query(
    'SELECT id, name FROM suppliers WHERE id = ? LIMIT 1 FOR UPDATE',
    [normalizedSupplierId]
  )
  const supplier = supplierRows[0]
  if (!supplier) {
    throw new Error('Proveedor no encontrado')
  }

  const pendingPurchases = await getSupplierPendingPurchases(conn, normalizedSupplierId, { forUpdate: true })
  const totalPending = roundCurrency(pendingPurchases.reduce((sum, purchase) => sum + purchase.balanceDue, 0))

  if (totalPending <= 0) {
    throw new Error('El proveedor no tiene facturas pendientes')
  }

  if (normalizedAmount - totalPending > 0.009) {
    throw new Error(`El abono excede el saldo pendiente del proveedor (${totalPending.toFixed(2)})`)
  }

  const [supplierPaymentResult] = await conn.query(
    `INSERT INTO supplier_payments (supplier_id, amount, payment_method, reference, notes, user_id, document_path, paid_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NOW())`,
    [
      normalizedSupplierId,
      normalizedAmount,
      finalPaymentMethod,
      reference || null,
      notes || null,
      userId || null,
      documentPath || null,
    ]
  )

  const supplierPaymentId = Number(supplierPaymentResult.insertId)
  const allocations = []
  let remainingAmount = normalizedAmount

  for (const purchase of pendingPurchases) {
    if (remainingAmount <= 0.009) break

    const allocationAmount = Math.min(remainingAmount, purchase.balanceDue)
    if (allocationAmount <= 0) continue

    const purchaseNote = notes
      ? `Abono global proveedor #${supplierPaymentId} | ${notes}`
      : `Abono global proveedor #${supplierPaymentId}`

    const purchasePayment = await registerPurchasePayment(conn, {
      purchaseId: purchase.id,
      amount: allocationAmount,
      paymentMethod: finalPaymentMethod,
      reference,
      notes: purchaseNote,
      userId,
      documentPath,
      registerCashMovement: true,
    })

    const summary = await syncPurchasePaymentState(conn, purchase.id)

    await conn.query(
      `INSERT INTO supplier_payment_allocations (supplier_payment_id, purchase_id, purchase_payment_id, amount, created_at)
       VALUES (?, ?, ?, ?, NOW())`,
      [supplierPaymentId, purchase.id, purchasePayment?.id || null, roundCurrency(allocationAmount)]
    )

    allocations.push({
      purchaseId: purchase.id,
      docNo: purchase.docNo,
      dueDate: purchase.dueDate,
      allocatedAmount: roundCurrency(allocationAmount),
      balanceDue: summary.balanceDue,
      paymentStatus: summary.paymentStatus,
    })

    remainingAmount = roundCurrency(remainingAmount - allocationAmount)
  }

  if (remainingAmount > 0.009) {
    throw new Error('No fue posible aplicar todo el abono al proveedor')
  }

  return {
    supplierId: normalizedSupplierId,
    supplierName: supplier.name,
    supplierPaymentId,
    amount: normalizedAmount,
    paymentMethod: finalPaymentMethod,
    reference: reference || null,
    notes: notes || null,
    totalPendingBefore: totalPending,
    remainingPending: roundCurrency(totalPending - normalizedAmount),
    allocations,
  }
}

async function recalculateProductCosts(conn, productId, quantity, unitCost) {
  const normalizedQty = Number(quantity || 0)
  const normalizedUnitCost = roundCurrency(unitCost)

  if (normalizedQty <= 0) {
    return
  }

  const [[product]] = await conn.query(
    `SELECT cost, avg_cost, last_cost
     FROM products
     WHERE id = ?
     LIMIT 1
     FOR UPDATE`,
    [productId]
  )

  if (!product) {
    throw new Error(`Producto ${productId} no encontrado para recalcular costos`)
  }

  const [stockRows] = await conn.query(
    `SELECT quantity
     FROM product_warehouse_stock
     WHERE product_id = ?
     FOR UPDATE`,
    [productId]
  )

  const totalStockAfterPurchase = stockRows.reduce((sum, row) => sum + Number(row?.quantity || 0), 0)
  const previousStock = Math.max(0, totalStockAfterPurchase - normalizedQty)
  const currentAverage = roundCurrency(product.avg_cost ?? product.cost ?? 0)

  const nextAverage = previousStock > 0
    ? roundCurrency(((previousStock * currentAverage) + (normalizedQty * normalizedUnitCost)) / (previousStock + normalizedQty))
    : normalizedUnitCost

  await conn.query(
    `UPDATE products
     SET cost = ?, avg_cost = ?, last_cost = ?
     WHERE id = ?`,
    [nextAverage, nextAverage, normalizedUnitCost, productId]
  )
}

// Listar compras
router.get('/', authMiddleware, async (req, res) => {
  try {
    const limit = Math.max(1, Number(req.query.limit || 50))
    const offset = Math.max(0, Number(req.query.offset || 0))
    const search = (req.query.search || '').toString().trim()
    const paymentStatus = String(req.query.paymentStatus || '').trim().toUpperCase()
    const normalizedPaymentStatus = ['PAID', 'PARTIAL', 'PENDING'].includes(paymentStatus) ? paymentStatus : ''
    const supplierId = Number(req.query.supplierId || 0)
    const normalizedSupplierId = supplierId > 0 ? supplierId : 0
    const startDate = String(req.query.startDate || '').trim()
    const endDate = String(req.query.endDate || '').trim()
    const normalizedStartDate = /^\d{4}-\d{2}-\d{2}$/.test(startDate) ? startDate : ''
    const normalizedEndDate = /^\d{4}-\d{2}-\d{2}$/.test(endDate) ? endDate : ''

    const pool = await getPool()
    let query = `
      SELECT
        p.*,
        COALESCE(p.status, 'COMPLETED') as status,
        COALESCE(p.payment_type, 'CASH') as payment_type,
        COALESCE(p.payment_status, 'PAID') as payment_status,
        COALESCE(p.payment_method, 'CASH') as payment_method,
        COALESCE(p.paid_amount, p.total) as paid_amount,
        COALESCE(p.balance_due, 0) as balance_due,
        s.name as supplier_name,
        u.name as user_name,
        w.name as warehouse_name
      FROM purchases p 
      LEFT JOIN suppliers s ON p.supplier_id = s.id
      LEFT JOIN users u ON p.user_id = u.id
      LEFT JOIN warehouses w ON p.warehouse_id = w.id
    `
    const params = []
    const whereClauses = []

    if (search) {
      whereClauses.push(`(p.doc_no LIKE ? OR s.name LIKE ? OR p.id = ?)`)
      params.push(`%${search}%`, `%${search}%`, search)
    }

    if (normalizedPaymentStatus) {
      whereClauses.push(`COALESCE(p.payment_status, 'PAID') = ?`)
      params.push(normalizedPaymentStatus)
    }

    if (normalizedSupplierId) {
      whereClauses.push(`p.supplier_id = ?`)
      params.push(normalizedSupplierId)
    }

    if (normalizedStartDate) {
      whereClauses.push(`DATE(p.created_at) >= ?`)
      params.push(normalizedStartDate)
    }

    if (normalizedEndDate) {
      whereClauses.push(`DATE(p.created_at) <= ?`)
      params.push(normalizedEndDate)
    }

    if (whereClauses.length > 0) {
      query += ` WHERE ${whereClauses.join(' AND ')}`
    }

    query += ` ORDER BY p.created_at DESC LIMIT ? OFFSET ?`
    params.push(limit, offset)

    const [rows] = await pool.query(query, params)
    
    // Get total count
    let countQuery = `
      SELECT COUNT(*) as total 
      FROM purchases p 
      LEFT JOIN suppliers s ON p.supplier_id = s.id
    `
    const countParams = []
    const countWhereClauses = []
    if (search) {
      countWhereClauses.push(`(p.doc_no LIKE ? OR s.name LIKE ? OR p.id = ?)`)
      countParams.push(`%${search}%`, `%${search}%`, search)
    }
    if (normalizedPaymentStatus) {
      countWhereClauses.push(`COALESCE(p.payment_status, 'PAID') = ?`)
      countParams.push(normalizedPaymentStatus)
    }
    if (normalizedSupplierId) {
      countWhereClauses.push(`p.supplier_id = ?`)
      countParams.push(normalizedSupplierId)
    }
    if (normalizedStartDate) {
      countWhereClauses.push(`DATE(p.created_at) >= ?`)
      countParams.push(normalizedStartDate)
    }
    if (normalizedEndDate) {
      countWhereClauses.push(`DATE(p.created_at) <= ?`)
      countParams.push(normalizedEndDate)
    }
    if (countWhereClauses.length > 0) {
      countQuery += ` WHERE ${countWhereClauses.join(' AND ')}`
    }
    const [countRows] = await pool.query(countQuery, countParams)
    const totalRecords = countRows[0].total

    let summaryQuery = `
      SELECT
        COUNT(*) as total_records,
        COALESCE(SUM(COALESCE(p.total, 0)), 0) as total_amount,
        COALESCE(SUM(COALESCE(p.paid_amount, p.total)), 0) as total_paid,
        COALESCE(SUM(COALESCE(p.balance_due, 0)), 0) as total_balance_due
      FROM purchases p
      LEFT JOIN suppliers s ON p.supplier_id = s.id
    `
    const summaryParams = []
    const summaryWhereClauses = []
    if (search) {
      summaryWhereClauses.push(`(p.doc_no LIKE ? OR s.name LIKE ? OR p.id = ?)`)
      summaryParams.push(`%${search}%`, `%${search}%`, search)
    }
    if (normalizedPaymentStatus) {
      summaryWhereClauses.push(`COALESCE(p.payment_status, 'PAID') = ?`)
      summaryParams.push(normalizedPaymentStatus)
    }
    if (normalizedSupplierId) {
      summaryWhereClauses.push(`p.supplier_id = ?`)
      summaryParams.push(normalizedSupplierId)
    }
    if (normalizedStartDate) {
      summaryWhereClauses.push(`DATE(p.created_at) >= ?`)
      summaryParams.push(normalizedStartDate)
    }
    if (normalizedEndDate) {
      summaryWhereClauses.push(`DATE(p.created_at) <= ?`)
      summaryParams.push(normalizedEndDate)
    }
    if (summaryWhereClauses.length > 0) {
      summaryQuery += ` WHERE ${summaryWhereClauses.join(' AND ')}`
    }
    const [summaryRows] = await pool.query(summaryQuery, summaryParams)
    const summary = summaryRows?.[0] || {}

    res.json({
      data: rows,
      pagination: {
        total: totalRecords,
        limit,
        offset
      },
      summary: {
        totalRecords: Number(summary.total_records || 0),
        totalAmount: roundCurrency(summary.total_amount),
        totalPaid: roundCurrency(summary.total_paid),
        totalBalanceDue: roundCurrency(summary.total_balance_due),
      }
    })
  } catch (err) {
    console.error('Purchases list error:', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// Obtener detalles de una compra
router.get('/:id', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params
    const pool = await getPool()
    
    const [rows] = await pool.query(`
      SELECT
        p.*,
        COALESCE(p.status, 'COMPLETED') as status,
        COALESCE(p.payment_type, 'CASH') as payment_type,
        COALESCE(p.payment_status, 'PAID') as payment_status,
        COALESCE(p.payment_method, 'CASH') as payment_method,
        COALESCE(p.paid_amount, p.total) as paid_amount,
        COALESCE(p.balance_due, 0) as balance_due,
        s.name as supplier_name,
        u.name as user_name,
        w.name as warehouse_name
      FROM purchases p
      LEFT JOIN suppliers s ON p.supplier_id = s.id
      LEFT JOIN users u ON p.user_id = u.id
      LEFT JOIN warehouses w ON p.warehouse_id = w.id
      WHERE p.id = ?
    `, [id])

    if (rows.length === 0) return res.status(404).json({ error: 'Purchase not found' })
    const purchase = rows[0]

    const [items] = await pool.query(`
      SELECT pi.*, p.name as product_name, p.product_code as product_code
      FROM purchase_items pi
      JOIN products p ON pi.product_id = p.id
      WHERE pi.purchase_id = ?
    `, [id])

    purchase.items = items
    res.json(purchase)
  } catch (err) {
    console.error('Purchase details error:', err)
    res.status(500).json({ error: 'Server error' })
  }
})

router.get('/:id/payments', authMiddleware, async (req, res) => {
  try {
    const pool = await getPool()
    const [rows] = await pool.query(
      `SELECT
         pp.id,
         pp.purchase_id,
         pp.amount,
         COALESCE(pp.payment_method, 'CASH') AS payment_method,
         pp.reference,
         pp.notes,
         pp.document_path,
         pp.paid_at,
         u.name AS user_name
       FROM purchase_payments pp
       LEFT JOIN users u ON u.id = pp.user_id
       WHERE pp.purchase_id = ?
       ORDER BY pp.paid_at DESC, pp.id DESC`,
      [req.params.id]
    )

    res.json(rows)
  } catch (err) {
    console.error('Purchase payments list error:', err)
    res.status(500).json({ error: 'Server error' })
  }
})

router.get('/suppliers/:supplierId/pending', authMiddleware, async (req, res) => {
  try {
    const supplierId = Number(req.params.supplierId)
    if (!supplierId) {
      return res.status(400).json({ error: 'Proveedor inválido' })
    }

    const pool = await getPool()
    const [[supplier]] = await pool.query(
      'SELECT id, name FROM suppliers WHERE id = ? LIMIT 1',
      [supplierId]
    )

    if (!supplier) {
      return res.status(404).json({ error: 'Proveedor no encontrado' })
    }

    const purchases = await getSupplierPendingPurchases(pool, supplierId)
    const totalPending = roundCurrency(purchases.reduce((sum, purchase) => sum + purchase.balanceDue, 0))

    res.json({
      supplier: {
        id: Number(supplier.id),
        name: supplier.name,
      },
      totals: {
        pendingCount: purchases.length,
        totalPending,
      },
      purchases,
    })
  } catch (err) {
    console.error('Supplier pending purchases error:', err)
    res.status(500).json({ error: 'Server error' })
  }
})

router.get('/suppliers/:supplierId/payments', authMiddleware, async (req, res) => {
  try {
    const supplierId = Number(req.params.supplierId)
    if (!supplierId) {
      return res.status(400).json({ error: 'Proveedor inválido' })
    }

    const pool = await getPool()
    const [paymentRows] = await pool.query(
      `SELECT
         sp.id,
         sp.supplier_id,
         sp.amount,
         COALESCE(sp.payment_method, 'CASH') AS payment_method,
         sp.reference,
         sp.notes,
         sp.document_path,
         sp.paid_at,
         u.name AS user_name
       FROM supplier_payments sp
       LEFT JOIN users u ON u.id = sp.user_id
       WHERE sp.supplier_id = ?
       ORDER BY sp.paid_at DESC, sp.id DESC`,
      [supplierId]
    )

    const [allocationRows] = await pool.query(
      `SELECT
         spa.supplier_payment_id,
         spa.purchase_id,
         spa.purchase_payment_id,
         spa.amount,
         p.doc_no,
         p.created_at,
         p.due_date
       FROM supplier_payment_allocations spa
       JOIN supplier_payments sp ON sp.id = spa.supplier_payment_id
       JOIN purchases p ON p.id = spa.purchase_id
       WHERE sp.supplier_id = ?
       ORDER BY spa.id ASC`,
      [supplierId]
    )

    const allocationsByPayment = new Map()
    for (const allocation of allocationRows) {
      const paymentId = Number(allocation.supplier_payment_id)
      const group = allocationsByPayment.get(paymentId) || []
      group.push({
        purchaseId: Number(allocation.purchase_id),
        purchasePaymentId: Number(allocation.purchase_payment_id),
        amount: roundCurrency(allocation.amount),
        docNo: allocation.doc_no || null,
        createdAt: allocation.created_at,
        dueDate: allocation.due_date || null,
      })
      allocationsByPayment.set(paymentId, group)
    }

    res.json(paymentRows.map(row => ({
      id: Number(row.id),
      supplierId: Number(row.supplier_id),
      amount: roundCurrency(row.amount),
      paymentMethod: row.payment_method || 'CASH',
      reference: row.reference || null,
      notes: row.notes || null,
      documentPath: row.document_path || null,
      paidAt: row.paid_at,
      userName: row.user_name || null,
      allocations: allocationsByPayment.get(Number(row.id)) || [],
    })))
  } catch (err) {
    console.error('Supplier payments list error:', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// Crear nueva compra
router.post('/', authMiddleware, upload.fields([
  { name: 'document', maxCount: 1 },
  { name: 'paymentDocument', maxCount: 1 },
]), async (req, res) => {
  try {
    let {
      supplierId,
      items,
      total,
      docNo,
      notes,
      warehouseId,
      paymentType,
      paymentMethod,
      initialPayment,
      dueDate,
      paymentReference,
      paymentNotes,
    } = req.body
    const userId = req.user?.id
    const purchaseDocumentFile = req.files?.document?.[0] || null
    const paymentDocumentFile = req.files?.paymentDocument?.[0] || null
    const documentPath = purchaseDocumentFile ? `/uploads/${purchaseDocumentFile.filename}` : null
    const paymentDocumentPath = paymentDocumentFile ? `/uploads/${paymentDocumentFile.filename}` : null

    // Parse items if string (multipart/form-data)
    if (typeof items === 'string') {
      try {
        items = JSON.parse(items)
      } catch (e) {
        return res.status(400).json({ error: 'Invalid items JSON format' })
      }
    }

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'No hay items en la compra' })
    }

    const normalizedTotal = roundCurrency(total)
    const normalizedPaymentType = normalizePurchasePaymentType(paymentType)
    const normalizedPaymentMethod = normalizePurchasePaymentMethod(paymentMethod)
    const requestedInitialPayment = roundCurrency(
      normalizedPaymentType === 'CASH' ? normalizedTotal : initialPayment
    )
    const normalizedInitialPayment = Math.min(normalizedTotal, Math.max(0, requestedInitialPayment))

    if (normalizedPaymentType === 'CREDIT' && normalizedInitialPayment < normalizedTotal && !dueDate) {
      return res.status(400).json({ error: 'Ingrese fecha de vencimiento para compras al crédito' })
    }

    if (['CARD', 'DEPOSIT'].includes(normalizedPaymentMethod) && normalizedInitialPayment > 0 && !paymentReference) {
      return res.status(400).json({ error: 'Referencia requerida para pagos con tarjeta o depósito' })
    }

    const pool = await getPool()
    const conn = await pool.getConnection()

    try {
      await conn.beginTransaction()

      // 1. Crear Compra
      const initialSummary = buildPurchasePaymentSummary(normalizedTotal, normalizedInitialPayment, normalizedPaymentType)
      const [result] = await conn.query(
        `INSERT INTO purchases (
          supplier_id, user_id, doc_no, total, notes, status, warehouse_id, document_path,
          payment_type, payment_status, payment_method, paid_amount, balance_due, due_date, paid_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          supplierId || null,
          userId || null,
          docNo || null,
          normalizedTotal,
          notes || null,
          'COMPLETED',
          warehouseId || null,
          documentPath,
          normalizedPaymentType,
          initialSummary.paymentStatus,
          normalizedPaymentMethod,
          initialSummary.paidAmount,
          initialSummary.balanceDue,
          dueDate || null,
          initialSummary.paymentStatus === 'PAID' ? new Date() : null,
        ]
      )
      const purchaseId = result.insertId

      // 2. Procesar items y actualizar stock
      const targetWarehouseId = warehouseId || 1 // Default to 1 if not specified
      const movementTypeByProduct = new Map()

      for (const item of items) {
        // item: { productId, quantity, unitCost }
        const itemTotal = Number(item.unitCost) * Number(item.quantity)
        const movementKey = `${item.productId}:${targetWarehouseId}`
        let movementType = movementTypeByProduct.get(movementKey)
        if (!movementType) {
          movementType = await resolvePurchaseMovementType(conn, item.productId, targetWarehouseId)
          movementTypeByProduct.set(movementKey, movementType)
        }
        const movementLabel = movementType === 'INITIAL' ? 'Ingreso inicial por compra' : 'Compra'
        
        await conn.query(
          'INSERT INTO purchase_items (purchase_id, product_id, quantity, unit_cost, total, total_cost, serials) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [purchaseId, item.productId, item.quantity, item.unitCost, itemTotal, itemTotal, item.serials || null]
        )

        // Handle Product Types
        if (item.productType === 'MEDICINAL') {
            if (item.batches && Array.isArray(item.batches) && item.batches.length > 0) {
                for (const batch of item.batches) {
                    if (batch.batchNo && batch.expiryDate && batch.quantity > 0) {
                        await conn.query(
                            'INSERT INTO product_batches (product_id, batch_no, expiry_date, quantity, warehouse_id) VALUES (?, ?, ?, ?, ?)',
                            [item.productId, batch.batchNo, batch.expiryDate, batch.quantity, targetWarehouseId]
                        )
                    }
                }
            } else if (item.batchNo && item.expiryDate) {
                 // Fallback for legacy/single batch
                 await conn.query(
                     'INSERT INTO product_batches (product_id, batch_no, expiry_date, quantity, warehouse_id) VALUES (?, ?, ?, ?, ?)',
                     [item.productId, item.batchNo, item.expiryDate, item.quantity, targetWarehouseId]
                 )
            }
        } else if (item.productType === 'IMEI' && item.serials) {
            const imeis = String(item.serials || '').split(/\r?\n/).map(s => s.trim()).filter(s => s)
            
            if (imeis.length !== Number(item.quantity)) {
                 throw new Error(`La cantidad de IMEIs (${imeis.length}) no coincide con la cantidad del producto ${item.productId} (${item.quantity})`)
            }

            for (const imei of imeis) {
                const [existing] = await conn.query('SELECT id FROM product_imeis WHERE product_id = ? AND imei = ?', [item.productId, imei])
                if (existing.length > 0) {
                     throw new Error(`El IMEI ${imei} ya existe para el producto ${item.productId}`)
                }

                await conn.query(
                    'INSERT INTO product_imeis (product_id, imei, status, warehouse_id) VALUES (?, ?, "AVAILABLE", ?)',
                    [item.productId, imei, targetWarehouseId]
                )
            }
        } else if (item.productType === 'SERIAL' && item.serials) {
             // Limpiar y validar seriales
             // Usar expresión regular para dividir por saltos de línea (\r\n, \n, \r)
             const serials = String(item.serials || '').split(/\r?\n/).map(s => s.trim()).filter(s => s)
             
             // Verificar que la cantidad de seriales coincida con la cantidad comprada
             if (serials.length !== Number(item.quantity)) {
                 throw new Error(`La cantidad de seriales (${serials.length}) no coincide con la cantidad del producto ${item.productId} (${item.quantity})`)
             }

             for (const serial of serials) {
                // Verificar si el serial ya existe para este producto (opcional, pero recomendado para evitar duplicados si la DB no tiene restricción única global)
                const [existing] = await conn.query('SELECT id FROM product_serials WHERE product_id = ? AND serial_no = ?', [item.productId, serial])
                if (existing.length > 0) {
                     // Si ya existe, podemos optar por lanzar error o ignorar. 
                     // Lanzar error es más seguro para evitar inconsistencias.
                     throw new Error(`El serial ${serial} ya existe para el producto ${item.productId}`)
                }

                await conn.query(
                    'INSERT INTO product_serials (product_id, serial_no, status, warehouse_id) VALUES (?, ?, "AVAILABLE", ?)', // Asumimos estado AVAILABLE
                    [item.productId, serial, targetWarehouseId]
                )
             }
        }

        // Actualizar stock usando servicio centralizado
        await registerMovement({
            productId: item.productId,
            warehouseId: targetWarehouseId, // Use the target warehouse
            type: movementType,
            quantity: item.quantity,
            referenceId: purchaseId,
            userId: userId,
            notes: `${movementLabel} #${docNo || purchaseId}`
        }, conn)

        await recalculateProductCosts(conn, item.productId, item.quantity, item.unitCost)
      }

      if (normalizedInitialPayment > 0) {
        await registerPurchasePayment(conn, {
          purchaseId,
          amount: normalizedInitialPayment,
          paymentMethod: normalizedPaymentMethod,
          reference: paymentReference,
          notes: paymentNotes || notes,
          userId,
          documentPath: paymentDocumentPath,
        })
      }

      await syncPurchasePaymentState(conn, purchaseId)

      await conn.commit()
      
      res.json({ success: true, id: purchaseId, message: 'Compra registrada correctamente' })
    } catch (err) {
      await conn.rollback()
      console.error('Purchase creation transaction error:', err)
      res.status(500).json({ error: 'Error al procesar la compra' })
    } finally {
      conn.release()
    }
  } catch (err) {
    console.error('Purchase creation error:', err)
    res.status(500).json({ error: 'Server error' })
  }
})

router.post('/:id/payments', authMiddleware, upload.single('document'), async (req, res) => {
  try {
    const purchaseId = Number(req.params.id)
    const { amount, paymentMethod, reference, notes } = req.body
    const normalizedAmount = roundCurrency(amount)
    const finalPaymentMethod = normalizePurchasePaymentMethod(paymentMethod)
    const documentPath = req.file ? `/uploads/${req.file.filename}` : null

    if (!purchaseId || normalizedAmount <= 0) {
      return res.status(400).json({ error: 'Monto inválido' })
    }

    if (['CARD', 'DEPOSIT'].includes(finalPaymentMethod) && !reference) {
      return res.status(400).json({ error: 'Referencia requerida para Tarjeta/Depósito' })
    }

    const pool = await getPool()
    const conn = await pool.getConnection()

    try {
      await conn.beginTransaction()

      const [purchaseRows] = await conn.query(
        `SELECT id, total, COALESCE(payment_type, 'CASH') AS payment_type, COALESCE(balance_due, total) AS balance_due
         FROM purchases
         WHERE id = ?
         FOR UPDATE`,
        [purchaseId]
      )

      const purchase = purchaseRows[0]
      if (!purchase) {
        throw new Error('Compra no encontrada')
      }

      const balanceDue = roundCurrency(purchase.balance_due)
      if (balanceDue <= 0) {
        throw new Error('La compra ya está pagada')
      }

      if (normalizedAmount - balanceDue > 0.009) {
        throw new Error(`El abono excede el saldo pendiente (${balanceDue.toFixed(2)})`)
      }

      await registerPurchasePayment(conn, {
        purchaseId,
        amount: normalizedAmount,
        paymentMethod: finalPaymentMethod,
        reference,
        notes,
        userId: req.user?.id,
        documentPath,
      })

      const summary = await syncPurchasePaymentState(conn, purchaseId)

      await conn.commit()

      res.json({
        success: true,
        purchaseId,
        paidAmount: summary.paidAmount,
        balanceDue: summary.balanceDue,
        paymentStatus: summary.paymentStatus,
      })
    } catch (err) {
      await conn.rollback()
      console.error('Purchase payment error:', err)
      res.status(400).json({ error: err.message || 'Error al registrar pago' })
    } finally {
      conn.release()
    }
  } catch (err) {
    console.error('Purchase payment route error:', err)
    res.status(500).json({ error: 'Server error' })
  }
})

router.post('/suppliers/:supplierId/payments', authMiddleware, upload.single('document'), async (req, res) => {
  try {
    const supplierId = Number(req.params.supplierId)
    const { amount, paymentMethod, reference, notes } = req.body
    const normalizedAmount = roundCurrency(amount)
    const finalPaymentMethod = normalizePurchasePaymentMethod(paymentMethod)
    const documentPath = req.file ? `/uploads/${req.file.filename}` : null

    if (!supplierId || normalizedAmount <= 0) {
      return res.status(400).json({ error: 'Monto inválido' })
    }

    if (['CARD', 'DEPOSIT'].includes(finalPaymentMethod) && !reference) {
      return res.status(400).json({ error: 'Referencia requerida para Tarjeta/Depósito' })
    }

    const pool = await getPool()
    const conn = await pool.getConnection()

    try {
      await conn.beginTransaction()

      const result = await registerSupplierPayment(conn, {
        supplierId,
        amount: normalizedAmount,
        paymentMethod: finalPaymentMethod,
        reference,
        notes,
        userId: req.user?.id,
        documentPath,
      })

      await conn.commit()

      res.json({
        success: true,
        ...result,
      })
    } catch (err) {
      await conn.rollback()
      console.error('Supplier payment error:', err)
      res.status(400).json({ error: err.message || 'Error al registrar abono global' })
    } finally {
      conn.release()
    }
  } catch (err) {
    console.error('Supplier payment route error:', err)
    res.status(500).json({ error: 'Server error' })
  }
})

export default router
