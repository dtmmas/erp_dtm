import axios from 'axios'

export const api = axios.create({
  baseURL: '/api',
})

export function setAuthToken(token?: string) {
  if (token) api.defaults.headers.common['Authorization'] = `Bearer ${token}`
  else delete api.defaults.headers.common['Authorization']
}

// Interceptor de respuestas para manejar errores comunes (401/403)
api.interceptors.response.use(
  (resp) => resp,
  (error) => {
    const status = error?.response?.status
    if (status === 401 || status === 403) {
      // Limpiar sesión ante token inválido o falta de permisos
      try { localStorage.removeItem('auth') } catch {}
      setAuthToken(undefined)
      // Si no estamos ya en login, redirigir
      if (typeof window !== 'undefined' && window.location.pathname !== '/login') {
        window.location.href = '/login'
      }
    }
    return Promise.reject(error)
  }
)

// Interceptor de petición para convertir todos los textos a MAYÚSCULAS
function isAuthUrl(url?: string) {
  return !!url && url.includes('/auth')
}

function shouldSkipKeyForUppercase(key: string, url?: string) {
  const k = key.toLowerCase()
  // En rutas de auth, no modificar email ni password
  if (isAuthUrl(url) && (k === 'password' || k === 'email')) return true
  // Enviar intactos los campos JSON en FormData para productos
  if (k === 'batches' || k === 'imeis' || k === 'serials') return true
  return false
}

function uppercaseValue(val: any, url?: string, keyHint?: string): any {
  if (val == null) return val
  if (typeof val === 'string') {
    if (keyHint && shouldSkipKeyForUppercase(keyHint, url)) return val
    return val.toUpperCase()
  }
  if (Array.isArray(val)) {
    return val.map(v => uppercaseValue(v, url))
  }
  if (val instanceof Date || (typeof File !== 'undefined' && val instanceof File) || (typeof Blob !== 'undefined' && val instanceof Blob)) {
    return val
  }
  if (typeof FormData !== 'undefined' && val instanceof FormData) {
    const next = new FormData()
    val.forEach((v, k) => {
      if (typeof v === 'string' && !shouldSkipKeyForUppercase(k, url)) next.append(k, v.toUpperCase())
      else next.append(k, v as any)
    })
    return next
  }
  if (val && typeof val === 'object') {
    const out: any = Array.isArray(val) ? [] : {}
    Object.entries(val).forEach(([k, v]) => {
      if (typeof v === 'string') {
        out[k] = shouldSkipKeyForUppercase(k, url) ? v : v.toUpperCase()
      } else {
        out[k] = uppercaseValue(v, url, k)
      }
    })
    return out
  }
  return val
}

api.interceptors.request.use((config) => {
  try {
    const isFD = typeof FormData !== 'undefined' && config.data instanceof FormData
    if (!isFD && config.data) config.data = uppercaseValue(config.data, config.url)
    if (config.params) config.params = uppercaseValue(config.params, config.url)
  } catch {}
  return config
})

// Product helpers used by Products page
export async function getProducts(params?: {
  paged?: boolean
  page?: number
  limit?: number
  offset?: number
  search?: string
  categoryId?: number | null
  subcategoryId?: number | null
  brandId?: number | null
  supplierId?: number | null
  departmentId?: number | null
  stockFilter?: 'all' | 'with_stock' | 'without_stock'
  warehouseId?: number | null
}) {
  const normalizedParams = params
    ? {
        ...params,
        offset: params.offset ?? ((params.page && params.limit) ? (Math.max(params.page, 1) - 1) * params.limit : undefined),
      }
    : undefined
  const { data } = await api.get('/products', { params: normalizedParams })
  return data
}

export async function getProductDetails(id: number) {
  const { data } = await api.get(`/products/${id}`)
  return data
}

export async function getProductCostHistory(id: number) {
  const { data } = await api.get(`/products/${id}/cost-history`)
  return data as {
    product: {
      id: number
      name: string
      productCode?: string
      cost: number
      avgCost: number
      lastCost: number
    }
    history: Array<{
      purchaseId: number
      purchaseNumber: string
      docNo?: string | null
      createdAt: string
      warehouseId?: number | null
      warehouseName?: string | null
      quantity: number
      unitCost: number
      totalCost: number
    }>
  }
}

export async function createProduct(form: FormData) {
  const { data } = await api.post('/products', form)
  return data
}

