import dotenv from 'dotenv'
import mysql from 'mysql2/promise'

dotenv.config()

const host = process.env.DB_HOST || 'localhost'
const port = Number(process.env.DB_PORT || 3306)
const user = process.env.DB_USER || 'root'
const password = process.env.DB_PASSWORD || ''
const database = process.env.DB_NAME || 'dtmpos'

const conn = await mysql.createConnection({ host, port, user, password, database })
const [roles] = await conn.query('SELECT id, code, name FROM roles WHERE code = ? OR name = ?', ['CHOFER', 'Chofer'])
console.log('roles:', roles)
const [perms] = await conn.query(
  `
    SELECT p.code
    FROM permissions p
    JOIN role_permissions rp ON rp.permission_id = p.id
    JOIN roles r ON r.id = rp.role_id
    WHERE r.code = ?
    ORDER BY p.code ASC
  `,
  ['CHOFER']
)
console.log('perms:', perms)
await conn.end()
