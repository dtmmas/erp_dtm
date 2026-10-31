import express from 'express'
import cors from 'cors'
import morgan from 'morgan'
import dotenv from 'dotenv'
import fs from 'fs'
import authRouter from './routes/auth.js'
import configRouter from './routes/config.js'
import productsRouter from './routes/products.js'
import categoriesRouter from './routes/categories.js'
import brandsRouter from './routes/brands.js'
import suppliersRouter from './routes/suppliers.js'
import unitsRouter from './routes/units.js'
import departmentsRouter from './routes/departments.js'
import shelvesRouter from './routes/shelves.js'
import warehousesRouter from './routes/warehouses.js'
import { getPool } from './db.js'
import salesRouter from './routes/sales.js'
import purchasesRouter from './routes/purchases.js'
import inventoryRouter from './routes/inventory.js'
import customersRouter from './routes/customers.js'
import creditsRouter from './routes/credits.js'
import creditContractsRouter from './routes/credit_contracts.js'
import rolesRouter from './routes/roles.js'
import usersRouter from './routes/users.js'
import transfersRouter from './routes/transfers.js'
import cashRegistersRouter from './routes/cash_registers.js'
import shipmentsRouter from './routes/shipments.js'
import { envPath, uploadsDir } from './paths.js'
import { auditTrackedInventoryConsistency, logTrackedInventoryAudit } from './services/tracked_inventory_audit.js'

dotenv.config({ path: envPath })
const app = express()
const PORT = process.env.PORT || 4000
const HOST = process.env.HOST || '0.0.0.0'
const isProduction = process.env.NODE_ENV === 'production'

const allowedOrigins = (process.env.CORS_ORIGIN || '')
  .split(',')
  .map(origin => origin.trim())
  .filter(Boolean)

function corsOrigin(origin, callback) {
  if (!origin) return callback(null, true)
  if (allowedOrigins.length === 0) return callback(null, true)
  if (allowedOrigins.includes(origin)) return callback(null, true)
  return callback(new Error(`Origin not allowed by CORS: ${origin}`))
}

app.set('trust proxy', process.env.TRUST_PROXY || 1)
app.use(cors({ origin: corsOrigin, credentials: true }))
app.use(express.json())
app.use(express.urlencoded({ extended: true }))
app.use(morgan('dev'))

// ensure uploads dir exists
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true })
app.use('/uploads', express.static(uploadsDir))

app.get('/api/health', (req, res) => res.json({ ok: true, env: process.env.NODE_ENV || 'development' }))
app.use('/api/auth', authRouter)
app.use('/api/roles', rolesRouter)
app.use('/api/users', usersRouter)
app.use('/api/config', configRouter)
app.use('/api/products', productsRouter)
app.use('/api/categories', categoriesRouter)
app.use('/api/brands', brandsRouter)
app.use('/api/suppliers', suppliersRouter)
app.use('/api/units', unitsRouter)
app.use('/api/departments', departmentsRouter)
app.use('/api/shelves', shelvesRouter)
app.use('/api/warehouses', warehousesRouter)
app.use('/api/sales', salesRouter)
app.use('/api/purchases', purchasesRouter)
app.use('/api/inventory', inventoryRouter)
app.use('/api/customers', customersRouter)
app.use('/api/credits', creditsRouter)
app.use('/api/credit-contracts', creditContractsRouter)
app.use('/api/transfers', transfersRouter)
app.use('/api/cash-registers', cashRegistersRouter)
app.use('/api/shipments', shipmentsRouter)

// Start server only if DB connects
;(async () => {
  try {
    const pool = await getPool()
    console.log('MySQL connected')
    auditTrackedInventoryConsistency(pool)
      .then(logTrackedInventoryAudit)
      .catch(err => {
        console.error('[tracked-audit] No se pudo ejecutar la auditoria automatica:', err?.message || err)
      })
    app.listen(PORT, HOST, () => {
      const publicHost = HOST === '0.0.0.0' ? 'localhost' : HOST
      console.log(`API running on http://${publicHost}:${PORT}`)
      if (isProduction && allowedOrigins.length === 0) {
        console.warn('CORS_ORIGIN is not configured; all origins are currently allowed.')
      }
    })
  } catch (err) {
    console.error('Failed to connect to MySQL:', err?.message || err)
    process.exit(1)
  }
})()
