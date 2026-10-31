import dotenv from 'dotenv'
import mysql from 'mysql2/promise'

dotenv.config()

async function main() {
  const host = process.env.DB_HOST || 'localhost'
  const port = Number(process.env.DB_PORT || 3306)
  const user = process.env.DB_USER || 'root'
  const password = process.env.DB_PASSWORD || ''
  const database = process.env.DB_NAME || 'dtmpos'

  const conn = await mysql.createConnection({ host, port, user, password, database })
  const [rows] = await conn.query(`
    SELECT
      u.id,
      u.name,
      u.email,
      u.active,
      u.can_sell,
      u.is_driver,
      u.role_id,
      COALESCE(r.name, '') AS role_name,
      u.warehouse_id,
      COALESCE(w.name, '') AS warehouse_name,
      u.created_at
    FROM users u
    LEFT JOIN roles r ON r.id = u.role_id
    LEFT JOIN warehouses w ON w.id = u.warehouse_id
    ORDER BY u.id ASC
  `)

  console.table(
    (rows || []).map(r => ({
      id: r.id,
      name: r.name,
      email: r.email,
      role: r.role_name || r.role_id,
      warehouse: r.warehouse_name || r.warehouse_id,
      active: r.active,
      can_sell: r.can_sell,
      is_driver: r.is_driver,
      created_at: r.created_at,
    }))
  )

  await conn.end()
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
