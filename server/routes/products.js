import express from 'express'
import fs from 'fs'
import multer from 'multer'
import path from 'path'
import { authMiddleware, canAccessWarehouse, getUserWarehouseId, isAdminUser, roleMiddleware } from '../auth.js'
import { getPool } from '../db.js'
import { registerMovement } from '../services/inventory.js'
import { projectRoot, uploadsDir } from '../paths.js'

// #region debug-point product-image-500-config
let __dbgUrl = null
try {
  const raw = fs.readFileSync(path.join(projectRoot, '.dbg', 'product-image-500.env'), 'utf-8')
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
        sessionId: 'product-image-500',
        at: new Date().toISOString(),
        ...event,
      }),
    })
  } catch {}
}
// #endregion debug-point product-image-500-config

const router = express.Router()
const upload = multer({ dest: uploadsDir })
const uploadProductImages = upload.fields([
  { name: 'image', maxCount: 1 },
  { name: 'images', maxCount: 12 },
])

function collectUploadedProductImages(req) {
  const map = req.files && typeof req.files === 'object' ? req.files : {}
  const legacy = Array.isArray(map.image) ? map.image : []
  const many = Array.isArray(map.images) ? map.images : []
  const all = [...legacy, ...many].filter(Boolean)
  const seen = new Set()
  const unique = []
  for (const file of all) {
    const key = file?.filename ? String(file.filename) : ''
    if (!key) continue
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(file)
  }
  return unique
}

async function readProductImages(conn, productId) {
  const [rows] = await conn.query(
    'SELECT id, image_url, sort_order FROM product_images WHERE product_id = ? ORDER BY sort_order ASC, id ASC',
    [productId]
  )
  const imageItems = (rows || [])
    .map(row => ({
      id: Number(row.id || 0),
      imageUrl: row.image_url ? String(row.image_url) : '',
      sortOrder: Number(row.sort_order || 0),
    }))
    .filter(item => item.id > 0 && item.imageUrl)
  const images = imageItems.map(item => item.imageUrl)
  return { imageItems, images }
}

async function refreshProductPrimaryImage(conn, productId) {
  const { images } = await readProductImages(conn, productId)
  const primary = images[0] ?? null
  await conn.query('UPDATE products SET image_url = ? WHERE id = ?', [primary, productId])
  return primary
}