export async function updateProduct(id: number, form: FormData) {
  const { data } = await api.put(`/products/${id}`, form)
  return data
}

export async function addProductImages(id: number, files: File[]) {
  const fd = new FormData()
  for (const file of files) fd.append('images', file)
  const { data } = await api.post(`/products/${id}/images`, fd)
  return data
}

export async function replaceProductImage(productId: number, imageId: number, file: File) {
  const fd = new FormData()
  fd.append('image', file)
  const { data } = await api.put(`/products/${productId}/images/${imageId}`, fd)
  return data
}

export async function deleteProductImage(productId: number, imageId: number) {
  const { data } = await api.delete(`/products/${productId}/images/${imageId}`)
  return data
}

export async function reorderProductImages(productId: number, orderIds: number[]) {
  const { data } = await api.put(`/products/${productId}/images/reorder`, { orderIds })
  return data
}

export async function deleteProduct(id: number) {
  await api.delete(`/products/${id}`)
}

// Category helpers used by Products page
export async function getCategories() {
  const { data } = await api.get('/categories')
  return data
}

// Department helpers
export async function getDepartments() {
  const { data } = await api.get('/departments')
  return data as { id: number; name: string }[]
}

export async function createDepartment(payload: { name: string }) {
  const { data } = await api.post('/departments', payload)
  return data as { id: number; name: string }
}

export async function updateDepartment(id: number, payload: { name: string }) {
  const { data } = await api.put(`/departments/${id}`, payload)
  return data as { id: number; name: string }
}

export async function deleteDepartment(id: number) {
  await api.delete(`/departments/${id}`)
}

// Brand helpers
export async function getBrands() {
  const { data } = await api.get('/brands')
  return data
}

export async function createBrand(payload: { name: string }) {
  const { data } = await api.post('/brands', payload)
  return data
}

export async function updateBrand(id: number, payload: { name: string }) {
  const { data } = await api.put(`/brands/${id}`, payload)
  return data
}

export async function deleteBrand(id: number) {
  await api.delete(`/brands/${id}`)
}

// Supplier helpers
export async function getSuppliers() {
  const { data } = await api.get('/suppliers')
  return data
}

export async function getSupplierPendingPurchases(id: number | string) {
  const { data } = await api.get(`/purchases/suppliers/${id}/pending`)
  return data as {
    supplier: { id: number; name: string }
    totals: { pendingCount: number; totalPending: number }
    purchases: Array<{
      id: number
      docNo?: string | null
      createdAt: string
      dueDate?: string | null
      total: number
      paidAmount: number
      balanceDue: number
      paymentStatus: string
    }>
  }
}

export async function getSupplierPayments(id: number | string) {
  const { data } = await api.get(`/purchases/suppliers/${id}/payments`)
  return data as Array<{
    id: number
    supplierId: number
    amount: number
    paymentMethod: string
    reference?: string | null
    notes?: string | null
    documentPath?: string | null
    paidAt: string
    userName?: string | null
    allocations: Array<{
      purchaseId: number
      purchasePaymentId?: number | null
      amount: number
      docNo?: string | null
      createdAt: string
      dueDate?: string | null
    }>
  }>
}

export async function paySupplier(id: number | string, form: FormData) {
  const { data } = await api.post(`/purchases/suppliers/${id}/payments`, form)
  return data as {
    success: boolean
    supplierId: number
    supplierName: string
    supplierPaymentId: number
    amount: number
    paymentMethod: string
    reference?: string | null
    notes?: string | null
    totalPendingBefore: number
    remainingPending: number
    allocations: Array<{
      purchaseId: number
      docNo?: string | null
      dueDate?: string | null
      allocatedAmount: number
      balanceDue: number
      paymentStatus: string
    }>
  }
}

export async function getPurchasePayments(id: number | string) {
  const { data } = await api.get(`/purchases/${id}/payments`)
  return data as Array<{
    id: number
    purchase_id: number
    amount: number
    payment_method: string
    reference?: string | null
    notes?: string | null
    document_path?: string | null
    paid_at: string
    user_name?: string | null
  }>
}

export async function payPurchase(id: number | string, form: FormData) {
  const { data } = await api.post(`/purchases/${id}/payments`, form)
  return data as {
    success: boolean
    purchaseId: number
    paidAmount: number
    balanceDue: number
    paymentStatus: string
  }
}

