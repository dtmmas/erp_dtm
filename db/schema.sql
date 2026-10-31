-- DTMPos MySQL schema
CREATE DATABASE IF NOT EXISTS dtmpos CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE dtmpos;

-- Roles
CREATE TABLE IF NOT EXISTS roles (
  id INT AUTO_INCREMENT PRIMARY KEY,
  code ENUM('ADMIN','CAJERO','ALMACEN') NOT NULL UNIQUE,
  name VARCHAR(50) NOT NULL
);
INSERT IGNORE INTO roles (id, code, name) VALUES
(1,'ADMIN','Administrador'),(2,'CAJERO','Cajero'),(3,'ALMACEN','Almacén');

-- Usuarios
CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  email VARCHAR(160) NOT NULL UNIQUE,
  password VARCHAR(200) NOT NULL,
  role ENUM('ADMIN','CAJERO','ALMACEN') NOT NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Configuración
CREATE TABLE IF NOT EXISTS system_config (
  id INT PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  currency VARCHAR(8) NOT NULL,
  logo_url VARCHAR(255)
);
INSERT IGNORE INTO system_config (id, name, currency, logo_url) VALUES (1,'DTMPos','Q.',NULL);

-- Proveedores y Clientes
CREATE TABLE IF NOT EXISTS suppliers (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(160) NOT NULL,
  document VARCHAR(50),
  phone VARCHAR(50),
  email VARCHAR(160),
  address VARCHAR(255)
);

CREATE TABLE IF NOT EXISTS customers (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(160) NOT NULL,
  document VARCHAR(50),
  phone VARCHAR(50),
  email VARCHAR(160),
  address VARCHAR(255)
);

-- Marcas
CREATE TABLE IF NOT EXISTS brands (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(120) NOT NULL
);

-- Estantes (Shelves)
CREATE TABLE IF NOT EXISTS shelves (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(120) NOT NULL UNIQUE
);

-- Tiendas
CREATE TABLE IF NOT EXISTS stores (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(120) NOT NULL UNIQUE
);

-- Bodegas
CREATE TABLE IF NOT EXISTS warehouses (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(120) NOT NULL UNIQUE
);

-- Productos y Categorías
-- Departamentos
CREATE TABLE IF NOT EXISTS departments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(120) NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS categories (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  parent_id INT NULL,
  department_id INT NULL,
  FOREIGN KEY (parent_id) REFERENCES categories(id) ON DELETE SET NULL,
  FOREIGN KEY (department_id) REFERENCES departments(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS products (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(160) NOT NULL,
  sku VARCHAR(80) UNIQUE,
  product_code VARCHAR(80) UNIQUE,
  category_id INT,
  brand_id INT,
  supplier_id INT,
  price DECIMAL(12,2) NOT NULL DEFAULT 0,
  price2 DECIMAL(12,2) NOT NULL DEFAULT 0,
  price3 DECIMAL(12,2) NOT NULL DEFAULT 0,
  cost DECIMAL(12,2) NOT NULL DEFAULT 0,
  stock INT NOT NULL DEFAULT 0,
  initial_stock INT NOT NULL DEFAULT 0,
  min_stock INT NOT NULL DEFAULT 0,
  unit VARCHAR(50),
  description TEXT,
  image_url VARCHAR(255),
  FOREIGN KEY (category_id) REFERENCES categories(id),
  FOREIGN KEY (brand_id) REFERENCES brands(id),
  FOREIGN KEY (supplier_id) REFERENCES suppliers(id)
);

CREATE TABLE IF NOT EXISTS product_images (
  id INT AUTO_INCREMENT PRIMARY KEY,
  product_id INT NOT NULL,
  image_url VARCHAR(255) NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
);

-- Asegurar columna brand_id si products ya existía sin ella
SET @col_exists := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'products' AND COLUMN_NAME = 'brand_id');
SET @stmt := IF(@col_exists = 0, 'ALTER TABLE products ADD COLUMN brand_id INT NULL', 'SELECT 1');
PREPARE s1 FROM @stmt; EXECUTE s1; DEALLOCATE PREPARE s1;
-- Asegurar foreign key brand_id
SET @fk_exists := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'products' AND COLUMN_NAME = 'brand_id' AND REFERENCED_TABLE_NAME = 'brands');
SET @stmt2 := IF(@fk_exists = 0, 'ALTER TABLE products ADD CONSTRAINT fk_products_brand FOREIGN KEY (brand_id) REFERENCES brands(id)', 'SELECT 1');
PREPARE s2 FROM @stmt2; EXECUTE s2; DEALLOCATE PREPARE s2;