// Ensure warehouse stock table and default warehouse id=1
async function ensureWarehouseStockTable(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS product_warehouse_stock (
    id INT AUTO_INCREMENT PRIMARY KEY,
    product_id INT NOT NULL,
    warehouse_id INT NOT NULL,
    quantity INT NOT NULL DEFAULT 0,
    UNIQUE KEY uniq_product_warehouse (product_id, warehouse_id),
    CONSTRAINT fk_pws_product FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
    CONSTRAINT fk_pws_warehouse FOREIGN KEY (warehouse_id) REFERENCES warehouses(id) ON DELETE CASCADE
  )`)
}

async function ensureDefaultWarehouseId1(pool) {
  // Create warehouses table if missing
  await pool.query(`CREATE TABLE IF NOT EXISTS warehouses (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(120) NOT NULL UNIQUE
  )`)
  // Ensure a warehouse with id=1 exists
  const [rows] = await pool.query('SELECT id FROM warehouses WHERE id = 1 LIMIT 1')
  if (!Array.isArray(rows) || rows.length === 0) {
    // Try to insert with explicit id=1; if duplicate on name, adjust
    try {
      await pool.query('INSERT INTO warehouses (id, name) VALUES (1, ?)', ['PRINCIPAL'])
    } catch (err) {
      // If explicit id insert fails due to constraints, create a row and then set id if needed
      await pool.query('INSERT INTO warehouses (name) VALUES (?)', ['PRINCIPAL'])
    }
  }
}

// Helpers para parsear JSON de FormData y sumar cantidades
function hasNum(v) {
  return v !== null && v !== undefined && !Number.isNaN(Number(v)) && String(v).trim() !== ''
}
function parseJsonArrayField(body, key) {
  const raw = body?.[key]
  if (!raw || typeof raw !== 'string') return []
  try {
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr : []
  } catch {
    return []
  }
}
function sumQuantity(arr, quantityKey = 'quantity') {
  return arr.reduce((acc, v) => acc + Number(v?.[quantityKey] || 0), 0)
}

function normalizeOptionalIdentifier(value) {
  const normalized = String(value ?? '').trim().toUpperCase()
  return normalized || null
}

async function ensureUniqueProductIdentifiers(pool, { sku, productCode, excludeProductId = null }) {
  const normalizedSku = normalizeOptionalIdentifier(sku)
  const normalizedProductCode = normalizeOptionalIdentifier(productCode)

  if (normalizedSku) {
    const skuParams = [normalizedSku]
    let skuQuery = 'SELECT id FROM products WHERE UPPER(TRIM(COALESCE(sku, ""))) = ?'
    if (excludeProductId) {
      skuQuery += ' AND id <> ?'
      skuParams.push(Number(excludeProductId))
    }
    skuQuery += ' LIMIT 1'

    const [skuRows] = await pool.query(skuQuery, skuParams)
    if (Array.isArray(skuRows) && skuRows.length > 0) {
      throw {
        code: 'ER_DUP_ENTRY',
        sqlMessage: `Duplicate entry '${normalizedSku}' for key 'products.sku'`,
        message: 'SKU duplicado'
      }
    }
  }

  if (normalizedProductCode) {
    const codeParams = [normalizedProductCode]
    let codeQuery = 'SELECT id FROM products WHERE UPPER(TRIM(COALESCE(product_code, ""))) = ?'
    if (excludeProductId) {
      codeQuery += ' AND id <> ?'
      codeParams.push(Number(excludeProductId))
    }
    codeQuery += ' LIMIT 1'

    const [codeRows] = await pool.query(codeQuery, codeParams)
    if (Array.isArray(codeRows) && codeRows.length > 0) {
      throw {
        code: 'ER_DUP_ENTRY',
        sqlMessage: `Duplicate entry '${normalizedProductCode}' for key 'uniq_products_product_code'`,
        message: 'Codigo de producto duplicado'
      }
    }
  }

  return {
    normalizedSku,
    normalizedProductCode,
  }
}

function resolveWarehouseScope(req, requestedWarehouseId) {
  const userWarehouseId = getUserWarehouseId(req.user)
  const isAdmin = isAdminUser(req.user)
  const targetWarehouseId = Number(requestedWarehouseId || 0)

  if (isAdmin) {
    return { warehouseId: targetWarehouseId || null, denied: false }
  }
  if (!userWarehouseId) {
    return { warehouseId: null, denied: true }
  }
  if (!targetWarehouseId) {
    return { warehouseId: userWarehouseId, denied: false }
  }
  if (!canAccessWarehouse(req.user, targetWarehouseId)) {
    return { warehouseId: null, denied: true }
  }
  return { warehouseId: targetWarehouseId, denied: false }
}

async function canViewSensitiveProductData(req, pool) {
  return userHasPermissionCode(req, pool, 'products:sensitive:read')
}

async function canWriteProducts(req, pool) {
  return userHasPermissionCode(req, pool, 'products:write')
}

async function userHasPermissionCode(req, pool, permissionCode) {
  if (isAdminUser(req.user)) {
    return true
  }
  if (!req.user?.id) {
    return false
  }

  const [rows] = await pool.query(
    `SELECT 1
     FROM users u
     JOIN role_permissions rp ON u.role_id = rp.role_id
     JOIN permissions p ON rp.permission_id = p.id
     WHERE u.id = ? AND p.code = ?
     LIMIT 1`,
    [req.user.id, permissionCode]
  )

  return Array.isArray(rows) && rows.length > 0
}

function sanitizeSensitiveProductFields(item, includeSensitive) {
  if (includeSensitive) {
    return item
  }

  return {
    ...item,
    cost: undefined,
    avgCost: undefined,
    lastCost: undefined,
    supplierId: undefined,
  }
}

function capTrackedDetailsByWarehouseStock(values, stockRows, warehouseKey = 'warehouseId') {
  const safeValues = Array.isArray(values) ? values.filter(Boolean) : []
  const stockMap = new Map(
    (Array.isArray(stockRows) ? stockRows : []).map(row => [
      Number(row?.warehouse_id || 0),
      Math.max(0, Number(row?.quantity || 0))
    ])
  )
  const usedByWarehouse = new Map()

  return safeValues.filter(item => {
    const warehouseId = Number(item?.[warehouseKey] || 0)
    const allowedQty = stockMap.get(warehouseId)

    if (!allowedQty) {
      return false
    }

    const usedQty = usedByWarehouse.get(warehouseId) || 0
    if (usedQty >= allowedQty) {
      return false
    }

    usedByWarehouse.set(warehouseId, usedQty + 1)
    return true
  })
}

router.get('/', authMiddleware, async (req, res) => {
  try {
    const {
      warehouseId,
      search,
      paged,
      limit: rawLimit,
      offset: rawOffset,
      categoryId,
      subcategoryId,
      brandId,
      supplierId,
      departmentId,
      stockFilter,
    } = req.query
    const pool = await getPool()
    const includeSensitive = await canViewSensitiveProductData(req, pool)
    const scope = resolveWarehouseScope(req, warehouseId)

    if (scope.denied) {
      return res.status(403).json({ error: 'No tienes acceso a esa tienda' })
    }
    
    // Si se especifica warehouseId, calculamos stock local y 'otros'
    // Si no, stock es global y other_stock es 0
    let stockAggregateExpr = `COALESCE(SUM(pws.quantity), 0)`
    let selectStock = `${stockAggregateExpr} as stock, 0 as other_stock`
    const params = []

    if (scope.warehouseId) {
      stockAggregateExpr = `COALESCE(SUM(CASE WHEN pws.warehouse_id = ? THEN pws.quantity ELSE 0 END), 0)`
      selectStock = `
        ${stockAggregateExpr} as stock,
        COALESCE(SUM(CASE WHEN pws.warehouse_id != ? THEN pws.quantity ELSE 0 END), 0) as other_stock
      `
      params.push(scope.warehouseId, scope.warehouseId)
    }

    const whereClauses = []
    const whereParams = []
    const havingClauses = []
    const havingParams = []

    let query = `
      SELECT p.id, p.name, p.sku, p.product_code, p.category_id, p.brand_id, p.supplier_id, p.price, p.price2, p.price3, p.cost, p.avg_cost, p.last_cost,
              ${selectStock}, 
              (SELECT COALESCE(SUM(quantity), 0) FROM inventory_movements WHERE product_id = p.id AND type = 'INITIAL') as initial_stock, 
              p.min_stock, p.unit, p.description, p.image_url, p.product_type, p.alt_name, p.generic_name, p.shelf_location 
       FROM products p 
       LEFT JOIN product_warehouse_stock pws ON p.id = pws.product_id
       LEFT JOIN categories c ON p.category_id = c.id
       LEFT JOIN categories pc ON c.parent_id = pc.id`

    const normalizedSearch = String(search || '').trim()
    if (normalizedSearch) {
      const searchTerms = normalizedSearch
        .split(/\s+/)
        .map(term => term.trim())
        .filter(Boolean)
        .slice(0, 8)

      for (const term of searchTerms) {
        const searchTerm = `%${term}%`
        whereClauses.push(`(
          p.name LIKE ?
          OR COALESCE(p.sku, '') LIKE ?
          OR COALESCE(p.product_code, '') LIKE ?
          OR COALESCE(p.description, '') LIKE ?
          OR COALESCE(p.alt_name, '') LIKE ?
          OR COALESCE(p.generic_name, '') LIKE ?
        )`)
        whereParams.push(searchTerm, searchTerm, searchTerm, searchTerm, searchTerm, searchTerm)
      }
    }

    const normalizedSubcategoryId = Number(subcategoryId || 0)
    const normalizedCategoryId = Number(categoryId || 0)
    const normalizedBrandId = Number(brandId || 0)
    const normalizedSupplierId = Number(supplierId || 0)
    const normalizedDepartmentId = Number(departmentId || 0)

    if (normalizedSubcategoryId > 0) {
      whereClauses.push('p.category_id = ?')
      whereParams.push(normalizedSubcategoryId)
    } else if (normalizedCategoryId > 0) {
      whereClauses.push('(p.category_id = ? OR c.parent_id = ?)')
      whereParams.push(normalizedCategoryId, normalizedCategoryId)
    }

    if (normalizedBrandId > 0) {
      whereClauses.push('p.brand_id = ?')
      whereParams.push(normalizedBrandId)
    }

    if (normalizedSupplierId > 0) {
      whereClauses.push('p.supplier_id = ?')
      whereParams.push(normalizedSupplierId)
    }

    if (normalizedDepartmentId > 0) {
      whereClauses.push('COALESCE(c.department_id, pc.department_id) = ?')
      whereParams.push(normalizedDepartmentId)
    }

    const normalizedStockFilter = String(stockFilter || '').trim().toLowerCase()
    if (normalizedStockFilter === 'with_stock') {
      havingClauses.push('stock > 0')
    } else if (normalizedStockFilter === 'without_stock') {
      havingClauses.push('stock = 0')
    }

    if (whereClauses.length > 0) {
      query += ` WHERE ${whereClauses.join(' AND ')}`
    }

    const limit = Math.min(Math.max(Number(rawLimit || 60), 1), 200)
    const offset = Math.max(Number(rawOffset || 0), 0)
    const isPaged = String(paged || '').toLowerCase() === 'true' || Number(rawLimit || 0) > 0

    const finalParams = [...params, ...whereParams]
    query += ` GROUP BY p.id`
    if (havingClauses.length > 0) {
      query += ` HAVING ${havingClauses.join(' AND ')}`
      finalParams.push(...havingParams)
    }
    query += ` ORDER BY p.id DESC`

    let total = null
    let catalogTotal = null

    if (isPaged) {
      const countParams = [...params, ...whereParams, ...havingParams]
      const [countRows] = await pool.query(
        `SELECT COUNT(*) AS total
         FROM (
           SELECT p.id, ${stockAggregateExpr} AS stock
           FROM products p
           LEFT JOIN product_warehouse_stock pws ON p.id = pws.product_id
           LEFT JOIN categories c ON p.category_id = c.id
           LEFT JOIN categories pc ON c.parent_id = pc.id
           ${whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : ''}
           GROUP BY p.id
           ${havingClauses.length > 0 ? `HAVING ${havingClauses.join(' AND ')}` : ''}
         ) grouped_products`,
        countParams
      )
      total = Number(countRows?.[0]?.total || 0)

      const [catalogRows] = await pool.query('SELECT COUNT(*) AS total FROM products')
      catalogTotal = Number(catalogRows?.[0]?.total || 0)

      query += ` LIMIT ? OFFSET ?`
      finalParams.push(limit, offset)
    }

    const [rows] = await pool.query(query, finalParams)

    const items = rows.map(r => sanitizeSensitiveProductFields({
      id: r.id,
      name: r.name,
      sku: r.sku,
      productCode: r.product_code || undefined,
      categoryId: r.category_id ?? undefined,
      brandId: r.brand_id ?? undefined,
      supplierId: r.supplier_id ?? undefined,
      price: Number(r.price ?? 0),
      price2: Number(r.price2 ?? 0),
      price3: Number(r.price3 ?? 0),
      cost: Number(r.cost ?? 0),
      avgCost: Number(r.avg_cost ?? r.cost ?? 0),
      lastCost: Number(r.last_cost ?? r.cost ?? 0),
      stock: Number(r.stock ?? 0),
      otherStock: Number(r.other_stock ?? 0),
      initialStock: Number(r.initial_stock ?? 0),
      minStock: Number(r.min_stock ?? 0),
      unit: r.unit || undefined,
      description: r.description || undefined,
      imageUrl: r.image_url || undefined,
      productType: r.product_type || undefined,
      altName: r.alt_name || undefined,
      genericName: r.generic_name || undefined,
      shelfLocation: r.shelf_location || undefined,
    }, includeSensitive))

    const productIds = items.map(item => Number(item?.id || 0)).filter(id => id > 0)
    if (productIds.length > 0) {
      const placeholders = productIds.map(() => '?').join(',')
      const [imageRows] = await pool.query(
        `SELECT product_id, image_url
         FROM product_images
         WHERE product_id IN (${placeholders})
         ORDER BY sort_order ASC, id ASC`,
        productIds
      )
      const map = new Map()
      for (const row of imageRows || []) {
        const pid = Number(row.product_id || 0)
        const url = row.image_url ? String(row.image_url) : ''
        if (!pid || !url) continue
        const arr = map.get(pid) || []
        arr.push(url)
        map.set(pid, arr)
      }
      for (const item of items) {
        const pid = Number(item?.id || 0)
        const images = map.get(pid) || []
        item.images = images
        if (!item.imageUrl && images.length > 0) {
          item.imageUrl = images[0]
        }
      }
    }

    if (isPaged) {
      return res.json({
        data: items,
        pagination: {
          total,
          limit,
          offset,
          page: Math.floor(offset / limit) + 1,
          totalPages: Math.max(1, Math.ceil(total / limit)),
          catalogTotal,
        }
      })
    }

    return res.json(items)
  } catch (err) {
    console.error('Products GET error:', err)
    return res.status(500).json({ error: 'Server error' })
  }
})

router.get('/:id/cost-history', authMiddleware, async (req, res) => {
  try {
    const id = Number(req.params.id)
    const pool = await getPool()
    const includeSensitive = await canViewSensitiveProductData(req, pool)

    if (!includeSensitive) {
      return res.status(403).json({ error: 'No tienes permisos para ver el historial de costos' })
    }

    const scope = resolveWarehouseScope(req)
    if (scope.denied) {
      return res.status(403).json({ error: 'No tienes acceso a esa tienda' })
    }

    const productParams = [id]
    let productWhere = 'WHERE p.id = ?'
    if (scope.warehouseId) {
      productWhere += ' AND pws.warehouse_id = ?'
      productParams.push(scope.warehouseId)
    }

    const [productRows] = await pool.query(
      `SELECT p.id, p.name, p.product_code, p.cost, p.avg_cost, p.last_cost
       FROM products p
       LEFT JOIN product_warehouse_stock pws ON p.id = pws.product_id
       ${productWhere}
       GROUP BY p.id
       LIMIT 1`,
      productParams
    )

    const product = productRows?.[0]
    if (!product) {
      return res.status(404).json({ error: 'Producto no encontrado' })
    }

    const historyParams = [id]
    let historyWhere = 'WHERE pi.product_id = ?'
    if (scope.warehouseId) {
      historyWhere += ' AND pu.warehouse_id = ?'
      historyParams.push(scope.warehouseId)
    }

    const [historyRows] = await pool.query(
      `SELECT pu.id AS purchase_id,
              pu.doc_no,
              pu.created_at,
              pu.warehouse_id,
              w.name AS warehouse_name,
              pi.quantity,
              pi.unit_cost,
              COALESCE(pi.total_cost, pi.total, pi.quantity * pi.unit_cost, 0) AS total_cost
       FROM purchase_items pi
       JOIN purchases pu ON pu.id = pi.purchase_id
       LEFT JOIN warehouses w ON w.id = pu.warehouse_id
       ${historyWhere}
       ORDER BY pu.created_at DESC, pi.id DESC`,
      historyParams
    )

    return res.json({
      product: {
        id: Number(product.id),
        name: product.name,
        productCode: product.product_code || undefined,
        cost: Number(product.cost ?? 0),
        avgCost: Number(product.avg_cost ?? product.cost ?? 0),
        lastCost: Number(product.last_cost ?? product.cost ?? 0),
      },
      history: (historyRows || []).map(row => ({
        purchaseId: Number(row.purchase_id),
        purchaseNumber: row.doc_no ? String(row.doc_no) : `Compra #${row.purchase_id}`,
        docNo: row.doc_no || null,
        createdAt: row.created_at,
        warehouseId: row.warehouse_id ? Number(row.warehouse_id) : null,
        warehouseName: row.warehouse_name || null,
        quantity: Number(row.quantity ?? 0),
        unitCost: Number(row.unit_cost ?? 0),
        totalCost: Number(row.total_cost ?? 0),
      })),
    })
  } catch (err) {
    console.error('Product cost history error:', err)
    return res.status(500).json({ error: 'Error al obtener historial de costos' })
  }
})