// Units helpers
export async function getUnits() {
  const { data } = await api.get('/units')
  return data as { id: number; code: string; name: string }[]
}

// Sales helpers
export async function getDailySales(date?: string) {
  const { data } = await api.get('/sales/daily', { params: { date } })
  return data as { total: number }
}

export async function getUpcomingCredits(days?: number) {
  const { data } = await api.get('/sales/credits/upcoming', { params: { days } })
  return data as { count: number; days: number }
}

export async function getUpcomingCreditsList(days?: number, limit?: number) {
  const { data } = await api.get('/sales/credits/upcoming/list', { params: { days, limit } })
  return data as { days: number; limit: number; items: Array<{ id: number; saleId: number; dueDate: string; amount: number; docNo: string; saleTotal: number; customerName: string }> }
}

export async function getSalesSummary(start?: string, end?: string) {
  const { data } = await api.get('/sales/summary', { params: { start, end } })
  return data as { total: number; start: string | null; end: string | null }
}

export async function getSales(params: { page?: number; limit?: number; search?: string; offset?: number; startDate?: string; endDate?: string; userId?: number | string; paymentMethod?: string; statusFilter?: string }) {
  const { data } = await api.get('/sales', { params })
  return data as {
    data: Array<{
      id: number
      doc_no: string
      total: number
      created_at: string
      credit_fully_paid_at?: string | null
      payment_method: string
      customer_name?: string
      received_amount?: number
      change_amount?: number
      reference_number?: string
      is_credit?: number
      credit_fully_paid?: number
      status?: string
      cancellation_reason?: string
      seller_id?: number | null
      seller_name?: string | null
      cost_total?: number
      profit?: number
    }>
    pagination: {
      total: number
      limit: number
      offset: number
    }
    summary: {
      records: number
      grossTotal: number
      netTotal: number
      totalProfit: number
      cancelledCount: number
      byMethod: Record<string, number>
    }
    byUser: Array<{
      userId: number | null
      userName: string
      salesCount: number
      grossTotal: number
      total: number
      profit: number
      cancelledCount: number
    }>
  }
}

export async function getMySalesReport(params: { limit?: number; search?: string; offset?: number; startDate?: string; endDate?: string; paymentMethod?: string; statusFilter?: string }) {
  const { data } = await api.get('/sales/my-report', { params })
  return data as {
    data: Array<{
      id: number
      doc_no: string
      total: number
      created_at: string
      credit_fully_paid_at?: string | null
      payment_method: string
      customer_name?: string
      received_amount?: number
      change_amount?: number
      reference_number?: string
      is_credit?: number
      credit_fully_paid?: number
      status?: string
      cancellation_reason?: string
      seller_id?: number | null
      seller_name?: string | null
    }>
    pagination: {
      total: number
      limit: number
      offset: number
    }
    summary: {
      records: number
      netTotal: number
      cancelledCount: number
    }
  }
}

export async function getMyCollectionsReport(params: { limit?: number; search?: string; offset?: number; startDate?: string; endDate?: string; paymentMethod?: string; statusFilter?: string }) {
  const { data } = await api.get('/sales/my-collections', { params })
  return data as {
    data: Array<{
      id: number
      doc_no: string
      total: number
      created_at: string
      paid_at?: string | null
      payment_method: string
      customer_name?: string
      received_amount?: number
      change_amount?: number
      reference_number?: string
      is_credit?: number
      status?: string
      cancellation_reason?: string
      seller_id?: number | null
      seller_name?: string | null
    }>
    pagination: {
      total: number
      limit: number
      offset: number
    }
    summary: {
      records: number
      collectedTotal: number
      creditTotal: number
      cancelledCount: number
    }
  }
}

export async function getSaleDetails(id: number) {
  const { data } = await api.get(`/sales/${id}`)
  return data
}

export async function cancelSale(id: number, reason: string) {
  const { data } = await api.post(`/sales/${id}/cancel`, { reason })
  return data
}

export async function getPendingPaymentSales(params?: { userId?: number; warehouseId?: number; limit?: number }) {
  const { data } = await api.get('/sales/pending-payment', { params })
  return data as {
    items: Array<{
      id: number
      docNo: string
      total: number
      createdAt: string
      customerName: string
      sellerName: string
      itemsCount: number
      pendingPaymentMethod?: 'CASH' | 'CARD' | 'DEPOSIT' | 'CREDIT' | null
      pendingReferenceNumber?: string | null
      pendingDownPaymentAmount?: number | null
      pendingDownPaymentMethod?: 'CASH' | 'CARD' | 'DEPOSIT' | null
      pendingDownPaymentReference?: string | null
    }>
  }
}