-- Asegurar columna supplier_id
SET @col_exists := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'products' AND COLUMN_NAME = 'supplier_id');
SET @stmt := IF(@col_exists = 0, 'ALTER TABLE products ADD COLUMN supplier_id INT NULL', 'SELECT 1');
PREPARE s3 FROM @stmt; EXECUTE s3; DEALLOCATE PREPARE s3;
-- Asegurar foreign key supplier_id
SET @fk_exists := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'products' AND COLUMN_NAME = 'supplier_id' AND REFERENCED_TABLE_NAME = 'suppliers');
SET @stmt2 := IF(@fk_exists = 0, 'ALTER TABLE products ADD CONSTRAINT fk_products_supplier FOREIGN KEY (supplier_id) REFERENCES suppliers(id)', 'SELECT 1');
PREPARE s4 FROM @stmt2; EXECUTE s4; DEALLOCATE PREPARE s4;

-- Asegurar columna min_stock
SET @col_exists := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'products' AND COLUMN_NAME = 'min_stock');
SET @stmt := IF(@col_exists = 0, 'ALTER TABLE products ADD COLUMN min_stock INT NOT NULL DEFAULT 0', 'SELECT 1');
PREPARE s5 FROM @stmt; EXECUTE s5; DEALLOCATE PREPARE s5;

-- Asegurar columna description
SET @col_exists := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'products' AND COLUMN_NAME = 'description');
SET @stmt := IF(@col_exists = 0, 'ALTER TABLE products ADD COLUMN description TEXT NULL', 'SELECT 1');
PREPARE s6 FROM @stmt; EXECUTE s6; DEALLOCATE PREPARE s6;

-- Asegurar columna unit
SET @col_exists := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'products' AND COLUMN_NAME = 'unit');
SET @stmt := IF(@col_exists = 0, 'ALTER TABLE products ADD COLUMN unit VARCHAR(50) NULL', 'SELECT 1');
PREPARE s7 FROM @stmt; EXECUTE s7; DEALLOCATE PREPARE s7;

-- Asegurar columna initial_stock
SET @col_exists := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'products' AND COLUMN_NAME = 'initial_stock');
SET @stmt := IF(@col_exists = 0, 'ALTER TABLE products ADD COLUMN initial_stock INT NOT NULL DEFAULT 0', 'SELECT 1');
PREPARE s8 FROM @stmt; EXECUTE s8; DEALLOCATE PREPARE s8;

-- Asegurar columna price2
SET @col_exists := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'products' AND COLUMN_NAME = 'price2');
SET @stmt := IF(@col_exists = 0, 'ALTER TABLE products ADD COLUMN price2 DECIMAL(12,2) NOT NULL DEFAULT 0', 'SELECT 1');
PREPARE s9 FROM @stmt; EXECUTE s9; DEALLOCATE PREPARE s9;

-- Asegurar columna price3
SET @col_exists := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'products' AND COLUMN_NAME = 'price3');
SET @stmt := IF(@col_exists = 0, 'ALTER TABLE products ADD COLUMN price3 DECIMAL(12,2) NOT NULL DEFAULT 0', 'SELECT 1');
PREPARE s10 FROM @stmt; EXECUTE s10; DEALLOCATE PREPARE s10;