// NEW: get product with arrays for editing
router.get('/:id', authMiddleware, async (req, res) => {
  try {
    const id = Number(req.params.id)
    const { warehouseId } = req.query
    const pool = await getPool()
    const includeSensitive = await canViewSensitiveProductData(req, pool)
    const scope = resolveWarehouseScope(req, warehouseId)

    if (scope.denied) {
      return res.status(403).json({ error: 'No tienes acceso a esa tienda' })
    }
    
    let selectStock = `COALESCE(SUM(pws.quantity), 0) as stock, 0 as other_stock`
    const params = []

    if (scope.warehouseId) {
      selectStock = `
        COALESCE(SUM(CASE WHEN pws.warehouse_id = ? THEN pws.quantity ELSE 0 END), 0) as stock,
        COALESCE(SUM(CASE WHEN pws.warehouse_id != ? THEN pws.quantity ELSE 0 END), 0) as other_stock
      `
      params.push(scope.warehouseId, scope.warehouseId)
    }
    
    params.push(id)

    const [rows] = await pool.query(
      `SELECT p.id, p.name, p.sku, p.product_code, p.category_id, p.brand_id, p.supplier_id, p.price, p.price2, p.price3, p.cost, p.avg_cost, p.last_cost,
              ${selectStock}, 
              (SELECT COALESCE(SUM(quantity), 0) FROM inventory_movements WHERE product_id = p.id AND type = 'INITIAL') as initial_stock,
              p.min_stock, p.unit, p.description, p.image_url, p.product_type, p.alt_name, p.generic_name, p.shelf_location 
       FROM products p 
       LEFT JOIN product_warehouse_stock pws ON p.id = pws.product_id
       WHERE p.id = ?
       GROUP BY p.id
       LIMIT 1`,
      params
    )
    const r = rows?.[0]
    if (!r) return res.status(404).json({ error: 'Not found' })

    const type = String(r.product_type || 'GENERAL').toUpperCase()
    let batches = []
    let imeis = []
    let serials = []
    let imeiDetails = []
    let serialDetails = []

    if (type === 'MEDICINAL') {
      let query = 'SELECT batch_no, expiry_date, quantity FROM product_batches WHERE product_id = ?'
      const qParams = [id]
      if (scope.warehouseId) {
        query += ' AND warehouse_id = ?'
        qParams.push(scope.warehouseId)
      }
      query += ' ORDER BY expiry_date ASC'
      const [batchRows] = await pool.query(query, qParams)
      batches = (batchRows || []).map(b => ({
        batchNo: b.batch_no || '',
        expiryDate: b.expiry_date ? String(b.expiry_date).slice(0, 10) : '',
        quantity: Number(b.quantity || 0),
      }))
    } else if (type === 'IMEI') {
      const stockQuery = scope.warehouseId
        ? 'SELECT warehouse_id, quantity FROM product_warehouse_stock WHERE product_id = ? AND warehouse_id = ? ORDER BY warehouse_id ASC'
        : 'SELECT warehouse_id, quantity FROM product_warehouse_stock WHERE product_id = ? ORDER BY warehouse_id ASC'
      const stockParams = scope.warehouseId ? [id, scope.warehouseId] : [id]
      const [trackedStockRows] = await pool.query(stockQuery, stockParams)

      let query = `
        SELECT pi.imei, pi.warehouse_id, w.name AS warehouse_name
        FROM product_imeis pi
        LEFT JOIN warehouses w ON w.id = pi.warehouse_id
        WHERE pi.product_id = ? AND pi.status = "AVAILABLE"`
      const qParams = [id]
      if (scope.warehouseId) {
        query += ' AND pi.warehouse_id = ?'
        qParams.push(scope.warehouseId)
      }
      query += ' ORDER BY pi.id ASC'
      const [imeiRows] = await pool.query(query, qParams)
      imeiDetails = capTrackedDetailsByWarehouseStock((imeiRows || []).map(rw => ({
        imei: rw.imei || '',
        warehouseId: rw.warehouse_id ? Number(rw.warehouse_id) : null,
        warehouseName: rw.warehouse_name || 'Sin almacén',
      })), trackedStockRows)
      imeis = imeiDetails.map(item => item.imei)
    } else if (type === 'SERIAL') {
      const stockQuery = scope.warehouseId
        ? 'SELECT warehouse_id, quantity FROM product_warehouse_stock WHERE product_id = ? AND warehouse_id = ? ORDER BY warehouse_id ASC'
        : 'SELECT warehouse_id, quantity FROM product_warehouse_stock WHERE product_id = ? ORDER BY warehouse_id ASC'
      const stockParams = scope.warehouseId ? [id, scope.warehouseId] : [id]
      const [trackedStockRows] = await pool.query(stockQuery, stockParams)

      let query = `
        SELECT ps.serial_no, ps.warehouse_id, w.name AS warehouse_name
        FROM product_serials ps
        LEFT JOIN warehouses w ON w.id = ps.warehouse_id
        WHERE ps.product_id = ? AND ps.status = "AVAILABLE"`
      const qParams = [id]
      if (scope.warehouseId) {
        query += ' AND ps.warehouse_id = ?'
        qParams.push(scope.warehouseId)
      }
      query += ' ORDER BY ps.id ASC'
      const [serialRows] = await pool.query(query, qParams)
      serialDetails = capTrackedDetailsByWarehouseStock((serialRows || []).map(rw => ({
        serial: rw.serial_no || '',
        warehouseId: rw.warehouse_id ? Number(rw.warehouse_id) : null,
        warehouseName: rw.warehouse_name || 'Sin almacén',
      })), trackedStockRows)
      serials = serialDetails.map(item => item.serial)
    }

    const [productImageRows] = await pool.query(
      'SELECT id, image_url, sort_order FROM product_images WHERE product_id = ? ORDER BY sort_order ASC, id ASC',
      [id]
    )
    const imageItems = (productImageRows || [])
      .map(row => ({
        id: Number(row.id || 0),
        imageUrl: row.image_url ? String(row.image_url) : '',
        sortOrder: Number(row.sort_order || 0),
      }))
      .filter(item => item.id > 0 && item.imageUrl)
    const images = imageItems.map(item => item.imageUrl)

    return res.json(sanitizeSensitiveProductFields({
      id: r.id,
      name: r.name,
      sku: r.sku,
      productCode: r.product_code || undefined,
      categoryId: r.category_id ?? undefined,
      brandId: r.brand_id ?? undefined,
      supplierId: r.supplier_id ?? undefined,
      price: Number(r.price ?? 0),
      price2: Number(r.price2 ?? 0),
      price3: Number(r.price3 ?? 0),
      cost: Number(r.cost ?? 0),
      avgCost: Number(r.avg_cost ?? r.cost ?? 0),
      lastCost: Number(r.last_cost ?? r.cost ?? 0),
      stock: Number(r.stock ?? 0),
      otherStock: Number(r.other_stock ?? 0),
      initialStock: Number(r.initial_stock ?? 0),
      minStock: Number(r.min_stock ?? 0),
      unit: r.unit || undefined,
      description: r.description || undefined,
      imageUrl: r.image_url || images[0] || undefined,
      images,
      imageItems,
      productType: type,
      altName: r.alt_name || undefined,
      genericName: r.generic_name || undefined,
      shelfLocation: r.shelf_location || undefined,
      batches,
      imeis,
      serials,
      imeiDetails,
      serialDetails,
    }, includeSensitive))
  } catch (err) {
    console.error('Products GET by id error:', err)
    return res.status(500).json({ error: 'Server error' })
  }
})