export async function collectPendingSalePayment(
  id: number,
  payload: {
    paymentMethod: 'CASH' | 'CARD' | 'DEPOSIT' | 'CREDIT'
    receivedAmount?: number
    changeAmount?: number
    referenceNumber?: string | null
    creditInstallments?: Array<{ amount: number; dueDate: string }>
    downPaymentAmount?: number
    downPaymentMethod?: 'CASH' | 'CARD' | 'DEPOSIT'
    downPaymentReference?: string | null
  },
  documentFile?: File | null,
  downPaymentDocumentFile?: File | null
) {
  if (documentFile || downPaymentDocumentFile) {
    const form = new FormData()
    form.append('paymentMethod', payload.paymentMethod)
    form.append('receivedAmount', String(payload.receivedAmount ?? ''))
    form.append('changeAmount', String(payload.changeAmount ?? ''))
    form.append('referenceNumber', payload.referenceNumber ?? '')
    if (payload.downPaymentAmount != null) {
      form.append('downPaymentAmount', String(payload.downPaymentAmount))
    }
    if (payload.downPaymentMethod != null) {
      form.append('downPaymentMethod', String(payload.downPaymentMethod))
    }
    if (payload.downPaymentReference != null) {
      form.append('downPaymentReference', String(payload.downPaymentReference || ''))
    }
    if (payload.creditInstallments) {
      form.append('creditInstallments', JSON.stringify(payload.creditInstallments))
    }
    if (documentFile) form.append('document', documentFile)
    if (downPaymentDocumentFile) form.append('downPaymentDocument', downPaymentDocumentFile)
    const { data } = await api.post(`/sales/${id}/collect-payment`, form)
    return data as { success: boolean; saleId: number }
  }

  const { data } = await api.post(`/sales/${id}/collect-payment`, payload)
  return data as { success: boolean; saleId: number }
}

export async function createUnit(payload: { code: string; name: string }) {
  const { data } = await api.post('/units', payload)
  return data as { id: number; code: string; name: string }
}

export async function updateUnit(id: number, payload: { code: string; name: string }) {
  const { data } = await api.put(`/units/${id}`, payload)
  return data as { id: number; code: string; name: string }
}

export async function deleteUnit(id: number) {
  await api.delete(`/units/${id}`)
}

// (Inventario por ubicación retirado)

export async function getShelves() {
  const { data } = await api.get('/shelves')
  return data as Array<{ id: number; name: string; warehouseId?: number | null; warehouseIds?: number[] }>
}

// Warehouses helpers
export async function getWarehouses() {
  const { data } = await api.get('/warehouses')
  return data as Array<{ id: number; name: string }>
}

export async function createWarehouse(payload: { name: string }) {
  const { data } = await api.post('/warehouses', payload)
  return data as { id: number; name: string }
}

export async function updateWarehouse(id: number, payload: { name: string }) {
  const { data } = await api.put(`/warehouses/${id}`, payload)
  return data as { id: number; name: string }
}

export async function deleteWarehouse(id: number) {
  await api.delete(`/warehouses/${id}`)
}

// Shelves helpers
export async function createShelf(payload: { name: string; warehouseId: number }) {
  const { data } = await api.post('/shelves', payload)
  return data as { id: number; name: string; warehouseId: number | null }
}

export async function updateShelf(id: number, payload: { name: string; warehouseId: number }) {
  const { data } = await api.put(`/shelves/${id}`, payload)
  return data as { id: number; name: string; warehouseId: number | null }
}

// Asignar un estante existente a un almacén adicional
export async function assignShelfToWarehouse(shelfId: number, warehouseId: number) {
  const { data } = await api.post(`/shelves/${shelfId}/assign`, { warehouseId })
  return data as { id: number; warehouseIds: number[] }
}

export async function deleteShelf(id: number) {
  await api.delete(`/shelves/${id}`)
}

// Product warehouse stock helpers
export async function getProductWarehouseStock(productId: number) {
  const { data } = await api.get(`/products/${productId}/warehouse-stock`)
  return data as Array<{ warehouseId: number; warehouseName: string; quantity: number }>
}