-- Asegurar columna product_code
SET @col_exists := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'products' AND COLUMN_NAME = 'product_code');
SET @stmt := IF(@col_exists = 0, 'ALTER TABLE products ADD COLUMN product_code VARCHAR(80) NULL', 'SELECT 1');
PREPARE s11 FROM @stmt; EXECUTE s11; DEALLOCATE PREPARE s11;

-- Asegurar columna product_type
SET @col_exists := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'products' AND COLUMN_NAME = 'product_type');
SET @stmt := IF(@col_exists = 0, 'ALTER TABLE products ADD COLUMN product_type VARCHAR(20) DEFAULT "GENERAL"', 'SELECT 1');
PREPARE s12 FROM @stmt; EXECUTE s12; DEALLOCATE PREPARE s12;

-- Asegurar columna alt_name
SET @col_exists := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'products' AND COLUMN_NAME = 'alt_name');
SET @stmt := IF(@col_exists = 0, 'ALTER TABLE products ADD COLUMN alt_name VARCHAR(160) NULL', 'SELECT 1');
PREPARE s13 FROM @stmt; EXECUTE s13; DEALLOCATE PREPARE s13;

-- Asegurar columna generic_name
SET @col_exists := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'products' AND COLUMN_NAME = 'generic_name');
SET @stmt := IF(@col_exists = 0, 'ALTER TABLE products ADD COLUMN generic_name VARCHAR(160) NULL', 'SELECT 1');
PREPARE s14 FROM @stmt; EXECUTE s14; DEALLOCATE PREPARE s14;

-- Asegurar columna shelf_location
SET @col_exists := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'products' AND COLUMN_NAME = 'shelf_location');
SET @stmt := IF(@col_exists = 0, 'ALTER TABLE products ADD COLUMN shelf_location VARCHAR(100) NULL', 'SELECT 1');
PREPARE s15 FROM @stmt; EXECUTE s15; DEALLOCATE PREPARE s15;

-- (Eliminado: columnas store_stock y warehouse_stock en products)

-- Tablas para productos especializados

-- Lotes para productos medicinales
CREATE TABLE IF NOT EXISTS product_batches (
  id INT AUTO_INCREMENT PRIMARY KEY,
  product_id INT NOT NULL,
  batch_no VARCHAR(100) NOT NULL,
  expiry_date DATE,
  quantity INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
);

-- IMEIs para productos con IMEI
CREATE TABLE IF NOT EXISTS product_imeis (
  id INT AUTO_INCREMENT PRIMARY KEY,
  product_id INT NOT NULL,
  imei VARCHAR(50) NOT NULL UNIQUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
);

-- Números de serie para productos con serial
CREATE TABLE IF NOT EXISTS product_serials (
  id INT AUTO_INCREMENT PRIMARY KEY,
  product_id INT NOT NULL,
  serial_no VARCHAR(100) NOT NULL UNIQUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
);