// Obtener stock por almacén para un producto
router.get('/:id/warehouse-stock', authMiddleware, async (req, res) => {
  try {
    const productId = Number(req.params.id)
    if (!productId || Number.isNaN(productId)) {
      return res.status(400).json({ error: 'ID de producto inválido' })
    }
    const pool = await getPool()
    await ensureDefaultWarehouseId1(pool)
    await ensureWarehouseStockTable(pool)
    const preferredWarehouseId = Number(getUserWarehouseId(req.user) || 0)
    const [rows] = await pool.query(
      `SELECT
         w.id AS warehouseId,
         w.name AS warehouseName,
         COALESCE(pws.quantity, 0) AS quantity
       FROM warehouses w
       LEFT JOIN product_warehouse_stock pws
         ON pws.warehouse_id = w.id
        AND pws.product_id = ?
       ORDER BY
         CASE WHEN ? > 0 AND w.id = ? THEN 0 ELSE 1 END,
         w.name ASC`,
      [productId, preferredWarehouseId, preferredWarehouseId]
    )
    const items = (rows || []).map(r => ({
      warehouseId: Number(r.warehouseId),
      warehouseName: r.warehouseName,
      quantity: Number(r.quantity || 0),
    }))
    return res.json(items)
  } catch (err) {
    console.error('Products GET warehouse-stock error:', err)
    return res.status(500).json({ error: 'Server error' })
  }
})

// Transferir stock entre almacenes para un producto
router.post('/:id/warehouse-stock/transfer', authMiddleware, roleMiddleware(['ADMIN', 'ALMACEN']), async (req, res) => {
  try {
    const productId = Number(req.params.id)
    const { fromWarehouseId, toWarehouseId, quantity } = req.body || {}
    const isAdmin = isAdminUser(req.user)
    const userWarehouseId = getUserWarehouseId(req.user)
    const fromId = isAdmin ? Number(fromWarehouseId) : Number(userWarehouseId || 0)
    const toId = Number(toWarehouseId)
    const qty = Number(quantity)

    if (!productId || Number.isNaN(productId)) {
      return res.status(400).json({ error: 'ID de producto inválido' })
    }
    if (!fromId || !toId || Number.isNaN(fromId) || Number.isNaN(toId)) {
      return res.status(400).json({ error: 'IDs de almacén inválidos' })
    }
    if (!isAdmin && !userWarehouseId) {
      return res.status(400).json({ error: 'El usuario no tiene una tienda asignada para transferir' })
    }
    if (!isAdmin && Number(fromWarehouseId || 0) && Number(fromWarehouseId) !== Number(userWarehouseId)) {
      return res.status(403).json({ error: 'Solo puedes transferir desde tu tienda asignada' })
    }
    if (fromId === toId) {
      return res.status(400).json({ error: 'El almacén origen y destino deben ser distintos' })
    }
    if (!qty || Number.isNaN(qty) || qty <= 0) {
      return res.status(400).json({ error: 'Cantidad inválida' })
    }

    const pool = await getPool()
    await ensureDefaultWarehouseId1(pool)
    await ensureWarehouseStockTable(pool)
    const conn = await pool.getConnection()
    try {
      await conn.beginTransaction()

      const [[productRow]] = await conn.query(
        'SELECT name, product_type FROM products WHERE id = ? LIMIT 1',
        [productId]
      )
      if (!productRow) {
        throw new Error('Producto no encontrado')
      }

      const normalizedProductType = String(productRow.product_type || '').toUpperCase()
      if (['IMEI', 'SERIAL', 'MEDICINAL'].includes(normalizedProductType)) {
        throw new Error(`El producto ${productRow.name} usa detalle por ${normalizedProductType === 'MEDICINAL' ? 'lotes' : normalizedProductType.toLowerCase()}. Usa el modulo de transferencias con seleccion detallada para evitar desfases.`)
      }
      
      // Registrar salida del origen
      await registerMovement({
        productId,
        warehouseId: fromId,
        type: 'TRANSFER_OUT',
        quantity: qty,
        notes: `Transferencia a almacén ${toId}`,
        userId: req.user?.id
      }, conn)

      // Registrar entrada al destino
      await registerMovement({
        productId,
        warehouseId: toId,
        type: 'TRANSFER_IN',
        quantity: qty,
        notes: `Transferencia desde almacén ${fromId}`,
        userId: req.user?.id
      }, conn)

      await conn.commit()
      return res.json({ ok: true })
    } catch (err) {
      try { await conn.rollback() } catch {}
      console.error('Products POST warehouse-stock/transfer txn error:', err)
      return res.status(400).json({ error: err.message || 'Error realizando transferencia' })
    } finally {
      conn.release()
    }
  } catch (err) {
    console.error('Products POST warehouse-stock/transfer error:', err)
    return res.status(500).json({ error: 'Server error' })
  }
})

