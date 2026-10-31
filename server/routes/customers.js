import express from 'express'
import { authMiddleware, roleMiddleware } from '../auth.js'
import { getPool } from '../db.js'

const router = express.Router()

// List all customers
router.get('/', authMiddleware, async (req, res) => {
  try {
    const pool = await getPool()
    const [rows] = await pool.query(
      'SELECT id, name, document, phone, email, address, age, nationality, civil_status, occupation, municipality, department FROM customers ORDER BY name ASC'
    )
    const items = rows.map(r => ({ 
      id: r.id, 
      name: r.name, 
      document: r.document || '', 
      phone: r.phone || '', 
      email: r.email || '', 
      address: r.address || '',
      age: r.age ?? null,
      nationality: r.nationality || '',
      civil_status: r.civil_status || '',
      occupation: r.occupation || '',
      municipality: r.municipality || '',
      department: r.department || ''
    }))
    return res.json(items)
  } catch (err) {
    console.error('Customers GET error:', err)
    return res.status(500).json({ error: 'Server error' })
  }
})

// Create customer
router.post('/', authMiddleware, async (req, res) => {
  try {
    let { name, document, phone, email, address, age, nationality, civil_status, occupation, municipality, department } = req.body
    name = (name || '').trim()
    if (!name) return res.status(400).json({ error: 'Nombre requerido' })
    
    const pool = await getPool()
    const [result] = await pool.query(
      'INSERT INTO customers (name, document, phone, email, address, age, nationality, civil_status, occupation, municipality, department) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', 
      [
        name,
        document || null,
        phone || null,
        email || null,
        address || null,
        Number.isFinite(Number(age)) ? Number(age) : null,
        nationality || null,
        civil_status || null,
        occupation || null,
        municipality || null,
        department || null,
      ]
    )
    return res.json({ id: result.insertId, name, document, phone, email, address, age, nationality, civil_status, occupation, municipality, department })
  } catch (err) {
    console.error('Customers POST error:', err)
    return res.status(500).json({ error: 'Server error' })
  }
})

// Update customer
router.put('/:id', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params
    let { name, document, phone, email, address, age, nationality, civil_status, occupation, municipality, department } = req.body
    name = (name || '').trim()
    if (!name) return res.status(400).json({ error: 'Nombre requerido' })

    const pool = await getPool()
    await pool.query(
      'UPDATE customers SET name=?, document=?, phone=?, email=?, address=?, age=?, nationality=?, civil_status=?, occupation=?, municipality=?, department=? WHERE id=?',
      [
        name,
        document || null,
        phone || null,
        email || null,
        address || null,
        Number.isFinite(Number(age)) ? Number(age) : null,
        nationality || null,
        civil_status || null,
        occupation || null,
        municipality || null,
        department || null,
        id,
      ]
    )
    return res.json({ id, name, document, phone, email, address, age, nationality, civil_status, occupation, municipality, department })
  } catch (err) {
    console.error('Customers PUT error:', err)
    return res.status(500).json({ error: 'Server error' })
  }
})

// Delete customer
router.delete('/:id', authMiddleware, roleMiddleware(['ADMIN']), async (req, res) => {
  try {
    const { id } = req.params
    const pool = await getPool()
    // Check if used in sales
    const [sales] = await pool.query('SELECT id FROM sales WHERE customer_id = ? LIMIT 1', [id])
    if (sales.length > 0) {
      return res.status(400).json({ error: 'No se puede eliminar: el cliente tiene ventas asociadas' })
    }

    await pool.query('DELETE FROM customers WHERE id = ?', [id])
    return res.json({ success: true })
  } catch (err) {
    console.error('Customers DELETE error:', err)
    return res.status(500).json({ error: 'Server error' })
  }
})

export default router
