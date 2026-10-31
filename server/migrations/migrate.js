import dotenv from 'dotenv'
import mysql from 'mysql2/promise'

dotenv.config()

async function migrate() {
  const host = process.env.DB_HOST || 'localhost'
  const port = Number(process.env.DB_PORT || 3306)
  const user = process.env.DB_USER || 'root'
  const password = process.env.DB_PASSWORD || ''
  const database = process.env.DB_NAME || 'dtmpos'

  const conn = await mysql.createConnection({ host, port, user, password, database })

  async function columnExists(table, column) {
    const [rows] = await conn.query(
      `SELECT COUNT(*) AS c FROM INFORMATION_SCHEMA.COLUMNS\n       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
      [database, table, column]
    )
    return (rows?.[0]?.c || 0) > 0
  }

  async function ensureColumn(table, column, definition) {
    if (!(await columnExists(table, column))) {
      await conn.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`)
      console.log(`Added column ${table}.${column}`)
    } else {
      console.log(`Column ${table}.${column} exists`)
    }
  }

  async function fkExists(table, column, referencedTable) {
    const [rows] = await conn.query(
      `SELECT COUNT(*) AS c FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE\n       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ? AND REFERENCED_TABLE_NAME = ?`,
      [database, table, column, referencedTable]
    )
    return (rows?.[0]?.c || 0) > 0
  }

  async function ensureForeignKey(table, column, referencedTable, fkName, onDeleteAction = null) {
    try {
      if (!(await fkExists(table, column, referencedTable))) {
        const onDeleteClause = onDeleteAction ? ` ON DELETE ${onDeleteAction}` : ''
        await conn.query(
          `ALTER TABLE \`${table}\` ADD CONSTRAINT \`${fkName}\` FOREIGN KEY (\`${column}\`) REFERENCES \`${referencedTable}\`(id)${onDeleteClause}`
        )
        console.log(`Added FK ${fkName} on ${table}.${column} -> ${referencedTable}.id${onDeleteAction ? ` (ON DELETE ${onDeleteAction})` : ''}`)
      } else {
        console.log(`FK exists for ${table}.${column} -> ${referencedTable}.id`)
      }
    } catch (err) {
      console.warn(`Skipping FK ${fkName} on ${table}.${column} -> ${referencedTable}.id due to error: ${err.code || err.message}`)
    }
  }

  async function indexExists(table, indexName) {
    const [rows] = await conn.query(`SHOW INDEX FROM \`${table}\` WHERE Key_name = ?`, [indexName])
    return Array.isArray(rows) && rows.length > 0
  }

  async function ensureIndex(table, indexName, columnsExpr) {
    if (!(await indexExists(table, indexName))) {
      await conn.query(`CREATE INDEX \`${indexName}\` ON \`${table}\` (${columnsExpr})`)
      console.log(`Created index ${indexName} on ${table}(${columnsExpr})`)
    } else {
      console.log(`Index ${indexName} exists`)
    }
  }

  // Create units catalog table
  await conn.query(`CREATE TABLE IF NOT EXISTS units (
    id INT AUTO_INCREMENT PRIMARY KEY,
    code VARCHAR(16) NOT NULL UNIQUE,
    name VARCHAR(64) NOT NULL
  )`)
  console.log('Ensured units table')
  // Seed default units if empty
  const [urows] = await conn.query('SELECT COUNT(*) AS c FROM units')
  const ucount = urows?.[0]?.c || 0
  if (ucount === 0) {
    await conn.query('INSERT INTO units (code, name) VALUES ?', [
      [
        ['UND','Unidad'],
        ['CJ','Caja'],
        ['PAQ','Paquete'],
        ['BOT','Botella'],
        ['KG','Kilogramo'],
        ['G','Gramo'],
        ['L','Litro'],
        ['ML','Mililitro']
      ]
    ])
    console.log('Seeded default units')
  }

  // Ensure new columns in products
  // Ensure core lookup tables exist (brands, suppliers)
  await conn.query(`CREATE TABLE IF NOT EXISTS brands (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(120) NOT NULL
  )`)
  console.log('Ensured brands table')
  await conn.query(`CREATE TABLE IF NOT EXISTS suppliers (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(160) NOT NULL,
    document VARCHAR(50),
    phone VARCHAR(50),
    email VARCHAR(160),
    address VARCHAR(255)
  )`)
  console.log('Ensured suppliers table')

  // Ensure new columns in products
  await ensureColumn('products', 'brand_id', 'INT NULL')
  await ensureColumn('products', 'supplier_id', 'INT NULL')
  await ensureColumn('products', 'price2', 'DECIMAL(12,2) NOT NULL DEFAULT 0')
  await ensureColumn('products', 'price3', 'DECIMAL(12,2) NOT NULL DEFAULT 0')
  await ensureColumn('products', 'cost', 'DECIMAL(12,2) NOT NULL DEFAULT 0')
  await ensureColumn('products', 'avg_cost', 'DECIMAL(12,2) NOT NULL DEFAULT 0')
  await ensureColumn('products', 'last_cost', 'DECIMAL(12,2) NOT NULL DEFAULT 0')
  await ensureColumn('products', 'initial_stock', 'INT NOT NULL DEFAULT 0')
  await ensureColumn('products', 'min_stock', 'INT NOT NULL DEFAULT 0')
  await ensureColumn('products', 'unit', 'VARCHAR(50) NULL')
  await ensureColumn('products', 'description', 'TEXT NULL')
  await ensureColumn('products', 'image_url', 'VARCHAR(255) NULL')
  await ensureColumn('products', 'product_code', 'VARCHAR(80) NULL')
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
  // Drop legacy store/warehouse stock columns if present
  async function dropColumnIfExists(table, column) {
    const exists = await columnExists(table, column)
    if (exists) {
      await conn.query(`ALTER TABLE \`${table}\` DROP COLUMN \`${column}\``)
      console.log(`Dropped column ${table}.${column}`)
    } else {
      console.log(`Column ${table}.${column} not found (nothing to drop)`)    
    }
  }
  await dropColumnIfExists('products', 'store_stock')
  await dropColumnIfExists('products', 'warehouse_stock')

  // New columns for product types and medicinal meta
  await ensureColumn('products', 'product_type', 'VARCHAR(20) NOT NULL DEFAULT "GENERAL"')
  await ensureColumn('products', 'alt_name', 'VARCHAR(255) NULL')
  await ensureColumn('products', 'generic_name', 'VARCHAR(255) NULL')
  await ensureColumn('products', 'shelf_location', 'VARCHAR(255) NULL')

  // Ensure FKs
  await ensureForeignKey('products', 'brand_id', 'brands', 'fk_products_brand')
  await ensureForeignKey('products', 'supplier_id', 'suppliers', 'fk_products_supplier')

  // Helpful indices for filtering
  await ensureIndex('products', 'idx_products_brand', 'brand_id')
  await ensureIndex('products', 'idx_products_supplier', 'supplier_id')
  await ensureIndex('products', 'idx_products_type', 'product_type')

  await conn.query(`CREATE TABLE IF NOT EXISTS product_images (
    id INT AUTO_INCREMENT PRIMARY KEY,
    product_id INT NOT NULL,
    image_url VARCHAR(255) NOT NULL,
    sort_order INT NOT NULL DEFAULT 0,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
  )`)
  console.log('Ensured product_images table')
  await ensureIndex('product_images', 'idx_product_images_product', 'product_id')
  await ensureIndex('product_images', 'idx_product_images_sort', 'product_id, sort_order, id')
  await conn.query(`
    INSERT INTO product_images (product_id, image_url, sort_order)
    SELECT p.id, p.image_url, 0
    FROM products p
    LEFT JOIN product_images pi ON pi.product_id = p.id
    WHERE p.image_url IS NOT NULL
      AND p.image_url != ''
      AND pi.id IS NULL
  `)
  console.log('Backfilled product_images from products.image_url')

  // NEW: Categories parent-child hierarchy
  await ensureColumn('categories', 'parent_id', 'INT NULL')
  await ensureForeignKey('categories', 'parent_id', 'categories', 'fk_categories_parent', 'SET NULL')
  await ensureIndex('categories', 'idx_categories_parent', 'parent_id')

  // NEW: Departments table and category.department_id
  await conn.query(`CREATE TABLE IF NOT EXISTS departments (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(120) NOT NULL UNIQUE
  )`)
  console.log('Ensured departments table')
  await ensureColumn('categories', 'department_id', 'INT NULL')
  await ensureForeignKey('categories', 'department_id', 'departments', 'fk_categories_department', 'SET NULL')
  await ensureIndex('categories', 'idx_categories_department', 'department_id')

  await ensureColumn('sale_items', 'unit_cost_snapshot', 'DECIMAL(12,2) NULL')
  await ensureColumn('sale_items', 'total_cost_snapshot', 'DECIMAL(12,2) NULL')
  await conn.query(`
    UPDATE sale_items si
    JOIN products p ON p.id = si.product_id
    SET si.unit_cost_snapshot = COALESCE(si.unit_cost_snapshot, p.avg_cost, p.cost, 0),
        si.total_cost_snapshot = COALESCE(si.total_cost_snapshot, si.quantity * COALESCE(si.unit_cost_snapshot, p.avg_cost, p.cost, 0))
    WHERE si.unit_cost_snapshot IS NULL OR si.total_cost_snapshot IS NULL
  `)

  await ensureColumn('purchases', 'payment_type', 'VARCHAR(20) NOT NULL DEFAULT "CASH"')
  await ensureColumn('purchases', 'payment_status', 'VARCHAR(20) NOT NULL DEFAULT "PAID"')
  await ensureColumn('purchases', 'payment_method', 'VARCHAR(20) NOT NULL DEFAULT "CASH"')
  await ensureColumn('purchases', 'paid_amount', 'DECIMAL(12,2) NOT NULL DEFAULT 0')
  await ensureColumn('purchases', 'balance_due', 'DECIMAL(12,2) NOT NULL DEFAULT 0')
  await ensureColumn('purchases', 'due_date', 'DATE NULL')
  await ensureColumn('purchases', 'paid_at', 'DATETIME NULL')
  await conn.query(`
    UPDATE purchases
    SET payment_type = COALESCE(NULLIF(payment_type, ''), 'CASH'),
        payment_status = COALESCE(NULLIF(payment_status, ''), 'PAID'),
        payment_method = COALESCE(NULLIF(payment_method, ''), 'CASH'),
        paid_amount = CASE
          WHEN paid_amount IS NULL OR paid_amount = 0 THEN COALESCE(total, 0)
          ELSE paid_amount
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

  await conn.query(`CREATE TABLE IF NOT EXISTS purchase_payments (
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
  )`)
  await ensureForeignKey('purchase_payments', 'user_id', 'users', 'fk_purchase_payments_user', 'SET NULL')
  await ensureIndex('purchase_payments', 'idx_purchase_payments_purchase', 'purchase_id')
  await ensureIndex('purchase_payments', 'idx_purchase_payments_paid_at', 'paid_at')

  await conn.query(`CREATE TABLE IF NOT EXISTS supplier_payments (
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
  )`)
  await ensureColumn('supplier_payments', 'reference', 'VARCHAR(160) NULL')
  await ensureColumn('supplier_payments', 'notes', 'TEXT NULL')
  await ensureColumn('supplier_payments', 'document_path', 'VARCHAR(255) NULL')
  await ensureColumn('supplier_payments', 'user_id', 'INT NULL')
  await ensureForeignKey('supplier_payments', 'user_id', 'users', 'fk_supplier_payments_user', 'SET NULL')
  await ensureIndex('supplier_payments', 'idx_supplier_payments_supplier', 'supplier_id')
  await ensureIndex('supplier_payments', 'idx_supplier_payments_paid_at', 'paid_at')

  await conn.query(`CREATE TABLE IF NOT EXISTS supplier_payment_allocations (
    id INT AUTO_INCREMENT PRIMARY KEY,
    supplier_payment_id INT NOT NULL,
    purchase_id INT NOT NULL,
    purchase_payment_id INT NULL,
    amount DECIMAL(12,2) NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_supplier_payment_allocations_payment FOREIGN KEY (supplier_payment_id) REFERENCES supplier_payments(id) ON DELETE CASCADE,
    CONSTRAINT fk_supplier_payment_allocations_purchase FOREIGN KEY (purchase_id) REFERENCES purchases(id) ON DELETE CASCADE
  )`)
  await ensureColumn('supplier_payment_allocations', 'purchase_payment_id', 'INT NULL')
  await ensureForeignKey('supplier_payment_allocations', 'purchase_payment_id', 'purchase_payments', 'fk_supplier_payment_allocations_purchase_payment', 'SET NULL')
  await ensureIndex('supplier_payment_allocations', 'idx_supplier_payment_allocations_payment', 'supplier_payment_id')
  await ensureIndex('supplier_payment_allocations', 'idx_supplier_payment_allocations_purchase', 'purchase_id')

  // Ensure detail tables for medicinal, IMEI, serial, and variants
  await conn.query(`CREATE TABLE IF NOT EXISTS product_batches (
    id INT AUTO_INCREMENT PRIMARY KEY,
    product_id INT NOT NULL,
    batch_no VARCHAR(100) NOT NULL,
    expiry_date DATE,
    quantity INT NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_batches_product FOREIGN KEY (product_id) REFERENCES products(id)
  )`)
  await ensureIndex('product_batches', 'idx_batches_product', 'product_id')
  await ensureIndex('product_batches', 'idx_batches_expiry', 'expiry_date')

  // Migrate legacy lot_code -> batch_no if needed
  const [pbCols] = await conn.query(`SELECT COLUMN_NAME, DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'product_batches'`, [database])
  const pbHasBatchNo = pbCols.some((c) => c.COLUMN_NAME === 'batch_no')
  const pbHasLotCode = pbCols.some((c) => c.COLUMN_NAME === 'lot_code')
  if (!pbHasBatchNo && pbHasLotCode) {
    await conn.query(`ALTER TABLE product_batches ADD COLUMN batch_no VARCHAR(100) NULL`)
    await conn.query(`UPDATE product_batches SET batch_no = lot_code WHERE batch_no IS NULL`)
    await conn.query(`ALTER TABLE product_batches MODIFY COLUMN batch_no VARCHAR(100) NOT NULL`)
    console.log('Migrated product_batches: added batch_no and copied from lot_code')
  }

  await conn.query(`CREATE TABLE IF NOT EXISTS product_imeis (
    id INT AUTO_INCREMENT PRIMARY KEY,
    product_id INT NOT NULL,
    imei VARCHAR(32) NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'AVAILABLE',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_imeis_product FOREIGN KEY (product_id) REFERENCES products(id),
    UNIQUE KEY uniq_imei (imei)
  )`)
  await ensureIndex('product_imeis', 'idx_imeis_product', 'product_id')

  await conn.query(`CREATE TABLE IF NOT EXISTS product_serials (
    id INT AUTO_INCREMENT PRIMARY KEY,
    product_id INT NOT NULL,
    serial_no VARCHAR(100) NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'AVAILABLE',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_serials_product FOREIGN KEY (product_id) REFERENCES products(id),
    UNIQUE KEY uniq_serial (serial_no)
  )`)
  await ensureIndex('product_serials', 'idx_serials_product', 'product_id')

  // Migrate legacy serial -> serial_no if needed
  const [psCols] = await conn.query(`SELECT COLUMN_NAME, DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'product_serials'`, [database])
  const psHasSerialNo = psCols.some((c) => c.COLUMN_NAME === 'serial_no')
  const psHasSerial = psCols.some((c) => c.COLUMN_NAME === 'serial')
  if (!psHasSerialNo && psHasSerial) {
    await conn.query(`ALTER TABLE product_serials ADD COLUMN serial_no VARCHAR(100) NULL`)
    await conn.query(`UPDATE product_serials SET serial_no = serial WHERE serial_no IS NULL`)
    await conn.query(`ALTER TABLE product_serials MODIFY COLUMN serial_no VARCHAR(100) NOT NULL`)
    // Ensure unique index on serial_no
    const [idxRows] = await conn.query(`SHOW INDEX FROM product_serials WHERE Key_name = 'uniq_serial'`)
    if (!Array.isArray(idxRows) || idxRows.length === 0) {
      await conn.query(`ALTER TABLE product_serials ADD UNIQUE KEY uniq_serial (serial_no)`) 
    }
    console.log('Migrated product_serials: added serial_no and copied from serial')
  }

  // Adjust unique index on product_serials to be composite (product_id, serial_no)
  {
    const [idxRows] = await conn.query(`SHOW INDEX FROM product_serials WHERE Key_name = 'uniq_serial'`)
    const uniqSerialCols = Array.isArray(idxRows) ? idxRows.map(r => r.Column_name) : []
    const hasComposite = uniqSerialCols.includes('product_id') && uniqSerialCols.includes('serial_no')
    const hasOnlySerialNo = uniqSerialCols.length > 0 && uniqSerialCols.every(c => c === 'serial_no')
    if (!hasComposite) {
      // Drop old unique index if present and only on serial_no
      if (hasOnlySerialNo) {
        await conn.query(`ALTER TABLE product_serials DROP INDEX uniq_serial`)
      }
      // Create composite unique index to allow same serial across different products but not within the same product
      await conn.query(`ALTER TABLE product_serials ADD UNIQUE KEY uniq_serial (product_id, serial_no)`)
      console.log('Adjusted product_serials uniq_serial to composite (product_id, serial_no)')
    } else {
      console.log('Composite unique index on product_serials already set')
    }
  }

  // Ensure transactional engine (InnoDB) for consistency on rollback
  async function ensureInnoDb(table) {
    const [rows] = await conn.query(`SELECT ENGINE FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`, [database, table])
    const engine = rows?.[0]?.ENGINE || null
    if (engine && engine.toUpperCase() !== 'INNODB') {
      await conn.query(`ALTER TABLE \`${table}\` ENGINE=InnoDB`)
      console.log(`Altered ${table} engine to InnoDB`)
    } else {
      console.log(`${table} already uses InnoDB`)
    }
  }
  await ensureInnoDb('products')
  await ensureInnoDb('product_serials')

  await conn.query(`CREATE TABLE IF NOT EXISTS product_variants (
    id INT AUTO_INCREMENT PRIMARY KEY,
    product_id INT NOT NULL,
    name VARCHAR(160) NOT NULL,
    sku VARCHAR(80) UNIQUE,
    stock INT NOT NULL DEFAULT 0,
    price DECIMAL(12,2) NOT NULL DEFAULT 0,
    cost DECIMAL(12,2) NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_variants_product FOREIGN KEY (product_id) REFERENCES products(id)
  )`)
  await ensureIndex('product_variants', 'idx_variants_product', 'product_id')

  // Ensure products.product_type is VARCHAR
  const [ptRows] = await conn.query(`SELECT DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'products' AND COLUMN_NAME = 'product_type'`, [database])
  const ptType = ptRows?.[0]?.DATA_TYPE || null
  if (ptType && ptType.toLowerCase() !== 'varchar') {
    await conn.query(`ALTER TABLE products MODIFY COLUMN product_type VARCHAR(20) NOT NULL DEFAULT 'GENERAL'`)
    console.log('Altered products.product_type to VARCHAR(20)')
  }

  await conn.query(`CREATE TABLE IF NOT EXISTS warehouses (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(120) NOT NULL UNIQUE,
    type ENUM('ALMACEN','TIENDA') NOT NULL DEFAULT 'ALMACEN',
    address VARCHAR(255),
    status ENUM('ACTIVO','INACTIVO') NOT NULL DEFAULT 'ACTIVO'
  )`)
  await ensureColumn('warehouses', 'contract_phone', 'VARCHAR(60) NULL')
  await ensureColumn('warehouses', 'contract_facebook', 'VARCHAR(120) NULL')

  await conn.query(`CREATE TABLE IF NOT EXISTS customers (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(160) NOT NULL,
    document VARCHAR(60) NULL,
    phone VARCHAR(60) NULL,
    email VARCHAR(120) NULL,
    address VARCHAR(255) NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`)
  await ensureColumn('customers', 'age', 'INT NULL')
  await ensureColumn('customers', 'nationality', 'VARCHAR(60) NULL')
  await ensureColumn('customers', 'civil_status', 'VARCHAR(60) NULL')
  await ensureColumn('customers', 'occupation', 'VARCHAR(120) NULL')
  await ensureColumn('customers', 'municipality', 'VARCHAR(120) NULL')
  await ensureColumn('customers', 'department', 'VARCHAR(120) NULL')

  // Ensure sales table and payment_method
  await conn.query(`CREATE TABLE IF NOT EXISTS sales (
    id INT AUTO_INCREMENT PRIMARY KEY,
    customer_id INT NULL,
    user_id INT NULL,
    doc_no VARCHAR(50) NULL,
    total DECIMAL(12,2) NOT NULL DEFAULT 0,
    is_credit TINYINT(1) DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`)
  await ensureColumn('sales', 'payment_method', 'VARCHAR(50) DEFAULT "CASH"')
  await ensureColumn('sales', 'payment_document_url', 'VARCHAR(255) NULL')
  await ensureColumn('sales', 'status', 'VARCHAR(20) DEFAULT \"COMPLETED\"')
  await ensureColumn('sales', 'paid_at', 'DATETIME NULL')
  console.log('Ensured sales table and payment_method')

  await conn.query(`CREATE TABLE IF NOT EXISTS installments (
    id INT AUTO_INCREMENT PRIMARY KEY,
    sale_id INT NOT NULL,
    due_date DATE NOT NULL,
    amount DECIMAL(12,2) NOT NULL,
    paid TINYINT(1) NOT NULL DEFAULT 0,
    paid_at TIMESTAMP NULL,
    FOREIGN KEY (sale_id) REFERENCES sales(id)
  )`)
  console.log('Ensured installments table')
  await ensureColumn('installments', 'penalty_waived', 'TINYINT(1) NOT NULL DEFAULT 0')
  await ensureColumn('installments', 'penalty_waived_at', 'DATETIME NULL')
  await ensureColumn('installments', 'penalty_waived_by_user_id', 'INT NULL')

  await conn.query(`CREATE TABLE IF NOT EXISTS credit_payments (
    id INT AUTO_INCREMENT PRIMARY KEY,
    installment_id INT NOT NULL,
    amount DECIMAL(12,2) NOT NULL,
    paid_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (installment_id) REFERENCES installments(id)
  )`)
  console.log('Ensured credit_payments table')

  await ensureColumn('credit_payments', 'payment_type', 'VARCHAR(20) NULL')
  await ensureColumn('credit_payments', 'payment_method', 'VARCHAR(20) NULL')
  await ensureColumn('credit_payments', 'reference', 'VARCHAR(160) NULL')
  await ensureColumn('credit_payments', 'document_url', 'VARCHAR(255) NULL')
  await ensureColumn('credit_payments', 'received_by', 'VARCHAR(160) NULL')
  await ensureColumn('credit_payments', 'user_id', 'INT NULL')
  await ensureIndex('credit_payments', 'idx_credit_payments_installment', 'installment_id')
  await conn.query(`UPDATE credit_payments SET payment_type = COALESCE(NULLIF(payment_type, ''), 'INSTALLMENT')`)
  await conn.query(`
    UPDATE credit_payments cp
    JOIN installments i ON i.id = cp.installment_id
    JOIN sales s ON s.id = i.sale_id
    SET cp.payment_type = 'DOWN_PAYMENT'
    WHERE (cp.payment_type IS NULL OR cp.payment_type = 'INSTALLMENT')
      AND COALESCE(s.payment_method, '') = 'CREDIT'
      AND COALESCE(s.is_credit, 0) = 1
      AND i.paid = 1
      AND i.paid_at IS NOT NULL
      AND s.paid_at IS NOT NULL
      AND ABS(TIMESTAMPDIFF(SECOND, i.paid_at, s.paid_at)) <= 5
      AND ABS(COALESCE(cp.amount, 0) - COALESCE(i.amount, 0)) < 0.01
  `)

  await conn.query(`CREATE TABLE IF NOT EXISTS credit_contracts (
    id INT AUTO_INCREMENT PRIMARY KEY,
    sale_id INT NOT NULL,
    customer_id INT NOT NULL,
    warehouse_id INT NOT NULL,
    template_version VARCHAR(20) NOT NULL DEFAULT 'v1',
    html LONGTEXT NOT NULL,
    data_json LONGTEXT NOT NULL,
    sha256 CHAR(64) NOT NULL,
    created_by_user_id INT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NULL,
    CONSTRAINT fk_credit_contracts_sale FOREIGN KEY (sale_id) REFERENCES sales(id) ON DELETE CASCADE
  )`)
  await ensureColumn('credit_contracts', 'buyer_signature_data', 'LONGTEXT NULL')
  await ensureColumn('credit_contracts', 'buyer_signed_at', 'DATETIME NULL')
  await ensureIndex('credit_contracts', 'idx_credit_contracts_sale', 'sale_id')
  await ensureIndex('credit_contracts', 'idx_credit_contracts_wh', 'warehouse_id')
  await ensureIndex('credit_contracts', 'idx_credit_contracts_customer', 'customer_id')

  await conn.query(`CREATE TABLE IF NOT EXISTS credit_contract_references (
    id INT AUTO_INCREMENT PRIMARY KEY,
    contract_id INT NOT NULL,
    ref_no INT NOT NULL,
    name VARCHAR(160) NULL,
    phone VARCHAR(60) NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_credit_contract_refs_contract FOREIGN KEY (contract_id) REFERENCES credit_contracts(id) ON DELETE CASCADE
  )`)
  await ensureIndex('credit_contract_references', 'idx_credit_contract_refs_contract', 'contract_id')

  await conn.query(`CREATE TABLE IF NOT EXISTS permissions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    code VARCHAR(80) NOT NULL UNIQUE,
    description VARCHAR(255) NULL
  )`)
  await conn.query(`CREATE TABLE IF NOT EXISTS roles (
    id INT AUTO_INCREMENT PRIMARY KEY,
    code VARCHAR(80) NOT NULL UNIQUE,
    name VARCHAR(120) NOT NULL UNIQUE,
    description VARCHAR(255) NULL
  )`)
  try {
    await conn.query('ALTER TABLE roles MODIFY COLUMN code VARCHAR(80) NOT NULL')
  } catch {}
  try {
    await conn.query("UPDATE roles SET code = 'ADMIN' WHERE (code IS NULL OR code = '') AND UPPER(TRIM(name)) IN ('ADMIN','ADMINISTRADOR')")
    await conn.query("UPDATE roles SET code = 'CAJERO' WHERE (code IS NULL OR code = '') AND UPPER(TRIM(name)) IN ('CAJERO')")
    await conn.query("UPDATE roles SET code = 'VENDEDOR' WHERE (code IS NULL OR code = '') AND UPPER(TRIM(name)) IN ('VENDEDOR')")
    await conn.query("UPDATE roles SET code = 'ALMACEN' WHERE (code IS NULL OR code = '') AND (UPPER(TRIM(name)) IN ('ALMACEN','ALMACÉN'))")
  } catch {}
  await conn.query(`CREATE TABLE IF NOT EXISTS role_permissions (
    role_id INT NOT NULL,
    permission_id INT NOT NULL,
    PRIMARY KEY (role_id, permission_id)
  )`)

  async function ensurePermission(code, description) {
    const [rows] = await conn.query('SELECT id FROM permissions WHERE code = ? LIMIT 1', [code])
    if (Array.isArray(rows) && rows.length > 0) return Number(rows[0].id)
    const [ins] = await conn.query('INSERT INTO permissions (code, description) VALUES (?, ?)', [code, description || null])
    return Number(ins.insertId)
  }

  async function ensureRole(code, name, description) {
    const [rows] = await conn.query('SELECT id FROM roles WHERE code = ? OR name = ? LIMIT 1', [code, name])
    if (Array.isArray(rows) && rows.length > 0) return Number(rows[0].id)
    const [ins] = await conn.query('INSERT INTO roles (code, name, description) VALUES (?, ?, ?)', [code, name, description || null])
    return Number(ins.insertId)
  }

  async function ensureRolePermission(roleId, permissionId) {
    await conn.query('INSERT IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)', [roleId, permissionId])
  }

  const permShipMyRead = await ensurePermission('shipments:my:read', 'Ver mis entregas asignadas')
  const permShipMyWrite = await ensurePermission('shipments:my:write', 'Registrar eventos y finalizar mis entregas')
  const roleChoferId = await ensureRole('CHOFER', 'Chofer', 'Chofer (Entregas)')
  await ensureRolePermission(roleChoferId, permShipMyRead)
  await ensureRolePermission(roleChoferId, permShipMyWrite)

  // Create units catalog table
  await conn.query(`CREATE TABLE IF NOT EXISTS units (
    id INT AUTO_INCREMENT PRIMARY KEY,
    code VARCHAR(16) NOT NULL UNIQUE,
    name VARCHAR(64) NOT NULL
  )`)
  console.log('Ensured units table')

  // DROP: eliminar tabla almacen si existe
  await conn.query('DROP TABLE IF EXISTS almacen')

  try {
    await ensureColumn('users', 'is_driver', 'TINYINT(1) NOT NULL DEFAULT 0')
  } catch {}

  await conn.query(`CREATE TABLE IF NOT EXISTS vehicles (
    id INT AUTO_INCREMENT PRIMARY KEY,
    plate VARCHAR(40) NOT NULL UNIQUE,
    name VARCHAR(120) NULL,
    capacity VARCHAR(120) NULL,
    active TINYINT(1) NOT NULL DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`)
  await ensureIndex('vehicles', 'idx_vehicles_active', 'active')

  await conn.query(`CREATE TABLE IF NOT EXISTS shipments (
    id INT AUTO_INCREMENT PRIMARY KEY,
    type VARCHAR(30) NOT NULL,
    source_sale_id INT NULL,
    source_transfer_id INT NULL,
    from_warehouse_id INT NOT NULL,
    to_warehouse_id INT NULL,
    customer_id INT NULL,
    delivery_address VARCHAR(255) NULL,
    contact_name VARCHAR(160) NULL,
    contact_phone VARCHAR(60) NULL,
    driver_user_id INT NULL,
    vehicle_id INT NULL,
    status VARCHAR(30) NOT NULL DEFAULT 'DRAFT',
    scheduled_date DATETIME NULL,
    priority VARCHAR(20) NULL,
    created_by_user_id INT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NULL
  )`)
  await ensureIndex('shipments', 'idx_shipments_type', 'type')
  await ensureIndex('shipments', 'idx_shipments_status', 'status')
  await ensureIndex('shipments', 'idx_shipments_driver', 'driver_user_id')
  await ensureIndex('shipments', 'idx_shipments_source_sale', 'source_sale_id')
  await ensureIndex('shipments', 'idx_shipments_source_transfer', 'source_transfer_id')
  await ensureIndex('shipments', 'idx_shipments_from_wh', 'from_warehouse_id')
  await ensureIndex('shipments', 'idx_shipments_to_wh', 'to_warehouse_id')

  await conn.query(`CREATE TABLE IF NOT EXISTS shipment_items (
    id INT AUTO_INCREMENT PRIMARY KEY,
    shipment_id INT NOT NULL,
    product_id INT NOT NULL,
    qty_planned DECIMAL(12,2) NOT NULL DEFAULT 0,
    qty_dispatched DECIMAL(12,2) NOT NULL DEFAULT 0,
    qty_received DECIMAL(12,2) NOT NULL DEFAULT 0,
    qty_missing DECIMAL(12,2) NOT NULL DEFAULT 0,
    qty_damaged DECIMAL(12,2) NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_shipment_items_shipment FOREIGN KEY (shipment_id) REFERENCES shipments(id) ON DELETE CASCADE,
    CONSTRAINT fk_shipment_items_product FOREIGN KEY (product_id) REFERENCES products(id)
  )`)
  await ensureIndex('shipment_items', 'idx_shipment_items_shipment', 'shipment_id')

  await conn.query(`CREATE TABLE IF NOT EXISTS shipment_events (
    id INT AUTO_INCREMENT PRIMARY KEY,
    shipment_id INT NOT NULL,
    event_type VARCHAR(40) NOT NULL,
    notes TEXT NULL,
    receiver_name VARCHAR(160) NULL,
    receiver_dpi VARCHAR(40) NULL,
    created_by_user_id INT NULL,
    geo_lat DECIMAL(10,7) NULL,
    geo_lng DECIMAL(10,7) NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_shipment_events_shipment FOREIGN KEY (shipment_id) REFERENCES shipments(id) ON DELETE CASCADE
  )`)
  await ensureIndex('shipment_events', 'idx_shipment_events_shipment', 'shipment_id')
  await ensureIndex('shipment_events', 'idx_shipment_events_created', 'created_at')

  await conn.query(`CREATE TABLE IF NOT EXISTS shipment_event_media (
    id INT AUTO_INCREMENT PRIMARY KEY,
    event_id INT NOT NULL,
    media_type VARCHAR(20) NOT NULL,
    url VARCHAR(255) NOT NULL,
    captured_at DATETIME NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_shipment_event_media_event FOREIGN KEY (event_id) REFERENCES shipment_events(id) ON DELETE CASCADE
  )`)
  await ensureIndex('shipment_event_media', 'idx_shipment_event_media_event', 'event_id')

  await conn.query(`CREATE TABLE IF NOT EXISTS shipment_issues (
    id INT AUTO_INCREMENT PRIMARY KEY,
    shipment_id INT NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'OPEN',
    reason VARCHAR(255) NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    resolved_at DATETIME NULL,
    CONSTRAINT fk_shipment_issues_shipment FOREIGN KEY (shipment_id) REFERENCES shipments(id) ON DELETE CASCADE
  )`)
  await ensureIndex('shipment_issues', 'idx_shipment_issues_shipment', 'shipment_id')
  await ensureIndex('shipment_issues', 'idx_shipment_issues_status', 'status')

  await conn.query(`CREATE TABLE IF NOT EXISTS shipment_issue_items (
    id INT AUTO_INCREMENT PRIMARY KEY,
    issue_id INT NOT NULL,
    product_id INT NOT NULL,
    qty_missing DECIMAL(12,2) NOT NULL DEFAULT 0,
    qty_damaged DECIMAL(12,2) NOT NULL DEFAULT 0,
    notes VARCHAR(255) NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_shipment_issue_items_issue FOREIGN KEY (issue_id) REFERENCES shipment_issues(id) ON DELETE CASCADE,
    CONSTRAINT fk_shipment_issue_items_product FOREIGN KEY (product_id) REFERENCES products(id)
  )`)
  await ensureIndex('shipment_issue_items', 'idx_shipment_issue_items_issue', 'issue_id')

  await conn.end()
  console.log('Migration finished.')
}

migrate().catch(err => {
  console.error('Migration error:', err)
  process.exit(1)
})