router.post('/', authMiddleware, uploadProductImages, async (req, res) => {
  try {
    const { name, sku, productCode, categoryId, brandId, supplierId, price, price2, price3, cost, stock, initialStock, minStock, unit, description, productType, altName, genericName, shelfLocation } = req.body
    const imageUrls = collectUploadedProductImages(req).map(file => `/uploads/${file.filename}`)
    const imageUrl = imageUrls[0] ?? null
    const pool = await getPool()
    if (!await canWriteProducts(req, pool)) {
      return res.status(403).json({ error: 'No tienes permisos para crear productos' })
    }
    const { normalizedSku, normalizedProductCode } = await ensureUniqueProductIdentifiers(pool, { sku, productCode })

    // Sanear arrays recibidos
    const rawBatches = parseJsonArrayField(req.body, 'batches')
    const batches = rawBatches
      .map(b => ({
        batch_no: String(b?.batch_no ?? b?.batchNo ?? '').trim(),
        expiry_date: b?.expiry_date ?? b?.expiryDate ?? null,
        quantity: Number(b?.quantity ?? 0),
      }))
      .filter(b => b.batch_no.length > 0 && b.quantity > 0)
    const rawImeis = parseJsonArrayField(req.body, 'imeis')
    const imeis = rawImeis.map(x => String(x || '').trim()).filter(s => s.length > 0)
    const rawSerials = parseJsonArrayField(req.body, 'serials')
    const serials = rawSerials.map(x => String(x || '').trim()).filter(s => s.length > 0)
    const type = String(productType || 'GENERAL').toUpperCase()
    let derivedStock = hasNum(stock) ? Number(stock) : 0
    if (type === 'MEDICINAL') derivedStock = sumQuantity(batches, 'quantity')
    else if (type === 'IMEI') derivedStock = imeis.length
    else if (type === 'SERIAL') derivedStock = serials.length

    // Reglas de conteo para IMEI/SERIAL: requerir cantidad exacta según stock inicial
    // REMOVED: Stock logic is now handled via purchases/adjustments
    
    // Validar duplicados dentro del mismo envío (protección backend)
    if (type === 'IMEI' && imeis.length) {
      const dupList = [...new Set(imeis.filter((v, i, arr) => arr.indexOf(v) !== i))]
      if (dupList.length > 0) {
        return res.status(409).json({ error: 'Valores duplicados detectados en IMEIs', duplicate: dupList.join(', ') })
      }
    } else if (type === 'SERIAL' && serials.length) {
      const dupList = [...new Set(serials.filter((v, i, arr) => arr.indexOf(v) !== i))]
      if (dupList.length > 0) {
        return res.status(409).json({ error: 'Valores duplicados detectados en series', duplicate: dupList.join(', ') })
      }
    }

    // Verificar duplicados ANTES de crear nada contra la base de datos
    if (type === 'IMEI' && imeis.length) {
      for (const imei of imeis) {
        const [dupRows] = await pool.query('SELECT id FROM product_imeis WHERE imei = ? LIMIT 1', [imei])
        if (dupRows.length > 0) {
          throw { code: 'ER_DUP_ENTRY', sqlMessage: `Duplicate entry '${imei}' for key 'uniq_imei'`, message: 'IMEI duplicado' }
        }
      }
    }

    // Asegurar tablas auxiliares y almacén por defecto
    await ensureDefaultWarehouseId1(pool)
    await ensureWarehouseStockTable(pool)

      // Usar una sola conexión en transacción para crear todo atómicamente
    const conn = await pool.getConnection()
    try {
      await conn.beginTransaction()
      const initialStockValue = Number(initialStock ?? derivedStock ?? 0)

      const [result] = await conn.query(
        'INSERT INTO products (name, sku, product_code, category_id, brand_id, supplier_id, price, price2, price3, cost, avg_cost, last_cost, min_stock, unit, description, image_url, product_type, alt_name, generic_name, shelf_location) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          name,
          normalizedSku,
          normalizedProductCode,
          categoryId ? Number(categoryId) : null,
          brandId ? Number(brandId) : null,
          supplierId ? Number(supplierId) : null,
          Number(price || 0),
          Number(price2 || 0),
          Number(price3 || 0),
          Number(cost || 0),
          Number(cost || 0),
          Number(cost || 0),
          Number(minStock || 0),
          unit || null,
          description || null,
          imageUrl,
          type,
          altName || null,
          genericName || null,
          shelfLocation || null,
        ]
      )
      const id = result.insertId

      if (imageUrls.length > 0) {
        await conn.query(
          'INSERT INTO product_images (product_id, image_url, sort_order) VALUES ?',
          [imageUrls.map((url, idx) => [id, url, idx])]
        )
      }


      if (type === 'MEDICINAL' && batches.length) {
        await Promise.all(
          batches.map(b =>
            conn.query('INSERT INTO product_batches (product_id, batch_no, expiry_date, quantity) VALUES (?, ?, ?, ?)', [id, b.batch_no, b.expiry_date, Number(b.quantity || 0)])
          )
        )
      } else if (type === 'IMEI' && imeis.length) {
        await Promise.all(imeis.map(imei => conn.query('INSERT INTO product_imeis (product_id, imei) VALUES (?, ?)', [id, String(imei || '')])))
      } else if (type === 'SERIAL' && serials.length) {
        await Promise.all(serials.map(serial => conn.query('INSERT INTO product_serials (product_id, serial_no) VALUES (?, ?)', [id, String(serial || '')])))
      }

      // Registrar movimiento INICIAL si hay stock
      if (initialStockValue > 0) {
        // Usamos el almacén ID 1 por defecto para la creación inicial, o lógica futura para elegir almacén
        // Asignar los detalles (lotes, series, imeis) al almacén ID 1 por defecto
        if (type === 'MEDICINAL' && batches.length) {
          await conn.query('UPDATE product_batches SET warehouse_id = 1 WHERE product_id = ?', [id])
        } else if (type === 'IMEI' && imeis.length) {
          await conn.query('UPDATE product_imeis SET warehouse_id = 1 WHERE product_id = ?', [id])
        } else if (type === 'SERIAL' && serials.length) {
          await conn.query('UPDATE product_serials SET warehouse_id = 1 WHERE product_id = ?', [id])
        }

        await registerMovement({
            productId: id,
            warehouseId: 1, // Default TIENDA/PRINCIPAL
            type: 'INITIAL',
            quantity: initialStockValue,
            notes: 'Inventario inicial al crear producto',
            userId: req.user?.id
        }, conn)
      }

      await conn.commit()

      return res.json({
        id,
        name,
        sku: normalizedSku || undefined,
        productCode: normalizedProductCode || undefined,
        categoryId: categoryId ? Number(categoryId) : undefined,
        brandId: brandId ? Number(brandId) : undefined,
        supplierId: supplierId ? Number(supplierId) : undefined,
        price: Number(price || 0),
        price2: Number(price2 || 0),
        price3: Number(price3 || 0),
        cost: Number(cost || 0),
        avgCost: Number(cost || 0),
        lastCost: Number(cost || 0),
        stock: initialStockValue, // Return computed for frontend convenience
        initialStock: initialStockValue,
        minStock: Number(minStock || 0),
        unit: unit || undefined,
        description: description || undefined,
        imageUrl: imageUrl || undefined,
        images: imageUrls,
        productType: type,
        altName: altName || undefined,
        genericName: genericName || undefined,
        shelfLocation: shelfLocation || undefined,
      })
    } catch (txErr) {
      await conn.rollback()
      throw txErr
    } finally {
      conn.release()
    }
  } catch (err) {
    console.error('Products POST error:', err)
    const isDup = err?.code === 'ER_DUP_ENTRY'
    if (isDup) {
      const m = String(err?.sqlMessage || err?.message || '')
      const match = m.match(/Duplicate entry '(.+?)' for key/i)
      const duplicate = match?.[1]
      if (m.includes('product_serials') || m.toLowerCase().includes('serial_no')) {
        return res.status(409).json({ error: 'Serial duplicado', duplicate })
      }
      if (m.includes('product_imeis') || m.toLowerCase().includes('imei')) {
        return res.status(409).json({ error: 'IMEI duplicado', duplicate })
      }
      if (m.toLowerCase().includes('product_code') || m.toLowerCase().includes('uniq_products_product_code')) {
        return res.status(409).json({ error: 'Codigo de producto duplicado', duplicate })
      }
      if (m.includes('products') || m.toLowerCase().includes('sku')) {
        return res.status(409).json({ error: 'SKU duplicado', duplicate })
      }
      return res.status(409).json({ error: 'Registro duplicado', duplicate })
    }
    return res.status(500).json({ error: 'Server error' })
  }
})

