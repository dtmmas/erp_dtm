import { useState, useEffect, useMemo, useRef } from 'react'
import { api, getCashStatus, getCreditContractBySale, getProducts } from '../api'
import { useConfigStore } from '../store/config'
import { useAuthStore } from '../store/auth'
import { useNavigate } from 'react-router-dom'
import jsPDF from 'jspdf'
import { formatDateTime } from '../utils/date'
import { formatMoney as formatCurrency, formatNumber, formatPercent } from '../utils/currency'
import { formatCompanyName } from '../utils/text'
import { getWarehouseHighlightStyle } from '../utils/warehouseHighlight'
import { addLogoToPdf, buildPrintLogoHtml } from '../utils/printBranding'
import MobileBarcodeScannerButton from '../components/MobileBarcodeScannerButton'
import SignaturePad from '../components/SignaturePad'
import { GUATEMALA_DEPARTMENTS, getGuatemalaMunicipalities } from '../data/gt_locations'

interface Product {
  id: number
  name: string
  price: number
  price2?: number
  price3?: number
  cost?: number
  stock: number
  otherStock?: number
  imageUrl?: string
  categoryId?: number
  brandId?: number
  sku?: string
  productCode?: string
  productType?: 'GENERAL' | 'MEDICINAL' | 'IMEI' | 'SERIAL'
}

interface CartItem extends Product {
  quantity: number
  originalPrice?: number
  priceSource?: 'BASE' | 'PRICE2' | 'PRICE3' | 'MANUAL'
  batchNo?: string
  expiryDate?: string
  maxQuantity?: number
  imei?: string
  serial?: string
}

interface Category {
  id: number
  name: string
  departmentId?: number
}

interface Brand {
  id: number
  name: string
}

interface Department {
  id: number
  name: string
}

interface Customer {
  id: number
  name: string
  document?: string
  phone?: string
  address?: string
  age?: number | null
  nationality?: string
  civil_status?: string
  occupation?: string
  municipality?: string
  department?: string
}

interface ServerDraftSale {
  id: number
  total: number
  doc_no?: string | null
  customer_id: number
  user_id: number
  warehouse_id: number
  created_at?: string
  customer_name?: string
  seller_name?: string
}

interface HeldSale {
  id: string
  name: string
  savedAt: string
  customerId: number | null
  customerName?: string
  cart: CartItem[]
  paymentMethod: 'CASH' | 'CARD' | 'DEPOSIT' | 'CREDIT'
  receivedAmount: string
  referenceNumber: string
  creditDownPayment?: string
  creditInstallments?: CreditInstallmentDraft[]
  creditPlanConfirmed?: boolean
  creditContractPayload?: any | null
  creditContractCustomer?: {
    phone: string
    address: string
    dpi: string
    age: string
    nationality: string
    civilStatus: string
    occupation: string
    municipality: string
    department: string
  }
  creditContractWarrantyTime?: string
  creditContractRefs?: Array<{ name: string; phone: string }>
  total: number
}

type CreditInstallmentDraft = {
  amount: string
  dueDate: string
}

type CompletedSale = {
  saleId: number
  date: string
  items: CartItem[]
  total: number
  paymentDetails: any
  customer?: Customer
}

type GeneratedQuote = {
  quoteNo: string
  date: string
  items: CartItem[]
  total: number
  customer?: Customer
}

type POSMode = 'sale' | 'quote'

