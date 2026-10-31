import fs from 'fs'
import path from 'path'
import bcrypt from 'bcryptjs'
import dotenv from 'dotenv'
import mysql from 'mysql2/promise'
import { envPath, projectRoot } from './paths.js'

dotenv.config({ path: envPath })

const dbName = process.env.DB_NAME || 'dtmpos'
const adminEmail = process.env.DEFAULT_ADMIN_EMAIL || 'admin@local'
const adminPassword = process.env.DEFAULT_ADMIN_PASSWORD || 'admin123'

const permissionCatalog = [
  ['users:read', 'Ver usuarios'],
  ['users:write', 'Crear/Editar usuarios'],
  ['roles:read', 'Ver roles'],
  ['roles:write', 'Crear/Editar roles'],
  ['products:read', 'Ver productos'],
  ['products:write', 'Crear/Editar productos'],
  ['products:sensitive:read', 'Ver costos y proveedores en productos'],
  ['categories:read', 'Ver categorias'],
  ['categories:write', 'Crear/Editar categorias'],
  ['brands:read', 'Ver marcas'],
  ['brands:write', 'Crear/Editar marcas'],
  ['suppliers:read', 'Ver proveedores'],
  ['suppliers:write', 'Crear/Editar proveedores'],
  ['departments:read', 'Ver departamentos'],
  ['departments:write', 'Crear/Editar departamentos'],
  ['shelves:read', 'Ver estanterias'],
  ['shelves:write', 'Crear/Editar estanterias'],
  ['warehouses:read', 'Ver almacenes'],
  ['warehouses:write', 'Crear/Editar almacenes'],
  ['units:read', 'Ver unidades'],
  ['units:write', 'Crear/Editar unidades'],
  ['customers:read', 'Ver clientes'],
  ['customers:write', 'Crear/Editar clientes'],
  ['sales:read', 'Ver historial de ventas'],
  ['sales:create', 'Realizar ventas'],
  ['sales:cancel', 'Anular ventas'],
  ['credits:read', 'Reporte de creditos'],
  ['credits:write', 'Gestion de creditos'],
  ['config:read', 'Ver configuracion'],
  ['config:write', 'Editar configuracion'],
  ['reports:read', 'Ver reportes'],
  ['purchases:read', 'Ver compras'],
  ['purchases:write', 'Crear/Editar compras'],
  ['logs:read', 'Ver logs del sistema'],
  ['inventory:read', 'Ver movimientos de inventario'],
  ['inventory:write', 'Realizar ajustes de inventario'],
  ['transfers:read', 'Ver transferencias'],
  ['transfers:write', 'Realizar transferencias'],
  ['pos:access', 'Acceso al POS'],
  ['pos:change_price', 'Cambiar precio en POS'],
  ['pos:manual_price', 'Ingresar precio manual en POS'],
  ['cash:open', 'Abrir caja'],
  ['cash:close', 'Cerrar caja'],
  ['cash:movements', 'Registrar entradas/salidas de efectivo'],
  ['cash:view', 'Ver estado de caja'],
]

const roleDefinitions = [
  {
    code: 'ADMIN',
    name: 'Administrador',
    description: 'Administrador total',
    permissions: 'ALL',
  },
  {
    code: 'CAJERO',
    name: 'Cajero',
    description: 'Cajero punto de venta',
    permissions: [
      'pos:access',
      'pos:change_price',
      'sales:create',
      'sales:read',
      'sales:cancel',
      'customers:read',
      'customers:write',
      'products:read',
      'credits:read',
      'credits:write',
      'cash:open',
      'cash:close',
      'cash:movements',
      'cash:view',
    ],
  },
  {
    code: 'VENDEDOR',
    name: 'Vendedor',
    description: 'Vendedor con acceso a POS sin operaciones de caja',
    permissions: [
      'pos:access',
      'sales:create',
      'sales:read',
      'customers:read',
      'customers:write',
      'products:read',
    ],
  },
  {
    code: 'ALMACEN',
    name: 'Almacen',
    description: 'Encargado de inventario',
    permissions: [
      'products:read',
      'products:write',
      'categories:read',
      'categories:write',
      'brands:read',
      'brands:write',
      'suppliers:read',
      'suppliers:write',
      'departments:read',
      'departments:write',
      'shelves:read',
      'shelves:write',
      'warehouses:read',
      'warehouses:write',
      'units:read',
      'units:write',
      'config:read',
      'purchases:read',
      'purchases:write',
      'inventory:read',
      'inventory:write',
      'transfers:read',
      'transfers:write',
    ],
  },
]