router.put('/:id', authMiddleware, uploadProductImages, async (req, res) => {
  try {
    const id = Number(req.params.id)
    const { name, sku, productCode, categoryId, brandId, supplierId, price, price2, price3, cost, stock, initialStock, minStock, unit, description, productType, altName, genericName, shelfLocation } = req.body
    const pool = await getPool()
// #region debug-point product-image-500-products-put
    void __dbgReport({
      hypothesisId: 'H2',
      point: 'products.put.start',
      route: 'PUT /api/products/:id',
      productId: id,
      hasFileKeys: req.files && typeof req.files === 'object' ? Object.keys(req.files) : [],
      fileCounts: req.files && typeof req.files === 'object'
        ? Object.fromEntries(Object.entries(req.files).map(([k, v]) => [k, Array.isArray(v) ? v.length : 0]))
        : {},
      bodyKeys: req.body && typeof req.body === 'object' ? Object.keys(req.body) : [],
    })
// #endregion debug-point product-image-500-products-put
    if (!await canWriteProducts(req, pool)) {
      return res.status(403).json({ error: 'No tienes permisos para editar productos' })
    }
    let nextImage = null
    const newImageUrls = collectUploadedProductImages(req).map(file => `/uploads/${file.filename}`)
    if (newImageUrls.length > 0) nextImage = newImageUrls[0]
    else {
      const [rows] = await pool.query('SELECT image_url FROM products WHERE id = ? LIMIT 1', [id])
      nextImage = rows?.[0]?.image_url ?? null
    }
    const [currRows] = await pool.query(
      `SELECT p.id, p.name, p.sku, p.product_code, p.category_id, p.brand_id, p.supplier_id, p.price, p.price2, p.price3, p.cost, p.avg_cost, p.last_cost,
              COALESCE(SUM(pws.quantity), 0) as stock, 
              (SELECT COALESCE(SUM(quantity), 0) FROM inventory_movements WHERE product_id = p.id AND type = 'INITIAL') as initial_stock,
              p.min_stock, p.unit, p.description, p.image_url, p.product_type, p.alt_name, p.generic_name, p.shelf_location 
       FROM products p 
       LEFT JOIN product_warehouse_stock pws ON p.id = pws.product_id
       WHERE p.id = ?
       GROUP BY p.id
       LIMIT 1`,
      [id]
    )
    const current = currRows?.[0]
    if (!current) return res.status(404).json({ error: 'Not found' })
    const currentType = String(current.product_type || 'GENERAL').toUpperCase()
    const has = (v) => v !== undefined && v !== null && !(typeof v === 'string' && v.trim() === '')
    const hasNum = (v) => has(v) && !isNaN(Number(v))

    // Sanear arrays recibidos
    const rawBatches = parseJsonArrayField(req.body, 'batches')
    const batches = rawBatches
      .map(b => ({
        batch_no: String(b?.batch_no ?? b?.batchNo ?? '').trim(),
        expiry_date: b?.expiry_date ?? b?.expiryDate ?? null,
        quantity: Number(b?.quantity ?? 0),
      }))
      .filter(b => b.batch_no.length > 0 && b.quantity > 0)
    const rawImeis = parseJsonArrayField(req.body, 'imeis')
    const imeis = rawImeis.map(x => String(x || '').trim()).filter(s => s.length > 0)
    const rawSerials = parseJsonArrayField(req.body, 'serials')
    const serials = rawSerials.map(x => String(x || '').trim()).filter(s => s.length > 0)
    const nextType = has(productType) ? String(productType).toUpperCase() : currentType
    let derivedStock = hasNum(stock) ? Number(stock) : Number(current.stock || 0)
    if (nextType === 'MEDICINAL') derivedStock = sumQuantity(batches, 'quantity')
    else if (nextType === 'IMEI') derivedStock = imeis.length
    else if (nextType === 'SERIAL') derivedStock = serials.length

    const immutableTrackedTypes = new Set(['IMEI', 'SERIAL'])
    if (currentType !== nextType && (immutableTrackedTypes.has(currentType) || immutableTrackedTypes.has(nextType))) {
      return res.status(400).json({
        error: 'No puedes cambiar el tipo de un producto con trazabilidad IMEI/SERIAL desde editar producto. Usa un producto nuevo o un proceso controlado de migracion.'
      })
    }

    const nextName = has(name) ? name : current.name
    const nextSku = has(sku) ? normalizeOptionalIdentifier(sku) : normalizeOptionalIdentifier(current.sku)
    const nextProductCode = has(productCode) ? normalizeOptionalIdentifier(productCode) : normalizeOptionalIdentifier(current.product_code)
    const nextCategoryId = hasNum(categoryId) ? Number(categoryId) : (current.category_id ?? null)
    const nextBrandId = hasNum(brandId) ? Number(brandId) : (current.brand_id ?? null)
    const nextSupplierId = hasNum(supplierId) ? Number(supplierId) : (current.supplier_id ?? null)
    const nextPrice = hasNum(price) ? Number(price) : Number(current.price ?? 0)
    const nextPrice2 = hasNum(price2) ? Number(price2) : Number(current.price2 ?? 0)
    const nextPrice3 = hasNum(price3) ? Number(price3) : Number(current.price3 ?? 0)
    const nextCost = hasNum(cost) ? Number(cost) : Number(current.avg_cost ?? current.cost ?? 0)
    const nextStock = Number(derivedStock)
    const nextInitialStock = hasNum(initialStock) ? Number(initialStock) : Number((current.initial_stock ?? current.stock ?? 0))
    const nextMinStock = hasNum(minStock) ? Number(minStock) : Number(current.min_stock ?? 0)
    const nextUnit = has(unit) ? unit : (current.unit || null)
    const nextDescription = has(description) ? description : (current.description || null)
    const nextAltName = has(altName) ? altName : (current.alt_name || null)
    const nextGenericName = has(genericName) ? genericName : (current.generic_name || null)
    const nextShelfLocation = has(shelfLocation) ? shelfLocation : (current.shelf_location || null)
    await ensureUniqueProductIdentifiers(pool, { sku: nextSku, productCode: nextProductCode, excludeProductId: id })

    // Reglas de conteo para IMEI/SERIAL: requerir cantidad exacta según stock inicial
    // REMOVED: Stock logic is now handled via purchases/adjustments

    // Validar duplicados dentro del mismo envío (protección backend)
    if (nextType === 'IMEI' && imeis.length) {
      const dupList = [...new Set(imeis.filter((v, i, arr) => arr.indexOf(v) !== i))]
      if (dupList.length > 0) {
        return res.status(409).json({ error: 'Valores duplicados detectados en IMEIs', duplicate: dupList.join(', ') })
      }
    } else if (nextType === 'SERIAL' && serials.length) {
      const dupList = [...new Set(serials.filter((v, i, arr) => arr.indexOf(v) !== i))]
      if (dupList.length > 0) {
        return res.status(409).json({ error: 'Valores duplicados detectados en series', duplicate: dupList.join(', ') })
      }
    }

    // Verificar duplicados ANTES de hacer cualquier cambio contra la base de datos
    if (nextType === 'IMEI' && imeis.length) {
      for (const imei of imeis) {
        const [dupRows] = await pool.query('SELECT id FROM product_imeis WHERE imei = ? AND product_id != ?', [imei, id])
        if (dupRows.length > 0) {
          throw { code: 'ER_DUP_ENTRY', sqlMessage: `Duplicate entry '${imei}' for key 'uniq_imei'`, message: 'IMEI duplicado' }
        }
      }
    }

    // Usar una sola conexión para la transacción completa
    // Asegurar tablas auxiliares y almacén por defecto
    await ensureDefaultWarehouseId1(pool)
    await ensureWarehouseStockTable(pool)

    const conn = await pool.getConnection()
    try {
      await conn.beginTransaction()

      // Actualizar tabla products con stock tienda/bodega
      await conn.query(
        'UPDATE products SET name = ?, sku = ?, product_code = ?, category_id = ?, brand_id = ?, supplier_id = ?, price = ?, price2 = ?, price3 = ?, cost = ?, avg_cost = ?, last_cost = ?, min_stock = ?, unit = ?, description = ?, image_url = ?, product_type = ?, alt_name = ?, generic_name = ?, shelf_location = ? WHERE id = ?',
        [
          nextName,
          nextSku,
          nextProductCode,
          nextCategoryId,
          nextBrandId,
          nextSupplierId,
          nextPrice,
          nextPrice2,
          nextPrice3,
          nextCost,
          nextCost,
          nextCost,
          nextMinStock,
          nextUnit,
          nextDescription,
          nextImage,
          nextType,
          nextAltName,
          nextGenericName,
          nextShelfLocation,
          id,
        ]
      )

      // NOTA: No sobrescribimos product_warehouse_stock con initial_stock aquí porque
      // eso resetearía el stock real del almacén al valor inicial cada vez que se edita el producto.
      // Solo actualizamos si es un producto nuevo o si queremos forzar el reinicio (lo cual debería ser otra operación).
      // Si se desea actualizar el stock del almacén 1 al editar el "initial_stock", descomentar con precaución.
      /*
      await conn.query(
        'INSERT INTO product_warehouse_stock (product_id, warehouse_id, quantity) VALUES (?, 1, ?) ON DUPLICATE KEY UPDATE quantity = VALUES(quantity)',
        [id, Number(nextInitialStock || 0)]
      )
      */


      await conn.query('DELETE FROM product_batches WHERE product_id = ?', [id])
      if (nextType !== 'IMEI') {
        await conn.query('DELETE FROM product_imeis WHERE product_id = ?', [id])
      }
      if (nextType !== 'SERIAL') {
        await conn.query('DELETE FROM product_serials WHERE product_id = ?', [id])
      }
      await conn.query('DELETE FROM product_variants WHERE product_id = ?', [id])

      if (nextType === 'MEDICINAL' && batches.length) {
        await Promise.all(
          batches.map(b =>
            conn.query('INSERT INTO product_batches (product_id, batch_no, expiry_date, quantity) VALUES (?, ?, ?, ?)', [id, b.batch_no, b.expiry_date, Number(b.quantity || 0)])
          )
        )
      } else if (nextType === 'IMEI' && currentType !== 'IMEI' && imeis.length) {
        await Promise.all(imeis.map(imei => conn.query('INSERT INTO product_imeis (product_id, imei) VALUES (?, ?)', [id, String(imei || '')])))
      } else if (nextType === 'SERIAL' && currentType !== 'SERIAL' && serials.length) {
        await Promise.all(serials.map(serial => conn.query('INSERT INTO product_serials (product_id, serial_no) VALUES (?, ?)', [id, String(serial || '')])))
      }

      if (newImageUrls.length > 0) {
        const [[orderRow]] = await conn.query(
          'SELECT COALESCE(MAX(sort_order), -1) AS max_order FROM product_images WHERE product_id = ?',
          [id]
        )
        const start = Number(orderRow?.max_order ?? -1) + 1
        await conn.query(
          'INSERT INTO product_images (product_id, image_url, sort_order) VALUES ?',
          [newImageUrls.map((url, idx) => [id, url, start + idx])]
        )
      }

      // Confirmar transacción
      await conn.commit()

      const [rows2] = await conn.query(
        `SELECT p.id, p.name, p.sku, p.product_code, p.category_id, p.brand_id, p.supplier_id, p.price, p.price2, p.price3, p.cost, p.avg_cost, p.last_cost,
                COALESCE(SUM(pws.quantity), 0) as stock, 
                (SELECT COALESCE(SUM(quantity), 0) FROM inventory_movements WHERE product_id = p.id AND type = 'INITIAL') as initial_stock,
                p.min_stock, p.unit, p.description, p.image_url, p.product_type, p.alt_name, p.generic_name, p.shelf_location 
         FROM products p 
         LEFT JOIN product_warehouse_stock pws ON p.id = pws.product_id
         WHERE p.id = ?
         GROUP BY p.id
         LIMIT 1`,
        [id]
      )
      const r = rows2?.[0]
      if (!r) return res.status(404).json({ error: 'Not found' })

      const { images, imageItems } = await readProductImages(conn, id)

      return res.json({
        id: r.id,
        name: r.name,
        sku: r.sku,
        productCode: r.product_code || undefined,
        categoryId: r.category_id ?? undefined,
        brandId: r.brand_id ?? undefined,
        supplierId: r.supplier_id ?? undefined,
        price: Number(r.price ?? 0),
        price2: Number(r.price2 ?? 0),
        price3: Number(r.price3 ?? 0),
        cost: Number(r.cost ?? 0),
        avgCost: Number(r.avg_cost ?? r.cost ?? 0),
        lastCost: Number(r.last_cost ?? r.cost ?? 0),
        stock: Number(r.stock ?? 0),
        initialStock: Number(r.initial_stock ?? 0),
        minStock: Number(r.min_stock ?? 0),
        unit: r.unit || undefined,
        description: r.description || undefined,
        imageUrl: r.image_url || images[0] || undefined,
        images,
        imageItems,
        productType: r.product_type || undefined,
        altName: r.alt_name || undefined,
        genericName: r.generic_name || undefined,
        shelfLocation: r.shelf_location || undefined,
      })
    } catch (transactionErr) {
      // Rollback en caso de error dentro de la transacción
      await conn.rollback()
      throw transactionErr
    } finally {
      conn.release()
    }
  } catch (err) {
    console.error('Products PUT error:', err)
// #region debug-point product-image-500-products-put-error
    void __dbgReport({
      hypothesisId: 'H1',
      point: 'products.put.error',
      route: 'PUT /api/products/:id',
      productId: Number(req.params.id || 0),
      errCode: err?.code,
      errMessage: err?.message,
      sqlMessage: err?.sqlMessage,
      stack: err?.stack,
    })
// #endregion debug-point product-image-500-products-put-error
    const isDup = err?.code === 'ER_DUP_ENTRY'
    if (isDup) {
      const m = String(err?.sqlMessage || err?.message || '')
      const match = m.match(/Duplicate entry '(.+?)' for key/i)
      const duplicate = match?.[1]
      if (m.includes('product_serials') || m.toLowerCase().includes('serial_no')) {
        return res.status(409).json({ error: 'Serial duplicado', duplicate })
      }
      if (m.includes('product_imeis') || m.toLowerCase().includes('imei')) {
        return res.status(409).json({ error: 'IMEI duplicado', duplicate })
      }
      if (m.toLowerCase().includes('product_code') || m.toLowerCase().includes('uniq_products_product_code')) {
        return res.status(409).json({ error: 'Codigo de producto duplicado', duplicate })
      }
      if (m.includes('products') || m.toLowerCase().includes('sku')) {
        return res.status(409).json({ error: 'SKU duplicado', duplicate })
      }
      return res.status(409).json({ error: 'Registro duplicado', duplicate })
    }
    return res.status(500).json({ error: 'Server error' })
  }
})