export async function transferProductWarehouseStock(productId: number, payload: { fromWarehouseId: number; toWarehouseId: number; quantity: number }) {
  const { data } = await api.post(`/products/${productId}/warehouse-stock/transfer`, payload)
  return data as { ok: boolean }
}

// Logistics / Shipments
export async function getShipments(params?: { status?: string; type?: string; driverUserId?: number; search?: string }) {
  const { data } = await api.get('/shipments', { params })
  return data as any[]
}

export async function getMyShipments() {
  const { data } = await api.get('/shipments/my')
  return data as any[]
}

export async function getShipment(id: number) {
  const { data } = await api.get(`/shipments/${id}`)
  return data as any
}

export async function createShipment(payload: any) {
  const { data } = await api.post('/shipments', payload)
  return data as { success: boolean; shipmentId: number }
}

export async function assignShipment(id: number, payload: { driverUserId: number; vehicleId?: number | null }) {
  const { data } = await api.post(`/shipments/${id}/assign`, payload)
  return data as { success: boolean }
}

export async function getVehicles() {
  const { data } = await api.get('/shipments/vehicles')
  return data as any[]
}

export async function getDrivers() {
  const { data } = await api.get('/shipments/drivers')
  return data as any[]
}

export async function getPendingShipmentSales() {
  const { data } = await api.get('/shipments/pending-sales')
  return data as Array<{
    id: number
    doc_no: string
    warehouse_id: number | null
    warehouse_name: string
    customer_id: number | null
    customer_name: string
    customer_phone: string
    customer_address: string
    total: string | number
    created_at: string
  }>
}

export async function createVehicle(payload: { plate: string; name?: string; capacity?: string; active?: number }) {
  const { data } = await api.post('/shipments/vehicles', payload)
  return data as { success: boolean; id: number }
}

export async function addShipmentEvent(id: number, payload: FormData) {
  const { data } = await api.post(`/shipments/${id}/event`, payload)
  return data as { success: boolean; eventId: number }
}

export async function completeShipment(id: number, payload: FormData) {
  const { data } = await api.post(`/shipments/${id}/complete`, payload)
  return data as { success: boolean; eventId: number; issueId?: number | null; status: string }
}

// Credits helpers
export async function getCredits(params?: { search?: string; status?: string; startDate?: string; endDate?: string }) {
  const { data } = await api.get('/credits', { params })
  return data as Array<{
    id: number
    sale_id: number
    due_date: string
    total_amount: string | number
    sale_total?: string | number
    paid: number
    doc_no: string
    sale_date: string
    customer_name: string
    paid_amount: string | number
    installments_count?: number
    installment_number?: number
  }>
}

export async function payCredit(payload: FormData) {
  const { data } = await api.post('/credits/pay', payload)
  return data as { success: boolean; paymentId: number }
}

export async function payCreditSale(payload: FormData) {
  const { data } = await api.post('/credits/pay-sale', payload)
  return data as {
    success: boolean
    paymentIds: number[]
    totalApplied: number
    penaltyApplied: number
    principalApplied: number
    allocations: Array<{
      installmentId: number
      paymentType: string
      amount: number
      paymentId: number
    }>
  }
}

export async function getCreditPayments(id: number) {
  const { data } = await api.get(`/credits/${id}/payments`)
  return data as Array<{
    id: number
    amount: string | number
    payment_type?: string
    payment_method: string
    reference: string
    created_at: string
    received_by: string
    document_url?: string | null
  }>
}

export async function getCreditSalePayments(saleId: number) {
  const { data } = await api.get(`/credits/sale/${saleId}/payments`)
  return data as Array<{
    id: number
    amount: string | number
    payment_type?: string
    payment_method: string
    reference: string
    created_at: string
    received_by: string
    document_url?: string | null
    installment_id?: number
    installment_due_date?: string
    installment_amount?: string | number
    installment_number?: number
  }>
}

export async function getCreditContractBySale(saleId: number) {
  const { data } = await api.get(`/credit-contracts/sale/${saleId}`)
  return data as { contract: any | null }
}

export async function getCreditContractHtmlBySale(saleId: number) {
  const { data } = await api.get(`/credit-contracts/sale/${saleId}/html`, { responseType: 'text' as any })
  return data as string
}

