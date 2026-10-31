const BASE = process.env.API_BASE_URL || 'http://localhost:4003/api'

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function http(method, path, { token, json, formData } = {}) {
  const headers = {}
  if (token) headers.Authorization = `Bearer ${token}`
  if (json) headers['Content-Type'] = 'application/json'

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: json ? JSON.stringify(json) : formData || undefined,
  })
  const contentType = res.headers.get('content-type') || ''
  const body = contentType.includes('application/json') ? await res.json() : await res.text()
  if (!res.ok) {
    const msg = typeof body === 'string' ? body : (body?.error || JSON.stringify(body))
    throw new Error(`${method} ${path} failed (${res.status}): ${msg}`)
  }
  return body
}

function dummyPngBuffer() {
  const b64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO3ZbskAAAAASUVORK5CYII='
  return Buffer.from(b64, 'base64')
}

async function main() {
  console.log('[1/7] Health...')
  const health = await http('GET', '/health')
  assert(health?.ok === true, 'health not ok')

  console.log('[2/7] Login...')
  const login = await http('POST', '/auth/login', {
    json: { email: 'admin@local', password: 'admin123' },
  })
  const token = login?.token
  assert(token, 'token missing')

  console.log('[3/7] Load warehouses and products...')
  const warehouses = await http('GET', '/warehouses', { token })
  assert(Array.isArray(warehouses) && warehouses.length > 0, 'no warehouses')
  const fromWarehouseId = Number(warehouses[0].id)
  assert(fromWarehouseId, 'invalid warehouse id')

  const productsResp = await http('GET', '/products', { token })
  const products = Array.isArray(productsResp?.products) ? productsResp.products : (Array.isArray(productsResp) ? productsResp : [])
  assert(products.length > 0, 'no products')
  const productId = Number(products[0].id)
  assert(productId, 'invalid product id')

  console.log('[4/7] Create vehicle...')
  const plate = `TST-${Date.now().toString().slice(-6)}`
  const v = await http('POST', '/shipments/vehicles', {
    token,
    json: { plate, name: 'TEST', capacity: 'N/A', active: 1 },
  })
  assert(v?.id, 'vehicle id missing')

  console.log('[5/7] Create shipment...')
  const created = await http('POST', '/shipments', {
    token,
    json: {
      type: 'SALE_DELIVERY',
      fromWarehouseId,
      deliveryAddress: 'TEST ADDRESS',
      contactName: 'TEST RECEIVER',
      contactPhone: '0000',
      items: [{ productId, qty: 2 }],
    },
  })
  const shipmentId = Number(created?.shipmentId)
  assert(shipmentId, 'shipmentId missing')

  console.log('[6/7] Assign shipment to admin user as driver...')
  const driverUserId = Number(login?.user?.id)
  assert(driverUserId, 'driverUserId missing')
  try {
    await http('PUT', `/users/${driverUserId}`, { token, json: { is_driver: true } })
  } catch {}
  await http('POST', `/shipments/${shipmentId}/assign`, {
    token,
    json: { driverUserId, vehicleId: Number(v.id) },
  })

  const my = await http('GET', '/shipments/my', { token })
  assert(Array.isArray(my) && my.some(s => Number(s.id) === shipmentId), 'shipment not visible in /my')

  console.log('[7/7] Upload event and complete with issues (missing 1 unit)...')
  {
    const buf = dummyPngBuffer()
    const fd = new FormData()
    fd.append('eventType', 'PICKED_UP')
    fd.append('notes', 'TEST PICKUP')
    fd.append('status', 'PICKED_UP')
    fd.append('photos', new File([buf], 'pickup.png', { type: 'image/png' }))
    await http('POST', `/shipments/${shipmentId}/event`, { token, formData: fd })
  }

  const detailBefore = await http('GET', `/shipments/${shipmentId}`, { token })
  const itemId = Number(detailBefore?.items?.[0]?.id)
  assert(itemId, 'shipment item id missing')

  {
    const buf = dummyPngBuffer()
    const fd = new FormData()
    fd.append('action', 'DELIVER')
    fd.append('receiverName', 'CLIENTE PRUEBA')
    fd.append('receiverDpi', '1234567890101')
    fd.append('notes', 'TEST DELIVER WITH MISSING')
    fd.append('items', JSON.stringify([{ itemId, qtyReceived: 1, qtyDamaged: 0 }]))
    fd.append('photos', new File([buf], 'deliver.png', { type: 'image/png' }))
    fd.append('signature', new File([buf], 'sign.png', { type: 'image/png' }))
    const completed = await http('POST', `/shipments/${shipmentId}/complete`, { token, formData: fd })
    assert(String(completed?.status || '').includes('ISSUES'), 'expected *_WITH_ISSUES status')
  }

  const detail = await http('GET', `/shipments/${shipmentId}`, { token })
  assert(Array.isArray(detail?.issues) && detail.issues.length > 0, 'issue not created')
  assert(detail?.issues?.[0]?.status === 'OPEN', 'issue not OPEN')

  console.log('OK: E2E logistics shipment flow verified', { shipmentId })
}

main().catch((err) => {
  console.error('E2E verification FAILED:', err?.message || err)
  process.exit(1)
})