router.post('/:id/images', authMiddleware, upload.array('images', 12), async (req, res) => {
  try {
    const productId = Number(req.params.id)
    if (!productId || Number.isNaN(productId)) {
      return res.status(400).json({ error: 'ID de producto inválido' })
    }
    const files = Array.isArray(req.files) ? req.files : []
    const imageUrls = files.map(file => `/uploads/${file.filename}`).filter(Boolean)
    if (imageUrls.length === 0) {
      return res.status(400).json({ error: 'No se recibieron imágenes' })
    }
    const pool = await getPool()
    if (!await canWriteProducts(req, pool)) {
      return res.status(403).json({ error: 'No tienes permisos para editar productos' })
    }
    const conn = await pool.getConnection()
    try {
      await conn.beginTransaction()
      const [[orderRow]] = await conn.query(
        'SELECT COALESCE(MAX(sort_order), -1) AS max_order FROM product_images WHERE product_id = ?',
        [productId]
      )
      const start = Number(orderRow?.max_order ?? -1) + 1
      await conn.query(
        'INSERT INTO product_images (product_id, image_url, sort_order) VALUES ?',
        [imageUrls.map((url, idx) => [productId, url, start + idx])]
      )
      const imageUrl = await refreshProductPrimaryImage(conn, productId)
      const { images, imageItems } = await readProductImages(conn, productId)
      await conn.commit()
      return res.json({ ok: true, imageUrl: imageUrl || undefined, images, imageItems })
    } catch (txErr) {
      await conn.rollback()
      throw txErr
    } finally {
      conn.release()
    }
  } catch (err) {
    console.error('Products POST images error:', err)
    return res.status(500).json({ error: 'Server error' })
  }
})