-- Variantes para productos con variantes
CREATE TABLE IF NOT EXISTS product_variants (
  id INT AUTO_INCREMENT PRIMARY KEY,
  product_id INT NOT NULL,
  name VARCHAR(160) NOT NULL,
  sku VARCHAR(80) UNIQUE,
  stock INT NOT NULL DEFAULT 0,
  price DECIMAL(12,2) NOT NULL DEFAULT 0,
  cost DECIMAL(12,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
);

-- (Eliminado: tabla 'almacen')

-- Movimientos de inventario (Kardex)
CREATE TABLE IF NOT EXISTS inventory_movements (
  id INT AUTO_INCREMENT PRIMARY KEY,
  product_id INT NOT NULL,
  type ENUM('IN','OUT','ADJ') NOT NULL,
  quantity INT NOT NULL,
  unit_cost DECIMAL(12,2) NOT NULL DEFAULT 0,
  total_cost DECIMAL(12,2) NOT NULL DEFAULT 0,
  ref_type ENUM('PURCHASE','SALE','MANUAL','ADJUST') NOT NULL,
  ref_id INT,
  note VARCHAR(255),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (product_id) REFERENCES products(id)
);

-- (Ubicaciones detalladas retiradas: se usa stock por tienda/bodega en products)

-- Compras
CREATE TABLE IF NOT EXISTS purchases (
  id INT AUTO_INCREMENT PRIMARY KEY,
  supplier_id INT NOT NULL,
  doc_no VARCHAR(80),
  total DECIMAL(12,2) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (supplier_id) REFERENCES suppliers(id)
);
CREATE TABLE IF NOT EXISTS purchase_items (
  id INT AUTO_INCREMENT PRIMARY KEY,
  purchase_id INT NOT NULL,
  product_id INT NOT NULL,
  quantity INT NOT NULL,
  unit_cost DECIMAL(12,2) NOT NULL,
  total DECIMAL(12,2) NOT NULL,
  FOREIGN KEY (purchase_id) REFERENCES purchases(id),
  FOREIGN KEY (product_id) REFERENCES products(id)
);

-- Ventas
CREATE TABLE IF NOT EXISTS sales (
  id INT AUTO_INCREMENT PRIMARY KEY,
  customer_id INT,
  user_id INT,
  doc_no VARCHAR(80),
  total DECIMAL(12,2) NOT NULL,
  is_credit TINYINT(1) NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (customer_id) REFERENCES customers(id),
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS sale_items (
  id INT AUTO_INCREMENT PRIMARY KEY,
  sale_id INT NOT NULL,
  product_id INT NOT NULL,
  quantity INT NOT NULL,
  unit_price DECIMAL(12,2) NOT NULL,
  total DECIMAL(12,2) NOT NULL,
  FOREIGN KEY (sale_id) REFERENCES sales(id),
  FOREIGN KEY (product_id) REFERENCES products(id)
);

-- Créditos (cuotas y pagos)
CREATE TABLE IF NOT EXISTS installments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  sale_id INT NOT NULL,
  due_date DATE NOT NULL,
  amount DECIMAL(12,2) NOT NULL,
  paid TINYINT(1) NOT NULL DEFAULT 0,
  paid_at TIMESTAMP NULL,
  FOREIGN KEY (sale_id) REFERENCES sales(id)
);

CREATE TABLE IF NOT EXISTS credit_payments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  installment_id INT NOT NULL,
  amount DECIMAL(12,2) NOT NULL,
  payment_type VARCHAR(20) NULL,
  payment_method VARCHAR(20) NULL,
  reference VARCHAR(160) NULL,
  document_url VARCHAR(255) NULL,
  received_by VARCHAR(160) NULL,
  user_id INT NULL,
  paid_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (installment_id) REFERENCES installments(id)
);

-- Caja
CREATE TABLE IF NOT EXISTS cashbox_shifts (
  id INT AUTO_INCREMENT PRIMARY KEY,
  opened_by INT NOT NULL,
  closed_by INT,
  opening_balance DECIMAL(12,2) NOT NULL DEFAULT 0,
  closing_balance DECIMAL(12,2),
  opened_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  closed_at TIMESTAMP NULL,
  FOREIGN KEY (opened_by) REFERENCES users(id),
  FOREIGN KEY (closed_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS cash_movements (
  id INT AUTO_INCREMENT PRIMARY KEY,
  shift_id INT NOT NULL,
  type ENUM('IN','OUT') NOT NULL,
  concept VARCHAR(160) NOT NULL,
  amount DECIMAL(12,2) NOT NULL,
  ref_type ENUM('SALE','PURCHASE','MANUAL','PAYMENT','CREDIT_PAYMENT') NOT NULL,
  ref_id INT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (shift_id) REFERENCES cashbox_shifts(id)
);

-- Índices
CREATE INDEX idx_product_sku ON products(sku);
CREATE INDEX idx_inventory_product ON inventory_movements(product_id);
CREATE INDEX idx_sale_customer ON sales(customer_id);
CREATE INDEX idx_categories_parent ON categories(parent_id);
CREATE INDEX idx_categories_department ON categories(department_id);