function getConnectionConfig(withDatabase = true) {
  return {
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    ...(withDatabase ? { database: dbName } : {}),
    multipleStatements: true,
  }
}

async function columnExists(conn, table, column) {
  const [rows] = await conn.query(
    `SELECT COUNT(*) AS c
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [dbName, table, column]
  )
  return Number(rows?.[0]?.c || 0) > 0
}

async function indexExists(conn, table, indexName) {
  const [rows] = await conn.query(`SHOW INDEX FROM \`${table}\` WHERE Key_name = ?`, [indexName])
  return Array.isArray(rows) && rows.length > 0
}

async function fkExists(conn, table, fkName) {
  const [rows] = await conn.query(
    `SELECT COUNT(*) AS c
     FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND CONSTRAINT_NAME = ? AND CONSTRAINT_TYPE = 'FOREIGN KEY'`,
    [dbName, table, fkName]
  )
  return Number(rows?.[0]?.c || 0) > 0
}

async function ensureColumn(conn, table, column, definition) {
  if (!(await columnExists(conn, table, column))) {
    await conn.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`)
    console.log(`Added column ${table}.${column}`)
  }
}

async function ensureIndex(conn, table, indexName, expression) {
  if (!(await indexExists(conn, table, indexName))) {
    await conn.query(`CREATE INDEX \`${indexName}\` ON \`${table}\` (${expression})`)
    console.log(`Created index ${indexName} on ${table}`)
  }
}

async function ensureUniqueIndex(conn, table, indexName, expression, duplicateCheckQuery = null) {
  if (await indexExists(conn, table, indexName)) {
    return
  }

  if (duplicateCheckQuery) {
    const [duplicateRows] = await conn.query(duplicateCheckQuery)
    if (Array.isArray(duplicateRows) && duplicateRows.length > 0) {
      const duplicateValue = duplicateRows[0]?.duplicate_value || duplicateRows[0]?.value || 'desconocido'
      console.warn(`Skipped unique index ${indexName} on ${table}: existing duplicates found (${duplicateValue})`)
      return
    }
  }

  await conn.query(`CREATE UNIQUE INDEX \`${indexName}\` ON \`${table}\` (${expression})`)
  console.log(`Created unique index ${indexName} on ${table}`)
}

async function ensureForeignKey(conn, table, column, referencedTable, fkName, onDeleteClause = '') {
  if (!(await fkExists(conn, table, fkName))) {
    try {
      await conn.query(
        `ALTER TABLE \`${table}\` ADD CONSTRAINT \`${fkName}\`
         FOREIGN KEY (\`${column}\`) REFERENCES \`${referencedTable}\`(id)${onDeleteClause ? ` ON DELETE ${onDeleteClause}` : ''}`
      )
      console.log(`Created foreign key ${fkName}`)
    } catch (error) {
      console.warn(`Skipped foreign key ${fkName}: ${error.message}`)
    }
  }
}