router.put('/:id/images/:imageId', authMiddleware, upload.single('image'), async (req, res) => {
  try {
    const productId = Number(req.params.id)
    const imageId = Number(req.params.imageId)
// #region debug-point product-image-500-image-replace
    void __dbgReport({
      hypothesisId: 'H2',
      point: 'products.images.replace.start',
      route: 'PUT /api/products/:id/images/:imageId',
      productId,
      imageId,
      hasFile: Boolean(req.file),
      file: req.file ? { fieldname: req.file.fieldname, originalname: req.file.originalname, filename: req.file.filename, size: req.file.size, mimetype: req.file.mimetype } : null,
    })
// #endregion debug-point product-image-500-image-replace
    if (!productId || Number.isNaN(productId) || !imageId || Number.isNaN(imageId)) {
      return res.status(400).json({ error: 'IDs inválidos' })
    }
    if (!req.file) {
      return res.status(400).json({ error: 'No se recibió imagen' })
    }
    const nextUrl = `/uploads/${req.file.filename}`
    const pool = await getPool()
    if (!await canWriteProducts(req, pool)) {
      return res.status(403).json({ error: 'No tienes permisos para editar productos' })
    }
    const conn = await pool.getConnection()
    try {
      await conn.beginTransaction()
      const [rows] = await conn.query(
        'SELECT id FROM product_images WHERE id = ? AND product_id = ? LIMIT 1',
        [imageId, productId]
      )
      if (!Array.isArray(rows) || rows.length === 0) {
        await conn.rollback()
        return res.status(404).json({ error: 'Imagen no encontrada' })
      }
      await conn.query('UPDATE product_images SET image_url = ? WHERE id = ? AND product_id = ?', [nextUrl, imageId, productId])
      const imageUrl = await refreshProductPrimaryImage(conn, productId)
      const { images, imageItems } = await readProductImages(conn, productId)
      await conn.commit()
      return res.json({ ok: true, imageUrl: imageUrl || undefined, images, imageItems })
    } catch (txErr) {
      await conn.rollback()
      throw txErr
    } finally {
      conn.release()
    }
  } catch (err) {
    console.error('Products PUT image replace error:', err)
// #region debug-point product-image-500-image-replace-error
    void __dbgReport({
      hypothesisId: 'H3',
      point: 'products.images.replace.error',
      route: 'PUT /api/products/:id/images/:imageId',
      productId: Number(req.params.id || 0),
      imageId: Number(req.params.imageId || 0),
      errCode: err?.code,
      errMessage: err?.message,
      sqlMessage: err?.sqlMessage,
      stack: err?.stack,
    })
// #endregion debug-point product-image-500-image-replace-error
    return res.status(500).json({ error: 'Server error' })
  }
})

router.delete('/:id/images/:imageId', authMiddleware, async (req, res) => {
  try {
    const productId = Number(req.params.id)
    const imageId = Number(req.params.imageId)
    if (!productId || Number.isNaN(productId) || !imageId || Number.isNaN(imageId)) {
      return res.status(400).json({ error: 'IDs inválidos' })
    }
    const pool = await getPool()
    if (!await canWriteProducts(req, pool)) {
      return res.status(403).json({ error: 'No tienes permisos para editar productos' })
    }
    const conn = await pool.getConnection()
    try {
      await conn.beginTransaction()
      const [rows] = await conn.query(
        'SELECT id FROM product_images WHERE id = ? AND product_id = ? LIMIT 1',
        [imageId, productId]
      )
      if (!Array.isArray(rows) || rows.length === 0) {
        await conn.rollback()
        return res.status(404).json({ error: 'Imagen no encontrada' })
      }
      await conn.query('DELETE FROM product_images WHERE id = ? AND product_id = ?', [imageId, productId])
      const imageUrl = await refreshProductPrimaryImage(conn, productId)
      const { images, imageItems } = await readProductImages(conn, productId)
      await conn.commit()
      return res.json({ ok: true, imageUrl: imageUrl || undefined, images, imageItems })
    } catch (txErr) {
      await conn.rollback()
      throw txErr
    } finally {
      conn.release()
    }
  } catch (err) {
    console.error('Products DELETE image error:', err)
    return res.status(500).json({ error: 'Server error' })
  }
})

router.put('/:id/images/reorder', authMiddleware, async (req, res) => {
  try {
    const productId = Number(req.params.id)
    if (!productId || Number.isNaN(productId)) {
      return res.status(400).json({ error: 'ID de producto inválido' })
    }
    const rawOrderIds = Array.isArray(req.body?.orderIds) ? req.body.orderIds : []
    const orderIds = rawOrderIds
      .map(x => Number(x))
      .filter(x => x > 0 && !Number.isNaN(x))
    const uniqueOrderIds = [...new Set(orderIds)]

    const pool = await getPool()
    if (!await canWriteProducts(req, pool)) {
      return res.status(403).json({ error: 'No tienes permisos para editar productos' })
    }

    const conn = await pool.getConnection()
    try {
      await conn.beginTransaction()
      const { imageItems } = await readProductImages(conn, productId)
      const existingIds = imageItems.map(item => item.id)
      if (existingIds.length === 0) {
        await conn.rollback()
        return res.status(404).json({ error: 'No hay imágenes para reordenar' })
      }
      const existingSet = new Set(existingIds)
      const filtered = uniqueOrderIds.filter(id => existingSet.has(id))
      const remaining = existingIds.filter(id => !new Set(filtered).has(id))
      const finalOrder = [...filtered, ...remaining]

      await Promise.all(finalOrder.map((id, idx) =>
        conn.query('UPDATE product_images SET sort_order = ? WHERE id = ? AND product_id = ?', [idx, id, productId])
      ))

      const imageUrl = await refreshProductPrimaryImage(conn, productId)
      const { images, imageItems: nextItems } = await readProductImages(conn, productId)
      await conn.commit()
      return res.json({ ok: true, imageUrl: imageUrl || undefined, images, imageItems: nextItems })
    } catch (txErr) {
      await conn.rollback()
      throw txErr
    } finally {
      conn.release()
    }
  } catch (err) {
    console.error('Products PUT images reorder error:', err)
    return res.status(500).json({ error: 'Server error' })
  }
})

router.delete('/:id', authMiddleware, async (req, res) => {
  try {
    const id = Number(req.params.id)
    const pool = await getPool()
    if (!await canWriteProducts(req, pool)) {
      return res.status(403).json({ error: 'No tienes permisos para eliminar productos' })
    }
    await ensureWarehouseStockTable(pool)

    const [rows] = await pool.query(
      `SELECT p.id, COALESCE(SUM(pws.quantity), 0) AS stock
       FROM products p
       LEFT JOIN product_warehouse_stock pws ON p.id = pws.product_id
       WHERE p.id = ?
       GROUP BY p.id
       LIMIT 1`,
      [id]
    )

    const product = Array.isArray(rows) ? rows[0] : null
    if (!product) {
      return res.status(404).json({ error: 'Producto no encontrado' })
    }

    if (Number(product.stock || 0) > 0) {
      return res.status(409).json({
        error: 'No se puede eliminar un producto con stock. Ajusta el inventario a 0 antes de eliminarlo.',
      })
    }

    await pool.query('DELETE FROM product_batches WHERE product_id = ?', [id])
    await pool.query('DELETE FROM product_imeis WHERE product_id = ?', [id])
    await pool.query('DELETE FROM product_serials WHERE product_id = ?', [id])
    await pool.query('DELETE FROM product_variants WHERE product_id = ?', [id])
    await pool.query('DELETE FROM product_warehouse_stock WHERE product_id = ?', [id])
    await pool.query('DELETE FROM products WHERE id = ?', [id])
    return res.json({ ok: true })
  } catch (err) {
    console.error('Products DELETE error:', err)
    if (err?.code === 'ER_ROW_IS_REFERENCED_2' || err?.code === 'ER_ROW_IS_REFERENCED') {
      return res.status(409).json({
        error: 'No se puede eliminar el producto porque tiene movimientos o documentos asociados.',
      })
    }
    return res.status(500).json({ error: 'Server error' })
  }
})

export default router
