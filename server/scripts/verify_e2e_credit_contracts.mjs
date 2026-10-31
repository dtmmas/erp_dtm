const BASE = process.env.API_BASE_URL || 'http://localhost:4003/api'

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function http(method, path, { token, json } = {}) {
  const headers = {}
  if (token) headers.Authorization = `Bearer ${token}`
  if (json) headers['Content-Type'] = 'application/json'

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: json ? JSON.stringify(json) : undefined,
  })
  const contentType = res.headers.get('content-type') || ''
  const body = contentType.includes('application/json') ? await res.json() : await res.text()
  if (!res.ok) {
    const msg = typeof body === 'string' ? body : (body?.error || JSON.stringify(body))
    throw new Error(`${method} ${path} failed (${res.status}): ${msg}`)
  }
  return body
}

function addDays(date, days) {
  const d = new Date(date)
  d.setDate(d.getDate() + days)
  return d.toISOString().slice(0, 10)
}

async function loginAdmin() {
  return http('POST', '/auth/login', {
    json: { email: 'admin@local', password: 'admin123' },
  })
}

async function main() {
  const signature1x1 =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO5c2KQAAAAASUVORK5CYII='

  console.log('[1/8] Health...')
  const health = await http('GET', '/health')
  assert(health?.ok === true, 'health not ok')

  console.log('[2/8] Login...')
  const login = await loginAdmin()
  let token = login?.token
  assert(token, 'token missing')
  const userId = Number(login?.user?.id)
  assert(userId, 'user id missing')

  console.log('[3/8] Open cash register (if needed)...')
  try {
    await http('POST', '/cash-registers/open', { token, json: { openingAmount: 0, notes: 'E2E contratos' } })
  } catch {}

  console.log('[4/8] Load warehouses...')
  const warehouses = await http('GET', '/warehouses', { token })
  assert(Array.isArray(warehouses) && warehouses.length > 0, 'no warehouses')

  console.log('[5/8] Find or create customer...')
  let customers = await http('GET', '/customers', { token })
  if (!Array.isArray(customers)) customers = []
  let customerId = Number(customers?.[0]?.id || 0)
  if (!customerId) {
    const created = await http('POST', '/customers', {
      token,
      json: {
        name: `CLIENTE CONTRATO ${Date.now().toString().slice(-6)}`,
        document: '1234567890101',
        phone: '55555555',
        address: 'DIRECCIÓN PRUEBA',
        age: 25,
        nationality: 'guatemalteco(a)',
        civil_status: 'soltero(a)',
        occupation: 'comerciante',
        municipality: 'Jacaltenango',
        department: 'Huehuetenango',
      },
    })
    customerId = Number(created?.id)
  }
  assert(customerId, 'customerId missing')

  console.log('[6/8] Create test product...')
  const createdProduct = await http('POST', '/products', {
    token,
    json: {
      name: `PROD CONTRATO ${Date.now().toString().slice(-6)}`,
      sku: `CT-${Date.now().toString().slice(-6)}`,
      price: 1000,
      cost: 500,
      unit: 'UND',
      productType: 'GENERAL',
      initialStock: 0,
    },
  })
  const productId = Number(createdProduct?.id || 0)
  assert(productId, 'productId missing')

  console.log('[7/8] Generate contracts per warehouse...')
  for (const w of warehouses) {
    const warehouseId = Number(w.id)
    assert(warehouseId, 'invalid warehouse id')

    await http('PUT', `/users/${userId}`, { token, json: { warehouse_id: warehouseId } })
    const relog = await loginAdmin()
    token = relog?.token
    assert(token, 'token missing after relogin')

    const contractPhone = String(w.contract_phone || '55550000')
    const contractFacebook = String(w.contract_facebook || 'Muebles Yatir.')
    const address = String(w.address || 'DIRECCIÓN SUCURSAL')
    const name = String(w.name || '').trim() || `WH-${warehouseId}`
    const type = String(w.type || 'TIENDA')
    const status = String(w.status || 'ACTIVO')

    await http('PUT', `/warehouses/${warehouseId}`, {
      token,
      json: { name, type, address, contract_phone: contractPhone, contract_facebook: contractFacebook, status },
    })

    await http('POST', '/inventory/adjust', {
      token,
      json: {
        productId,
        warehouseId,
        type: 'ADJUSTMENT',
        quantity: 5,
        notes: 'E2E stock contratos',
      },
    })

    const today = new Date()
    const installments = [
      { amount: 500, dueDate: addDays(today, 30) },
      { amount: 500, dueDate: addDays(today, 60) },
    ]

    const sale = await http('POST', '/sales', {
      token,
      json: {
        customerId,
        items: [{ productId, quantity: 1, price: 1000 }],
        total: 1000,
        isCredit: true,
        creditInstallments: installments,
        creditContract: {
          customer: {
            phone: '55555555',
            address: 'DIRECCIÓN PRUEBA',
            dpi: '1234567890101',
            age: 25,
            nationality: 'guatemalteco(a)',
            civilStatus: 'soltero(a)',
            occupation: 'comerciante',
            municipality: 'Jacaltenango',
            department: 'Huehuetenango',
          },
          warrantyTime: '30 días',
          references: [
            { name: 'REFERENCIA 1', phone: '55550001' },
            { name: 'REFERENCIA 2', phone: '55550002' },
          ],
          buyerSignatureData: signature1x1,
        },
      },
    })
    const saleId = Number(sale?.saleId || sale?.id || 0)
    assert(saleId, 'sale id missing')

    const gen = await http('POST', `/credit-contracts/sale/${saleId}/generate`, {
      token,
      json: {
        customer: {
          phone: '55555555',
          address: 'DIRECCIÓN PRUEBA',
          dpi: '1234567890101',
          age: 25,
          nationality: 'guatemalteco(a)',
          civilStatus: 'soltero(a)',
          occupation: 'comerciante',
          municipality: 'Jacaltenango',
          department: 'Huehuetenango',
        },
        warrantyTime: '30 días',
        references: [
          { name: 'REFERENCIA 1', phone: '55550001' },
          { name: 'REFERENCIA 2', phone: '55550002' },
        ],
        buyerSignatureData: signature1x1,
      },
    })
    assert(gen?.contractId, 'contractId missing')
    assert(String(gen?.html || '').includes('CONTRATO DE CRÉDITOS'), 'contract html missing title')

    const html = await http('GET', `/credit-contracts/sale/${saleId}/html`, { token })
    assert(String(html || '').includes('PAGOS REALIZADOS'), 'html endpoint missing content')
  }

  console.log('OK: E2E credit contracts verified for warehouses:', warehouses.length)
}

main().catch((err) => {
  console.error('E2E verification FAILED:', err?.message || err)
  process.exit(1)
})