async function ensureDatabase() {
  const adminConn = await mysql.createConnection(getConnectionConfig(false))
  await adminConn.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`)
  await adminConn.end()
}

async function applySchema(conn) {
  const schemaPath = path.join(projectRoot, 'db', 'schema.sql')
  const sql = fs.readFileSync(schemaPath, 'utf-8')
  const statements = sql
    .split(/;\s*\r?\n/g)
    .map(chunk =>
      chunk
        .split(/\r?\n/g)
        .filter(line => {
          const trimmed = line.trim()
          return trimmed && !trimmed.startsWith('--')
        })
        .join('\n')
        .trim()
    )
    .filter(Boolean)

  for (const statement of statements) {
    const upper = statement.toUpperCase()
    if (
      upper.startsWith('CREATE DATABASE') ||
      upper.startsWith('USE ') ||
      upper.startsWith('SET @') ||
      upper.startsWith('PREPARE ') ||
      upper.startsWith('EXECUTE ') ||
      upper.startsWith('DEALLOCATE PREPARE')
    ) {
      continue
    }

    try {
      await conn.query(statement)
    } catch (error) {
      const ignorableCodes = new Set([
        'ER_DUP_FIELDNAME',
        'ER_DUP_KEYNAME',
        'ER_DUP_ENTRY',
        'ER_TABLE_EXISTS_ERROR',
      ])

      if (ignorableCodes.has(error.code)) continue
      throw error
    }
  }
}

async function normalizeSchema(conn) {
  await conn.query(`
    CREATE TABLE IF NOT EXISTS units (
      id INT AUTO_INCREMENT PRIMARY KEY,
      code VARCHAR(20) NOT NULL UNIQUE,
      name VARCHAR(100) NOT NULL
    )
  `)

  await ensureColumn(conn, 'roles', 'description', 'VARCHAR(255) NULL')
  await ensureColumn(conn, 'roles', 'code', 'VARCHAR(64) NULL')
  await conn.query(`UPDATE roles SET code = UPPER(REPLACE(name, ' ', '_')) WHERE code IS NULL OR code = ''`)

  await ensureColumn(conn, 'users', 'role_id', 'INT NULL')
  await ensureColumn(conn, 'users', 'warehouse_id', 'INT NULL')
  await ensureColumn(conn, 'users', 'can_sell', 'TINYINT(1) NOT NULL DEFAULT 1')
  try {
    await conn.query(`
      ALTER TABLE users
      MODIFY COLUMN warehouse_id INT NULL DEFAULT NULL
    `)
  } catch (error) {
    console.warn(`Could not normalize users.warehouse_id: ${error.message}`)
  }
  await conn.query(`
    UPDATE users
    SET can_sell = 1
    WHERE can_sell IS NULL
  `)

  await ensureColumn(conn, 'products', 'brand_id', 'INT NULL')
  await ensureColumn(conn, 'products', 'supplier_id', 'INT NULL')
  await ensureColumn(conn, 'products', 'price2', 'DECIMAL(12,2) NOT NULL DEFAULT 0')
  await ensureColumn(conn, 'products', 'price3', 'DECIMAL(12,2) NOT NULL DEFAULT 0')
  await ensureColumn(conn, 'products', 'cost', 'DECIMAL(12,2) NOT NULL DEFAULT 0')
  await ensureColumn(conn, 'products', 'avg_cost', 'DECIMAL(12,2) NOT NULL DEFAULT 0')
  await ensureColumn(conn, 'products', 'last_cost', 'DECIMAL(12,2) NOT NULL DEFAULT 0')
  await ensureColumn(conn, 'products', 'initial_stock', 'INT NOT NULL DEFAULT 0')
  await ensureColumn(conn, 'products', 'min_stock', 'INT NOT NULL DEFAULT 0')
  await ensureColumn(conn, 'products', 'unit', 'VARCHAR(50) NULL')
  await ensureColumn(conn, 'products', 'description', 'TEXT NULL')
  await ensureColumn(conn, 'products', 'image_url', 'VARCHAR(255) NULL')
  await ensureColumn(conn, 'products', 'product_code', 'VARCHAR(80) NULL')
  await ensureColumn(conn, 'products', 'product_type', `VARCHAR(20) NOT NULL DEFAULT 'GENERAL'`)
  await ensureColumn(conn, 'products', 'alt_name', 'VARCHAR(160) NULL')
  await ensureColumn(conn, 'products', 'generic_name', 'VARCHAR(160) NULL')
  await ensureColumn(conn, 'products', 'shelf_location', 'VARCHAR(100) NULL')
  await conn.query(`
    UPDATE products
    SET product_code = NULL
    WHERE product_code IS NOT NULL AND TRIM(product_code) = ''
  `)
  await conn.query(`
    UPDATE products
    SET avg_cost = cost
    WHERE avg_cost IS NULL OR avg_cost = 0
  `)
  await conn.query(`
    UPDATE products
    SET last_cost = cost
    WHERE last_cost IS NULL OR last_cost = 0
  `)
  await ensureUniqueIndex(
    conn,
    'products',
    'uniq_products_product_code',
    'product_code',
    `
      SELECT UPPER(TRIM(product_code)) AS duplicate_value
      FROM products
      WHERE product_code IS NOT NULL AND TRIM(product_code) <> ''
      GROUP BY UPPER(TRIM(product_code))
      HAVING COUNT(*) > 1
      LIMIT 1
    `
  )

  await conn.query(`
    CREATE TABLE IF NOT EXISTS permissions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      code VARCHAR(64) NOT NULL UNIQUE,
      description VARCHAR(255)
    )
  `)
  await conn.query(`
    CREATE TABLE IF NOT EXISTS role_permissions (
      role_id INT NOT NULL,
      permission_id INT NOT NULL,
      PRIMARY KEY (role_id, permission_id)
    )
  `)

  await ensureColumn(conn, 'warehouses', 'type', `ENUM('ALMACEN','TIENDA') NOT NULL DEFAULT 'ALMACEN'`)
  await ensureColumn(conn, 'warehouses', 'address', 'VARCHAR(255) NULL')
  await ensureColumn(conn, 'warehouses', 'status', `ENUM('ACTIVO','INACTIVO') NOT NULL DEFAULT 'ACTIVO'`)

  await ensureColumn(conn, 'purchases', 'user_id', 'INT NULL')
  await ensureColumn(conn, 'purchases', 'notes', 'TEXT NULL')
  await ensureColumn(conn, 'purchases', 'status', `VARCHAR(20) NOT NULL DEFAULT 'COMPLETED'`)
  await ensureColumn(conn, 'purchases', 'warehouse_id', 'INT NULL')
  await ensureColumn(conn, 'purchases', 'document_path', 'VARCHAR(255) NULL')
  await ensureColumn(conn, 'purchases', 'payment_type', `VARCHAR(20) NOT NULL DEFAULT 'CASH'`)
  await ensureColumn(conn, 'purchases', 'payment_status', `VARCHAR(20) NOT NULL DEFAULT 'PAID'`)
  await ensureColumn(conn, 'purchases', 'payment_method', `VARCHAR(20) NOT NULL DEFAULT 'CASH'`)
  await ensureColumn(conn, 'purchases', 'paid_amount', 'DECIMAL(12,2) NOT NULL DEFAULT 0')
  await ensureColumn(conn, 'purchases', 'balance_due', 'DECIMAL(12,2) NOT NULL DEFAULT 0')
  await ensureColumn(conn, 'purchases', 'due_date', 'DATE NULL')
  await ensureColumn(conn, 'purchases', 'paid_at', 'DATETIME NULL')
  await ensureColumn(conn, 'purchase_items', 'total', 'DECIMAL(12,2) NOT NULL DEFAULT 0')
  await ensureColumn(conn, 'purchase_items', 'total_cost', 'DECIMAL(12,2) NOT NULL DEFAULT 0')
  await ensureColumn(conn, 'purchase_items', 'serials', 'TEXT NULL')
  await conn.query(`
    UPDATE purchases
    SET payment_type = COALESCE(NULLIF(payment_type, ''), 'CASH'),
        payment_status = COALESCE(NULLIF(payment_status, ''), 'PAID'),
        payment_method = COALESCE(NULLIF(payment_method, ''), 'CASH'),
        paid_amount = CASE
          WHEN paid_amount IS NULL OR paid_amount = 0 THEN COALESCE(total, 0)
          ELSE paid_amount
        END,
        balance_due = CASE
          WHEN balance_due IS NULL THEN 0
          WHEN payment_status = 'PAID' THEN 0
          ELSE balance_due
        END
  `)
  await conn.query(`
    UPDATE purchases
    SET balance_due = GREATEST(ROUND(COALESCE(total, 0) - COALESCE(paid_amount, 0), 2), 0),
        payment_status = CASE
          WHEN ROUND(GREATEST(COALESCE(total, 0) - COALESCE(paid_amount, 0), 0), 2) = 0 THEN 'PAID'
          WHEN COALESCE(paid_amount, 0) > 0 THEN 'PARTIAL'
          ELSE 'PENDING'
        END
  `)

  await conn.query(`
    CREATE TABLE IF NOT EXISTS purchase_payments (
      id INT AUTO_INCREMENT PRIMARY KEY,
      purchase_id INT NOT NULL,
      amount DECIMAL(12,2) NOT NULL,
      payment_method VARCHAR(20) NOT NULL DEFAULT 'CASH',
      reference VARCHAR(160) NULL,
      notes TEXT NULL,
      document_path VARCHAR(255) NULL,
      paid_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      user_id INT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_purchase_payments_purchase FOREIGN KEY (purchase_id) REFERENCES purchases(id) ON DELETE CASCADE
    )
  `)
  await ensureColumn(conn, 'purchase_payments', 'reference', 'VARCHAR(160) NULL')
  await ensureColumn(conn, 'purchase_payments', 'notes', 'TEXT NULL')
  await ensureColumn(conn, 'purchase_payments', 'document_path', 'VARCHAR(255) NULL')
  await ensureColumn(conn, 'purchase_payments', 'user_id', 'INT NULL')
  await ensureIndex(conn, 'purchase_payments', 'idx_purchase_payments_purchase', 'purchase_id')
  await ensureIndex(conn, 'purchase_payments', 'idx_purchase_payments_paid_at', 'paid_at')
  await ensureForeignKey(conn, 'purchase_payments', 'user_id', 'users', 'fk_purchase_payments_user', 'SET NULL')

  await conn.query(`
    CREATE TABLE IF NOT EXISTS supplier_payments (
      id INT AUTO_INCREMENT PRIMARY KEY,
      supplier_id INT NOT NULL,
      amount DECIMAL(12,2) NOT NULL,
      payment_method VARCHAR(20) NOT NULL DEFAULT 'CASH',
      reference VARCHAR(160) NULL,
      notes TEXT NULL,
      document_path VARCHAR(255) NULL,
      paid_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      user_id INT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_supplier_payments_supplier FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON DELETE CASCADE
    )
  `)
  await ensureColumn(conn, 'supplier_payments', 'reference', 'VARCHAR(160) NULL')
  await ensureColumn(conn, 'supplier_payments', 'notes', 'TEXT NULL')
  await ensureColumn(conn, 'supplier_payments', 'document_path', 'VARCHAR(255) NULL')
  await ensureColumn(conn, 'supplier_payments', 'user_id', 'INT NULL')
  await ensureIndex(conn, 'supplier_payments', 'idx_supplier_payments_supplier', 'supplier_id')
  await ensureIndex(conn, 'supplier_payments', 'idx_supplier_payments_paid_at', 'paid_at')
  await ensureForeignKey(conn, 'supplier_payments', 'user_id', 'users', 'fk_supplier_payments_user', 'SET NULL')

  await conn.query(`
    CREATE TABLE IF NOT EXISTS supplier_payment_allocations (
      id INT AUTO_INCREMENT PRIMARY KEY,
      supplier_payment_id INT NOT NULL,
      purchase_id INT NOT NULL,
      purchase_payment_id INT NULL,
      amount DECIMAL(12,2) NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_supplier_payment_allocations_payment FOREIGN KEY (supplier_payment_id) REFERENCES supplier_payments(id) ON DELETE CASCADE,
      CONSTRAINT fk_supplier_payment_allocations_purchase FOREIGN KEY (purchase_id) REFERENCES purchases(id) ON DELETE CASCADE
    )
  `)
  await ensureColumn(conn, 'supplier_payment_allocations', 'purchase_payment_id', 'INT NULL')
  await ensureIndex(conn, 'supplier_payment_allocations', 'idx_supplier_payment_allocations_payment', 'supplier_payment_id')
  await ensureIndex(conn, 'supplier_payment_allocations', 'idx_supplier_payment_allocations_purchase', 'purchase_id')
  await ensureForeignKey(conn, 'supplier_payment_allocations', 'purchase_payment_id', 'purchase_payments', 'fk_supplier_payment_allocations_purchase_payment', 'SET NULL')

  if (await columnExists(conn, 'purchase_items', 'total')) {
    await conn.query(`
      UPDATE purchase_items
      SET total_cost = total
      WHERE (total_cost IS NULL OR total_cost = 0) AND total IS NOT NULL
    `)
    await conn.query(`
      UPDATE purchase_items
      SET total = total_cost
      WHERE (total IS NULL OR total = 0) AND total_cost IS NOT NULL
    `)
    try {
      await conn.query(`
        ALTER TABLE purchase_items
        MODIFY COLUMN total DECIMAL(12,2) NOT NULL DEFAULT 0
      `)
    } catch (error) {
      console.warn(`Could not normalize purchase_items.total: ${error.message}`)
    }
  }

  await ensureColumn(conn, 'sales', 'payment_method', `VARCHAR(50) DEFAULT 'CASH'`)
  await ensureColumn(conn, 'sales', 'received_amount', 'DECIMAL(12,2) NOT NULL DEFAULT 0')
  await ensureColumn(conn, 'sales', 'change_amount', 'DECIMAL(12,2) NOT NULL DEFAULT 0')
  await ensureColumn(conn, 'sales', 'reference_number', 'VARCHAR(120) NULL')
  await ensureColumn(conn, 'sales', 'status', `VARCHAR(20) NOT NULL DEFAULT 'COMPLETED'`)
  await ensureColumn(conn, 'sales', 'cancellation_reason', 'TEXT NULL')
  await ensureColumn(conn, 'sales', 'user_id', 'INT NULL')

  await ensureColumn(conn, 'credit_payments', 'payment_method', `VARCHAR(20) NOT NULL DEFAULT 'CASH'`)
  await ensureColumn(conn, 'credit_payments', 'reference', 'VARCHAR(160) NULL')
  await ensureColumn(conn, 'credit_payments', 'document_url', 'VARCHAR(255) NULL')
  await ensureColumn(conn, 'credit_payments', 'received_by', 'VARCHAR(160) NULL')
  await ensureColumn(conn, 'credit_payments', 'user_id', 'INT NULL')
  try {
    await conn.query(`
      ALTER TABLE cash_movements
      MODIFY COLUMN ref_type ENUM('SALE','PURCHASE','MANUAL','PAYMENT','CREDIT_PAYMENT') NOT NULL
    `)
  } catch (error) {
    console.warn(`Could not normalize cash_movements.ref_type: ${error.message}`)
  }
  await conn.query(`
    UPDATE credit_payments
    SET document_url = SUBSTRING(document_url, LOCATE('/uploads/', document_url))
    WHERE document_url IS NOT NULL
      AND document_url != ''
      AND LOCATE('/uploads/', document_url) > 0
      AND document_url NOT LIKE '/uploads/%'
  `)

  await ensureColumn(conn, 'sale_items', 'serial', 'VARCHAR(100) NULL')
  await ensureColumn(conn, 'sale_items', 'imei', 'VARCHAR(50) NULL')
  await ensureColumn(conn, 'sale_items', 'unit_cost_snapshot', 'DECIMAL(12,2) NULL')
  await ensureColumn(conn, 'sale_items', 'total_cost_snapshot', 'DECIMAL(12,2) NULL')
  await conn.query(`
    UPDATE sale_items si
    JOIN products p ON p.id = si.product_id
    SET si.unit_cost_snapshot = COALESCE(si.unit_cost_snapshot, p.avg_cost, p.cost, 0),
        si.total_cost_snapshot = COALESCE(si.total_cost_snapshot, si.quantity * COALESCE(si.unit_cost_snapshot, p.avg_cost, p.cost, 0))
    WHERE si.unit_cost_snapshot IS NULL OR si.total_cost_snapshot IS NULL
  `)

  await ensureColumn(conn, 'product_batches', 'warehouse_id', 'INT NOT NULL DEFAULT 1')
  await ensureColumn(conn, 'product_imeis', 'status', `VARCHAR(16) NOT NULL DEFAULT 'AVAILABLE'`)
  await ensureColumn(conn, 'product_imeis', 'warehouse_id', 'INT NOT NULL DEFAULT 1')
  await ensureColumn(conn, 'product_serials', 'status', `VARCHAR(16) NOT NULL DEFAULT 'AVAILABLE'`)
  await ensureColumn(conn, 'product_serials', 'warehouse_id', 'INT NOT NULL DEFAULT 1')

  await conn.query(`
    CREATE TABLE IF NOT EXISTS product_warehouse_stock (
      id INT AUTO_INCREMENT PRIMARY KEY,
      product_id INT NOT NULL,
      warehouse_id INT NOT NULL,
      quantity INT NOT NULL DEFAULT 0,
      UNIQUE KEY uniq_product_warehouse (product_id, warehouse_id),
      CONSTRAINT fk_pws_product FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
      CONSTRAINT fk_pws_warehouse FOREIGN KEY (warehouse_id) REFERENCES warehouses(id) ON DELETE CASCADE
    )
  `)

  await ensureColumn(conn, 'inventory_movements', 'warehouse_id', 'INT NOT NULL DEFAULT 1')
  await ensureColumn(conn, 'inventory_movements', 'reference_id', 'INT NULL')
  await ensureColumn(conn, 'inventory_movements', 'user_id', 'INT NULL')
  await ensureColumn(conn, 'inventory_movements', 'notes', 'VARCHAR(255) NULL')

  if (await columnExists(conn, 'inventory_movements', 'ref_id')) {
    await conn.query(`
      UPDATE inventory_movements
      SET reference_id = ref_id
      WHERE reference_id IS NULL AND ref_id IS NOT NULL
    `)
  }
  if (await columnExists(conn, 'inventory_movements', 'note')) {
    await conn.query(`
      UPDATE inventory_movements
      SET notes = note
      WHERE (notes IS NULL OR notes = '') AND note IS NOT NULL
    `)
  }

  await conn.query(`
    ALTER TABLE inventory_movements
    MODIFY COLUMN type ENUM('INITIAL','PURCHASE','SALE','TRANSFER_IN','TRANSFER_OUT','ADJUSTMENT','ADJUSTMENT_IN','ADJUSTMENT_OUT','IN','OUT','ADJ') NOT NULL
  `)

  await conn.query(`
    CREATE TABLE IF NOT EXISTS transfers (
      id INT AUTO_INCREMENT PRIMARY KEY,
      source_warehouse_id INT NOT NULL,
      destination_warehouse_id INT NOT NULL,
      status ENUM('PENDING','COMPLETED','CANCELLED') NOT NULL DEFAULT 'COMPLETED',
      user_id INT NULL,
      notes TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (source_warehouse_id) REFERENCES warehouses(id),
      FOREIGN KEY (destination_warehouse_id) REFERENCES warehouses(id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `)

  await conn.query(`
    CREATE TABLE IF NOT EXISTS transfer_items (
      id INT AUTO_INCREMENT PRIMARY KEY,
      transfer_id INT NOT NULL,
      product_id INT NOT NULL,
      quantity INT NOT NULL,
      FOREIGN KEY (transfer_id) REFERENCES transfers(id) ON DELETE CASCADE,
      FOREIGN KEY (product_id) REFERENCES products(id)
    )
  `)
  await ensureColumn(conn, 'transfer_items', 'destination_movement_type', 'VARCHAR(20) NULL')
  await ensureColumn(conn, 'transfer_items', 'batch_no', 'VARCHAR(100) NULL')
  await ensureColumn(conn, 'transfer_items', 'imei', 'VARCHAR(100) NULL')
  await ensureColumn(conn, 'transfer_items', 'serial', 'VARCHAR(100) NULL')

  await ensureForeignKey(conn, 'users', 'role_id', 'roles', 'fk_users_role', 'SET NULL')
  await ensureForeignKey(conn, 'users', 'warehouse_id', 'warehouses', 'fk_users_warehouse', 'SET NULL')
  await ensureForeignKey(conn, 'purchases', 'user_id', 'users', 'fk_purchases_user', 'SET NULL')
  await ensureForeignKey(conn, 'purchases', 'warehouse_id', 'warehouses', 'fk_purchases_warehouse', 'SET NULL')
  await ensureForeignKey(conn, 'sales', 'user_id', 'users', 'fk_sales_user', 'SET NULL')
  await ensureForeignKey(conn, 'product_batches', 'warehouse_id', 'warehouses', 'fk_batches_warehouse')
  await ensureForeignKey(conn, 'product_imeis', 'warehouse_id', 'warehouses', 'fk_imeis_warehouse')
  await ensureForeignKey(conn, 'product_serials', 'warehouse_id', 'warehouses', 'fk_serials_warehouse')

  await ensureIndex(conn, 'product_batches', 'idx_batches_warehouse', 'warehouse_id')
  await ensureIndex(conn, 'product_imeis', 'idx_imeis_warehouse', 'warehouse_id')
  await ensureIndex(conn, 'product_serials', 'idx_serials_warehouse', 'warehouse_id')
  await ensureIndex(conn, 'inventory_movements', 'idx_inventory_warehouse', 'warehouse_id')
}

async function seedSecurity(conn) {
  for (const [code, description] of permissionCatalog) {
    await conn.query(
      `INSERT INTO permissions (code, description)
       VALUES (?, ?)
       ON DUPLICATE KEY UPDATE description = VALUES(description)`,
      [code, description]
    )
  }

  for (const role of roleDefinitions) {
    await conn.query(
      `INSERT INTO roles (code, name, description)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE name = VALUES(name), description = VALUES(description)`,
      [role.code, role.name, role.description]
    )
  }

  const [roleRows] = await conn.query(`SELECT id, code FROM roles WHERE code IN ('ADMIN','CAJERO','VENDEDOR','ALMACEN')`)
  const roleIds = Object.fromEntries(roleRows.map(row => [row.code, row.id]))

  const [permissionRows] = await conn.query('SELECT id, code FROM permissions')
  const permissionIds = Object.fromEntries(permissionRows.map(row => [row.code, row.id]))

  for (const role of roleDefinitions) {
    const roleId = roleIds[role.code]
    if (!roleId) continue

    await conn.query('DELETE FROM role_permissions WHERE role_id = ?', [roleId])
    const codes = role.permissions === 'ALL' ? Object.keys(permissionIds) : role.permissions
    for (const code of codes) {
      const permissionId = permissionIds[code]
      if (!permissionId) continue
      await conn.query(
        'INSERT IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)',
        [roleId, permissionId]
      )
    }
  }

  await conn.query(`
    UPDATE users u
    JOIN roles r ON r.code = u.role
    SET u.role_id = r.id
    WHERE u.role_id IS NULL AND u.role IS NOT NULL
  `)

  const passwordHash = await bcrypt.hash(adminPassword, 10)
  await conn.query(
    `INSERT INTO users (name, email, password, role, role_id, warehouse_id, active)
     VALUES (?, ?, ?, 'ADMIN', ?, NULL, 1)
     ON DUPLICATE KEY UPDATE
       name = VALUES(name),
       password = VALUES(password),
       role = 'ADMIN',
       role_id = VALUES(role_id),
       active = 1`,
    ['Admin', adminEmail, passwordHash, roleIds.ADMIN]
  )
}

async function seedCatalogData(conn) {
  console.log('Skipping business catalog seed (units, brands, suppliers, departments, shelves, warehouses).')
  console.log('Create business catalogs manually after bootstrap.')
}

async function main() {
  await ensureDatabase()
  const conn = await mysql.createConnection(getConnectionConfig(true))

  try {
    console.log('Applying schema...')
    await applySchema(conn)

    console.log('Normalizing runtime schema...')
    await normalizeSchema(conn)

    console.log('Seeding roles, permissions and admin...')
    await seedSecurity(conn)

    console.log('Leaving business catalogs empty...')
    await seedCatalogData(conn)

    console.log(`Bootstrap complete for database "${dbName}".`)
    console.log(`Admin user: ${adminEmail} / ${adminPassword}`)
  } finally {
    await conn.end()
  }
}

main().catch(err => {
  console.error('Bootstrap error:', err)
  process.exit(1)
})