function formatInputDate(date: Date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function addDaysToInputDate(baseDate: string | Date, days: number) {
  const base = typeof baseDate === 'string'
    ? new Date(`${(baseDate || formatInputDate(new Date())).slice(0, 10)}T12:00:00`)
    : new Date(baseDate)
  base.setDate(base.getDate() + days)
  return formatInputDate(base)
}

function buildCreditInstallmentDrafts(total: number, count: number, firstDueDate?: string): CreditInstallmentDraft[] {
  const safeCount = Math.max(1, Math.min(36, Number(count) || 1))
  const totalCents = Math.max(0, Math.round(Number(total || 0) * 100))
  const baseAmount = Math.floor(totalCents / safeCount)
  let remainder = totalCents - (baseAmount * safeCount)
  const startDate = firstDueDate || addDaysToInputDate(new Date(), 30)

  return Array.from({ length: safeCount }, (_, index) => {
    const cents = baseAmount + (remainder > 0 ? 1 : 0)
    remainder = Math.max(0, remainder - 1)
    return {
      amount: (cents / 100).toFixed(2),
      dueDate: index === 0 ? startDate : addDaysToInputDate(startDate, index * 30),
    }
  })
}

function normalizeStoredCreditInstallments(value: unknown): CreditInstallmentDraft[] {
  if (!Array.isArray(value) || value.length === 0) return []
  return value
    .map((installment: any) => ({
      amount: String(installment?.amount ?? ''),
      dueDate: String(installment?.dueDate ?? installment?.due_date ?? ''),
    }))
    .filter(installment => installment.amount || installment.dueDate)
}

function validateCreditInstallments(installments: CreditInstallmentDraft[], total: number) {
  if (!Array.isArray(installments) || installments.length === 0) {
    return { valid: false, error: 'Debes registrar al menos una cuota para la venta a crédito' }
  }

  const normalized = installments.map((installment, index) => {
    const amount = Math.round(Number(installment.amount || 0) * 100) / 100
    const dueDate = String(installment.dueDate || '').trim()

    if (!Number.isFinite(amount) || amount <= 0) {
      return { error: `La cuota #${index + 1} debe tener un monto válido` }
    }

    if (!dueDate) {
      return { error: `La cuota #${index + 1} debe tener fecha de vencimiento` }
    }

    return {
      amount,
      dueDate,
    }
  })

  const invalid = normalized.find(item => 'error' in item)
  if (invalid && 'error' in invalid) {
    return { valid: false, error: invalid.error }
  }

  const installmentsTotal = Math.round(
    (normalized as Array<{ amount: number; dueDate: string }>).reduce((sum, installment) => sum + installment.amount, 0) * 100
  ) / 100
  const expectedTotal = Math.round(Number(total || 0) * 100) / 100

  if (Math.abs(installmentsTotal - expectedTotal) > 0.01) {
    return { valid: false, error: 'La suma de las cuotas no coincide con el total de la venta' }
  }

  return {
    valid: true,
    installments: normalized as Array<{ amount: number; dueDate: string }>,
  }
}

async function fileToDataUrl(file: File) {
  const buf = await file.arrayBuffer()
  const bytes = new Uint8Array(buf)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  const b64 = btoa(binary)
  const mime = String(file.type || '').toLowerCase()
  const safeMime = mime.startsWith('image/') ? mime : 'image/png'
  return `data:${safeMime};base64,${b64}`
}

export default function POS({ mode = 'sale' }: { mode?: POSMode }) {
  const isQuoteMode = mode === 'quote'
  const productsPerPage = 40
  const [products, setProducts] = useState<Product[]>([])
  const [loadedImages, setLoadedImages] = useState<Record<number, boolean>>({})
  const [categories, setCategories] = useState<Category[]>([])
  const [brands, setBrands] = useState<Brand[]>([])
  const [departments, setDepartments] = useState<Department[]>([])
  const [customers, setCustomers] = useState<Customer[]>([])
  const [cart, setCart] = useState<CartItem[]>([])
  const [searchTerm, setSearchTerm] = useState('')
  const [debouncedSearchTerm, setDebouncedSearchTerm] = useState('')
  const [selectedCategory, setSelectedCategory] = useState<number | null>(null)
  const [selectedBrand, setSelectedBrand] = useState<number | null>(null)
  const [selectedDepartment, setSelectedDepartment] = useState<number | null>(null)
  const [currentPage, setCurrentPage] = useState(1)
  const [totalProducts, setTotalProducts] = useState(0)
  const [selectedCustomer, setSelectedCustomer] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)
  const [paymentMethod, setPaymentMethod] = useState<'CASH' | 'CARD' | 'DEPOSIT' | 'CREDIT'>('CASH')
  const [receivedAmount, setReceivedAmount] = useState<string>('')
  const [referenceNumber, setReferenceNumber] = useState<string>('')
  const [creditDownPayment, setCreditDownPayment] = useState<string>('0')
  const [creditInstallments, setCreditInstallments] = useState<CreditInstallmentDraft[]>(() => buildCreditInstallmentDrafts(0, 1))
  const [creditInlineAlert, setCreditInlineAlert] = useState<{ kind: 'error' | 'warn' | 'ok'; text: string } | null>(null)
  const [creditPlanConfirmed, setCreditPlanConfirmed] = useState(false)
  const [creditContractModalOpen, setCreditContractModalOpen] = useState(false)
  const [creditContractPayload, setCreditContractPayload] = useState<any | null>(null)
  const [creditContractSignatureFile, setCreditContractSignatureFile] = useState<File | null>(null)
  const [creditContractCustomer, setCreditContractCustomer] = useState({
    phone: '',
    address: '',
    dpi: '',
    age: '',
    nationality: 'guatemalteco(a)',
    civilStatus: '',
    occupation: '',
    municipality: '',
    department: '',
  })
  const [creditContractWarrantyTime, setCreditContractWarrantyTime] = useState('')
  const [creditContractRefs, setCreditContractRefs] = useState<Array<{ name: string; phone: string }>>([
    { name: '', phone: '' },
    { name: '', phone: '' },
    { name: '', phone: '' },
    { name: '', phone: '' },
  ])
  const guatemalaDepartments = useMemo(() => GUATEMALA_DEPARTMENTS.map(d => d.name), [])
  const guatemalaMunicipalities = useMemo(() => getGuatemalaMunicipalities(creditContractCustomer.department), [creditContractCustomer.department])
  const [isCustomerModalOpen, setIsCustomerModalOpen] = useState(false)
  const [isMobileCartOpen, setIsMobileCartOpen] = useState(false)
  const [isPhoneViewport, setIsPhoneViewport] = useState(false)
  const [isPhonePaymentPanelOpen, setIsPhonePaymentPanelOpen] = useState(false)
  const [isPhoneHeldSalesOpen, setIsPhoneHeldSalesOpen] = useState(false)
  const [isServerDraftsOpen, setIsServerDraftsOpen] = useState(false)
  const [serverDrafts, setServerDrafts] = useState<ServerDraftSale[]>([])
  const [serverDraftsLoading, setServerDraftsLoading] = useState(false)
  const [serverDraftsLoaded, setServerDraftsLoaded] = useState(false)
  const [currentServerDraftId, setCurrentServerDraftId] = useState<number | null>(null)

  // Batch Selection State
  const [selectedProductForBatch, setSelectedProductForBatch] = useState<Product | null>(null)
  const [availableBatches, setAvailableBatches] = useState<{batchNo: string, expiryDate: string, quantity: number}[]>([])
  const [loadingBatches, setLoadingBatches] = useState(false)

  // IMEI/Serial Selection State
  const [selectedProductForImei, setSelectedProductForImei] = useState<Product | null>(null)
  const [availableImeis, setAvailableImeis] = useState<string[]>([])

  const [selectedProductForSerial, setSelectedProductForSerial] = useState<Product | null>(null)
  const [availableSerials, setAvailableSerials] = useState<string[]>([])

  // Modal Search State
  const [modalSearchTerm, setModalSearchTerm] = useState('')

  // Warehouse Stock View
  const [viewStockProduct, setViewStockProduct] = useState<Product | null>(null)
  const [warehouseStocks, setWarehouseStocks] = useState<{warehouseId: number, warehouseName: string, quantity: number}[]>([])
  const [loadingStocks, setLoadingStocks] = useState(false)
  const [isCashOpen, setIsCashOpen] = useState<boolean | null>(null)

  const user = useAuthStore(s => s.user)
  const hasPermission = useAuthStore(s => s.hasPermission)
  const hasExplicitPermission = useAuthStore(s => s.hasExplicitPermission)
  const isAdmin = String(user?.role || '').toUpperCase() === 'ADMIN'
  const canChangePosPrice = hasExplicitPermission('pos:change_price')
  const canUseManualPosPrice = hasExplicitPermission('pos:manual_price')
  const canViewProjectedProfit = isAdmin || hasPermission('products:sensitive:read')
  const canOperateCash = isAdmin
    || hasPermission('cash:view')
    || hasPermission('cash:open')
    || hasPermission('cash:movements')
    || hasPermission('cash:close')
  // Print Settings
  const [shouldPrintTicket, setShouldPrintTicket] = useState(true)
  const [lastSale, setLastSale] = useState<CompletedSale | null>(null)
  const [lastQuote, setLastQuote] = useState<GeneratedQuote | null>(null)
  const [heldSales, setHeldSales] = useState<HeldSale[]>([])
  const [heldSalesLoaded, setHeldSalesLoaded] = useState(false)

  const iframeRef = useRef<HTMLIFrameElement>(null)

  const config = useConfigStore(s => s.config)
  const companyName = formatCompanyName(config?.name)
    const [newCustomer, setNewCustomer] = useState({
    name: '',
    document: '',
    phone: '',
    email: '',
    address: ''
  })

  const navigate = useNavigate()
  const heldSalesStorageKey = `dtmpos_${isQuoteMode ? 'quotes' : 'pos'}_held_sales_${user?.id || 'guest'}`
  const currentOrderLabel = isQuoteMode ? 'Cotización Actual' : 'Orden Actual'
  const heldOrderLabel = isQuoteMode ? 'Cotizaciones En Espera' : 'Ventas En Espera'
  const emptyHeldOrderLabel = isQuoteMode ? 'No hay cotizaciones guardadas en espera.' : 'No hay ventas guardadas en espera.'
  const backButtonLabel = isQuoteMode ? 'Cerrar cotizador' : 'Cerrar POS'
  const scannerTitle = isQuoteMode ? 'Escanear producto en cotización' : 'Escanear producto en POS'
  const modeChipLabel = isQuoteMode ? 'Modo cotización' : 'Modo venta'

  useEffect(() => {
    if (isQuoteMode || !canOperateCash) {
      setIsCashOpen(null)
      return
    }
    checkCashStatus()
  }, [isQuoteMode, canOperateCash])

  useEffect(() => {
    if (paymentMethod !== 'CREDIT') {
      setCreditContractPayload(null)
      setCreditContractModalOpen(false)
      setCreditContractSignatureFile(null)
      setCreditPlanConfirmed(false)
    }
  }, [paymentMethod])

  useEffect(() => {
    if (paymentMethod !== 'CREDIT') return
    if (!selectedCustomer) {
      setCreditContractPayload(null)
      return
    }
    const payloadCustomerId = Number((creditContractPayload as any)?.customerId || 0)
    if (payloadCustomerId && payloadCustomerId === Number(selectedCustomer)) return
    setCreditContractPayload(null)
  }, [selectedCustomer])

  useEffect(() => {
    const mediaQuery = window.matchMedia('(max-width: 768px)')
    const syncMobileCart = (event?: MediaQueryListEvent) => {
      const isMobile = event ? event.matches : mediaQuery.matches
      if (!isMobile) {
        setIsMobileCartOpen(false)
      }
    }

    syncMobileCart()
    if (typeof mediaQuery.addEventListener === 'function') {
      mediaQuery.addEventListener('change', syncMobileCart)
      return () => mediaQuery.removeEventListener('change', syncMobileCart)
    }

    mediaQuery.addListener(syncMobileCart)
    return () => mediaQuery.removeListener(syncMobileCart)
  }, [])

  useEffect(() => {
    const mediaQuery = window.matchMedia('(max-width: 480px)')
    const syncPhoneViewport = (event?: MediaQueryListEvent) => {
      const isPhone = event ? event.matches : mediaQuery.matches
      setIsPhoneViewport(isPhone)
      if (!isPhone) {
        setIsPhonePaymentPanelOpen(false)
        setIsPhoneHeldSalesOpen(false)
      }
    }

    syncPhoneViewport()
    if (typeof mediaQuery.addEventListener === 'function') {
      mediaQuery.addEventListener('change', syncPhoneViewport)
      return () => mediaQuery.removeEventListener('change', syncPhoneViewport)
    }

    mediaQuery.addListener(syncPhoneViewport)
    return () => mediaQuery.removeListener(syncPhoneViewport)
  }, [])

  useEffect(() => {
    if (cart.length === 0) {
      setIsPhonePaymentPanelOpen(false)
    }
  }, [cart.length])

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      setDebouncedSearchTerm(searchTerm.trim())
    }, 300)

    return () => window.clearTimeout(timeoutId)
  }, [searchTerm])

  useEffect(() => {
    setCurrentPage(1)
  }, [debouncedSearchTerm, selectedCategory, selectedBrand, selectedDepartment, user?.warehouseId])

  useEffect(() => {
    loadData()
  }, [user?.warehouseId, currentPage, debouncedSearchTerm, selectedCategory, selectedBrand, selectedDepartment])

  useEffect(() => {
    setHeldSalesLoaded(false)
    try {
      const raw = localStorage.getItem(heldSalesStorageKey)
      const parsed = raw ? JSON.parse(raw) : []
      setHeldSales(Array.isArray(parsed) ? parsed.map((sale: any) => ({
        ...sale,
        creditInstallments: normalizeStoredCreditInstallments(sale?.creditInstallments),
      })) : [])
    } catch (err) {
      console.error('Error loading held POS sales:', err)
      setHeldSales([])
    } finally {
      setHeldSalesLoaded(true)
    }
  }, [heldSalesStorageKey])

  useEffect(() => {
    if (!heldSalesLoaded) return
    try {
      localStorage.setItem(heldSalesStorageKey, JSON.stringify(heldSales))
    } catch (err) {
      console.error('Error saving held POS sales:', err)
    }
  }, [heldSales, heldSalesStorageKey, heldSalesLoaded])

  useEffect(() => {
    if (isQuoteMode || !canOperateCash) return
    const refreshCashStatus = () => {
      checkCashStatus()
    }

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        refreshCashStatus()
      }
    }

    window.addEventListener('focus', refreshCashStatus)
    document.addEventListener('visibilitychange', handleVisibilityChange)

    const intervalId = window.setInterval(refreshCashStatus, 15000)

    return () => {
      window.removeEventListener('focus', refreshCashStatus)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      window.clearInterval(intervalId)
    }
  }, [isQuoteMode, canOperateCash])

  const checkCashStatus = async () => {
    if (!canOperateCash) {
      setIsCashOpen(null)
      return
    }
    try {
      const status = await getCashStatus()
      setIsCashOpen(status.isOpen)
    } catch (err) {
      console.error(err)
    }
  }

  const loadData = async () => {
    try {
      const wId = user?.warehouseId ? Number(user.warehouseId) : null
      if (!isAdmin && !wId) {
        setProducts([])
        setTotalProducts(0)
        return
      }

      const categoryIdsForDepartment = selectedDepartment
        ? categories.filter(c => c.departmentId === selectedDepartment).map(c => c.id)
        : []
      const effectiveCategoryId = selectedCategory || (categoryIdsForDepartment.length === 1 ? categoryIdsForDepartment[0] : null)

      const [prodRes, catRes, brandRes, deptRes, custRes] = await Promise.all([
        getProducts({
          paged: true,
          page: currentPage,
          limit: productsPerPage,
          search: debouncedSearchTerm || undefined,
          categoryId: effectiveCategoryId,
          brandId: selectedBrand,
          departmentId: selectedDepartment,
          stockFilter: isQuoteMode ? undefined : 'with_stock',
          warehouseId: wId,
        }),
        api.get('/categories'),
        api.get('/brands'),
        api.get('/departments'),
        api.get('/customers')
      ])
      const nextProducts = Array.isArray(prodRes?.data) ? prodRes.data : []
      setProducts(nextProducts)
      setTotalProducts(Number(prodRes?.pagination?.total || 0))
      setCategories(catRes.data)
      setBrands(brandRes.data)
      setDepartments(deptRes.data)
      setCustomers(custRes.data)
    } catch (err) {
      console.error('Error loading POS data:', err)
      setProducts([])
      setTotalProducts(0)
    }
  }

  const handleViewStock = async (e: React.MouseEvent, product: Product) => {
    e.stopPropagation()
    setViewStockProduct(product)
    setLoadingStocks(true)
    try {
      const res = await api.get(`/products/${product.id}/warehouse-stock`)
      setWarehouseStocks(res.data)
    } catch (err) {
      console.error(err)
      alert('Error al cargar existencias')
    } finally {
      setLoadingStocks(false)
    }
  }

  const addToCart = async (product: Product) => {
    if (!isQuoteMode && product.stock <= 0) {
      alert('Producto sin stock disponible')
      return
    }

        if (isQuoteMode) {
            setCart(prev => {
              const existing = prev.find(item => item.id === product.id && !item.batchNo && !item.imei && !item.serial)
              if (existing) {
                return prev.map(item =>
                  (item.id === product.id && !item.batchNo && !item.imei && !item.serial)
                    ? { ...item, quantity: item.quantity + 1 }
                    : item
                )
              }
              return [...prev, { ...product, quantity: 1, originalPrice: product.price, priceSource: 'BASE' }]
            })
            return
        }

        if (product.productType === 'MEDICINAL') {
            setLoadingBatches(true)
            try {
                const wId = user?.warehouseId ? Number(user.warehouseId) : null
                if (!wId && !isAdmin) {
                    alert('Tu usuario no tiene una tienda asignada')
                    return
                }
                const res = await api.get(`/products/${product.id}`, wId ? { params: { warehouseId: wId } } : undefined)
                if (res.data.batches && res.data.batches.length > 0) {
                    // Filter batches with positive quantity and sort by expiry date (ASC)
                    const validBatches = res.data.batches
                        .filter((b: any) => b.quantity > 0)
                        .sort((a: any, b: any) => new Date(a.expiryDate).getTime() - new Date(b.expiryDate).getTime())

                    if (validBatches.length > 0) {
                        setAvailableBatches(validBatches)
                        setSelectedProductForBatch(product)
                        setModalSearchTerm('')
                    } else {
                        // Check if stock exists but in other warehouse
                        if (product.otherStock && product.otherStock > 0) {
                             alert(`No hay lotes en este almacén. Disponibles ${product.otherStock} en otros almacenes.`)
                        } else {
                             alert('No hay lotes con stock disponible para este producto')
                        }
                    }
                } else {
                    alert('No hay lotes registrados para este producto')
                }
            } catch (err) {
                console.error(err)
                alert('Error al cargar lotes')
            } finally {
                setLoadingBatches(false)
            }
            return
        }

    if (product.productType === 'IMEI') {
        try {
            const wId = user?.warehouseId ? Number(user.warehouseId) : null
            if (!wId && !isAdmin) {
                alert('Tu usuario no tiene una tienda asignada')
                return
            }
            const res = await api.get(`/products/${product.id}`, wId ? { params: { warehouseId: wId } } : undefined)
            if (res.data.imeis && res.data.imeis.length > 0) {
                // Filter out IMEIs already in cart
                const usedImeis = cart.filter(c => c.id === product.id && c.imei).map(c => c.imei)
                const available = res.data.imeis.filter((i: string) => !usedImeis.includes(i))

                if (available.length > 0) {
                    setAvailableImeis(available)
                    setSelectedProductForImei(product)
                    setModalSearchTerm('')
                } else {
                     if (product.otherStock && product.otherStock > 0) {
                          alert(`No hay IMEIs en este almacén. Disponibles ${product.otherStock} en otros.`)
                     } else {
                          alert('Todos los IMEIs ya están en el carrito o no hay disponibles en este almacén')
                     }
                }
            } else {
                if (product.otherStock && product.otherStock > 0) {
                    alert(`No hay IMEIs en este almacén. Disponibles ${product.otherStock} en otros.`)
                } else {
                    alert('No hay IMEIs registrados para este producto en este almacén')
                }
            }
        } catch (err) {
            console.error(err)
            alert('Error al cargar IMEIs')
        }
        return
    }

    if (product.productType === 'SERIAL') {
        try {
            const wId = user?.warehouseId ? Number(user.warehouseId) : null
            if (!wId && !isAdmin) {
                alert('Tu usuario no tiene una tienda asignada')
                return
            }
            const res = await api.get(`/products/${product.id}`, wId ? { params: { warehouseId: wId } } : undefined)
            if (res.data.serials && res.data.serials.length > 0) {
                 // Filter out Serials already in cart
                 const usedSerials = cart.filter(c => c.id === product.id && c.serial).map(c => c.serial)
                 const available = res.data.serials.filter((s: string) => !usedSerials.includes(s))

                if (available.length > 0) {
                    setAvailableSerials(available)
                    setSelectedProductForSerial(product)
                    setModalSearchTerm('')
                } else {
                     if (product.otherStock && product.otherStock > 0) {
                          alert(`No hay Seriales en este almacén. Disponibles ${product.otherStock} en otros.`)
                     } else {
                          alert('Todos los Seriales ya están en el carrito o no hay disponibles en este almacén')
                     }
                }
            } else {
                if (product.otherStock && product.otherStock > 0) {
                    alert(`No hay Seriales en este almacén. Disponibles ${product.otherStock} en otros.`)
                } else {
                    alert('No hay Seriales registrados para este producto en este almacén')
                }
            }
        } catch (err) {
            console.error(err)
            alert('Error al cargar Seriales')
        }
        return
    }

    setCart(prev => {
      // General product logic
      const existing = prev.find(item => item.id === product.id && !item.batchNo && !item.imei && !item.serial)
      if (existing) {
        if (existing.quantity >= product.stock) {
          alert(`Stock insuficiente. Solo hay ${product.stock} disponibles.`)
          return prev
        }
        return prev.map(item =>
          (item.id === product.id && !item.batchNo && !item.imei && !item.serial)
            ? { ...item, quantity: item.quantity + 1 }
            : item
        )
      }
      return [...prev, { ...product, quantity: 1, originalPrice: product.price, priceSource: 'BASE' }]
    })
  }

  const handleScannedProductCode = async (rawValue: string) => {
    const scannedValue = String(rawValue || '').trim()
    if (!scannedValue) return

    setSearchTerm(scannedValue)

    const normalizedValue = scannedValue.toLowerCase()
    let exactMatches = products.filter(product => {
      const productCode = String(product.productCode || '').trim().toLowerCase()
      const sku = String(product.sku || '').trim().toLowerCase()
      return productCode === normalizedValue || sku === normalizedValue
    })

    if (exactMatches.length === 0) {
      try {
        const wId = user?.warehouseId ? Number(user.warehouseId) : null
        const response = await getProducts({
          paged: true,
          page: 1,
          limit: 10,
          search: scannedValue,
          stockFilter: isQuoteMode ? undefined : 'with_stock',
          warehouseId: wId,
        })
        const remoteProducts = Array.isArray(response?.data) ? response.data : []
        exactMatches = remoteProducts.filter(product => {
          const productCode = String(product.productCode || '').trim().toLowerCase()
          const sku = String(product.sku || '').trim().toLowerCase()
          return productCode === normalizedValue || sku === normalizedValue
        })
      } catch (error) {
        console.error('Error searching scanned product:', error)
      }
    }

    if (exactMatches.length === 1) {
      await addToCart(exactMatches[0])
    }
  }

  const addBatchToCart = (product: Product, batch: {batchNo: string, expiryDate: string, quantity: number}, qty: number) => {
      setCart(prev => {
          const existing = prev.find(item => item.id === product.id && item.batchNo === batch.batchNo)
          if (existing) {
              const newQty = existing.quantity + qty
              if (newQty > batch.quantity) {
                  alert(`Stock insuficiente en lote. Solo hay ${batch.quantity} disponibles.`)
                  return prev
              }
              return prev.map(item =>
                  (item.id === product.id && item.batchNo === batch.batchNo)
                  ? { ...item, quantity: newQty }
                  : item
              )
          }
          return [...prev, {
              ...product,
              quantity: qty,
              originalPrice: product.price,
              priceSource: 'BASE',
              batchNo: batch.batchNo,
              expiryDate: batch.expiryDate,
              maxQuantity: batch.quantity
          }]
      })
      setSelectedProductForBatch(null)
  }

  const addImeiToCart = (product: Product, imei: string) => {
      setCart(prev => {
          // Check uniqueness just in case
          if (prev.some(item => item.id === product.id && item.imei === imei)) {
              return prev
          }
          return [...prev, {
              ...product,
              quantity: 1,
              originalPrice: product.price,
              priceSource: 'BASE',
              imei: imei,
              maxQuantity: 1 // Unique item
          }]
      })
      setSelectedProductForImei(null)
  }

  const addSerialToCart = (product: Product, serial: string) => {
      setCart(prev => {
          if (prev.some(item => item.id === product.id && item.serial === serial)) {
              return prev
          }
          return [...prev, {
              ...product,
              quantity: 1,
              originalPrice: product.price,
              priceSource: 'BASE',
              serial: serial,
              maxQuantity: 1 // Unique item
          }]
      })
      setSelectedProductForSerial(null)
  }

  const updatePrice = (
    productId: number,
    newPrice: number,
    batchNo?: string,
    imei?: string,
    serial?: string,
    priceSource: CartItem['priceSource'] = 'BASE'
  ) => {
    setCart(prev => prev.map(item => {
      const isTarget = item.id === productId &&
                       item.batchNo === batchNo &&
                       item.imei === imei &&
                       item.serial === serial

      if (isTarget) {
        return { ...item, price: newPrice, priceSource }
      }
      return item
    }))
  }

  const handleManualPriceChange = (productId: number, value: string, batchNo?: string, imei?: string, serial?: string) => {
    const manualPrice = Number(value)
    if (!Number.isFinite(manualPrice) || manualPrice <= 0) return
    updatePrice(productId, manualPrice, batchNo, imei, serial, 'MANUAL')
  }

  const updateQuantity = (productId: number, delta: number, batchNo?: string, imei?: string, serial?: string) => {
    setCart(prev => prev.map(item => {
      const isTarget = item.id === productId &&
                       item.batchNo === batchNo &&
                       item.imei === imei &&
                       item.serial === serial

      if (isTarget) {
        const newQty = item.quantity + delta
        if (newQty < 1) return item

        if (isQuoteMode) {
          return { ...item, quantity: newQty }
        }

        const limit = item.maxQuantity || item.stock
        if (newQty > limit) {
          alert(`Stock insuficiente. Solo hay ${limit} disponibles.`)
          return item
        }
        return { ...item, quantity: newQty }
      }
      return item
    }))
  }

  const handleQuantityChange = (productId: number, value: string, batchNo?: string, imei?: string, serial?: string) => {
    const newQty = parseInt(value)
    if (isNaN(newQty)) return

    setCart(prev => prev.map(item => {
      const isTarget = item.id === productId &&
                       item.batchNo === batchNo &&
                       item.imei === imei &&
                       item.serial === serial

      if (isTarget) {
        if (newQty < 1) return item

        if (isQuoteMode) {
          return { ...item, quantity: newQty }
        }

        const limit = item.maxQuantity || item.stock
        if (newQty > limit) {
          alert(`Stock insuficiente. Solo hay ${limit} disponibles.`)
          return { ...item, quantity: limit }
        }
        return { ...item, quantity: newQty }
      }
      return item
    }))
  }

  const removeFromCart = (productId: number, batchNo?: string, imei?: string, serial?: string) => {
    setCart(prev => prev.filter(item => !(
        item.id === productId &&
        item.batchNo === batchNo &&
        item.imei === imei &&
        item.serial === serial
    )))
  }

  const clearFilters = () => {
    setSearchTerm('')
    setSelectedCategory(null)
    setSelectedBrand(null)
    setSelectedDepartment(null)
    setCurrentPage(1)
  }

  const totalPages = Math.max(1, Math.ceil(totalProducts / productsPerPage))

  const total = useMemo(() => {
    return cart.reduce((sum, item) => sum + (item.price * item.quantity), 0)
  }, [cart])

  const totalUnits = useMemo(() => {
    return cart.reduce((sum, item) => sum + Number(item.quantity || 0), 0)
  }, [cart])

  const creditDownPaymentAmount = useMemo(() => {
    return Math.max(0, Math.round(Number(creditDownPayment || 0) * 100) / 100)
  }, [creditDownPayment])

  const creditBaseTotal = useMemo(() => {
    return Math.round(Math.max(0, total - creditDownPaymentAmount) * 100) / 100
  }, [total, creditDownPaymentAmount])

  useEffect(() => {
    if (paymentMethod !== 'CREDIT') {
      setCreditInlineAlert(null)
    }
  }, [paymentMethod])

  const creditInstallmentsTotal = useMemo(() => {
    return Math.round(creditInstallments.reduce((sum, installment) => sum + (Number(installment.amount || 0) || 0), 0) * 100) / 100
  }, [creditInstallments])

  const creditDifference = useMemo(() => {
    return Math.round((creditBaseTotal - creditInstallmentsTotal) * 100) / 100
  }, [creditBaseTotal, creditInstallmentsTotal])

  useEffect(() => {
    if (paymentMethod !== 'CREDIT') return
    if (creditInstallments.length === 0) {
      setCreditInstallments(buildCreditInstallmentDrafts(creditBaseTotal, 1))
      return
    }

    const allAmountsEmpty = creditInstallments.every(installment => !Number(installment.amount || 0))
    if (allAmountsEmpty && creditBaseTotal > 0) {
      setCreditInstallments(prev => buildCreditInstallmentDrafts(creditBaseTotal, prev.length || 1, prev[0]?.dueDate))
    }
  }, [paymentMethod, creditBaseTotal, creditInstallments])

  useEffect(() => {
    if (paymentMethod !== 'CREDIT') return
    setCreditPlanConfirmed(false)
  }, [paymentMethod, creditDownPayment, creditInstallments])

  const shouldCollapsePhonePayment = isPhoneViewport
  const showPhoneProductsOnly = shouldCollapsePhonePayment && !isPhonePaymentPanelOpen
  const showPhoneCheckoutContext = !showPhoneProductsOnly
  const showExpandedPaymentPanel = !shouldCollapsePhonePayment || isPhonePaymentPanelOpen
  const showCartItemsPanel = !shouldCollapsePhonePayment || !isPhonePaymentPanelOpen

  const projectedCostTotal = useMemo(() => {
    if (!canViewProjectedProfit) return 0
    return cart.reduce((sum, item) => sum + (Number(item.cost || 0) * item.quantity), 0)
  }, [canViewProjectedProfit, cart])

  const projectedProfitTotal = useMemo(() => {
    if (!canViewProjectedProfit) return 0
    return total - projectedCostTotal
  }, [canViewProjectedProfit, total, projectedCostTotal])

  const projectedMargin = useMemo(() => {
    if (!canViewProjectedProfit || total <= 0) return 0
    return (projectedProfitTotal / total) * 100
  }, [canViewProjectedProfit, total, projectedProfitTotal])

  const formatMoney = (value: number) => formatCurrency(Number(value || 0), config?.currency)

  const resetCurrentSale = () => {
    setCart([])
    setSelectedCustomer(null)
    setPaymentMethod('CASH')
    setReceivedAmount('')
    setReferenceNumber('')
    setCreditDownPayment('0')
    setCreditInstallments(buildCreditInstallmentDrafts(0, 1))
    setIsPhonePaymentPanelOpen(false)
    setCurrentServerDraftId(null)
  }

  const regenerateCreditInstallments = (count = creditInstallments.length || 1) => {
    setCreditInstallments(prev => buildCreditInstallmentDrafts(creditBaseTotal, count, prev[0]?.dueDate))
  }

  const updateCreditInstallment = (index: number, field: keyof CreditInstallmentDraft, value: string) => {
    setCreditInstallments(prev => prev.map((installment, installmentIndex) => (
      installmentIndex === index
        ? { ...installment, [field]: value }
        : installment
    )))
  }

  const addCreditInstallment = () => {
    setCreditInstallments(prev => {
      const lastDueDate = prev[prev.length - 1]?.dueDate || addDaysToInputDate(new Date(), 30)
      return [
        ...prev,
        {
          amount: '0.00',
          dueDate: addDaysToInputDate(lastDueDate, 30),
        },
      ]
    })
  }

  const removeCreditInstallment = (index: number) => {
    setCreditInstallments(prev => {
      if (prev.length <= 1) return prev
      return prev.filter((_, installmentIndex) => installmentIndex !== index)
    })
  }

  const downloadTicketPdf = (blobUrl: string, saleId: number) => {
    const link = document.createElement('a')
    link.href = blobUrl
    link.download = `ticket-venta-${saleId}.pdf`
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    window.setTimeout(() => URL.revokeObjectURL(blobUrl), 1000)
  }

  const escapeHtml = (value: unknown) =>
    String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')

  const getPriceSourceLabel = (source?: CartItem['priceSource']) => {
    if (source === 'PRICE2') return 'P2'
    if (source === 'PRICE3') return 'P3'
    if (source === 'MANUAL') return 'Manual'
    return 'Base'
  }

  const renderHeldSalesSection = (compact = false) => (
    <div
      className={compact ? 'pos-held-sales-block pos-held-sales-block-compact' : 'pos-held-sales-block'}
      style={{ padding: compact ? '0 16px 12px' : '10px 16px', borderBottom: compact ? 'none' : '1px solid var(--border)', backgroundColor: 'var(--bg)' }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: heldSales.length ? 10 : 0 }}>
        <div style={{ fontWeight: 700, color: 'var(--text)' }}>{heldOrderLabel}</div>
        <div style={{ fontSize: '0.85rem', color: 'var(--muted)' }}>{heldSales.length}</div>
      </div>
      {heldSales.length === 0 ? (
        <div style={{ fontSize: '0.85rem', color: 'var(--muted)' }}>
          {emptyHeldOrderLabel}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: compact ? 220 : 170, overflowY: 'auto' }}>
          {heldSales.map(sale => (
            <div key={sale.id} style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 10, background: 'var(--modal)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'flex-start' }}>
                <div>
                  <div style={{ fontWeight: 700, color: 'var(--text)' }}>{sale.name}</div>
                  <div style={{ fontSize: '0.8rem', color: 'var(--muted)' }}>
                    {sale.customerName || 'Cliente general'} | {sale.cart.length} item(s)
                  </div>
                  <div style={{ fontSize: '0.8rem', color: 'var(--muted)' }}>
                    {formatDateTime(new Date(sale.savedAt))}
                  </div>
                </div>
                <div style={{ fontWeight: 700, color: 'var(--accent)' }}>
                  {formatMoney(sale.total)}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                <button
                  type="button"
                  onClick={() => resumeHeldSale(sale.id)}
                  style={{
                    flex: 1,
                    padding: '8px 10px',
                    borderRadius: 6,
                    border: '1px solid var(--border)',
                    background: 'var(--surface)',
                    color: 'var(--text)',
                    cursor: 'pointer',
                    fontWeight: 600
                  }}
                >
                  Retomar
                </button>
                <button
                  type="button"
                  onClick={() => deleteHeldSale(sale.id)}
                  style={{
                    padding: '8px 10px',
                    borderRadius: 6,
                    border: '1px solid rgba(239, 68, 68, 0.35)',
                    background: 'transparent',
                    color: '#ef4444',
                    cursor: 'pointer',
                    fontWeight: 600
                  }}
                >
                  Eliminar
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )

  const renderPhoneHeldSalesAccordion = () => (
    <div className="pos-phone-held-sales-accordion">
      <button
        type="button"
        className="pos-phone-held-sales-toggle"
        onClick={() => setIsPhoneHeldSalesOpen(prev => !prev)}
      >
        <span>{heldOrderLabel}</span>
        <span className="pos-phone-held-sales-toggle-meta">
          {heldSales.length}
          <span className={`pos-phone-held-sales-chevron${isPhoneHeldSalesOpen ? ' open' : ''}`}>▾</span>
        </span>
      </button>
      {isPhoneHeldSalesOpen && renderHeldSalesSection(true)}
    </div>
  )

  const buildPrintableTicketHtml = (
    saleId: number,
    date: string,
    items: CartItem[],
    totalAmount: number,
    paymentDetails?: any,
    customer?: Customer
  ) => {
    const logoBlock = buildPrintLogoHtml(config?.logoUrl, companyName, { maxWidth: 110, maxHeight: 40, marginBottom: 4 })
    const paymentLines: string[] = []
    if (paymentDetails?.paymentMethod === 'CASH') {
      paymentLines.push(`Efectivo: ${formatNumber(Number(paymentDetails.receivedAmount || 0))}`)
      paymentLines.push(`Cambio: ${formatNumber(Number(paymentDetails.changeAmount || 0))}`)
    } else if (paymentDetails?.paymentMethod === 'CARD') {
      paymentLines.push(`Tarjeta Ref: ${paymentDetails.referenceNumber || ''}`)
    } else if (paymentDetails?.paymentMethod === 'DEPOSIT') {
      paymentLines.push(`Deposito Ref: ${paymentDetails.referenceNumber || ''}`)
    } else if (paymentDetails?.paymentMethod === 'CREDIT') {
      paymentLines.push('Venta a credito')
    }

    const itemsHtml = items
      .map(item => {
        const lineTotal = item.price * item.quantity
        return `
          <div class="row item">
            <div class="name">${escapeHtml(item.name)}</div>
            <div class="qty">${escapeHtml(formatNumber(item.quantity, 0))} x ${escapeHtml(formatNumber(item.price))}</div>
            <div class="line-total">${escapeHtml(formatNumber(lineTotal))}</div>
          </div>
        `
      })
      .join('')

    const paymentHtml = paymentLines
      .map(line => `<div class="payment-line">${escapeHtml(line)}</div>`)
      .join('')

    return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Ticket Venta ${escapeHtml(saleId)}</title>
    <style>
      @page { size: 80mm auto; margin: 4mm; }
      html, body { margin: 0; padding: 0; background: #fff; }
      body { font-family: Arial, sans-serif; font-size: 11px; color: #000; }
      .ticket { width: 72mm; margin: 0 auto; padding: 2mm 0; }
      .center { text-align: center; }
      .muted { margin-top: 2mm; }
      .divider { border-top: 1px dashed #000; margin: 3mm 0; }
      .row { display: flex; gap: 2mm; align-items: flex-start; }
      .item { margin-bottom: 2mm; }
      .name { flex: 1; word-break: break-word; }
      .qty, .line-total { white-space: nowrap; }
      .line-total { margin-left: auto; }
      .total { font-weight: 700; font-size: 12px; text-align: right; }
      .payment-line { margin-top: 1mm; }
    </style>
  </head>
  <body>
    <div class="ticket">
      ${logoBlock}
      <div class="center"><strong>${escapeHtml(companyName)}</strong></div>
      <div class="center muted">Fecha: ${escapeHtml(date)}</div>
      <div class="center muted">Venta #${escapeHtml(saleId)}</div>
      ${customer ? `<div class="center muted">Cliente: ${escapeHtml(customer.name)}</div>` : ''}
      <div class="divider"></div>
      ${itemsHtml}
      <div class="divider"></div>
      <div class="total">TOTAL: ${escapeHtml(formatMoney(totalAmount))}</div>
      ${paymentHtml ? `<div class="divider"></div>${paymentHtml}` : ''}
    </div>
    <script>
      window.onload = function () {
        setTimeout(function () {
          try {
            window.focus();
            window.print();
          } catch (error) {}
        }, 150);
      };
    </script>
  </body>
</html>`
  }

  const printTicketHtml = (
    blobUrl: string,
    saleId: number,
    date: string,
    items: CartItem[],
    totalAmount: number,
    paymentDetails?: any,
    customer?: Customer,
    printWindow?: Window | null
  ) => {
    const printableHtml = buildPrintableTicketHtml(saleId, date, items, totalAmount, paymentDetails, customer)

    if (printWindow && !printWindow.closed) {
      try {
        printWindow.document.open()
        printWindow.document.write(printableHtml)
        printWindow.document.close()
        window.setTimeout(() => URL.revokeObjectURL(blobUrl), 60000)
        return
      } catch (error) {
        try {
          printWindow.close()
        } catch {}
      }
    }

    const iframe = iframeRef.current
    const frameWindow = iframe?.contentWindow
    const frameDocument = frameWindow?.document

    if (!iframe || !frameWindow || !frameDocument) {
      downloadTicketPdf(blobUrl, saleId)
      return
    }

    try {
      frameDocument.open()
      frameDocument.write(printableHtml)
      frameDocument.close()


      window.setTimeout(() => {
        try {
          frameWindow.focus()
          frameWindow.print()
        } catch (error) {
          downloadTicketPdf(blobUrl, saleId)
          return
        }
      }, 300)

      window.setTimeout(() => {
        try {
          iframe.src = 'about:blank'
        } catch {}
        URL.revokeObjectURL(blobUrl)
      }, 60000)
    } catch (error) {
      downloadTicketPdf(blobUrl, saleId)
    }
  }

  const buildQuoteNo = () => {
    const now = new Date()
    return `COT-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`
  }

  const buildPrintableQuoteHtml = (
    quoteNo: string,
    date: string,
    items: CartItem[],
    totalAmount: number,
    customer?: Customer
  ) => {
    const logoBlock = buildPrintLogoHtml(config?.logoUrl, companyName, { maxWidth: 160, maxHeight: 60, marginBottom: 10, align: 'left' })
    const itemsHtml = items
      .map(item => {
        const lineTotal = item.price * item.quantity
        return `
          <tr>
            <td>${escapeHtml(item.name)}</td>
            <td>${escapeHtml(item.sku || item.productCode || '')}</td>
            <td style="text-align:center;">${escapeHtml(formatNumber(item.quantity, 0))}</td>
            <td style="text-align:right;">${escapeHtml(formatNumber(item.price))}</td>
            <td style="text-align:right;">${escapeHtml(formatNumber(lineTotal))}</td>
          </tr>
        `
      })
      .join('')

    return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Cotizacion ${escapeHtml(quoteNo)}</title>
    <style>
      @page { size: A4; margin: 12mm; }
      html, body { margin: 0; padding: 0; background: #fff; color: #111827; font-family: Arial, sans-serif; }
      body { font-size: 12px; }
      .sheet { max-width: 180mm; margin: 0 auto; padding: 8mm 0; }
      .header { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; }
      .title { font-size: 24px; font-weight: 700; margin: 0 0 4px; }
      .company { font-size: 18px; font-weight: 700; margin: 0 0 6px; }
      .meta, .note { color: #4b5563; }
      .note { margin-top: 14px; padding: 10px 12px; border-radius: 10px; background: #f3f4f6; }
      table { width: 100%; border-collapse: collapse; margin-top: 18px; }
      th, td { border-bottom: 1px solid #e5e7eb; padding: 8px; vertical-align: top; }
      th { background: #f9fafb; text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; }
      .summary { margin-top: 18px; margin-left: auto; width: 90mm; }
      .summary-row { display: flex; justify-content: space-between; padding: 6px 0; border-bottom: 1px solid #e5e7eb; }
      .summary-row.total { font-size: 16px; font-weight: 700; }
      .footer { margin-top: 26px; color: #6b7280; font-size: 11px; }
    </style>
  </head>
  <body>
    <div class="sheet">
      <div class="header">
        <div>
          ${logoBlock}
          <div class="company">${escapeHtml(companyName)}</div>
          <h1 class="title">Cotizacion</h1>
          <div class="meta">Cliente: ${escapeHtml(customer?.name || 'CLIENTE GENERAL')}</div>
          <div class="meta">Fecha: ${escapeHtml(date)}</div>
        </div>
        <div>
          <div class="meta"><strong>No.:</strong> ${escapeHtml(quoteNo)}</div>
          <div class="meta"><strong>Tienda:</strong> ${escapeHtml(user?.warehouseName || 'GENERAL')}</div>
        </div>
      </div>

      <table>
        <thead>
          <tr>
            <th>Producto</th>
            <th>SKU/COD</th>
            <th>Cant.</th>
            <th>Precio</th>
            <th>Total</th>
          </tr>
        </thead>
        <tbody>
          ${itemsHtml}
        </tbody>
      </table>

      <div class="summary">
        <div class="summary-row total"><span>Total cotizado</span><span>${escapeHtml(formatNumber(totalAmount))}</span></div>
      </div>

      <div class="note">Esta cotizacion es informativa y no afecta inventario ni caja. El documento muestra unicamente informacion comercial apta para entregar al cliente.</div>
      <div class="footer">Documento generado desde POS.</div>
    </div>
    <script>
      window.onload = function () {
        setTimeout(function () {
          try {
            window.focus();
            window.print();
          } catch (error) {}
        }, 150);
      };
    </script>
  </body>
</html>`
  }

  const printQuoteHtml = (quoteNo: string, date: string, items: CartItem[], totalAmount: number, customer?: Customer) => {
    const printableHtml = buildPrintableQuoteHtml(quoteNo, date, items, totalAmount, customer)
    const printWindow = window.open('', `dtmpos-quote-${Date.now()}`, 'width=960,height=720,left=120,top=80')

    if (printWindow && !printWindow.closed) {
      try {
        printWindow.document.open()
        printWindow.document.write(printableHtml)
        printWindow.document.close()
        return
      } catch (error) {
        try {
          printWindow.close()
        } catch {}
      }
    }

    const iframe = iframeRef.current
    const frameWindow = iframe?.contentWindow
    const frameDocument = frameWindow?.document

    if (!iframe || !frameWindow || !frameDocument) {
      alert('No se pudo abrir la impresion de la cotizacion. Intenta permitir ventanas emergentes.')
      return
    }

    try {
      frameDocument.open()
      frameDocument.write(printableHtml)
      frameDocument.close()
      window.setTimeout(() => {
        try {
          frameWindow.focus()
          frameWindow.print()
        } catch (error) {
          alert('No se pudo imprimir la cotizacion.')
        }
      }, 300)
    } catch (error) {
      alert('No se pudo generar la cotizacion.')
    }
  }

  const handleGenerateQuote = () => {
    if (cart.length === 0) return

    const quoteData: GeneratedQuote = {
      quoteNo: buildQuoteNo(),
      date: formatDateTime(new Date()),
      items: [...cart],
      total,
      customer: selectedCustomer ? customers.find(c => c.id === selectedCustomer) : undefined,
    }

    setLastQuote(quoteData)
    printQuoteHtml(quoteData.quoteNo, quoteData.date, quoteData.items, quoteData.total, quoteData.customer)
  }

  const buildHeldSale = (): HeldSale => {
    const customer = selectedCustomer ? customers.find(c => c.id === selectedCustomer) : undefined
    const now = new Date()
    return {
      id: `${now.getTime()}_${Math.random().toString(36).slice(2, 8)}`,
      name: `Espera ${now.toLocaleTimeString('es-DO', { hour: '2-digit', minute: '2-digit' })}`,
      savedAt: now.toISOString(),
      customerId: selectedCustomer,
      customerName: customer?.name,
      cart: [...cart],
      paymentMethod,
      receivedAmount,
      referenceNumber,
      creditDownPayment,
      creditInstallments: creditInstallments.map(installment => ({ ...installment })),
      creditPlanConfirmed,
      creditContractPayload,
      creditContractCustomer: { ...creditContractCustomer },
      creditContractWarrantyTime,
      creditContractRefs: creditContractRefs.map(r => ({ ...r })),
      total
    }
  }

  const holdCurrentSale = (silent = false) => {
    if (cart.length === 0) {
      if (!silent) alert(`No hay una ${isQuoteMode ? 'cotización' : 'venta'} activa para poner en espera`)
      return false
    }

    const heldSale = buildHeldSale()
    setHeldSales(prev => [heldSale, ...prev])
    resetCurrentSale()

    if (!silent) {
      alert(`${isQuoteMode ? 'Cotización' : 'Venta'} guardada en espera: ${heldSale.name}`)
    }
    return true
  }

  const deleteHeldSale = (heldSaleId: string) => {
    setHeldSales(prev => prev.filter(sale => sale.id !== heldSaleId))
  }

  const resumeHeldSale = (heldSaleId: string) => {
    const heldSale = heldSales.find(sale => sale.id === heldSaleId)
    if (!heldSale) return

    let currentHeldSale: HeldSale | null = null
    if (cart.length > 0) {
      const confirmSwap = window.confirm('Ya tienes una venta activa. Aceptar guardara la actual en espera y retomara la seleccionada.')
      if (!confirmSwap) return
      currentHeldSale = buildHeldSale()
    }

    setHeldSales(prev => {
      const remaining = prev.filter(sale => sale.id !== heldSaleId)
      return currentHeldSale ? [currentHeldSale, ...remaining] : remaining
    })

    setCart(heldSale.cart)
    setSelectedCustomer(heldSale.customerId)
    setPaymentMethod(heldSale.paymentMethod)
    setReceivedAmount(heldSale.receivedAmount)
    setReferenceNumber(heldSale.referenceNumber)
    setCreditDownPayment(String((heldSale as any)?.creditDownPayment ?? '0'))
    setCreditContractCustomer((heldSale as any)?.creditContractCustomer
      ? { ...(heldSale as any).creditContractCustomer }
      : creditContractCustomer)
    setCreditContractWarrantyTime(String((heldSale as any)?.creditContractWarrantyTime ?? ''))
    setCreditContractRefs(Array.isArray((heldSale as any)?.creditContractRefs) ? (heldSale as any).creditContractRefs : creditContractRefs)
    setCreditContractPayload((heldSale as any)?.creditContractPayload ?? null)
    setCreditPlanConfirmed(Boolean((heldSale as any)?.creditPlanConfirmed))
    setCreditInstallments(normalizeStoredCreditInstallments(heldSale.creditInstallments).length
      ? normalizeStoredCreditInstallments(heldSale.creditInstallments)
      : buildCreditInstallmentDrafts(heldSale.total, 1))
    alert(`${isQuoteMode ? 'Cotización' : 'Venta'} retomada: ${heldSale.name}`)
  }

  const generateTicket = async (saleId: number, date: string, items: CartItem[], totalAmount: number, paymentDetails?: any, customer?: Customer, printWindow?: Window | null) => {
    if (String(paymentDetails?.paymentMethod || '').toUpperCase() === 'CREDIT') {
      try {
        const meta = await getCreditContractBySale(saleId)
        if (!meta?.contract?.buyer_signed_at) {
          alert('No se puede imprimir el ticket/plan de cuotas sin contrato firmado')
          return
        }
      } catch {
        alert('No se pudo validar contrato para imprimir el ticket/plan de cuotas')
        return
      }
    }

    // Calcular altura dinámica
    const headerHeight = 58
    const itemHeight = 5
    const footerHeight = 40
    const totalHeight = headerHeight + (items.length * itemHeight) + footerHeight

    const doc = new jsPDF({
      orientation: 'portrait',
      unit: 'mm',
      format: [80, Math.max(200, totalHeight)]
    })

    const logoHeight = await addLogoToPdf(doc, config?.logoUrl, { x: 28, y: 4, maxWidth: 24, maxHeight: 18 })
    const headerTextY = logoHeight > 0 ? 27 : 5

    doc.setFontSize(10)
    doc.text(companyName, 40, headerTextY, { align: 'center' })
    doc.setFontSize(8)
    doc.text(`Fecha: ${date}`, 5, headerTextY + 10)
    doc.text(`Venta #${saleId}`, 5, headerTextY + 15)

    if (customer) {
      doc.text(`Cliente: ${customer.name}`, 5, headerTextY + 20)
    }

    const dividerY = headerTextY + (customer ? 25 : 20)
    doc.line(5, dividerY, 75, dividerY)

    let y = dividerY + 5
    items.forEach(item => {
      const lineTotal = item.price * item.quantity
      doc.text(`${item.name.substring(0, 20)}`, 5, y)
      doc.text(`${formatNumber(item.quantity, 0)} x ${formatNumber(item.price)}`, 50, y, { align: 'right' })
      doc.text(formatNumber(lineTotal), 75, y, { align: 'right' })
      y += 5
    })

    doc.line(5, y, 75, y)
    y += 5
    doc.setFontSize(10)
    doc.text(`TOTAL: ${formatMoney(totalAmount)}`, 75, y, { align: 'right' })

    y += 5
    doc.setFontSize(8)
    if (paymentDetails) {
       if (paymentDetails.paymentMethod === 'CASH') {
          doc.text(`Efectivo: ${formatNumber(Number(paymentDetails.receivedAmount))}`, 5, y)
          y += 4
          doc.text(`Cambio: ${formatNumber(Number(paymentDetails.changeAmount))}`, 5, y)
       } else if (paymentDetails.paymentMethod === 'CARD') {
          doc.text(`Tarjeta Ref: ${paymentDetails.referenceNumber}`, 5, y)
       } else if (paymentDetails.paymentMethod === 'DEPOSIT') {
          doc.text(`Depósito Ref: ${paymentDetails.referenceNumber}`, 5, y)
       } else if (paymentDetails.paymentMethod === 'CREDIT') {
          doc.text(`Venta a Crédito`, 5, y)
       } else if (paymentDetails.paymentMethod === 'PENDING') {
          doc.text(`Pendiente de cobro en caja`, 5, y)
       }
    }

    // Imprimir usando iframe para evitar bloqueo de popups
    const blob = doc.output('blob')
    const blobUrl = URL.createObjectURL(blob)

    if (shouldPrintTicket) {
      printTicketHtml(blobUrl, saleId, date, items, totalAmount, paymentDetails, customer, printWindow)
      return
    }

    downloadTicketPdf(blobUrl, saleId)
  }

  const openCreditContractModal = () => {
    if (!selectedCustomer) {
      setCreditInlineAlert({ kind: 'error', text: 'Selecciona un cliente antes de completar el contrato.' })
      return
    }
    const c = customers.find(x => x.id === selectedCustomer)
    setCreditContractCustomer((prev) => ({
      ...prev,
      phone: String((c as any)?.phone || prev.phone || ''),
      address: String((c as any)?.address || prev.address || ''),
      dpi: String((c as any)?.document || prev.dpi || ''),
      age: String((c as any)?.age ?? prev.age ?? ''),
      nationality: String((c as any)?.nationality || prev.nationality || 'guatemalteco(a)'),
      civilStatus: String((c as any)?.civil_status || prev.civilStatus || ''),
      occupation: String((c as any)?.occupation || prev.occupation || ''),
      municipality: String((c as any)?.municipality || prev.municipality || ''),
      department: String((c as any)?.department || prev.department || ''),
    }))
    setCreditContractSignatureFile(null)
    setCreditContractModalOpen(true)
  }

  const submitCreditContract = async () => {
    if (!creditContractSignatureFile) {
      alert('Firma del comprador requerida')
      return
    }
    if (!selectedCustomer) {
      setCreditInlineAlert({ kind: 'error', text: 'Selecciona un cliente antes de guardar el contrato.' })
      return
    }
    const buyerSignatureData = await fileToDataUrl(creditContractSignatureFile)
    setCreditContractPayload({
      customerId: selectedCustomer,
      customer: {
        phone: creditContractCustomer.phone,
        address: creditContractCustomer.address,
        dpi: creditContractCustomer.dpi,
        age: creditContractCustomer.age,
        nationality: creditContractCustomer.nationality,
        civilStatus: creditContractCustomer.civilStatus,
        occupation: creditContractCustomer.occupation,
        municipality: creditContractCustomer.municipality,
        department: creditContractCustomer.department,
      },
      warrantyTime: creditContractWarrantyTime,
      references: creditContractRefs.map(r => ({ name: r.name, phone: r.phone })),
      buyerSignatureData,
    })
    setCreditInlineAlert({ kind: 'ok', text: 'Contrato firmado listo.' })
    setCreditContractModalOpen(false)
  }

  const handleCheckout = async () => {
    if (cart.length === 0) return
    if (!canOperateCash) {
      alert('Tu usuario no tiene permisos para cobrar. Debes enviar la venta a caja.')
      return
    }

    if (isCashOpen === false) {
      alert('Caja cerrada. Debes abrir caja antes de vender.')
      navigate('/cash-register')
      return
    }

    // Validaciones de pago
    if (paymentMethod === 'CASH') {
       const received = parseFloat(receivedAmount) || 0
       if (received < total) {
         alert(`El monto recibido (${formatNumber(received)}) es menor al total (${formatNumber(total)})`)
         return
       }
    } else if (paymentMethod === 'CARD' || paymentMethod === 'DEPOSIT') {
       if (!referenceNumber.trim()) {
         alert('Por favor ingrese el número de referencia')
         return
       }
    } else if (paymentMethod === 'CREDIT') {
       if (!selectedCustomer) {
         alert('Debes seleccionar un cliente para registrar la venta a crédito')
         return
       }
    }

    let printWindow: Window | null = null
    if (shouldPrintTicket) {
      try {
        printWindow = window.open('', `dtmpos-print-${Date.now()}`, 'width=420,height=640,left=120,top=120')
      } catch (error) {
      }
    }

    setLoading(true)
    try {
      if (isCashOpen === null) {
        try {
          const status = await getCashStatus()
          setIsCashOpen(status.isOpen)
          if (!status.isOpen) {
            alert('Caja cerrada. Debes abrir caja antes de vender.')
            navigate('/cash-register')
            return
          }
        } catch {}
      }

      const isCreditSale = paymentMethod === 'CREDIT'
      const received = parseFloat(receivedAmount) || 0
      const change = received - total
      if (isCreditSale && !creditContractPayload) {
        setCreditInlineAlert({ kind: 'error', text: 'Completa el contrato y la firma antes de continuar.' })
        openCreditContractModal()
        return
      }
      if (isCreditSale && !creditPlanConfirmed) {
        setCreditInlineAlert({ kind: 'error', text: 'Confirma el enganche y las cuotas antes de continuar.' })
        return
      }
      if (isCreditSale && creditDownPaymentAmount >= total - 0.01) {
        setCreditInlineAlert({ kind: 'error', text: 'El enganche debe ser menor al total de la venta.' })
        return
      }
      const creditPlan = isCreditSale ? validateCreditInstallments(creditInstallments, creditBaseTotal) : null

      if (creditPlan && !creditPlan.valid) {
        setCreditInlineAlert({ kind: 'error', text: creditPlan.error })
        return
      }

      const res = await api.post('/sales', {
        customerId: selectedCustomer,
        items: cart.map(item => ({
          productId: item.id,
          quantity: item.quantity,
          price: item.price,
          priceSource: item.priceSource || 'BASE',
          batchNo: item.batchNo,
          expiryDate: item.expiryDate,
          imei: item.imei,
          serial: item.serial
        })),
        total,
        isCredit: isCreditSale,
        paymentMethod,
        receivedAmount: paymentMethod === 'CASH' ? received : 0,
        changeAmount: paymentMethod === 'CASH' ? change : 0,
        referenceNumber: (paymentMethod === 'CARD' || paymentMethod === 'DEPOSIT') ? referenceNumber : null,
        downPaymentAmount: isCreditSale ? creditDownPaymentAmount : undefined,
        creditInstallments: creditPlan?.valid ? creditPlan.installments : undefined,
        creditContract: isCreditSale ? creditContractPayload : undefined,
      })

      if (res.data.success) {
        const saleData: CompletedSale = {
          saleId: res.data.saleId,
          date: formatDateTime(new Date()),
          items: [...cart],
          total: total,
          paymentDetails: {
             paymentMethod,
             receivedAmount: paymentMethod === 'CASH' ? received : 0,
             changeAmount: paymentMethod === 'CASH' ? change : 0,
             referenceNumber: (paymentMethod === 'CARD' || paymentMethod === 'DEPOSIT') ? referenceNumber : null,
             creditInstallments: creditPlan?.valid ? creditPlan.installments : undefined,
          },
          customer: selectedCustomer ? customers.find(c => c.id === selectedCustomer) : undefined
        }

        setLastSale(saleData)
        if (shouldPrintTicket) {
          await generateTicket(
            saleData.saleId,
            saleData.date,
            saleData.items,
            saleData.total,
            saleData.paymentDetails,
            saleData.customer,
            printWindow
          )
        }
        resetCurrentSale()
        void loadData()
        return
      }
    } catch (err) {
      console.error(err)
      const msg = (err as any)?.response?.data?.error
      if (msg) {
        alert(msg)
        if (String(msg).toLowerCase().includes('caja cerrada')) {
          setIsCashOpen(false)
          navigate('/cash-register')
        }
      } else {
        alert('Error al procesar la venta')
      }
      if (printWindow && !printWindow.closed) {
        try {
          printWindow.close()
        } catch {}
      }
    } finally {
      setLoading(false)
    }
  }

  const handleSendToCashRegister = async () => {
    if (cart.length === 0) return

    const selectedCustomerRow = selectedCustomer ? customers.find(c => c.id === selectedCustomer) : undefined
    if (!selectedCustomerRow || !String(selectedCustomerRow.name || '').trim()) {
      alert('Debes seleccionar un cliente real (con nombre) para enviar la venta a caja')
      return
    }

    setLoading(true)
    try {
      const isCreditSale = paymentMethod === 'CREDIT'
      let creditPlan: ReturnType<typeof validateCreditInstallments> | null = null

      if (isCreditSale) {
        if (!creditContractPayload) {
          setCreditInlineAlert({ kind: 'error', text: 'Completa el contrato y la firma antes de enviar a caja.' })
          openCreditContractModal()
          return
        }
        if (!creditPlanConfirmed) {
          setCreditInlineAlert({ kind: 'error', text: 'Confirma el enganche y las cuotas antes de enviar a caja.' })
          return
        }
        if (creditDownPaymentAmount >= total - 0.01) {
          setCreditInlineAlert({ kind: 'error', text: 'El enganche debe ser menor al total de la venta.' })
          return
        }
        creditPlan = validateCreditInstallments(creditInstallments, creditBaseTotal)
        if (!creditPlan.valid) {
          setCreditInlineAlert({ kind: 'error', text: creditPlan.error })
          return
        }
      }

      const res = await api.post('/sales', {
        customerId: selectedCustomer,
        items: cart.map(item => ({
          productId: item.id,
          quantity: item.quantity,
          price: item.price,
          priceSource: item.priceSource || 'BASE',
          batchNo: item.batchNo,
          expiryDate: item.expiryDate,
          imei: item.imei,
          serial: item.serial
        })),
        total,
        sendToCashier: true,
        paymentMethod,
        isCredit: isCreditSale,
        referenceNumber: (paymentMethod === 'CARD' || paymentMethod === 'DEPOSIT') ? referenceNumber : null,
        downPaymentAmount: isCreditSale ? creditDownPaymentAmount : undefined,
        creditInstallments: creditPlan?.valid ? creditPlan.installments : undefined,
        creditContract: isCreditSale ? creditContractPayload : undefined,
      })

      if (res.data.success) {
        const saleData: CompletedSale = {
          saleId: res.data.saleId,
          date: formatDateTime(new Date()),
          items: [...cart],
          total,
          paymentDetails: {
            paymentMethod: 'PENDING',
          },
          customer: selectedCustomerRow
        }

        setLastSale(saleData)
        if (shouldPrintTicket) {
          await generateTicket(
            saleData.saleId,
            saleData.date,
            saleData.items,
            saleData.total,
            saleData.paymentDetails,
            saleData.customer
          )
        }
        resetCurrentSale()
        void loadData()
        alert(`Venta #${saleData.saleId} enviada a caja para cobro.`)
      }
    } catch (err) {
      console.error(err)
      alert((err as any)?.response?.data?.error || 'Error al enviar la venta a caja')
    } finally {
      setLoading(false)
    }
  }

  const loadServerDrafts = async () => {
    setServerDraftsLoading(true)
    try {
      const res = await api.get('/sales/drafts', { params: { limit: 100, onlyMine: 1 } })
      const items = Array.isArray(res.data?.items) ? res.data.items : []
      setServerDrafts(items)
      setServerDraftsLoaded(true)
    } catch (err) {
      console.error(err)
      alert((err as any)?.response?.data?.error || 'Error al cargar borradores')
    } finally {
      setServerDraftsLoading(false)
    }
  }

  useEffect(() => {
    if (!isServerDraftsOpen) return
    void loadServerDrafts()
  }, [isServerDraftsOpen])

  const handleSaveServerDraft = async () => {
    if (cart.length === 0) return
    if (!selectedCustomer) {
      if (paymentMethod === 'CREDIT') setCreditInlineAlert({ kind: 'error', text: 'Selecciona un cliente antes de guardar el borrador de crédito.' })
      else alert('Debes seleccionar un cliente para guardar el borrador')
      return
    }

    setLoading(true)
    try {
      if (paymentMethod === 'CREDIT') {
        if (!creditContractPayload) {
          setCreditInlineAlert({ kind: 'error', text: 'Completa el contrato y la firma antes de guardar el borrador.' })
          openCreditContractModal()
          return
        }
        if (!creditPlanConfirmed) {
          setCreditInlineAlert({ kind: 'error', text: 'Confirma el enganche y las cuotas antes de guardar el borrador.' })
          return
        }
        if (creditDownPaymentAmount >= total - 0.01) {
          setCreditInlineAlert({ kind: 'error', text: 'El enganche debe ser menor al total de la venta.' })
          return
        }
        const creditPlan = validateCreditInstallments(creditInstallments, creditBaseTotal)
        if (!creditPlan.valid) {
          setCreditInlineAlert({ kind: 'error', text: creditPlan.error })
          return
        }
      }

      const payload = {
        customerId: selectedCustomer,
        items: cart.map(item => ({
          productId: item.id,
          quantity: item.quantity,
          price: item.price,
          priceSource: item.priceSource || 'BASE',
          batchNo: item.batchNo,
          expiryDate: item.expiryDate,
          imei: item.imei,
          serial: item.serial
        })),
        total,
        paymentMethod: paymentMethod === 'CREDIT' ? 'CREDIT' : undefined,
        downPaymentAmount: paymentMethod === 'CREDIT' ? creditDownPaymentAmount : undefined,
        creditInstallments: paymentMethod === 'CREDIT'
          ? validateCreditInstallments(creditInstallments, creditBaseTotal).installments
          : undefined,
        creditContract: paymentMethod === 'CREDIT' ? creditContractPayload : undefined,
      }

      const res = currentServerDraftId
        ? await api.put(`/sales/${currentServerDraftId}/draft`, payload)
        : await api.post('/sales', { ...payload, saveAsDraft: true })

      if (res.data?.success) {
        const saleId = Number(res.data.saleId || 0)
        if (saleId) setCurrentServerDraftId(saleId)
        await loadServerDrafts()
        alert(saleId ? `Borrador guardado (#${saleId}).` : 'Borrador guardado.')
      }
    } catch (err) {
      console.error(err)
      alert((err as any)?.response?.data?.error || 'Error al guardar el borrador')
    } finally {
      setLoading(false)
    }
  }

  const handleLoadServerDraft = async (draftId: number) => {
    if (!Number.isFinite(draftId) || draftId <= 0) return
    if (cart.length > 0) {
      const ok = window.confirm('Hay productos en el carrito. ¿Deseas reemplazar el carrito con este borrador?')
      if (!ok) return
    }

    setLoading(true)
    try {
      const res = await api.get(`/sales/${draftId}`)
      const sale = res.data
      const items = Array.isArray(sale?.items) ? sale.items : []
      const nextCart: CartItem[] = items.map((it: any) => {
        const productId = Number(it.product_id || 0)
        const baseProduct = products.find(p => p.id === productId)
        const name = String(it.product_name || baseProduct?.name || '')
        const unitPrice = Number(it.unit_price || it.price || 0)
        const quantity = Number(it.quantity || 0)
        const productType = (baseProduct?.productType || it.product_type || 'GENERAL') as any
        return {
          id: productId,
          name,
          price: unitPrice,
          stock: Number(baseProduct?.stock || 0),
          otherStock: baseProduct?.otherStock,
          imageUrl: baseProduct?.imageUrl,
          categoryId: baseProduct?.categoryId,
          brandId: baseProduct?.brandId,
          sku: String(it.sku || baseProduct?.sku || ''),
          productCode: baseProduct?.productCode,
          productType,
          quantity,
          originalPrice: it.original_unit_price != null ? Number(it.original_unit_price) : undefined,
          priceSource: (it.price_source || 'BASE') as any,
          batchNo: it.batch_no || undefined,
          expiryDate: it.expiry_date ? String(it.expiry_date).slice(0, 10) : undefined,
          imei: it.imei || undefined,
          serial: it.serial || undefined,
        }
      }).filter((x: any) => x.id && x.quantity)

      setCart(nextCart)
      setSelectedCustomer(sale?.customer_id ? Number(sale.customer_id) : null)

      const rawPendingPaymentMethod = String(
        sale?.pending_payment_method
        ?? sale?.pendingPaymentMethod
        ?? sale?.pending_paymentMethod
        ?? sale?.payment_method
        ?? sale?.paymentMethod
        ?? ''
      ).trim().toUpperCase()
      let nextPaymentMethod = rawPendingPaymentMethod || 'CASH'
      if (nextPaymentMethod === 'TRANSFER') nextPaymentMethod = 'DEPOSIT'
      if (!['CASH', 'CARD', 'DEPOSIT', 'CREDIT'].includes(nextPaymentMethod)) nextPaymentMethod = 'CASH'

      const pendingReference = String(
        sale?.installments?.referenceNumber
        ?? sale?.installments?.reference_number
        ?? sale?.pending_reference_number
        ?? sale?.pendingReferenceNumber
        ?? sale?.reference_number
        ?? sale?.referenceNumber
        ?? ''
      ).trim()

      const pendingDownPaymentRaw = sale?.installments?.downPaymentAmount
        ?? sale?.installments?.down_payment_amount
        ?? sale?.pending_down_payment_amount
        ?? sale?.pendingDownPaymentAmount
        ?? sale?.down_payment_amount
        ?? sale?.downPaymentAmount
        ?? 0
      const pendingDownPaymentAmount = Math.max(0, Math.round(Number(pendingDownPaymentRaw || 0) * 100) / 100)
      const nextTotal = nextCart.reduce((sum, item) => sum + (Number(item.price || 0) * Number(item.quantity || 0)), 0)
      const nextCreditBaseTotal = Math.round(Math.max(0, nextTotal - pendingDownPaymentAmount) * 100) / 100

      const normalizedServerInstallments = normalizeStoredCreditInstallments(
        Array.isArray(sale?.installments)
          ? sale.installments
          : (Array.isArray(sale?.installments?.items) ? sale.installments.items : [])
      )

      setPaymentMethod(nextPaymentMethod as any)
      setReceivedAmount('')
      setReferenceNumber(pendingReference)
      setCreditDownPayment(nextPaymentMethod === 'CREDIT' ? String(pendingDownPaymentAmount) : '0')
      setCreditInstallments(
        normalizedServerInstallments.length
          ? normalizedServerInstallments
          : (nextPaymentMethod === 'CREDIT' ? buildCreditInstallmentDrafts(nextCreditBaseTotal, 1) : buildCreditInstallmentDrafts(0, 1))
      )
      setCreditContractPayload(null)
      setCreditContractSignatureFile(null)
      setCurrentServerDraftId(draftId)
      setIsServerDraftsOpen(false)
    } catch (err) {
      console.error(err)
      alert((err as any)?.response?.data?.error || 'Error al cargar el borrador')
    } finally {
      setLoading(false)
    }
  }

  const handleSendServerDraftToCashier = async (draftId: number) => {
    if (!Number.isFinite(draftId) || draftId <= 0) return
    const ok = window.confirm(`¿Enviar el borrador #${draftId} a caja? Esto reservará inventario.`)
    if (!ok) return
    setLoading(true)
    try {
      const res = await api.post(`/sales/${draftId}/send-to-cashier`)
      if (res.data?.success) {
        await loadServerDrafts()
        if (currentServerDraftId === draftId) resetCurrentSale()
        alert(`Venta #${draftId} enviada a caja para cobro.`)
      }
    } catch (err) {
      console.error(err)
      alert((err as any)?.response?.data?.error || 'Error al enviar a caja')
    } finally {
      setLoading(false)
    }
  }

  const handleCancelServerDraft = async (draftId: number) => {
    if (!Number.isFinite(draftId) || draftId <= 0) return
    const reason = String(window.prompt(`Motivo de cancelación para el borrador #${draftId}:`) || '').trim()
    if (!reason) return

    setLoading(true)
    try {
      const res = await api.post(`/sales/${draftId}/cancel`, { reason })
      if (res.data?.success) {
        await loadServerDrafts()
        if (currentServerDraftId === draftId) resetCurrentSale()
        alert(`Borrador #${draftId} cancelado.`)
      }
    } catch (err) {
      console.error(err)
      alert((err as any)?.response?.data?.error || 'Error al cancelar el borrador')
    } finally {
      setLoading(false)
    }
  }

  const handleCreateCustomer = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!newCustomer.name) return alert('El nombre es obligatorio')

    setLoading(true)
    try {
      const res = await api.post('/customers', newCustomer)
      const createdCustomer = res.data

      // Refresh customers list
      const custRes = await api.get('/customers')
      setCustomers(custRes.data)

      // Select the new customer
      setSelectedCustomer(createdCustomer.id)

      // Reset and close modal
      setNewCustomer({ name: '', document: '', phone: '', email: '', address: '' })
      setIsCustomerModalOpen(false)
      alert('Cliente creado y seleccionado')
    } catch (err) {
      console.error('Error creating customer:', err)
      alert('Error al crear cliente')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="pos-container">
      <button
        type="button"
        className="pos-mobile-cart-toggle"
        onClick={() => setIsMobileCartOpen(true)}
      >
        <span>{isQuoteMode ? 'Cotización' : 'Carrito'}</span>
        <strong>{cart.length}</strong>
      </button>

      {isMobileCartOpen && (
        <button
          type="button"
          className="pos-cart-backdrop"
          onClick={() => setIsMobileCartOpen(false)}
          aria-label="Cerrar panel lateral"
        />
      )}

      {/* Left: Products */}
      <div className="pos-left-panel">
        {/* Header: Search & Filter */}
        <div className="pos-filters">
          <div style={{ flexBasis: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <div style={{ fontSize: '1.15rem', fontWeight: 700, color: 'var(--text)' }}>
                {isQuoteMode ? 'Cotizador' : 'Ventas / POS'}
              </div>
              <div style={{ fontSize: '0.9rem', color: 'var(--muted)' }}>
                {isQuoteMode ? 'Prepara cotizaciones sin afectar caja ni inventario.' : 'Registra la venta, envíala a caja o cóbrala al instante si operas una caja abierta.'}
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <div style={{ padding: '8px 12px', borderRadius: 999, border: '1px solid var(--border)', background: 'var(--modal)', color: 'var(--text)', fontWeight: 700 }}>
                {modeChipLabel}
              </div>
              <button
                type="button"
                className="btn-danger"
                onClick={() => {
                  window.close()
                  setTimeout(() => navigate('/'), 200)
                }}
                style={{ padding: '8px 12px' }}
              >
                {backButtonLabel}
              </button>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flex: '1 1 250px' }}>
            <div style={{ position: 'relative', flex: 1 }}>
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{
                  position: 'absolute',
                  left: '12px',
                  top: '50%',
                  transform: 'translateY(-50%)',
                  color: 'var(--muted)'
                }}
              >
                <circle cx="11" cy="11" r="8"></circle>
                <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
              </svg>
              <input
                type="text"
                placeholder="Buscar por nombre, SKU o codigo..."
                value={searchTerm}
                onChange={e => setSearchTerm(e.target.value)}
                style={{
                  width: '100%',
                  padding: '10px 10px 10px 40px',
                  border: '1px solid var(--border)',
                  borderRadius: 8,
                  fontSize: '1rem',
                  outline: 'none',
                  background: 'var(--bg)',
                  color: 'var(--text)',
                  transition: 'border-color 0.2s'
                }}
                onFocus={(e) => e.target.style.borderColor = 'var(--accent)'}
                onBlur={(e) => e.target.style.borderColor = 'var(--border)'}
              />
            </div>
            <MobileBarcodeScannerButton
              buttonLabel="Escanear"
              modalTitle={scannerTitle}
              onDetected={value => {
                void handleScannedProductCode(value)
              }}
            />
          </div>

          <div style={{ position: 'relative', flex: '1 1 150px' }}>
            <select
              value={selectedDepartment || ''}
              onChange={e => {
                setSelectedDepartment(e.target.value ? Number(e.target.value) : null)
                setSelectedCategory(null)
              }}
              style={{
                width: '100%',
                padding: '10px',
                border: '1px solid var(--border)',
                borderRadius: 8,
                fontSize: '1rem',
                outline: 'none',
                cursor: 'pointer',
                backgroundColor: 'var(--bg)',
                color: 'var(--text)',
                appearance: 'none',
                backgroundImage: `url("data:image/svg+xml;charset=US-ASCII,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%22292.4%22%20height%3D%22292.4%22%3E%3Cpath%20fill%3D%22%239ca3af%22%20d%3D%22M287%2069.4a17.6%2017.6%200%200%200-13-5.4H18.4c-5%200-9.3%201.8-12.9%205.4A17.6%2017.6%200%200%200%200%2082.2c0%205%201.8%209.3%205.4%2012.9l128%20127.9c3.6%203.6%207.8%205.4%2012.8%205.4s9.2-1.8%2012.8-5.4L287%2095c3.5-3.5%205.4-7.8%205.4-12.8%200-5-1.9-9.2-5.5-12.8z%22%2F%3E%3C%2Fsvg%3E")`,
                backgroundRepeat: 'no-repeat',
                backgroundPosition: 'right 12px center',
                backgroundSize: '12px'
              }}
            >
              <option value="">Deptos</option>
              {departments.map(d => (
                <option key={d.id} value={d.id}>{d.name}</option>
              ))}
            </select>
          </div>

          <div style={{ position: 'relative', flex: '1 1 150px' }}>
            <select
              value={selectedCategory || ''}
              onChange={e => setSelectedCategory(e.target.value ? Number(e.target.value) : null)}
              style={{
                width: '100%',
                padding: '10px',
                border: '1px solid var(--border)',
                borderRadius: 8,
                fontSize: '1rem',
                outline: 'none',
                cursor: 'pointer',
                backgroundColor: 'var(--bg)',
                color: 'var(--text)',
                appearance: 'none',
                backgroundImage: `url("data:image/svg+xml;charset=US-ASCII,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%22292.4%22%20height%3D%22292.4%22%3E%3Cpath%20fill%3D%22%239ca3af%22%20d%3D%22M287%2069.4a17.6%2017.6%200%200%200-13-5.4H18.4c-5%200-9.3%201.8-12.9%205.4A17.6%2017.6%200%200%200%200%2082.2c0%205%201.8%209.3%205.4%2012.9l128%20127.9c3.6%203.6%207.8%205.4%2012.8%205.4s9.2-1.8%2012.8-5.4L287%2095c3.5-3.5%205.4-7.8%205.4-12.8%200-5-1.9-9.2-5.5-12.8z%22%2F%3E%3C%2Fsvg%3E")`,
                backgroundRepeat: 'no-repeat',
                backgroundPosition: 'right 12px center',
                backgroundSize: '12px'
              }}
            >
              <option value="">Categorías</option>
              {categories
                .filter(c => !selectedDepartment || c.departmentId === selectedDepartment)
                .map(c => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>

          <div style={{ position: 'relative', flex: '1 1 150px' }}>
            <select
              value={selectedBrand || ''}
              onChange={e => setSelectedBrand(e.target.value ? Number(e.target.value) : null)}
              style={{
                width: '100%',
                padding: '10px',
                border: '1px solid var(--border)',
                borderRadius: 8,
                fontSize: '1rem',
                outline: 'none',
                cursor: 'pointer',
                backgroundColor: 'var(--bg)',
                color: 'var(--text)',
                appearance: 'none',
                backgroundImage: `url("data:image/svg+xml;charset=US-ASCII,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%22292.4%22%20height%3D%22292.4%22%3E%3Cpath%20fill%3D%22%239ca3af%22%20d%3D%22M287%2069.4a17.6%2017.6%200%200%200-13-5.4H18.4c-5%200-9.3%201.8-12.9%205.4A17.6%2017.6%200%200%200%200%2082.2c0%205%201.8%209.3%205.4%2012.9l128%20127.9c3.6%203.6%207.8%205.4%2012.8%205.4s9.2-1.8%2012.8-5.4L287%2095c3.5-3.5%205.4-7.8%205.4-12.8%200-5-1.9-9.2-5.5-12.8z%22%2F%3E%3C%2Fsvg%3E")`,
                backgroundRepeat: 'no-repeat',
                backgroundPosition: 'right 12px center',
                backgroundSize: '12px'
              }}
            >
              <option value="">Marcas</option>
              {brands.map(b => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </select>
          </div>

          <button
            onClick={clearFilters}
            className="icon-btn danger"
            style={{
              width: 42,
              height: 42,
              borderRadius: 8
            }}
            title="Borrar filtros"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
               <line x1="18" y1="6" x2="6" y2="18"></line>
               <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </div>

        <div className="pos-products-scroll">
          {/* Grid */}
          <div className="pos-grid">
            {products.map(p => (
              <div
                key={p.id}
                onClick={() => addToCart(p)}
                style={{
                  border: '1px solid var(--border)',
                  borderRadius: 16,
                  padding: 16,
                  cursor: 'pointer',
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'space-between',
                  backgroundColor: 'var(--modal)',
                  transition: 'transform 0.1s',
                  height: '100%',
                  boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.05)'
                }}
                className="product-card"
              >
                <div style={{ position: 'relative', width: '100%', height: 140, marginBottom: 12, borderRadius: 12, background: 'var(--bg)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  {p.imageUrl ? (
                    <>
                      {!loadedImages[p.id] && (
                        <div
                          style={{
                            position: 'absolute',
                            inset: 0,
                            borderRadius: 12,
                            background: 'linear-gradient(90deg, var(--bg) 0%, var(--surface) 50%, var(--bg) 100%)'
                          }}
                          aria-hidden="true"
                        />
                      )}
                      <img
                        src={p.imageUrl}
                        alt={p.name}
                        loading="lazy"
                        onLoad={() => setLoadedImages(prev => ({ ...prev, [p.id]: true }))}
                        style={{
                          width: '100%',
                          height: '100%',
                          objectFit: 'contain',
                          borderRadius: 12,
                          opacity: loadedImages[p.id] ? 1 : 0,
                          transition: 'opacity 200ms'
                        }}
                      />
                    </>
                  ) : (
                    <div style={{ color: 'var(--muted)' }}>Sin Imagen</div>
                  )}
                </div>
                <div>
                  <div
                    style={{
                      fontWeight: 600,
                      fontSize: '1rem',
                      marginBottom: 4,
                      color: 'var(--text)',
                      lineHeight: 1.3,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap'
                    }}
                    title={p.name}
                  >
                    {p.name}
                  </div>
                  <div style={{ color: 'var(--muted)', fontSize: '0.9rem', display: 'flex', flexDirection: 'column', gap: 2 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span>{isQuoteMode ? `Stock actual (${user?.warehouseName || 'Tienda'}): ${p.stock}` : `Stock (${user?.warehouseName || 'Tienda'}): ${p.stock}`}</span>
                       <button
                          onClick={(e) => handleViewStock(e, p)}
                          style={{ border: 'none', background: 'none', cursor: 'pointer', padding: 0, color: 'var(--accent)', display: 'flex', alignItems: 'center' }}
                          title="Ver detalle"
                       >
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M3 21h18"/>
                            <path d="M5 21V7l8-4 8 4v14"/>
                            <path d="M13 21V11"/>
                          </svg>
                       </button>
                    </div>
                    <div>Otras tiendas: {Number(p.otherStock ?? 0)}</div>
                  </div>
                  <div style={{ color: 'var(--accent)', fontWeight: 700, fontSize: '1.1rem', marginTop: 8 }}>{formatMoney(p.price)}</div>
                </div>
              </div>
            ))}
          </div>
          {products.length === 0 && !loading && (
            <div style={{ padding: 24, textAlign: 'center', color: 'var(--muted)' }}>
              No se encontraron productos para los filtros actuales.
            </div>
          )}
          {totalProducts > productsPerPage && (
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16, flexWrap: 'wrap', marginTop: 20, padding: '14px 16px', borderRadius: 12, border: '1px solid var(--border)', background: 'var(--modal)' }}>
              <div style={{ color: 'var(--muted)', fontSize: 13 }}>
                Mostrando {products.length} de {totalProducts} productos. Pagina {currentPage} de {totalPages}
              </div>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', justifyContent: 'flex-end' }}>
                <button
                  className="icon-btn"
                  disabled={currentPage === 1 || loading}
                  onClick={() => setCurrentPage(1)}
                  style={{ minWidth: 88, padding: '10px 14px', borderRadius: 10, opacity: currentPage === 1 || loading ? 0.5 : 1 }}
                >
                  Primera
                </button>
                <button
                  className="icon-btn"
                  disabled={currentPage === 1 || loading}
                  onClick={() => setCurrentPage(prev => Math.max(1, prev - 1))}
                  style={{ minWidth: 88, padding: '10px 14px', borderRadius: 10, opacity: currentPage === 1 || loading ? 0.5 : 1 }}
                >
                  Anterior
                </button>
                <div style={{ minWidth: 110, padding: '10px 14px', borderRadius: 10, background: 'var(--bg)', border: '1px solid var(--border)', textAlign: 'center', fontWeight: 600, color: 'var(--text)' }}>
                  {currentPage} / {totalPages}
                </div>
                <button
                  className="icon-btn"
                  disabled={currentPage >= totalPages || loading}
                  onClick={() => setCurrentPage(prev => Math.min(totalPages, prev + 1))}
                  style={{ minWidth: 88, padding: '10px 14px', borderRadius: 10, opacity: currentPage >= totalPages || loading ? 0.5 : 1 }}
                >
                  Siguiente
                </button>
                <button
                  className="icon-btn"
                  disabled={currentPage >= totalPages || loading}
                  onClick={() => setCurrentPage(totalPages)}
                  style={{ minWidth: 88, padding: '10px 14px', borderRadius: 10, opacity: currentPage >= totalPages || loading ? 0.5 : 1 }}
                >
                  Ultima
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Right: Cart */}
      <div className={`pos-cart ${isMobileCartOpen ? 'open' : ''}`}>
        {isPhoneViewport && renderPhoneHeldSalesAccordion()}
        {showPhoneCheckoutContext && (
          <>
            <div style={{ padding: 16, borderBottom: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <span style={{ fontWeight: 600, fontSize: '1.2rem', color: 'var(--text)' }}>{currentOrderLabel}</span>
                  {currentServerDraftId && (
                    <span style={{ fontSize: 12, fontWeight: 800, color: '#2563eb', background: 'rgba(37, 99, 235, 0.12)', border: '1px solid rgba(37, 99, 235, 0.24)', padding: '6px 10px', borderRadius: 999 }}>
                      Borrador #{currentServerDraftId}
                    </span>
                  )}
                  <button
                    onClick={() => holdCurrentSale()}
                    disabled={cart.length === 0}
                    style={{
                      color: cart.length === 0 ? 'var(--muted)' : '#f59e0b',
                      background: cart.length === 0 ? 'var(--surface)' : 'rgba(245, 158, 11, 0.12)',
                      border: cart.length === 0 ? '1px solid rgba(148, 163, 184, 0.25)' : '1px solid rgba(245, 158, 11, 0.22)',
                      cursor: cart.length === 0 ? 'not-allowed' : 'pointer',
                      fontWeight: 800,
                      borderRadius: 10,
                      padding: '6px 10px'
                    }}
                  >
                    En espera
                  </button>
                  <button
                    onClick={handleSaveServerDraft}
                    disabled={cart.length === 0 || loading}
                    style={{
                      color: cart.length === 0 || loading ? 'var(--muted)' : '#2563eb',
                      background: cart.length === 0 || loading ? 'var(--surface)' : 'rgba(37, 99, 235, 0.12)',
                      border: cart.length === 0 || loading ? '1px solid rgba(148, 163, 184, 0.25)' : '1px solid rgba(37, 99, 235, 0.2)',
                      cursor: cart.length === 0 || loading ? 'not-allowed' : 'pointer',
                      fontWeight: 800,
                      borderRadius: 10,
                      padding: '6px 10px'
                    }}
                  >
                    Borrador
                  </button>
                  <button
                    onClick={() => setIsServerDraftsOpen(true)}
                    style={{
                      color: 'var(--text)',
                      background: 'var(--surface)',
                      border: '1px solid rgba(148, 163, 184, 0.25)',
                      cursor: 'pointer',
                      fontWeight: 800,
                      borderRadius: 10,
                      padding: '6px 10px'
                    }}
                  >
                    Borradores
                  </button>
                  <button
                    onClick={resetCurrentSale}
                    style={{
                      color: '#ef4444',
                      background: 'rgba(239, 68, 68, 0.1)',
                      border: '1px solid rgba(239, 68, 68, 0.2)',
                      cursor: 'pointer',
                      fontWeight: 800,
                      borderRadius: 10,
                      padding: '6px 10px'
                    }}
                  >
                    Vaciar
                  </button>
                  <button
                    type="button"
                    className="pos-mobile-cart-close"
                    onClick={() => setIsMobileCartOpen(false)}
                  >
                    Cerrar
                  </button>
                </div>
              </div>
            </div>

            {/* Customer Selection */}
            <div style={{ padding: '8px 16px', borderBottom: '1px solid var(--border)', backgroundColor: 'var(--bg)', display: 'flex', gap: 8 }}>
              <select
                style={{
                  flex: 1,
                  padding: 8,
                  borderRadius: 6,
                  border: '1px solid var(--border)',
                  background: 'var(--modal)',
                  color: 'var(--text)'
                }}
                value={selectedCustomer || ''}
                onChange={e => setSelectedCustomer(e.target.value ? Number(e.target.value) : null)}
              >
                <option value="">Seleccionar Cliente (General)</option>
                {customers.map(c => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
              <button
                onClick={() => setIsCustomerModalOpen(true)}
                className="icon-btn primary"
                style={{
                  width: 38,
                  height: 38,
                  borderRadius: 6
                }}
                title="Agregar Cliente"
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="12" y1="5" x2="12" y2="19"></line>
                  <line x1="5" y1="12" x2="19" y2="12"></line>
                </svg>
              </button>
            </div>

          </>
        )}

        {showCartItemsPanel && (
          <div className="pos-cart-items" style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 16 }}>
            {cart.length === 0 ? (
              <>
                {showPhoneProductsOnly && (
                  <div
                    className="pos-cart-list-header"
                    style={{ marginBottom: 16 }}
                  >
                    <div>
                      <div className="pos-cart-list-title">{currentOrderLabel}</div>
                      <div className="pos-cart-list-subtitle">Aun no hay productos agregados</div>
                    </div>
                  </div>
                )}
                <div style={{ textAlign: 'center', color: 'var(--muted)', marginTop: showPhoneProductsOnly ? 0 : 32 }}>
                  Carrito vacío
                </div>
              </>
            ) : (
              <>
                <div className="pos-cart-list-header pos-cart-list-header-mobile-only">
                  <div>
                    <div className="pos-cart-list-title">Productos agregados</div>
                    <div className="pos-cart-list-subtitle">
                      {cart.length} producto(s) | {totalUnits} unidad(es)
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                    <div className="pos-cart-list-total">{formatMoney(total)}</div>
                  </div>
                </div>

                <div className="pos-cart-list">
                  {cart.map(item => (
                    <div key={`${item.id}-${item.batchNo || ''}-${item.imei || ''}-${item.serial || ''}`} className="pos-cart-item-card">
                    <div className="pos-cart-item-head">
                      <div className="pos-cart-item-title-wrap">
                        <div className="pos-cart-item-name">{item.name}</div>
                        <div className="pos-cart-item-line">
                          <span>{config?.currency}</span>
                          {(item.price2 || item.price3) && canChangePosPrice ? (
                              <select
                                  value={item.priceSource === 'MANUAL' ? (item.originalPrice ?? item.price) : item.price}
                                  onChange={(e) => {
                                    const nextPrice = Number(e.target.value)
                                    let nextSource: CartItem['priceSource'] = 'BASE'
                                    if (item.price2 && Math.abs(nextPrice - Number(item.price2)) <= 0.0001) nextSource = 'PRICE2'
                                    else if (item.price3 && Math.abs(nextPrice - Number(item.price3)) <= 0.0001) nextSource = 'PRICE3'
                                    updatePrice(item.id, nextPrice, item.batchNo, item.imei, item.serial, nextSource)
                                  }}
                                  style={{
                                      background: 'var(--bg)',
                                      border: '1px solid var(--border)',
                                      borderRadius: 8,
                                      color: 'var(--text)',
                                      fontSize: '0.85rem',
                                      padding: '3px 8px',
                                      cursor: 'pointer',
                                      maxWidth: 110
                                  }}
                              >
                                  <option value={item.originalPrice ?? item.price}>{formatNumber(Number(item.originalPrice ?? item.price))}</option>
                                  {item.price2 && <option value={item.price2}>{formatNumber(Number(item.price2))} (P2)</option>}
                                  {item.price3 && <option value={item.price3}>{formatNumber(Number(item.price3))} (P3)</option>}
                              </select>
                          ) : (
                              <span>{formatNumber(item.price)}</span>
                          )}
                          <span>x {item.quantity}</span>
                        </div>
                      </div>
                      <div className="pos-cart-item-total">{formatMoney(item.price * item.quantity)}</div>
                    </div>

                    {canUseManualPosPrice && (
                      <div className="pos-cart-item-manual">
                        <span style={{ fontSize: '0.75rem', color: 'var(--muted)' }}>Precio manual:</span>
                        <input
                          type="number"
                          min="0.01"
                          step="0.01"
                          defaultValue={item.priceSource === 'MANUAL' ? item.price.toFixed(2) : ''}
                          placeholder="0.00"
                          onBlur={(e) => handleManualPriceChange(item.id, e.target.value, item.batchNo, item.imei, item.serial)}
                          style={{
                            width: 96,
                            padding: '4px 8px',
                            fontSize: '0.8rem'
                          }}
                        />
                        {item.priceSource === 'MANUAL' && (
                          <span className="pos-cart-chip pos-cart-chip-warning">
                            Manual
                          </span>
                        )}
                      </div>
                    )}

                    {isQuoteMode && canViewProjectedProfit && (
                      <div className="pos-cart-item-profit">
                        <span>Costo: {formatMoney(Number(item.cost || 0) * item.quantity)}</span>
                        <span>Utilidad: {formatMoney((item.price * item.quantity) - (Number(item.cost || 0) * item.quantity))}</span>
                        <span>Margen: {formatPercent((item.price * item.quantity) > 0 ? ((((item.price * item.quantity) - (Number(item.cost || 0) * item.quantity)) / (item.price * item.quantity)) * 100) : 0)}</span>
                      </div>
                    )}

                    {(item.batchNo || item.imei || item.serial) && (
                      <div className="pos-cart-chips">
                        {item.batchNo && (
                          <span className="pos-cart-chip pos-cart-chip-batch">
                            Lote: {item.batchNo} {item.expiryDate ? `(Vence: ${item.expiryDate})` : ''}
                          </span>
                        )}
                        {item.imei && (
                          <span className="pos-cart-chip pos-cart-chip-imei">
                            IMEI: {item.imei}
                          </span>
                        )}
                        {item.serial && (
                          <span className="pos-cart-chip pos-cart-chip-serial">
                            Serial: {item.serial}
                          </span>
                        )}
                      </div>
                    )}

                    <div className="pos-cart-item-actions">
                      <div className="pos-cart-qty-group">
                        <button
                          onClick={() => updateQuantity(item.id, -1, item.batchNo, item.imei, item.serial)}
                          style={{
                            width: 32,
                            height: 32,
                            borderRadius: '50%',
                            border: '1px solid var(--border)',
                            background: 'var(--surface)',
                            cursor: 'pointer',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            color: 'var(--text)'
                          }}
                        >
                          <svg width="12" height="2" viewBox="0 0 12 2" fill="none" xmlns="http://www.w3.org/2000/svg">
                            <path d="M0 1H12" stroke="currentColor" strokeWidth="2"/>
                          </svg>
                        </button>
                        <input
                          type="number"
                          min="1"
                          max={isQuoteMode ? undefined : (item.maxQuantity || item.stock)}
                          value={item.quantity}
                          onChange={(e) => handleQuantityChange(item.id, e.target.value, item.batchNo, item.imei, item.serial)}
                          className="pos-cart-qty-input"
                          style={{
                            width: 56,
                            height: 32,
                            textAlign: 'center',
                            border: 'none',
                            background: 'transparent',
                            fontWeight: 'bold',
                            fontSize: '1rem',
                            padding: 0,
                            margin: 0,
                            color: 'var(--text)'
                          }}
                        />
                        <button
                          onClick={() => updateQuantity(item.id, 1, item.batchNo, item.imei, item.serial)}
                          style={{
                            width: 32,
                            height: 32,
                            borderRadius: '50%',
                            border: '1px solid var(--border)',
                            background: 'var(--surface)',
                            cursor: 'pointer',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            color: 'var(--text)'
                          }}
                        >
                          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg">
                            <path d="M6 0V12M0 6H12" stroke="currentColor" strokeWidth="2"/>
                          </svg>
                        </button>
                      </div>
                      <button
                        onClick={() => removeFromCart(item.id, item.batchNo, item.imei, item.serial)}
                        className="icon-btn danger"
                        style={{
                          minWidth: 112,
                          height: 36,
                          borderRadius: 10,
                          marginLeft: 0
                        }}
                      >
                        Quitar
                      </button>
                    </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        )}

        <div className={`pos-cart-summary${shouldCollapsePhonePayment && !isPhonePaymentPanelOpen ? ' phone-collapsed' : ''}`} style={{ padding: 16, borderTop: '1px solid var(--border)', backgroundColor: 'var(--bg)' }}>
          {showPhoneCheckoutContext && (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '1.2rem', fontWeight: 'bold', marginBottom: !isQuoteMode ? 8 : 16, color: 'var(--text)' }}>
                <span>Total:</span>
                <span>{formatMoney(total)}</span>
              </div>
              {!isQuoteMode && (
                <div className="pos-cart-summary-meta">
                  {cart.length} producto(s) | {totalUnits} unidad(es)
                </div>
              )}
            </>
          )}

          {shouldCollapsePhonePayment && (
            <div className="pos-phone-payment-toggle">
              {!isPhonePaymentPanelOpen ? (
                <>
                  <button
                    type="button"
                    onClick={() => setIsPhonePaymentPanelOpen(true)}
                    disabled={cart.length === 0 || loading}
                    className="primary-btn"
                    style={{ width: '100%' }}
                  >
                    {isQuoteMode ? 'Confirmar cotización' : (canOperateCash ? 'Confirmar pago' : 'Confirmar venta')}
                  </button>
                  <button
                    type="button"
                    onClick={() => setIsMobileCartOpen(false)}
                    className="secondary-btn"
                    style={{ width: '100%', marginTop: 8 }}
                  >
                    Cerrar
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => setIsPhonePaymentPanelOpen(false)}
                  className="secondary-btn"
                  style={{ width: '100%' }}
                >
                  Volver a productos
                </button>
              )}
            </div>
          )}

          {isQuoteMode && showExpandedPaymentPanel && (
            <div style={{ marginBottom: 16, padding: 12, borderRadius: 10, border: '1px solid var(--border)', background: 'var(--modal)' }}>
              <div style={{ fontWeight: 700, marginBottom: 6, color: 'var(--text)' }}>Cotización</div>
              <div style={{ fontSize: '0.9rem', color: 'var(--muted)' }}>
                La cotización usa los precios actuales del carrito, incluidos precios manuales, y no afecta inventario ni caja.
              </div>
              {canViewProjectedProfit && (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 10, marginTop: 12 }}>
                  <div style={{ padding: 10, borderRadius: 8, background: 'var(--bg)', border: '1px solid var(--border)' }}>
                    <div style={{ fontSize: '0.8rem', color: 'var(--muted)' }}>Costo proyectado</div>
                    <div style={{ fontWeight: 700, color: 'var(--text)', marginTop: 4 }}>{formatMoney(projectedCostTotal)}</div>
                  </div>
                  <div style={{ padding: 10, borderRadius: 8, background: 'var(--bg)', border: '1px solid var(--border)' }}>
                    <div style={{ fontSize: '0.8rem', color: 'var(--muted)' }}>Utilidad proyectada</div>
                    <div style={{ fontWeight: 700, color: projectedProfitTotal >= 0 ? '#22c55e' : '#ef4444', marginTop: 4 }}>{formatMoney(projectedProfitTotal)}</div>
                  </div>
                  <div style={{ padding: 10, borderRadius: 8, background: 'var(--bg)', border: '1px solid var(--border)' }}>
                    <div style={{ fontSize: '0.8rem', color: 'var(--muted)' }}>Margen proyectado</div>
                    <div style={{ fontWeight: 700, color: 'var(--text)', marginTop: 4 }}>{formatPercent(projectedMargin)}</div>
                  </div>
                </div>
              )}
            </div>
          )}

          {!isQuoteMode && showExpandedPaymentPanel && (
            <div style={{ marginBottom: 16 }}>
              <div style={{ marginBottom: 14, padding: 12, borderRadius: 10, border: '1px solid rgba(59, 130, 246, 0.25)', background: 'rgba(59, 130, 246, 0.08)', color: 'var(--text)' }}>
                <div style={{ fontWeight: 700, marginBottom: 4 }}>Flujo vendedor + caja</div>
                <div style={{ fontSize: '0.9rem', color: 'var(--muted)' }}>
                  {canOperateCash
                    ? 'Puedes enviar esta venta a caja para que el cajero la cobre después. Si esta caja está abierta para tu usuario, también puedes cobrarla aquí mismo.'
                    : 'Tu usuario puede preparar la venta y enviarla a caja para que el cajero la cobre. El cobro directo no está habilitado para este rol.'}
                </div>
              </div>
              <>
              <label style={{ display: 'block', marginBottom: 8, fontWeight: 'bold', color: 'var(--muted)' }}>Tipo de venta:</label>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <button
                onClick={() => setPaymentMethod('CASH')}
                style={{
                  padding: 8,
                  border: `1px solid ${paymentMethod === 'CASH' ? '#2ecc71' : 'var(--border)'}`,
                  backgroundColor: paymentMethod === 'CASH' ? 'rgba(46, 204, 113, 0.1)' : 'var(--modal)',
                  color: paymentMethod === 'CASH' ? '#2ecc71' : 'var(--muted)',
                  borderRadius: 6,
                  cursor: 'pointer',
                  fontWeight: paymentMethod === 'CASH' ? 'bold' : 'normal'
                }}
              >
                💵 Efectivo
              </button>
              <button
                onClick={() => setPaymentMethod('CARD')}
                style={{
                  padding: 8,
                  border: `1px solid ${paymentMethod === 'CARD' ? '#3498db' : 'var(--border)'}`,
                  backgroundColor: paymentMethod === 'CARD' ? 'rgba(52, 152, 219, 0.1)' : 'var(--modal)',
                  color: paymentMethod === 'CARD' ? '#3498db' : 'var(--muted)',
                  borderRadius: 6,
                  cursor: 'pointer',
                  fontWeight: paymentMethod === 'CARD' ? 'bold' : 'normal'
                }}
              >
                💳 Tarjeta
              </button>
              <button
                onClick={() => setPaymentMethod('DEPOSIT')}
                style={{
                  padding: 8,
                  border: `1px solid ${paymentMethod === 'DEPOSIT' ? '#9b59b6' : 'var(--border)'}`,
                  backgroundColor: paymentMethod === 'DEPOSIT' ? 'rgba(155, 89, 182, 0.1)' : 'var(--modal)',
                  color: paymentMethod === 'DEPOSIT' ? '#9b59b6' : 'var(--muted)',
                  borderRadius: 6,
                  cursor: 'pointer',
                  fontWeight: paymentMethod === 'DEPOSIT' ? 'bold' : 'normal'
                }}
              >
                🏦 Depósito
              </button>
              <button
                onClick={() => {
                  setPaymentMethod('CREDIT')
                  setCreditInlineAlert(null)
                  if (!selectedCustomer) {
                    setCreditInlineAlert({ kind: 'error', text: 'Selecciona un cliente antes de ingresar a crédito.' })
                    return
                  }
                  if (!creditContractPayload) {
                    openCreditContractModal()
                    return
                  }
                  regenerateCreditInstallments(creditInstallments.length || 1)
                }}
                style={{
                  padding: 8,
                  border: `1px solid ${paymentMethod === 'CREDIT' ? '#e67e22' : 'var(--border)'}`,
                  backgroundColor: paymentMethod === 'CREDIT' ? 'rgba(230, 126, 34, 0.1)' : 'var(--modal)',
                  color: paymentMethod === 'CREDIT' ? '#e67e22' : 'var(--muted)',
                  borderRadius: 6,
                  cursor: 'pointer',
                  fontWeight: paymentMethod === 'CREDIT' ? 'bold' : 'normal'
                }}
              >
                📝 Crédito
              </button>
            </div>

            <div style={{ marginTop: 16 }}>
              {canOperateCash && paymentMethod === 'CASH' && (
                <div>
                  <label style={{ display: 'block', marginBottom: 8, fontWeight: 'bold', color: 'var(--muted)' }}>Cantidad Recibida:</label>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={receivedAmount}
                    onChange={e => setReceivedAmount(e.target.value)}
                    style={{
                      width: '100%',
                      padding: 12,
                      fontSize: '1.2rem',
                      border: '1px solid var(--border)',
                      borderRadius: 6,
                      background: 'var(--modal)',
                      color: 'var(--text)'
                    }}
                    placeholder="0.00"
                  />
                  <div style={{ marginTop: 8, fontSize: '1.1rem', fontWeight: 'bold', color: (parseFloat(receivedAmount) || 0) >= total ? '#2ecc71' : '#ef4444' }}>
                    Cambio: {formatMoney(Math.max(0, (parseFloat(receivedAmount) || 0) - total))}
                  </div>
                </div>
              )}

              {canOperateCash && (paymentMethod === 'CARD' || paymentMethod === 'DEPOSIT') && (
                <div>
                  <label style={{ display: 'block', marginBottom: 8, fontWeight: 'bold', color: 'var(--muted)' }}>Número de Referencia:</label>
                  <input
                    type="text"
                    value={referenceNumber}
                    onChange={e => setReferenceNumber(e.target.value)}
                    style={{
                      width: '100%',
                      padding: 12,
                      fontSize: '1rem',
                      border: '1px solid var(--border)',
                      borderRadius: 6,
                      background: 'var(--modal)',
                      color: 'var(--text)'
                    }}
                    placeholder="Ingrese número de referencia / operación"
                  />
                </div>
              )}

              {!canOperateCash && (paymentMethod === 'CASH' || paymentMethod === 'CARD' || paymentMethod === 'DEPOSIT') && (
                <div style={{ padding: 12, borderRadius: 10, border: '1px solid rgba(148, 163, 184, 0.25)', background: 'var(--surface)', color: 'var(--muted)', fontWeight: 700 }}>
                  El cobro lo realiza Caja. La referencia/comprobante se captura al cobrar.
                </div>
              )}

              {paymentMethod === 'CREDIT' && (
                <div style={{ display: 'grid', gap: 12 }}>
                  {creditInlineAlert && (
                    <div
                      style={{
                        padding: '10px 12px',
                        borderRadius: 10,
                        border: creditInlineAlert.kind === 'error'
                          ? '1px solid rgba(239, 68, 68, 0.25)'
                          : (creditInlineAlert.kind === 'warn'
                            ? '1px solid rgba(245, 158, 11, 0.25)'
                            : '1px solid rgba(22, 163, 74, 0.25)'),
                        background: creditInlineAlert.kind === 'error'
                          ? 'rgba(239, 68, 68, 0.08)'
                          : (creditInlineAlert.kind === 'warn'
                            ? 'rgba(245, 158, 11, 0.08)'
                            : 'rgba(22, 163, 74, 0.08)'),
                        color: creditInlineAlert.kind === 'error'
                          ? '#ef4444'
                          : (creditInlineAlert.kind === 'warn' ? '#f59e0b' : '#16a34a'),
                        fontWeight: 800
                      }}
                    >
                      {creditInlineAlert.text}
                    </div>
                  )}
                  <div style={{ padding: 12, borderRadius: 10, background: 'rgba(245, 158, 11, 0.12)', border: '1px solid rgba(245, 158, 11, 0.28)' }}>
                    <div style={{ fontWeight: 700, marginBottom: 4, color: '#b45309' }}>Venta a crédito por cuotas</div>
                    <div style={{ fontSize: '0.9rem', color: 'var(--text)' }}>
                      Define el plan de abonos con monto y fecha de vencimiento para cada cuota.
                    </div>
                    {!selectedCustomer && (
                      <div style={{ marginTop: 8, fontSize: '0.9rem', color: '#dc2626', fontWeight: 600 }}>
                        Selecciona un cliente antes de confirmar la venta a crédito.
                      </div>
                    )}
                  </div>

                  <div style={{ padding: 12, borderRadius: 10, border: '1px solid var(--border)', background: 'var(--modal)', display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                    <div style={{ display: 'grid', gap: 4 }}>
                      <div style={{ fontWeight: 800, color: 'var(--text)' }}>Contrato</div>
                      <div style={{ fontSize: '0.85rem', color: creditContractPayload ? '#16a34a' : '#dc2626', fontWeight: 700 }}>
                        {creditContractPayload ? 'Contrato firmado listo' : 'Obligatorio antes de confirmar'}
                      </div>
                    </div>
                    <button type="button" onClick={openCreditContractModal} className="btn-secondary" disabled={!selectedCustomer}>
                      {creditContractPayload ? 'Editar' : 'Completar'}
                    </button>
                  </div>

                  <div style={{ display: 'grid', gap: 10 }}>
                    <div>
                      <label style={{ display: 'block', marginBottom: 6, fontWeight: 'bold', color: 'var(--muted)' }}>Enganche</label>
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        value={creditDownPayment}
                        onChange={e => setCreditDownPayment(e.target.value)}
                        style={{
                          width: '100%',
                          padding: 10,
                          border: '1px solid var(--border)',
                          borderRadius: 6,
                          background: 'var(--modal)',
                          color: 'var(--text)'
                        }}
                      />
                      <div style={{ marginTop: 6, fontSize: 12, color: 'var(--muted)' }}>
                        Saldo a crédito: <strong style={{ color: 'var(--text)' }}>{formatMoney(creditBaseTotal)}</strong>
                      </div>
                    </div>
                  </div>

                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'end' }}>
                    <div style={{ flex: '1 1 120px' }}>
                      <label style={{ display: 'block', marginBottom: 6, fontWeight: 'bold', color: 'var(--muted)' }}>Cantidad de cuotas</label>
                      <input
                        type="number"
                        min="1"
                        max="36"
                        value={creditInstallments.length}
                        onChange={e => regenerateCreditInstallments(Number(e.target.value || 1))}
                        style={{
                          width: '100%',
                          padding: 10,
                          border: '1px solid var(--border)',
                          borderRadius: 6,
                          background: 'var(--modal)',
                          color: 'var(--text)'
                        }}
                      />
                    </div>
                    <button
                      type="button"
                      onClick={() => regenerateCreditInstallments(creditInstallments.length || 1)}
                      className="btn-secondary"
                    >
                      Repartir monto
                    </button>
                    <button
                      type="button"
                      onClick={addCreditInstallment}
                      className="btn-secondary"
                    >
                      Agregar cuota
                    </button>
                  </div>

                  <div style={{ display: 'grid', gap: 10 }}>
                    {creditInstallments.map((installment, index) => (
                      <div key={`${index}_${installment.dueDate}`} style={{ display: 'grid', gridTemplateColumns: isPhoneViewport ? '1fr' : '110px 1fr 1fr auto', gap: 8, alignItems: 'end', padding: 10, borderRadius: 10, border: '1px solid var(--border)', background: 'var(--modal)' }}>
                        <div style={{ fontWeight: 700, color: 'var(--text)' }}>Cuota {index + 1}</div>
                        <div>
                          <label style={{ display: 'block', marginBottom: 6, fontSize: '0.85rem', color: 'var(--muted)' }}>Monto</label>
                          <input
                            type="number"
                            min="0"
                            step="0.01"
                            value={installment.amount}
                            onChange={e => updateCreditInstallment(index, 'amount', e.target.value)}
                            style={{ width: '100%', padding: 10, border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg)', color: 'var(--text)' }}
                          />
                        </div>
                        <div>
                          <label style={{ display: 'block', marginBottom: 6, fontSize: '0.85rem', color: 'var(--muted)' }}>Vence el</label>
                          <input
                            type="date"
                            value={installment.dueDate}
                            onChange={e => updateCreditInstallment(index, 'dueDate', e.target.value)}
                            style={{ width: '100%', padding: 10, border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg)', color: 'var(--text)' }}
                          />
                        </div>
                        <button
                          type="button"
                          onClick={() => removeCreditInstallment(index)}
                          className="btn-secondary"
                          disabled={creditInstallments.length <= 1}
                        >
                          Quitar
                        </button>
                      </div>
                    ))}
                  </div>

                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 10 }}>
                    <div style={{ padding: 10, borderRadius: 8, background: 'var(--modal)', border: '1px solid var(--border)' }}>
                      <div style={{ fontSize: '0.8rem', color: 'var(--muted)' }}>Total venta</div>
                      <div style={{ fontWeight: 700, marginTop: 4, color: 'var(--text)' }}>{formatMoney(total)}</div>
                    </div>
                    <div style={{ padding: 10, borderRadius: 8, background: 'var(--modal)', border: '1px solid var(--border)' }}>
                      <div style={{ fontSize: '0.8rem', color: 'var(--muted)' }}>Total cuotas</div>
                      <div style={{ fontWeight: 700, marginTop: 4, color: 'var(--text)' }}>{formatMoney(creditInstallmentsTotal)}</div>
                    </div>
                    <div style={{ padding: 10, borderRadius: 8, background: 'var(--modal)', border: '1px solid var(--border)' }}>
                      <div style={{ fontSize: '0.8rem', color: 'var(--muted)' }}>Diferencia</div>
                      <div style={{ fontWeight: 700, marginTop: 4, color: Math.abs(creditDifference) < 0.01 ? '#16a34a' : '#dc2626' }}>
                        {formatMoney(Math.abs(creditDifference))}
                      </div>
                    </div>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
                    <div
                      style={{
                        padding: '8px 12px',
                        borderRadius: 10,
                        border: creditPlanConfirmed ? '1px solid rgba(22, 163, 74, 0.28)' : '1px solid rgba(239, 68, 68, 0.22)',
                        background: creditPlanConfirmed ? 'rgba(22, 163, 74, 0.08)' : 'rgba(239, 68, 68, 0.06)',
                        color: creditPlanConfirmed ? '#16a34a' : '#dc2626',
                        fontWeight: 900,
                        whiteSpace: 'nowrap'
                      }}
                    >
                      {creditPlanConfirmed ? 'Plan confirmado' : 'Plan sin confirmar'}
                    </div>

                    <button
                      type="button"
                      disabled={creditPlanConfirmed}
                      onClick={() => {
                        setCreditInlineAlert(null)
                        if (!selectedCustomer) {
                          setCreditInlineAlert({ kind: 'error', text: 'Selecciona un cliente antes de confirmar el plan.' })
                          return
                        }
                        if (!creditContractPayload) {
                          setCreditInlineAlert({ kind: 'error', text: 'Completa el contrato y la firma antes de confirmar el plan.' })
                          openCreditContractModal()
                          return
                        }
                        if (creditDownPaymentAmount >= total - 0.01) {
                          setCreditInlineAlert({ kind: 'error', text: 'El enganche debe ser menor al total de la venta.' })
                          return
                        }
                        const creditPlan = validateCreditInstallments(creditInstallments, creditBaseTotal)
                        if (!creditPlan.valid) {
                          setCreditInlineAlert({ kind: 'error', text: creditPlan.error })
                          return
                        }
                        setCreditPlanConfirmed(true)
                        setCreditInlineAlert({ kind: 'ok', text: 'Plan de crédito confirmado.' })
                      }}
                      className="btn-secondary"
                    >
                      Confirmar plan
                    </button>
                  </div>
                </div>
              )}
            </div>
              </>
            </div>
          )}

          {!isQuoteMode && showExpandedPaymentPanel && (
            <>
              <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 0, width: '100%', marginBottom: 10, fontSize: '0.95rem', color: 'var(--text)', cursor: 'pointer', whiteSpace: 'nowrap' }}>
                <input
                  type="checkbox"
                  checked={shouldPrintTicket}
                  onChange={e => setShouldPrintTicket(e.target.checked)}
                  style={{ margin: 0 }}
                />
                <span style={{ whiteSpace: 'nowrap' }}>Imprimir ticket</span>
              </label>
            </>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {isQuoteMode ? showExpandedPaymentPanel && (
              <button
                onClick={handleGenerateQuote}
                disabled={cart.length === 0 || loading}
                style={{
                  width: '100%',
                  padding: 15,
                  backgroundColor: '#2563eb',
                  color: 'white',
                  border: 'none',
                  borderRadius: 6,
                  fontSize: '1.05rem',
                  fontWeight: 'bold',
                  cursor: cart.length === 0 || loading ? 'not-allowed' : 'pointer',
                  opacity: cart.length === 0 || loading ? 0.7 : 1
                }}
              >
                {loading ? 'Generando...' : 'Generar cotización'}
              </button>
            ) : showExpandedPaymentPanel ? (
              <>
                <button
                  onClick={handleSendToCashRegister}
                  disabled={cart.length === 0 || loading}
                  style={{
                    width: '100%',
                    padding: 15,
                    backgroundColor: '#2563eb',
                    color: 'white',
                    border: 'none',
                    borderRadius: 6,
                    fontSize: '1.02rem',
                    fontWeight: 'bold',
                    cursor: cart.length === 0 || loading ? 'not-allowed' : 'pointer',
                    opacity: cart.length === 0 || loading ? 0.7 : 1
                  }}
                >
                  {loading ? 'Procesando...' : 'Enviar a caja'}
                </button>
                <button
                  onClick={handleCheckout}
                  disabled={cart.length === 0 || loading || !canOperateCash}
                  style={{
                    width: '100%',
                    padding: 16,
                    backgroundColor: '#16a34a',
                    color: 'white',
                    border: 'none',
                    borderRadius: 6,
                    fontSize: '1.1rem',
                    fontWeight: 'bold',
                    cursor: cart.length === 0 || loading || !canOperateCash ? 'not-allowed' : 'pointer',
                    opacity: cart.length === 0 || loading || !canOperateCash ? 0.7 : 1
                  }}
                >
                  {loading ? 'Procesando...' : 'Cobrar ahora'}
                </button>
              </>
            ) : null}

            {!isQuoteMode && lastSale && showExpandedPaymentPanel && (
                <div
                  style={{
                    width: '100%',
                    padding: 12,
                    backgroundColor: 'transparent',
                    color: 'var(--muted)',
                    border: '1px solid var(--border)',
                    borderRadius: 6,
                    fontSize: '0.95rem',
                    fontWeight: 600,
                    textAlign: 'center'
                  }}
                >
                   {lastSale.paymentDetails?.paymentMethod === 'PENDING'
                     ? `Última orden enviada a caja: #${lastSale.saleId}`
                     : `Última venta registrada: #${lastSale.saleId}`}
                </div>
            )}
            {isQuoteMode && lastQuote && showExpandedPaymentPanel && (
              <div
                style={{
                  width: '100%',
                  padding: 12,
                  backgroundColor: 'transparent',
                  color: 'var(--muted)',
                  border: '1px solid var(--border)',
                  borderRadius: 6,
                  fontSize: '0.95rem',
                  fontWeight: 600,
                  textAlign: 'center'
                }}
              >
                Ultima cotización generada: {lastQuote.quoteNo}
              </div>
            )}
          </div>
        </div>

        {!isPhoneViewport && renderHeldSalesSection(showPhoneProductsOnly)}
      </div>

      {creditContractModalOpen && (
        <div style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(0,0,0,0.6)',
          display: 'flex',
          justifyContent: 'center',
          alignItems: isPhoneViewport ? 'flex-end' : 'center',
          zIndex: 1001,
          padding: isPhoneViewport ? 0 : 16
        }}>
          <div className="responsive-modal" style={{
            background: 'var(--modal)',
            padding: isPhoneViewport ? 16 : 20,
            borderRadius: isPhoneViewport ? '18px 18px 0 0' : 12,
            border: '1px solid var(--border)',
            width: isPhoneViewport ? '100%' : '90%',
            maxWidth: 860,
            maxHeight: '90vh',
            overflowY: 'auto',
            overflowX: 'hidden'
          }}>
            <h2 style={{ marginTop: 0, marginBottom: 16 }}>Contrato de crédito</h2>

            <div style={{ marginBottom: 14, fontSize: 12, color: 'var(--muted)' }}>
              Este paso es obligatorio antes de confirmar una venta a crédito.
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: isPhoneViewport ? '1fr' : '1fr 1fr', gap: 12 }}>
              <div>
                <label style={{ display: 'block', marginBottom: 6, fontWeight: 700 }}>Teléfono *</label>
                <input
                  value={creditContractCustomer.phone}
                  onChange={(e) => setCreditContractCustomer({ ...creditContractCustomer, phone: e.target.value })}
                  style={{ width: '100%' }}
                />
              </div>
              <div>
                <label style={{ display: 'block', marginBottom: 6, fontWeight: 700 }}>DPI *</label>
                <input
                  value={creditContractCustomer.dpi}
                  onChange={(e) => setCreditContractCustomer({ ...creditContractCustomer, dpi: e.target.value })}
                  style={{ width: '100%' }}
                />
              </div>
              <div>
                <label style={{ display: 'block', marginBottom: 6, fontWeight: 700 }}>Edad *</label>
                <input
                  type="number"
                  min="0"
                  value={creditContractCustomer.age}
                  onChange={(e) => setCreditContractCustomer({ ...creditContractCustomer, age: e.target.value })}
                  style={{ width: '100%' }}
                />
              </div>
              <div>
                <label style={{ display: 'block', marginBottom: 6, fontWeight: 700 }}>Nacionalidad *</label>
                <input
                  value={creditContractCustomer.nationality}
                  onChange={(e) => setCreditContractCustomer({ ...creditContractCustomer, nationality: e.target.value })}
                  style={{ width: '100%' }}
                />
              </div>
              <div>
                <label style={{ display: 'block', marginBottom: 6, fontWeight: 700 }}>Estado civil *</label>
                <input
                  value={creditContractCustomer.civilStatus}
                  onChange={(e) => setCreditContractCustomer({ ...creditContractCustomer, civilStatus: e.target.value })}
                  style={{ width: '100%' }}
                />
              </div>
              <div>
                <label style={{ display: 'block', marginBottom: 6, fontWeight: 700 }}>Profesión u oficio *</label>
                <input
                  value={creditContractCustomer.occupation}
                  onChange={(e) => setCreditContractCustomer({ ...creditContractCustomer, occupation: e.target.value })}
                  style={{ width: '100%' }}
                />
              </div>
              <div style={{ gridColumn: isPhoneViewport ? 'auto' : '1 / span 2' }}>
                <label style={{ display: 'block', marginBottom: 6, fontWeight: 700 }}>Dirección *</label>
                <input
                  value={creditContractCustomer.address}
                  onChange={(e) => setCreditContractCustomer({ ...creditContractCustomer, address: e.target.value })}
                  style={{ width: '100%' }}
                />
              </div>
              <div>
                <label style={{ display: 'block', marginBottom: 6, fontWeight: 700 }}>Departamento *</label>
                <select
                  value={creditContractCustomer.department}
                  onChange={(e) => setCreditContractCustomer({ ...creditContractCustomer, department: e.target.value, municipality: '' })}
                  style={{ width: '100%', padding: 10, borderRadius: 8, background: 'var(--modal)', color: 'var(--text)', border: '1px solid var(--border)' }}
                >
                  <option value="">Selecciona un departamento…</option>
                  {guatemalaDepartments.map((d) => (
                    <option key={d} value={d}>
                      {d}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label style={{ display: 'block', marginBottom: 6, fontWeight: 700 }}>Municipio *</label>
                <select
                  value={creditContractCustomer.municipality}
                  onChange={(e) => setCreditContractCustomer({ ...creditContractCustomer, municipality: e.target.value })}
                  disabled={!creditContractCustomer.department}
                  style={{ width: '100%', padding: 10, borderRadius: 8, background: 'var(--modal)', color: 'var(--text)', border: '1px solid var(--border)' }}
                >
                  <option value="">
                    {creditContractCustomer.department ? 'Selecciona un municipio…' : 'Selecciona primero un departamento…'}
                  </option>
                  {guatemalaMunicipalities.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </div>
              <div style={{ gridColumn: isPhoneViewport ? 'auto' : '1 / span 2' }}>
                <label style={{ display: 'block', marginBottom: 6, fontWeight: 700 }}>Tiempo de garantía</label>
                <input
                  value={creditContractWarrantyTime}
                  onChange={(e) => setCreditContractWarrantyTime(e.target.value)}
                  placeholder="Ej: 30 días / 3 meses"
                  style={{ width: '100%' }}
                />
              </div>
            </div>

            <div style={{ marginTop: 18, borderTop: '1px solid var(--border)', paddingTop: 14 }}>
              <div style={{ fontWeight: 800, marginBottom: 10 }}>Referencias</div>
              <div style={{ display: 'grid', gap: 10 }}>
                {creditContractRefs.map((r, idx) => (
                  <div key={idx} style={{ display: 'grid', gridTemplateColumns: isPhoneViewport ? '1fr' : '70px 1fr 220px', gap: 10, alignItems: 'center' }}>
                    <div style={{ fontWeight: 800, color: 'var(--muted)' }}>#{idx + 1}</div>
                    <input
                      value={r.name}
                      placeholder="Nombre"
                      onChange={(e) => {
                        const next = creditContractRefs.map((x, i) => i === idx ? { ...x, name: e.target.value } : x)
                        setCreditContractRefs(next)
                      }}
                      style={{ width: '100%' }}
                    />
                    <input
                      value={r.phone}
                      placeholder="Tel/Cel"
                      onChange={(e) => {
                        const next = creditContractRefs.map((x, i) => i === idx ? { ...x, phone: e.target.value } : x)
                        setCreditContractRefs(next)
                      }}
                      style={{ width: '100%' }}
                    />
                  </div>
                ))}
              </div>
            </div>

            <div style={{ marginTop: 18, borderTop: '1px solid var(--border)', paddingTop: 14 }}>
              <div style={{ fontWeight: 800, marginBottom: 10 }}>Firma del comprador *</div>
              <SignaturePad onChange={setCreditContractSignatureFile} height={180} />
              {creditContractSignatureFile && (
                <div style={{ marginTop: 8, fontSize: 12, color: 'var(--muted)' }}>
                  {creditContractSignatureFile.name}
                </div>
              )}
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, flexWrap: 'wrap', flexDirection: isPhoneViewport ? 'column' : 'row', marginTop: 18 }}>
              <button
                type="button"
                onClick={() => { setCreditContractModalOpen(false); setCreditContractSignatureFile(null) }}
                className="btn-secondary"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={submitCreditContract}
                className="btn-primary"
              >
                Guardar contrato
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Customer Modal */}
      {isCustomerModalOpen && (
        <div className="modal-overlay" style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: 'rgba(0,0,0,0.5)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 1000
        }}>
          <div className="modal-content" style={{
            backgroundColor: 'var(--modal)',
            padding: 24,
            borderRadius: 16,
            width: '100%',
            maxWidth: 500,
            boxShadow: '0 4px 6px rgba(0,0,0,0.1)',
            border: '1px solid var(--border)',
            color: 'var(--text)'
          }}>
            <h2 style={{ marginTop: 0, marginBottom: 24 }}>Nuevo Cliente</h2>
            <form onSubmit={handleCreateCustomer}>
              <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                <div>
                  <label style={{ display: 'block', marginBottom: 8, fontSize: '0.9rem', color: 'var(--muted)' }}>Nombre *</label>
                  <input
                    required
                    value={newCustomer.name}
                    onChange={e => setNewCustomer({ ...newCustomer, name: e.target.value })}
                    style={{
                      width: '100%',
                      padding: 10,
                      borderRadius: 8,
                      border: '1px solid var(--border)',
                      background: 'var(--bg)',
                      color: 'var(--text)',
                      outline: 'none'
                    }}
                  />
                </div>
                <div>
                  <label style={{ display: 'block', marginBottom: 8, fontSize: '0.9rem', color: 'var(--muted)' }}>Documento / RUT</label>
                  <input
                    value={newCustomer.document}
                    onChange={e => setNewCustomer({ ...newCustomer, document: e.target.value })}
                    style={{
                      width: '100%',
                      padding: 10,
                      borderRadius: 8,
                      border: '1px solid var(--border)',
                      background: 'var(--bg)',
                      color: 'var(--text)',
                      outline: 'none'
                    }}
                  />
                </div>
                <div>
                  <label style={{ display: 'block', marginBottom: 8, fontSize: '0.9rem', color: 'var(--muted)' }}>Teléfono</label>
                  <input
                    value={newCustomer.phone}
                    onChange={e => setNewCustomer({ ...newCustomer, phone: e.target.value })}
                    style={{
                      width: '100%',
                      padding: 10,
                      borderRadius: 8,
                      border: '1px solid var(--border)',
                      background: 'var(--bg)',
                      color: 'var(--text)',
                      outline: 'none'
                    }}
                  />
                </div>
                <div>
                  <label style={{ display: 'block', marginBottom: 8, fontSize: '0.9rem', color: 'var(--muted)' }}>Email</label>
                  <input
                    type="email"
                    value={newCustomer.email}
                    onChange={e => setNewCustomer({ ...newCustomer, email: e.target.value })}
                    style={{
                      width: '100%',
                      padding: 10,
                      borderRadius: 8,
                      border: '1px solid var(--border)',
                      background: 'var(--bg)',
                      color: 'var(--text)',
                      outline: 'none'
                    }}
                  />
                </div>
                <div>
                  <label style={{ display: 'block', marginBottom: 8, fontSize: '0.9rem', color: 'var(--muted)' }}>Dirección</label>
                  <input
                    value={newCustomer.address}
                    onChange={e => setNewCustomer({ ...newCustomer, address: e.target.value })}
                    style={{
                      width: '100%',
                      padding: 10,
                      borderRadius: 8,
                      border: '1px solid var(--border)',
                      background: 'var(--bg)',
                      color: 'var(--text)',
                      outline: 'none'
                    }}
                  />
                </div>
              </div>
              <div className="modal-footer" style={{ marginTop: 24, display: 'flex', justifyContent: 'flex-end', gap: 12 }}>
                <button
                  type="button"
                  onClick={() => setIsCustomerModalOpen(false)}
                  disabled={loading}
                  style={{
                    padding: '10px 16px',
                    background: 'transparent',
                    border: '1px solid var(--border)',
                    borderRadius: 8,
                    color: 'var(--text)',
                    cursor: loading ? 'not-allowed' : 'pointer',
                    opacity: loading ? 0.7 : 1
                  }}
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={loading}
                  style={{
                    padding: '10px 16px',
                    backgroundColor: 'var(--accent)',
                    color: 'var(--accent-contrast)',
                    border: 'none',
                    borderRadius: 8,
                    fontWeight: 700,
                    cursor: loading ? 'not-allowed' : 'pointer',
                    opacity: loading ? 0.7 : 1
                  }}
                >
                  {loading ? 'Guardando...' : 'Guardar y Seleccionar'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {isServerDraftsOpen && (
        <div className="modal-overlay" style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: 'rgba(0,0,0,0.5)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 1000
        }}>
          <div className="modal-content" style={{
            backgroundColor: 'var(--modal)',
            padding: 20,
            borderRadius: 16,
            width: '100%',
            maxWidth: 760,
            maxHeight: '84vh',
            overflow: 'hidden',
            boxShadow: '0 4px 6px rgba(0,0,0,0.1)',
            border: '1px solid var(--border)',
            color: 'var(--text)',
            display: 'flex',
            flexDirection: 'column',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, marginBottom: 14 }}>
              <div>
                <div style={{ fontWeight: 900, fontSize: '1.05rem' }}>Borradores (Servidor)</div>
                <div style={{ fontSize: 12, color: 'var(--muted)' }}>{serverDrafts.length} registro(s)</div>
              </div>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                <button
                  type="button"
                  onClick={loadServerDrafts}
                  disabled={serverDraftsLoading}
                  style={{
                    padding: '8px 12px',
                    background: 'var(--surface)',
                    border: '1px solid var(--border)',
                    borderRadius: 10,
                    color: 'var(--text)',
                    cursor: serverDraftsLoading ? 'not-allowed' : 'pointer',
                    fontWeight: 800,
                    opacity: serverDraftsLoading ? 0.7 : 1
                  }}
                >
                  Actualizar
                </button>
                <button
                  type="button"
                  onClick={() => setIsServerDraftsOpen(false)}
                  style={{
                    padding: '8px 12px',
                    background: 'transparent',
                    border: '1px solid var(--border)',
                    borderRadius: 10,
                    color: 'var(--text)',
                    cursor: 'pointer',
                    fontWeight: 800
                  }}
                >
                  Cerrar
                </button>
              </div>
            </div>

            <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 10 }}>
              {serverDraftsLoading ? (
                <div style={{ color: 'var(--muted)', padding: 14 }}>Cargando...</div>
              ) : serverDrafts.length === 0 ? (
                <div style={{ color: 'var(--muted)', padding: 14 }}>Sin borradores.</div>
              ) : (
                serverDrafts.map(draft => (
                  <div key={draft.id} style={{ border: '1px solid var(--border)', borderRadius: 12, padding: 12, background: 'var(--bg)' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
                      <div style={{ minWidth: 220 }}>
                        <div style={{ fontWeight: 900 }}>#{draft.id} {draft.doc_no ? `(${draft.doc_no})` : ''}</div>
                        <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                          {draft.customer_name || 'Sin cliente'}{draft.seller_name ? ` | ${draft.seller_name}` : ''}
                        </div>
                        {draft.created_at && (
                          <div style={{ fontSize: 12, color: 'var(--muted)' }}>{String(draft.created_at).replace('T', ' ').slice(0, 19)}</div>
                        )}
                      </div>

                      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                        <div style={{ fontWeight: 900, whiteSpace: 'nowrap' }}>{formatMoney(Number(draft.total || 0))}</div>
                        <button
                          type="button"
                          onClick={() => handleLoadServerDraft(draft.id)}
                          style={{
                            padding: '8px 12px',
                            background: 'rgba(37, 99, 235, 0.12)',
                            border: '1px solid rgba(37, 99, 235, 0.24)',
                            borderRadius: 10,
                            color: '#2563eb',
                            cursor: 'pointer',
                            fontWeight: 900
                          }}
                        >
                          Retomar
                        </button>
                        <button
                          type="button"
                          onClick={() => handleSendServerDraftToCashier(draft.id)}
                          style={{
                            padding: '8px 12px',
                            background: 'rgba(245, 158, 11, 0.12)',
                            border: '1px solid rgba(245, 158, 11, 0.28)',
                            borderRadius: 10,
                            color: '#f59e0b',
                            cursor: 'pointer',
                            fontWeight: 900
                          }}
                        >
                          Enviar a caja
                        </button>
                        <button
                          type="button"
                          onClick={() => handleCancelServerDraft(draft.id)}
                          style={{
                            padding: '8px 12px',
                            background: 'rgba(239, 68, 68, 0.1)',
                            border: '1px solid rgba(239, 68, 68, 0.24)',
                            borderRadius: 10,
                            color: '#ef4444',
                            cursor: 'pointer',
                            fontWeight: 900
                          }}
                        >
                          Cancelar
                        </button>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* Batch Selection Modal */}
      {selectedProductForBatch && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1100 }}>
          <div style={{ background: 'var(--modal)', padding: 20, borderRadius: 12, width: 500, maxHeight: '80vh', display: 'flex', flexDirection: 'column', boxShadow: '0 4px 20px rgba(0,0,0,0.2)' }}>
            <h3 style={{ marginTop: 0, marginBottom: 15 }}>Seleccionar Lote para {selectedProductForBatch.name}</h3>

            <input
              type="text"
              placeholder="Buscar lote..."
              value={modalSearchTerm}
              onChange={e => setModalSearchTerm(e.target.value)}
              style={{
                width: '100%',
                padding: '10px',
                marginBottom: 15,
                border: '1px solid var(--border)',
                borderRadius: 8,
                background: 'var(--bg)',
                color: 'var(--text)',
                outline: 'none'
              }}
              autoFocus
            />

            <div style={{ flex: 1, overflowY: 'auto', marginBottom: 15 }}>
               {availableBatches.filter(b => b.batchNo.toLowerCase().includes(modalSearchTerm.toLowerCase())).length === 0 ? (
                   <div style={{ padding: 20, textAlign: 'center', color: 'var(--muted)' }}>
                     {availableBatches.length === 0 ? 'No hay lotes disponibles' : 'No se encontraron lotes'}
                   </div>
               ) : (
                   <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                       <thead>
                           <tr style={{ borderBottom: '1px solid var(--border)', textAlign: 'left' }}>
                               <th style={{ padding: 8 }}>Lote</th>
                               <th style={{ padding: 8 }}>Vence</th>
                               <th style={{ padding: 8, textAlign: 'right' }}>Disp.</th>
                               <th style={{ padding: 8 }}></th>
                           </tr>
                       </thead>
                       <tbody>
                           {availableBatches
                             .filter(b => b.batchNo.toLowerCase().includes(modalSearchTerm.toLowerCase()))
                             .map((b, index) => {
                               const isBest = availableBatches.length > 0 && availableBatches[0].batchNo === b.batchNo
                               return (
                               <tr key={b.batchNo} style={{ borderBottom: '1px solid var(--border)', backgroundColor: isBest ? 'rgba(234, 179, 8, 0.1)' : 'transparent' }}>
                                   <td style={{ padding: 8 }}>
                                       {b.batchNo}
                                       {isBest && (
                                           <span style={{
                                               fontSize: '0.7em',
                                               backgroundColor: '#eab308',
                                               color: '#000',
                                               padding: '2px 6px',
                                               borderRadius: 4,
                                               marginLeft: 8,
                                               fontWeight: 'bold'
                                           }}>
                                               Sugerido
                                           </span>
                                       )}
                                   </td>
                                   <td style={{ padding: 8 }}>{b.expiryDate}</td>
                                   <td style={{ padding: 8, textAlign: 'right' }}>{b.quantity}</td>
                                   <td style={{ padding: 8, textAlign: 'right' }}>
                                       <button
                                           className="btn-primary"
                                           onClick={() => {
                                               addBatchToCart(selectedProductForBatch, b, 1)
                                           }}
                                           style={{ fontSize: '0.8em', padding: '4px 8px' }}
                                       >
                                           Agregar
                                       </button>
                                   </td>
                               </tr>
                               )
                           })}
                       </tbody>
                   </table>
               )}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <button
                    onClick={() => setSelectedProductForBatch(null)}
                    style={{ padding: '8px 16px', borderRadius: 6, border: '1px solid var(--border)', background: 'transparent', cursor: 'pointer', color: 'var(--text)' }}
                >
                    Cancelar
                </button>
            </div>
          </div>
        </div>
      )}

      {/* IMEI Selection Modal */}
      {selectedProductForImei && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1100 }}>
          <div style={{ background: 'var(--modal)', padding: 20, borderRadius: 12, width: 400, maxHeight: '80vh', display: 'flex', flexDirection: 'column', boxShadow: '0 4px 20px rgba(0,0,0,0.2)' }}>
            <h3 style={{ marginTop: 0, marginBottom: 15 }}>Seleccionar IMEI para {selectedProductForImei.name}</h3>

            <input
              type="text"
              placeholder="Buscar IMEI..."
              value={modalSearchTerm}
              onChange={e => setModalSearchTerm(e.target.value)}
              style={{
                width: '100%',
                padding: '10px',
                marginBottom: 15,
                border: '1px solid var(--border)',
                borderRadius: 8,
                background: 'var(--bg)',
                color: 'var(--text)',
                outline: 'none'
              }}
              autoFocus
            />

            <div style={{ flex: 1, overflowY: 'auto', marginBottom: 15 }}>
               {availableImeis.filter(imei => imei.toLowerCase().includes(modalSearchTerm.toLowerCase())).length === 0 ? (
                   <div style={{ padding: 20, textAlign: 'center', color: 'var(--muted)' }}>
                     {availableImeis.length === 0 ? 'No hay IMEIs disponibles' : 'No se encontraron IMEIs'}
                   </div>
               ) : (
                   <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                       {availableImeis
                         .filter(imei => imei.toLowerCase().includes(modalSearchTerm.toLowerCase()))
                         .map(imei => (
                           <button
                               key={imei}
                               onClick={() => addImeiToCart(selectedProductForImei, imei)}
                               style={{ padding: 10, borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)', cursor: 'pointer', textAlign: 'left', color: 'var(--text)' }}
                           >
                               {imei}
                           </button>
                       ))}
                   </div>
               )}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <button
                    onClick={() => setSelectedProductForImei(null)}
                    style={{ padding: '8px 16px', borderRadius: 6, border: '1px solid var(--border)', background: 'transparent', cursor: 'pointer', color: 'var(--text)' }}
                >
                    Cancelar
                </button>
            </div>
          </div>
        </div>
      )}

      {/* Serial Selection Modal */}
      {selectedProductForSerial && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1100 }}>
          <div style={{ background: 'var(--modal)', padding: 20, borderRadius: 12, width: 400, maxHeight: '80vh', display: 'flex', flexDirection: 'column', boxShadow: '0 4px 20px rgba(0,0,0,0.2)' }}>
            <h3 style={{ marginTop: 0, marginBottom: 15 }}>Seleccionar Serial para {selectedProductForSerial.name}</h3>

            <input
              type="text"
              placeholder="Buscar Serial..."
              value={modalSearchTerm}
              onChange={e => setModalSearchTerm(e.target.value)}
              style={{
                width: '100%',
                padding: '10px',
                marginBottom: 15,
                border: '1px solid var(--border)',
                borderRadius: 8,
                background: 'var(--bg)',
                color: 'var(--text)',
                outline: 'none'
              }}
              autoFocus
            />

            <div style={{ flex: 1, overflowY: 'auto', marginBottom: 15 }}>
               {availableSerials.filter(serial => serial.toLowerCase().includes(modalSearchTerm.toLowerCase())).length === 0 ? (
                   <div style={{ padding: 20, textAlign: 'center', color: 'var(--muted)' }}>
                     {availableSerials.length === 0 ? 'No hay Seriales disponibles' : 'No se encontraron Seriales'}
                   </div>
               ) : (
                   <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                       {availableSerials
                         .filter(serial => serial.toLowerCase().includes(modalSearchTerm.toLowerCase()))
                         .map(serial => (
                           <button
                               key={serial}
                               onClick={() => addSerialToCart(selectedProductForSerial, serial)}
                               style={{ padding: 10, borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)', cursor: 'pointer', textAlign: 'left', color: 'var(--text)' }}
                           >
                               {serial}
                           </button>
                       ))}
                   </div>
               )}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <button
                    onClick={() => setSelectedProductForSerial(null)}
                    style={{ padding: '8px 16px', borderRadius: 6, border: '1px solid var(--border)', background: 'transparent', cursor: 'pointer', color: 'var(--text)' }}
                >
                    Cancelar
                </button>
            </div>
          </div>
        </div>
      )}

      {/* Warehouse Stock Modal */}
      {viewStockProduct && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1200 }}>
          <div style={{ background: 'var(--modal)', padding: 24, borderRadius: 16, width: 400, maxHeight: '80vh', display: 'flex', flexDirection: 'column', boxShadow: '0 10px 25px rgba(0,0,0,0.2)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
              <h3 style={{ margin: 0, color: 'var(--text)' }}>Existencias por Almacén</h3>
              <button
                onClick={() => setViewStockProduct(null)}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)' }}
              >
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18"></line>
                  <line x1="6" y1="6" x2="18" y2="18"></line>
                </svg>
              </button>
            </div>

            <div style={{ marginBottom: 16 }}>
              <div style={{ fontWeight: 600, color: 'var(--text)' }}>{viewStockProduct.name}</div>
              <div style={{ fontSize: '0.9rem', color: 'var(--muted)' }}>SKU: {viewStockProduct.sku || 'N/A'}</div>
              <div style={{ fontSize: '0.8rem', color: 'var(--muted)', marginTop: 6 }}>
                Consulta informativa. La venta sigue limitada a la tienda asignada.
              </div>
            </div>

            <div style={{ flex: 1, overflowY: 'auto' }}>
              {loadingStocks ? (
                <div style={{ textAlign: 'center', padding: 20, color: 'var(--muted)' }}>Cargando...</div>
              ) : (
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid var(--border)' }}>
                      <th style={{ textAlign: 'left', padding: '8px 4px', color: 'var(--muted)', fontSize: '0.9rem' }}>Almacén</th>
                      <th style={{ textAlign: 'right', padding: '8px 4px', color: 'var(--muted)', fontSize: '0.9rem' }}>Cantidad</th>
                    </tr>
                  </thead>
                  <tbody>
                    {warehouseStocks.map((ws: any, idx) => (
                      <tr
                        key={idx}
                        style={{
                          borderBottom: '1px solid var(--border)',
                          ...(String(user?.warehouseId) === String(ws.warehouseId)
                            ? { background: 'rgba(59, 130, 246, 0.10)' }
                            : {})
                        }}
                      >
                        <td style={{ padding: '12px 4px', color: 'var(--text)' }}>
                          <span className={`warehouse-highlight${String(user?.warehouseId) === String(ws.warehouseId) ? ' current' : ''}`} style={getWarehouseHighlightStyle(ws.warehouseName, String(user?.warehouseId) === String(ws.warehouseId))}>{ws.warehouseName}</span>
                          {String(user?.warehouseId) === String(ws.warehouseId) ? ' (Actual)' : ''}
                        </td>
                        <td style={{ padding: '12px 4px', textAlign: 'right', fontWeight: 600, color: 'var(--text)' }}>
                          {ws.quantity}
                        </td>
                      </tr>
                    ))}
                    {warehouseStocks.length === 0 && (
                      <tr>
                        <td colSpan={2} style={{ textAlign: 'center', padding: 20, color: 'var(--muted)' }}>
                          No hay stock registrado en almacenes
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Cash Register Closed Warning */}
      {canOperateCash && isCashOpen === false && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.8)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 2000 }}>
          <div style={{ background: 'var(--modal)', padding: 30, borderRadius: 16, width: 400, textAlign: 'center', boxShadow: '0 10px 40px rgba(0,0,0,0.5)', border: '1px solid var(--border)' }}>
            <div style={{ marginBottom: 15, display: 'flex', justifyContent: 'center' }}>
              <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--text)' }}>
                <rect x="3" y="11" width="18" height="11" rx="2"></rect>
                <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
              </svg>
            </div>
            <h2 style={{ marginTop: 0, marginBottom: 15, color: 'var(--text)' }}>Caja Cerrada</h2>
            <p style={{ color: 'var(--muted)', marginBottom: 25, lineHeight: 1.5 }}>
              Debes realizar la apertura de caja antes de poder realizar ventas.
            </p>
            <button
              onClick={() => navigate('/cash-register')}
              className="btn-primary"
              style={{ width: '100%', padding: '12px 0', fontSize: '1.1rem' }}
            >
              Ir a Apertura de Caja
            </button>
          </div>
        </div>
      )}

      {/* Hidden iframe for printing */}
      <iframe
        ref={iframeRef}
        style={{
          position: 'absolute',
          width: '0px',
          height: '0px',
          border: 'none',
          visibility: 'hidden'
        }}
      />
    </div>
  )
}