export async function getCreditContractSettlementHtmlBySale(saleId: number) {
  const { data } = await api.get(`/credit-contracts/sale/${saleId}/settlement-html`, { responseType: 'text' as any })
  return data as string
}

export async function generateCreditContractBySale(
  saleId: number,
  payload: {
    customer?: {
      phone?: string
      address?: string
      dpi?: string
      age?: string | number
      nationality?: string
      civilStatus?: string
      occupation?: string
      municipality?: string
      department?: string
    }
    warrantyTime?: string
    references?: Array<{ name?: string; phone?: string }>
    buyerSignatureData: string
  }
) {
  const { data } = await api.post(`/credit-contracts/sale/${saleId}/generate`, payload)
  return data as { contractId: number; sha256: string; html: string }
}

export async function getConfig() {
  const { data } = await api.get('/config')
  return data as { currency: string }
}

// Cash Register
export async function getCashStatus(params?: { userId?: number }) {
  const { data } = await api.get('/cash-registers/status', { params })
  return data as { isOpen: boolean; userId?: number; registerId?: number; openingTime?: string; openingAmount?: number }
}

export async function openCashRegister(payload: { openingAmount: number; notes?: string }) {
  const { data } = await api.post('/cash-registers/open', payload)
  return data as { success: boolean; registerId: number }
}

export async function closeCashRegister(payload: { closingAmount: number; notes?: string }) {
  const { data } = await api.post('/cash-registers/close', payload)
  return data as {
    success: boolean
    expected: number
    difference: number
    creditPaymentsByMethod?: Record<string, number>
    creditPaymentsCash?: number
  }
}

export async function getCashSummary(params?: { userId?: number }) {
  const { data } = await api.get('/cash-registers/summary', { params })
  return data as {
    userId?: number
    registerId: number
    openingTime: string
    openingAmount: number
    salesByMethod: Record<string, number>
    totalSales: number
    salesCash: number
    creditPaymentsByMethod: Record<string, number>
    creditPaymentsCash: number
    movementsIn: number
    movementsOut: number
    expectedCash: number
  }
}

export async function addCashMovement(payload: { type: 'IN' | 'OUT'; amount: number; description?: string }) {
  const { data } = await api.post('/cash-registers/movements', payload)
  return data as { success: boolean }
}

export async function getCashMovements(params?: { userId?: number }) {
  const { data } = await api.get('/cash-registers/movements', { params })
  return data as Array<{
    id: number
    type: 'IN' | 'OUT'
    amount: number
    description: string
    created_at: string
  }>
}

export async function getCashHistoryShifts(params?: { start?: string; end?: string; limit?: number }) {
  const { data } = await api.get('/cash-registers/history/shifts', { params })
  return data as {
    items: Array<{
      id: number
      openedBy: number
      openedByName: string
      closedBy: number
      closedByName: string
      openingBalance: number
      closingBalance: number
      openedAt: string
      closedAt: string
      salesCash: number
      creditPaymentsByMethod?: Record<string, number>
      creditPaymentsCash?: number
      movementsIn: number
      movementsOut: number
      expected: number
      difference: number
    }>
  }
}

export async function getCashHistoryShiftDetail(id: number) {
  const { data } = await api.get(`/cash-registers/history/shifts/${id}`)
  return data as {
    id: number
    openedBy: number
    openedByName: string
    closedBy: number
    closedByName: string
    openingBalance: number
    closingBalance: number
    openedAt: string
    closedAt: string
    salesByMethod: Record<string, number>
    totalSales: number
    salesCash: number
    creditPaymentsByMethod: Record<string, number>
    creditPaymentsCash: number
    movementsIn: number
    movementsOut: number
    expected: number
    difference: number
    movements: Array<{
      id: number
      type: 'IN' | 'OUT'
      amount: number
      description: string
      refType: string
      refId: number | null
      createdAt: string
    }>
  }
}

export async function getCashHistorySummary(params?: { period?: 'day' | 'month' | 'year'; start?: string; end?: string }) {
  const { data } = await api.get('/cash-registers/history/summary', { params })
  return data as {
    period: 'day' | 'month' | 'year'
    summary: Array<{
      period: string
      shifts: number
      opening: number
      closing: number
      expected: number
      difference: number
      salesCash: number
      creditPaymentsCash: number
      movementsIn: number
      movementsOut: number
    }>
  }
}
