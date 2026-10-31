import { useState, useEffect, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { 
  api,
  getCashStatus, 
  openCashRegister, 
  closeCashRegister, 
  getCashSummary, 
  addCashMovement, 
  getCashMovements,
  getPendingPaymentSales,
  getSaleDetails,
  collectPendingSalePayment,
  getCreditContractBySale,
} from '../api'
import { useAuthStore } from '../store/auth'
import { useConfigStore } from '../store/config'
import { formatDateTime } from '../utils/date'
import { formatNumber } from '../utils/currency'
import { buildPrintLogoHtml } from '../utils/printBranding'

// #region debug-point credit-installment-mismatch-client
const __dbgClientUrl = 'http://127.0.0.1:7777/event'
async function __dbgClientReport(event: any) {
  try {
    if (typeof window === 'undefined') return
    if (localStorage.getItem('dbg_credit_installment_mismatch') !== '1') return
    await fetch(__dbgClientUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: 'credit-installment-mismatch',
        at: new Date().toISOString(),
        side: 'client',
        ...event,
      }),
    })
  } catch {}
}
// #endregion debug-point credit-installment-mismatch-client

type CreditInstallmentDraft = {
  amount: string
  dueDate: string
}

type CreditInstallmentFrequency = 'WEEKLY' | 'BIWEEKLY' | 'MONTHLY'

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

function getCreditFrequencyDays(frequency: CreditInstallmentFrequency) {
  if (frequency === 'WEEKLY') return 7
  if (frequency === 'BIWEEKLY') return 15
  return 30
}

function buildCreditInstallmentDrafts(total: number, count: number, firstDueDate?: string, frequency: CreditInstallmentFrequency = 'MONTHLY'): CreditInstallmentDraft[] {
  const safeCount = Math.max(1, Math.min(36, Number(count) || 1))
  const totalCents = Math.max(0, Math.round(Number(total || 0) * 100))
  const baseAmount = Math.floor(totalCents / safeCount)
  let remainder = totalCents - (baseAmount * safeCount)
  const stepDays = getCreditFrequencyDays(frequency)
  const startDate = firstDueDate || addDaysToInputDate(new Date(), stepDays)

  return Array.from({ length: safeCount }, (_, index) => {
    const cents = baseAmount + (remainder > 0 ? 1 : 0)
    remainder = Math.max(0, remainder - 1)
    return {
      amount: (cents / 100).toFixed(2),
      dueDate: index === 0 ? startDate : addDaysToInputDate(startDate, index * stepDays),
    }
  })
}

function validateCreditInstallments(installments: CreditInstallmentDraft[], total: number) {
  if (!Array.isArray(installments) || installments.length === 0) {
    return { valid: false, error: 'Debes registrar al menos una cuota para el crédito' }
  }

  const normalized = installments.map((installment, index) => {
    const amount = Math.round(Number(installment.amount || 0) * 100) / 100
    const dueDate = String(installment.dueDate || '').trim()

    if (!Number.isFinite(amount) || amount <= 0) {
      void __dbgClientReport({ point: 'validate-installments-invalid-amount', index, amount: installment.amount, total })
      return { error: `La cuota #${index + 1} debe tener un monto válido` }
    }

    if (!dueDate) {
      void __dbgClientReport({ point: 'validate-installments-missing-date', index, amount, total })
      return { error: `La cuota #${index + 1} debe tener fecha de vencimiento` }
    }

    return { amount, dueDate }
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
    void __dbgClientReport({
      point: 'validate-installments-sum-mismatch',
      expectedTotal,
      installmentsTotal,
      diff: Math.round((expectedTotal - installmentsTotal) * 100) / 100,
      installments: (normalized as Array<{ amount: number; dueDate: string }>).map(it => it.amount),
    })
    return { valid: false, error: 'La suma de las cuotas no coincide con el total de la venta' }
  }

  return {
    valid: true,
    installments: normalized as Array<{ amount: number; dueDate: string }>,
  }
}

export default function CashRegister() {
  const { user } = useAuthStore()
  const navigate = useNavigate()
  const config = useConfigStore(s => s.config)
  const isAdmin = user?.role === 'ADMIN'
  const [isMobileViewport, setIsMobileViewport] = useState(false)
  const [loading, setLoading] = useState(true)
  const [openingCash, setOpeningCash] = useState(false)
  const [savingMovement, setSavingMovement] = useState(false)
  const [closingCash, setClosingCash] = useState(false)
  const [isOpen, setIsOpen] = useState(false)
  const [summary, setSummary] = useState<any>(null)
  const [movements, setMovements] = useState<any[]>([])
  const [pendingSales, setPendingSales] = useState<Array<{
    id: number
    docNo: string
    total: number
    createdAt: string
    customerName: string
    sellerName: string
    itemsCount: number
  }>>([])
  const [users, setUsers] = useState<Array<{ id: number; name: string; role_name?: string }>>([])
  const [selectedUserId, setSelectedUserId] = useState<number | null>(null)
  
  // Forms
  const [openingAmount, setOpeningAmount] = useState('')
  const [notes, setNotes] = useState('')
  
  // Modals
  const [showMovementModal, setShowMovementModal] = useState(false)
  const [movementType, setMovementType] = useState<'IN' | 'OUT'>('IN')
  const [movementAmount, setMovementAmount] = useState('')
  const [movementDesc, setMovementDesc] = useState('')
  
  const [showCloseModal, setShowCloseModal] = useState(false)
  const [closingAmount, setClosingAmount] = useState('')
  const [closeResult, setCloseResult] = useState<any>(null)
  const [showCollectModal, setShowCollectModal] = useState(false)
  const [collectingSale, setCollectingSale] = useState<{
    id: number
    docNo: string
    total: number
    createdAt: string
    customerName: string
    sellerName: string
    itemsCount: number
  } | null>(null)
  const [collectingPayment, setCollectingPayment] = useState(false)
  const [collectPaymentMethod, setCollectPaymentMethod] = useState<'CASH' | 'CARD' | 'DEPOSIT' | 'CREDIT'>('CASH')
  const [collectReceivedAmount, setCollectReceivedAmount] = useState('')
  const [collectReferenceNumber, setCollectReferenceNumber] = useState('')
  const [collectPaymentDocument, setCollectPaymentDocument] = useState<File | null>(null)
  const [collectPaymentDocumentPreview, setCollectPaymentDocumentPreview] = useState<string>('')
  const [collectCreditInstallments, setCollectCreditInstallments] = useState<CreditInstallmentDraft[]>(() => buildCreditInstallmentDrafts(0, 1))
  const [collectCreditFrequency, setCollectCreditFrequency] = useState<CreditInstallmentFrequency>('MONTHLY')
  const [collectCreditDownPayment, setCollectCreditDownPayment] = useState('0')
  const [collectCreditDownPaymentMethod, setCollectCreditDownPaymentMethod] = useState<'CASH' | 'CARD' | 'DEPOSIT'>('CASH')
  const [collectCreditDownPaymentReference, setCollectCreditDownPaymentReference] = useState('')
  const [collectCreditDownPaymentDocument, setCollectCreditDownPaymentDocument] = useState<File | null>(null)
  const [collectCreditDownPaymentDocumentPreview, setCollectCreditDownPaymentDocumentPreview] = useState<string>('')
  const [collectInlineAlert, setCollectInlineAlert] = useState<{ kind: 'error' | 'warn' | 'ok'; text: string; action?: 'goCredits' } | null>(null)
  const [collectContractSigned, setCollectContractSigned] = useState<boolean | null>(null)
  const [collectContractChecking, setCollectContractChecking] = useState(false)
  const [collectSaleInstallments, setCollectSaleInstallments] = useState<Array<{ id: number; due_date: string; amount: number; paid: number }>>([])
  const [collectSaleInstallmentsLoading, setCollectSaleInstallmentsLoading] = useState(false)
  const selectedUser = users.find(u => u.id === (selectedUserId || user?.id))
  const isOwnCash = !selectedUserId || selectedUserId === user?.id
  const cashParams = isAdmin && selectedUserId && selectedUserId !== user?.id ? { userId: selectedUserId } : undefined
  const salesByMethod = summary?.salesByMethod || {}
  const creditPaymentsByMethod = summary?.creditPaymentsByMethod || {}
  const depositSales = Number(salesByMethod.DEPOSIT || 0)
  const cardSales = Number(salesByMethod.CARD || 0)
  const creditSales = Number(salesByMethod.CREDIT || 0)
  const creditPaymentCash = Number(creditPaymentsByMethod.CASH || 0)
  const creditPaymentDeposit = Number(creditPaymentsByMethod.DEPOSIT || 0)
  const creditPaymentCard = Number(creditPaymentsByMethod.CARD || 0)
  const collectDownPaymentAmount = Math.max(0, Math.round(Number(collectCreditDownPayment || 0) * 100) / 100)
  const collectCreditBaseTotal = Math.round(Math.max(0, Number(collectingSale?.total || 0) - collectDownPaymentAmount) * 100) / 100
  const collectInstallmentsTotal = Math.round(collectCreditInstallments.reduce((sum, installment) => sum + (Number(installment.amount || 0) || 0), 0) * 100) / 100
  const collectInstallmentsDifference = Math.round((collectCreditBaseTotal - collectInstallmentsTotal) * 100) / 100
  const collectPreparedInstallmentsTotal = Math.round(collectSaleInstallments.reduce((sum, installment) => sum + (Number(installment.amount || 0) || 0), 0) * 100) / 100

  useEffect(() => {
    if (!collectPaymentDocument) {
      setCollectPaymentDocumentPreview('')
      return
    }
    const nextUrl = URL.createObjectURL(collectPaymentDocument)
    setCollectPaymentDocumentPreview(nextUrl)
    return () => {
      URL.revokeObjectURL(nextUrl)
    }
  }, [collectPaymentDocument])

  useEffect(() => {
    if (!collectCreditDownPaymentDocument) {
      setCollectCreditDownPaymentDocumentPreview('')
      return
    }
    const nextUrl = URL.createObjectURL(collectCreditDownPaymentDocument)
    setCollectCreditDownPaymentDocumentPreview(nextUrl)
    return () => {
      URL.revokeObjectURL(nextUrl)
    }
  }, [collectCreditDownPaymentDocument])

  useEffect(() => {
    if (!showCollectModal || !collectingSale) return
    if (collectPaymentMethod !== 'CREDIT') {
      setCollectSaleInstallments([])
      setCollectSaleInstallmentsLoading(false)
      setCollectContractSigned(null)
      setCollectContractChecking(false)
      return
    }

    let alive = true
    ;(async () => {
      try {
        setCollectSaleInstallmentsLoading(true)
        const [detail, contractMeta] = await Promise.all([
          getSaleDetails(collectingSale.id),
          getCreditContractBySale(collectingSale.id).catch(() => null),
        ])
        if (!alive) return
        const inst = Array.isArray(detail?.installments) ? detail.installments : []
        setCollectSaleInstallments(inst)
        setCollectContractSigned(Boolean(contractMeta?.contract?.buyer_signed_at))
      } finally {
        if (alive) setCollectSaleInstallmentsLoading(false)
      }
    })()

    return () => {
      alive = false
    }
  }, [showCollectModal, collectingSale?.id, collectPaymentMethod])

  const handlePrintReport = () => {
    const reportSummary = summary || null
    const reportTitle = closeResult ? 'Reporte de Cierre de Caja' : 'Reporte de Caja'
    const reportUser = isOwnCash ? `${user?.name || '-'} (${user?.role || '-'})` : (selectedUser?.name || '-')
    const openedAt = reportSummary?.openingTime ? formatDateTime(new Date(reportSummary.openingTime)) : '-'
    const printedAt = formatDateTime(new Date())
    const logoBlock = buildPrintLogoHtml(config?.logoUrl, config?.name || 'Logo empresa', { maxWidth: 150, maxHeight: 56, marginBottom: 8, align: 'left' })
    const methods = Object.entries(reportSummary?.salesByMethod || {}) as Array<[string, unknown]>
    const movementsRows = movements.map(m => `
      <tr>
        <td>${escapeHtml(formatDateTime(new Date(m.created_at)).split(' ')[1] || '')}</td>
        <td>${escapeHtml(m.type === 'IN' ? 'ENTRADA' : 'SALIDA')}</td>
        <td>${escapeHtml(String(m.description || ''))}</td>
        <td style="text-align:right;">${formatMoney(m.amount)}</td>
      </tr>
    `).join('')

    const printWindow = window.open('about:blank', '_blank', 'width=900,height=700')
    if (!printWindow) {
      alert('No se pudo abrir la ventana de impresion. Verifica si el navegador bloqueo el popup.')
      return
    }

    printWindow.document.write(`
      <!doctype html>
      <html>
        <head>
          <meta charset="utf-8" />
          <title>${escapeHtml(reportTitle)}</title>
          <style>
            body { font-family: Arial, sans-serif; margin: 24px; color: #111827; }
            h1, h2, h3 { margin: 0 0 12px; }
            .meta, .grid { margin-bottom: 20px; }
            .meta div { margin-bottom: 6px; }
            .grid { display: grid; grid-template-columns: repeat(2, minmax(220px, 1fr)); gap: 12px; }
            .card { border: 1px solid #d1d5db; border-radius: 8px; padding: 12px; }
            .label { font-size: 12px; color: #6b7280; margin-bottom: 4px; }
            .value { font-size: 22px; font-weight: 700; }
            table { width: 100%; border-collapse: collapse; margin-top: 8px; }
            th, td { border: 1px solid #d1d5db; padding: 8px; font-size: 12px; }
            th { background: #f3f4f6; text-align: left; }
            .section { margin-top: 20px; }
          </style>
        </head>
        <body>
          ${logoBlock}
          <h1>${escapeHtml(reportTitle)}</h1>
          <div class="meta">
            <div><strong>Responsable:</strong> ${escapeHtml(reportUser)}</div>
            <div><strong>Apertura:</strong> ${escapeHtml(openedAt)}</div>
            <div><strong>Impreso:</strong> ${escapeHtml(printedAt)}</div>
          </div>

          <div class="grid">
            <div class="card"><div class="label">Saldo Inicial</div><div class="value">${formatMoney(reportSummary?.openingAmount)}</div></div>
            <div class="card"><div class="label">Ventas (Efectivo)</div><div class="value">${formatMoney(reportSummary?.salesCash)}</div></div>
            <div class="card"><div class="label">Ventas (Deposito)</div><div class="value">${formatMoney(depositSales)}</div></div>
            <div class="card"><div class="label">Ventas (Tarjeta)</div><div class="value">${formatMoney(cardSales)}</div></div>
            <div class="card"><div class="label">Ventas (Credito)</div><div class="value">${formatMoney(creditSales)}</div></div>
            <div class="card"><div class="label">Abonos Credito (Efectivo)</div><div class="value">${formatMoney(creditPaymentCash)}</div></div>
            <div class="card"><div class="label">Abonos Credito (Deposito)</div><div class="value">${formatMoney(creditPaymentDeposit)}</div></div>
            <div class="card"><div class="label">Abonos Credito (Tarjeta)</div><div class="value">${formatMoney(creditPaymentCard)}</div></div>
            <div class="card"><div class="label">Entradas Extra</div><div class="value">${formatMoney(reportSummary?.movementsIn)}</div></div>
            <div class="card"><div class="label">Salidas / Gastos</div><div class="value">${formatMoney(reportSummary?.movementsOut)}</div></div>
            <div class="card"><div class="label">Total Esperado</div><div class="value">${formatMoney(reportSummary?.expectedCash)}</div></div>
            ${closeResult ? `<div class="card"><div class="label">Monto Real (Conteo)</div><div class="value">${formatMoney(closeResult.expected + closeResult.difference)}</div></div>` : ''}
            ${closeResult ? `<div class="card"><div class="label">Diferencia</div><div class="value">${formatMoney(closeResult.difference)}</div></div>` : ''}
          </div>

          <div class="section">
            <h3>Ventas por Metodo</h3>
            <table>
              <thead>
                <tr>
                  <th>Metodo</th>
                  <th style="text-align:right;">Monto</th>
                </tr>
              </thead>
              <tbody>
                ${methods.map(([method, total]) => `
                  <tr>
                    <td>${escapeHtml(translateMethod(method))}</td>
                    <td style="text-align:right;">${formatMoney(total)}</td>
                  </tr>
                `).join('')}
                <tr>
                  <td><strong>Total Ventas</strong></td>
                  <td style="text-align:right;"><strong>${formatMoney(reportSummary?.totalSales)}</strong></td>
                </tr>
              </tbody>
            </table>
          </div>

          <div class="section">
            <h3>Abonos a Credito por Metodo</h3>
            <table>
              <thead>
                <tr>
                  <th>Metodo</th>
                  <th style="text-align:right;">Monto</th>
                </tr>
              </thead>
              <tbody>
                ${Object.entries(reportSummary?.creditPaymentsByMethod || {}).map(([method, total]) => `
                  <tr>
                    <td>${escapeHtml(translateMethod(method))}</td>
                    <td style="text-align:right;">${formatMoney(total)}</td>
                  </tr>
                `).join('') || '<tr><td colspan="2" style="text-align:center;">Sin abonos de crédito</td></tr>'}
              </tbody>
            </table>
          </div>

          <div class="section">
            <h3>Movimientos de Efectivo</h3>
            <table>
              <thead>
                <tr>
                  <th>Hora</th>
                  <th>Tipo</th>
                  <th>Descripcion</th>
                  <th style="text-align:right;">Monto</th>
                </tr>
              </thead>
              <tbody>
                ${movementsRows || '<tr><td colspan="4" style="text-align:center;">Sin movimientos</td></tr>'}
              </tbody>
            </table>
          </div>
        </body>
      </html>
    `)
    printWindow.document.close()
    printWindow.focus()
    printWindow.print()
  }

  useEffect(() => {
    const mediaQuery = window.matchMedia('(max-width: 768px)')
    const syncViewport = () => setIsMobileViewport(mediaQuery.matches)
    syncViewport()
    mediaQuery.addEventListener('change', syncViewport)
    return () => mediaQuery.removeEventListener('change', syncViewport)
  }, [])

  useEffect(() => {
    if (isAdmin) {
      fetchUsers()
    } else if (user?.id) {
      setSelectedUserId(user.id)
    }
  }, [isAdmin, user?.id])

  useEffect(() => {
    if (!selectedUserId && user?.id) return
    setCloseResult(null)
    fetchStatus()
  }, [selectedUserId, user?.id])

  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === 'visible') fetchStatus(false)
    }

    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [selectedUserId, user?.id])

  useEffect(() => {
    if (!isOpen) return
    const id = window.setInterval(() => {
      fetchDetails()
    }, 15000)
    return () => window.clearInterval(id)
  }, [isOpen, selectedUserId, user?.id])

  const fetchUsers = async () => {
    try {
      const { data } = await api.get('/users')
      const list = Array.isArray(data) ? data : []
      setUsers(list)
      setSelectedUserId(current => current || user?.id || list[0]?.id || null)
    } catch (err) {
      console.error(err)
      if (user?.id) setSelectedUserId(user.id)
    }
  }

  const fetchStatus = async (showLoader = true) => {
    if (showLoader) setLoading(true)
    try {
      const status = await getCashStatus(cashParams)
      setIsOpen(status.isOpen)
      if (status.isOpen) {
        await fetchDetails()
      } else {
        setSummary(null)
        setMovements([])
        setPendingSales([])
      }
    } catch (err) {
      console.error(err)
    } finally {
      if (showLoader) setLoading(false)
    }
  }

  const fetchDetails = async () => {
    try {
      const [sum, movs, pending] = await Promise.all([
        getCashSummary(cashParams),
        getCashMovements(cashParams),
        getPendingPaymentSales(cashParams)
      ])
      setSummary(sum)
      setMovements(movs)
      setPendingSales(pending.items || [])
    } catch (err) {
      console.error(err)
    }
  }

  const handleOpenRegister = async (e: FormEvent) => {
    e.preventDefault()
    if (openingCash) return
    try {
      setOpeningCash(true)
      await openCashRegister({ 
        openingAmount: Number(openingAmount), 
        notes 
      })
      await fetchStatus()
      setOpeningAmount('')
      setNotes('')
    } catch (err: any) {
      alert(err.response?.data?.error || 'Error al abrir caja')
    } finally {
      setOpeningCash(false)
    }
  }

  const handleAddMovement = async (e: FormEvent) => {
    e.preventDefault()
    if (savingMovement) return
    try {
      setSavingMovement(true)
      await addCashMovement({
        type: movementType,
        amount: Number(movementAmount),
        description: movementDesc
      })
      setShowMovementModal(false)
      setMovementAmount('')
      setMovementDesc('')
      await fetchDetails()
    } catch (err: any) {
      alert(err.response?.data?.error || 'Error al registrar movimiento')
    } finally {
      setSavingMovement(false)
    }
  }

  const handleCloseRegister = async (e: FormEvent) => {
    e.preventDefault()
    if (closingCash) return
    try {
      setClosingCash(true)
      const res = await closeCashRegister({
        closingAmount: Number(closingAmount),
        notes
      })
      setCloseResult(res)
      setIsOpen(false)
      setShowCloseModal(false)
      setClosingAmount('')
      setNotes('')
    } catch (err: any) {
      alert(err.response?.data?.error || 'Error al cerrar caja')
    } finally {
      setClosingCash(false)
    }
  }

  const openCollectModal = (sale: {
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
  }) => {
    setCollectingSale(sale)
    const plannedMethod = String(sale.pendingPaymentMethod || '').toUpperCase()
    if (plannedMethod === 'CARD' || plannedMethod === 'DEPOSIT' || plannedMethod === 'CREDIT') setCollectPaymentMethod(plannedMethod as any)
    else setCollectPaymentMethod('CASH')
    setCollectReceivedAmount(String(sale.total))
    setCollectReferenceNumber(String(sale.pendingReferenceNumber || ''))
    setCollectPaymentDocument(null)
    setCollectCreditFrequency('MONTHLY')
    setCollectCreditDownPayment(String(sale.pendingDownPaymentAmount ?? 0))
    const plannedDownPaymentMethod = String(sale.pendingDownPaymentMethod || '').toUpperCase()
    if (plannedDownPaymentMethod === 'CARD' || plannedDownPaymentMethod === 'DEPOSIT') setCollectCreditDownPaymentMethod(plannedDownPaymentMethod as any)
    else setCollectCreditDownPaymentMethod('CASH')
    setCollectCreditDownPaymentReference(String(sale.pendingDownPaymentReference || ''))
    setCollectCreditDownPaymentDocument(null)
    setCollectCreditInstallments(buildCreditInstallmentDrafts(Number(sale.total || 0), 1, undefined, 'MONTHLY'))
    setShowCollectModal(true)
  }

  const regenerateCollectCreditInstallments = (count = collectCreditInstallments.length || 1) => {
    setCollectCreditInstallments(prev => buildCreditInstallmentDrafts(collectCreditBaseTotal, count, prev[0]?.dueDate, collectCreditFrequency))
  }

  const updateCollectCreditInstallment = (index: number, field: keyof CreditInstallmentDraft, value: string) => {
    setCollectCreditInstallments(prev => prev.map((installment, installmentIndex) => (
      installmentIndex === index
        ? { ...installment, [field]: value }
        : installment
    )))
  }

  const addCollectCreditInstallment = () => {
    setCollectCreditInstallments(prev => {
      const stepDays = getCreditFrequencyDays(collectCreditFrequency)
      const lastDueDate = prev[prev.length - 1]?.dueDate || addDaysToInputDate(new Date(), stepDays)
      return [
        ...prev,
        {
          amount: '0.00',
          dueDate: addDaysToInputDate(lastDueDate, stepDays),
        },
      ]
    })
  }

  const removeCollectCreditInstallment = (index: number) => {
    setCollectCreditInstallments(prev => {
      if (prev.length <= 1) return prev
      return prev.filter((_, installmentIndex) => installmentIndex !== index)
    })
  }

  const handleCollectPendingSale = async (e: FormEvent) => {
    e.preventDefault()
    if (!collectingSale || collectingPayment) return

    const received = Number(collectReceivedAmount || 0)
    const change = Math.max(0, received - Number(collectingSale.total || 0))

    if (collectPaymentMethod === 'CASH' && received < Number(collectingSale.total || 0)) {
      setCollectInlineAlert({ kind: 'error', text: 'El monto recibido es menor al total de la venta.' })
      return
    }
    if ((collectPaymentMethod === 'CARD' || collectPaymentMethod === 'DEPOSIT') && !collectReferenceNumber.trim()) {
      setCollectInlineAlert({ kind: 'error', text: 'Debes ingresar la referencia del pago.' })
      return
    }
    if (collectPaymentMethod === 'DEPOSIT' && !collectPaymentDocument) {
      setCollectInlineAlert({ kind: 'error', text: 'Debes adjuntar la foto del comprobante para depósito/transferencia.' })
      return
    }
    if (collectPaymentMethod === 'CREDIT' && collectDownPaymentAmount >= Number(collectingSale.total || 0) - 0.01) {
      setCollectInlineAlert({ kind: 'error', text: 'El enganche debe ser menor al total de la venta para poder generar cuotas.' })
      return
    }
    if (collectPaymentMethod === 'CREDIT' && collectDownPaymentAmount > 0) {
      if ((collectCreditDownPaymentMethod === 'CARD' || collectCreditDownPaymentMethod === 'DEPOSIT') && !collectCreditDownPaymentReference.trim()) {
        setCollectInlineAlert({ kind: 'error', text: 'Debes ingresar la referencia del enganche.' })
        return
      }
      if (collectCreditDownPaymentMethod === 'DEPOSIT' && !collectCreditDownPaymentDocument) {
        setCollectInlineAlert({ kind: 'error', text: 'Debes adjuntar la foto del comprobante del enganche.' })
        return
      }
    }

    if (collectPaymentMethod === 'CREDIT') {
      try {
        setCollectContractChecking(true)
        const meta = await getCreditContractBySale(collectingSale.id)
        if (!meta?.contract?.buyer_signed_at) {
          setCollectContractSigned(false)
          setCollectInlineAlert({ kind: 'error', text: 'Debes firmar el contrato antes de cobrar a crédito.', action: 'goCredits' })
          return
        }
        setCollectContractSigned(true)
      } catch (err: any) {
        setCollectInlineAlert({ kind: 'error', text: err?.response?.data?.error || 'No se pudo validar el contrato del crédito.' })
        return
      } finally {
        setCollectContractChecking(false)
      }
    }

    if (collectPaymentMethod === 'CREDIT') {
      void __dbgClientReport({
        point: 'collect-credit-before-validate',
        saleId: collectingSale.id,
        saleTotal: Number(collectingSale.total || 0),
        downPayment: collectDownPaymentAmount,
        creditBaseTotal: collectCreditBaseTotal,
        frequency: collectCreditFrequency,
        installmentsCount: collectCreditInstallments.length,
        installmentsAmounts: collectCreditInstallments.map(it => it.amount),
      })
    }

    if (collectPaymentMethod === 'CREDIT') {
      if (collectSaleInstallmentsLoading) {
        setCollectInlineAlert({ kind: 'warn', text: 'Cargando cuotas del crédito. Intenta de nuevo en un momento.' })
        return
      }
      if (collectSaleInstallments.length === 0) {
        setCollectInlineAlert({ kind: 'error', text: 'No hay cuotas preparadas para esta venta. Debe definirse el plan desde el vendedor.' })
        return
      }
    }

    try {
      setCollectingPayment(true)
      await collectPendingSalePayment(collectingSale.id, {
        paymentMethod: collectPaymentMethod,
        receivedAmount: collectPaymentMethod === 'CASH' ? received : 0,
        changeAmount: collectPaymentMethod === 'CASH' ? change : 0,
        referenceNumber: (collectPaymentMethod === 'CARD' || collectPaymentMethod === 'DEPOSIT') ? collectReferenceNumber : null,
        downPaymentAmount: collectPaymentMethod === 'CREDIT' ? collectDownPaymentAmount : undefined,
        downPaymentMethod: collectPaymentMethod === 'CREDIT' ? collectCreditDownPaymentMethod : undefined,
        downPaymentReference: collectPaymentMethod === 'CREDIT' ? collectCreditDownPaymentReference : undefined,
      },
      collectPaymentMethod === 'DEPOSIT' ? collectPaymentDocument : null,
      collectPaymentMethod === 'CREDIT' && collectCreditDownPaymentMethod === 'DEPOSIT'
        ? collectCreditDownPaymentDocument
        : null)
      setShowCollectModal(false)
      setCollectingSale(null)
      await fetchDetails()
      setCollectInlineAlert(null)
      alert(`Venta #${collectingSale.id} cobrada correctamente.`)
    } catch (err: any) {
      const msg = err?.response?.data?.error || 'Error al cobrar la venta pendiente'
      if (collectPaymentMethod === 'CREDIT' && String(msg).toLowerCase().includes('contrato')) {
        setCollectInlineAlert({ kind: 'error', text: `${msg}.`, action: 'goCredits' })
        return
      }
      setCollectInlineAlert({ kind: 'error', text: msg })
    } finally {
      setCollectingPayment(false)
    }
  }

  if (loading) return <div style={{ padding: 20 }}>Cargando estado de caja...</div>

  // Vista: Caja Cerrada -> Formulario Apertura
  if (!isOpen && !closeResult) {
    return (
      <div style={{ padding: isMobileViewport ? 14 : 20, maxWidth: 500, margin: '0 auto' }}>
        <div className="card">
          <h2>{isOwnCash ? 'Apertura de Caja' : 'Caja sin apertura activa'}</h2>
          {isAdmin && users.length > 0 && (
            <div style={{ marginBottom: 16 }}>
              <label style={{ display: 'block', marginBottom: 5 }}>Usuario a supervisar</label>
              <select
                value={selectedUserId || user?.id || ''}
                onChange={(e) => setSelectedUserId(Number(e.target.value))}
                style={{ width: '100%', padding: 10, borderRadius: 8, background: 'var(--modal)', color: 'var(--text)', border: '1px solid var(--border)' }}
              >
                {users.map(u => (
                  <option key={u.id} value={u.id}>{u.name}{u.role_name ? ` (${u.role_name})` : ''}</option>
                ))}
              </select>
            </div>
          )}
          {isOwnCash ? (
            <>
              <p style={{ color: 'var(--muted)', marginBottom: 20 }}>
                Hola, <strong>{user?.name}</strong>. No tienes una caja abierta actualmente.
              </p>
              <form onSubmit={handleOpenRegister}>
                <div style={{ marginBottom: 15 }}>
                  <label style={{ display: 'block', marginBottom: 5 }}>Monto Inicial (Base)</label>
                  <input 
                    type="number" 
                    step="0.01" 
                    min="0"
                    value={openingAmount}
                    onChange={e => setOpeningAmount(e.target.value)}
                    style={{ width: '100%', padding: 10, fontSize: '1.2rem' }}
                    placeholder="0.00"
                    required
                  />
                </div>
                <div style={{ marginBottom: 15 }}>
                  <label style={{ display: 'block', marginBottom: 5 }}>Notas (Opcional)</label>
                  <textarea 
                    value={notes}
                    onChange={e => setNotes(e.target.value)}
                    style={{ width: '100%', padding: 10 }}
                    rows={3}
                  />
                </div>
                <button type="submit" className="btn-primary" style={{ width: '100%', padding: 12 }} disabled={openingCash}>
                  {openingCash ? 'Abriendo caja...' : 'Abrir Caja'}
                </button>
              </form>
            </>
          ) : (
            <div style={{ color: 'var(--muted)', lineHeight: 1.5 }}>
              {selectedUser?.name || 'Este usuario'} no tiene una caja abierta en este momento. Puedes cambiar de usuario para supervisar otra caja.
            </div>
          )}
        </div>
      </div>
    )
  }

  // Vista: Resultado Cierre
  if (closeResult) {
    return (
      <div style={{ padding: isMobileViewport ? 14 : 20, maxWidth: 500, margin: '0 auto' }}>
        <div className="card" style={{ textAlign: 'center' }}>
          <h2>Caja Cerrada Correctamente</h2>
          <div style={{ margin: '20px 0', textAlign: 'left', background: 'var(--bg)', padding: 15, borderRadius: 8 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
              <span>Esperado por Sistema:</span>
              <strong>{formatMoney(closeResult.expected)}</strong>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
              <span>Monto Real (Conteo):</span>
              <strong>{formatMoney(closeResult.expected + closeResult.difference)}</strong>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', paddingTop: 8, borderTop: '1px solid var(--border)', color: closeResult.difference === 0 ? 'green' : 'red' }}>
              <span>Diferencia:</span>
              <strong>{closeResult.difference > 0 ? '+' : ''}{formatMoney(closeResult.difference)}</strong>
            </div>
          </div>
          <div style={{ display: 'flex', justifyContent: 'center', gap: 10, flexWrap: 'wrap' }}>
            <button type="button" onClick={handlePrintReport} className="btn-secondary">
              Imprimir Cierre
            </button>
            <button type="button" onClick={() => setCloseResult(null)} className="btn-primary">
              Volver (Abrir Nueva Caja)
            </button>
          </div>
        </div>
      </div>
    )
  }

  // Vista: Dashboard Caja Abierta
  return (
    <div style={{ padding: isMobileViewport ? 14 : 20, maxWidth: 1000, margin: '0 auto' }}>
      {isAdmin && users.length > 0 && (
        <div className="card" style={{ marginBottom: 16, background: isOwnCash ? undefined : 'rgba(59, 130, 246, 0.08)', border: '1px solid var(--border)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: isMobileViewport ? 'stretch' : 'center', flexDirection: isMobileViewport ? 'column' : 'row', gap: 12, flexWrap: 'wrap' }}>
            <div>
              <div style={{ fontWeight: 700 }}>Modo Supervisión</div>
              <div style={{ color: 'var(--muted)', fontSize: '0.9rem' }}>
                {isOwnCash ? 'Estás viendo tu caja activa.' : `Estás viendo la caja activa de ${selectedUser?.name || 'otro usuario'}.`}
              </div>
            </div>
            <select
              value={selectedUserId || user?.id || ''}
              onChange={(e) => setSelectedUserId(Number(e.target.value))}
              style={{ minWidth: isMobileViewport ? '100%' : 240, width: isMobileViewport ? '100%' : 'auto', padding: 10, borderRadius: 8, background: 'var(--modal)', color: 'var(--text)', border: '1px solid var(--border)' }}
            >
              {users.map(u => (
                <option key={u.id} value={u.id}>{u.name}{u.role_name ? ` (${u.role_name})` : ''}</option>
              ))}
            </select>
          </div>
        </div>
      )}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: isMobileViewport ? 'stretch' : 'center', flexDirection: isMobileViewport ? 'column' : 'row', gap: 14, marginBottom: 20 }}>
        <div>
          <h2 style={{ margin: 0 }}>Control de Caja</h2>
          <div style={{ color: 'var(--muted)', fontSize: '0.9rem' }}>
            Abierta el: {summary ? formatDateTime(new Date(summary.openingTime)) : ''}
          </div>
          <div style={{ color: 'var(--muted)', fontSize: '0.9rem' }}>
            Responsable: {isOwnCash ? `${user?.name} (${user?.role})` : (selectedUser?.name || '-')}
          </div>
        </div>
        {isOwnCash ? (
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', width: isMobileViewport ? '100%' : 'auto' }}>
            <button
              type="button"
              className="btn-secondary"
              onClick={handlePrintReport}
              style={{ width: isMobileViewport ? '100%' : 'auto' }}
            >
              Imprimir Caja
            </button>
            <button 
              type="button"
              className="btn-secondary"
              onClick={() => {
                  setMovementType('IN')
                  setShowMovementModal(true)
              }}
              style={{ flex: isMobileViewport ? '1 1 calc(50% - 5px)' : undefined }}
            >
              + Entrada
            </button>
            <button 
              type="button"
              className="btn-secondary"
              onClick={() => {
                  setMovementType('OUT')
                  setShowMovementModal(true)
              }}
              style={{ flex: isMobileViewport ? '1 1 calc(50% - 5px)' : undefined }}
            >
              - Salida
            </button>
            <button 
              type="button"
              className="btn-danger"
              onClick={() => setShowCloseModal(true)}
              style={{ width: isMobileViewport ? '100%' : 'auto' }}
            >
              Cerrar Caja
            </button>
          </div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', width: isMobileViewport ? '100%' : 'auto' }}>
            <button
              type="button"
              className="btn-secondary"
              onClick={handlePrintReport}
              style={{ width: isMobileViewport ? '100%' : 'auto' }}
            >
              Imprimir Caja
            </button>
            <div style={{ padding: '10px 12px', borderRadius: 10, background: 'rgba(59, 130, 246, 0.08)', color: 'var(--muted)', fontSize: '0.9rem' }}>
              Supervisando en modo lectura
            </div>
          </div>
        )}
      </div>

      {/* Cards Resumen */}
      <div style={{ display: 'grid', gridTemplateColumns: isMobileViewport ? 'repeat(2, minmax(0, 1fr))' : 'repeat(auto-fit, minmax(150px, 1fr))', gap: 15, marginBottom: 20 }}>
        <StatCard title="Saldo Inicial" value={summary?.openingAmount} color="#64748b" />
        <StatCard title="Ventas (Efectivo)" value={summary?.salesCash} color="#22c55e" />
        <StatCard title="Ventas (Depósito)" value={depositSales} color="#8b5cf6" />
        <StatCard title="Ventas (Tarjeta)" value={cardSales} color="#06b6d4" />
        <StatCard title="Ventas (Crédito)" value={creditSales} color="#f59e0b" />
        <StatCard title="Abonos Créd. (Efectivo)" value={creditPaymentCash} color="#14b8a6" />
        <StatCard title="Abonos Créd. (Depósito)" value={creditPaymentDeposit} color="#7c3aed" />
        <StatCard title="Abonos Créd. (Tarjeta)" value={creditPaymentCard} color="#0284c7" />
        <StatCard title="Entradas Extra" value={summary?.movementsIn} color="#3b82f6" />
        <StatCard title="Salidas / Gastos" value={summary?.movementsOut} color="#ef4444" negative />
        <StatCard title="Total Esperado" value={summary?.expectedCash} color="#eab308" highlight />
      </div>

      <div className="card" style={{ marginBottom: 20 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: isMobileViewport ? 'stretch' : 'center', flexDirection: isMobileViewport ? 'column' : 'row', gap: 10, marginBottom: 14 }}>
          <div>
            <h3 style={{ margin: 0 }}>Ventas Pendientes por Cobrar</h3>
            <div style={{ color: 'var(--muted)', fontSize: '0.9rem', marginTop: 4 }}>
              Cola enviada por vendedores para cobro en caja.
            </div>
          </div>
          <div style={{ padding: '8px 12px', borderRadius: 999, background: 'rgba(37, 99, 235, 0.1)', color: '#1d4ed8', fontWeight: 700 }}>
            {pendingSales.length} pendiente(s)
          </div>
        </div>

        {pendingSales.length === 0 ? (
          <div style={{ padding: 16, textAlign: 'center', color: 'var(--muted)', background: 'var(--surface)', borderRadius: 12 }}>
            No hay ventas pendientes en esta caja.
          </div>
        ) : (
          <div style={{ display: 'grid', gap: 10 }}>
            {pendingSales.map(sale => (
              <div
                key={sale.id}
                style={{
                  display: 'grid',
                  gridTemplateColumns: isMobileViewport ? '1fr' : 'minmax(0, 1fr) auto',
                  gap: 12,
                  padding: 14,
                  borderRadius: 12,
                  border: '1px solid var(--border)',
                  background: 'var(--surface)'
                }}
              >
                <div style={{ display: 'grid', gap: 6 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                    <strong>Venta #{sale.id}</strong>
                    <span style={{ color: 'var(--muted)', fontSize: '0.9rem' }}>{formatDateTime(new Date(sale.createdAt))}</span>
                  </div>
                  <div style={{ color: 'var(--muted)', fontSize: '0.92rem' }}>
                    Cliente: <strong style={{ color: 'var(--text)' }}>{sale.customerName}</strong> | Vendedor: <strong style={{ color: 'var(--text)' }}>{sale.sellerName}</strong>
                  </div>
                  <div style={{ color: 'var(--muted)', fontSize: '0.92rem' }}>
                    Ítems: {sale.itemsCount} | Total: <strong style={{ color: 'var(--text)' }}>{formatMoney(sale.total)}</strong>
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: isMobileViewport ? 'stretch' : 'center' }}>
                  {isOwnCash ? (
                    <button type="button" className="btn-primary" onClick={() => openCollectModal(sale)} style={{ width: isMobileViewport ? '100%' : 'auto' }}>
                      Cobrar
                    </button>
                  ) : (
                    <div style={{ padding: '10px 12px', borderRadius: 10, background: 'rgba(59, 130, 246, 0.08)', color: 'var(--muted)', fontSize: '0.9rem' }}>
                      Solo lectura
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: isMobileViewport ? '1fr' : '1fr 1fr', gap: 20 }}>
        {/* Ventas por Método */}
        <div className="card">
          <h3>Ventas por Método</h3>
          {isMobileViewport ? (
            <div style={{ display: 'grid', gap: 10 }}>
              {summary && Object.entries(summary.salesByMethod).map(([method, total]: any) => (
                <div key={method} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: 10, borderRadius: 10, background: 'var(--surface)' }}>
                  <span>{translateMethod(method)}</span>
                  <strong>{formatMoney(total)}</strong>
                </div>
              ))}
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: 10, borderRadius: 10, background: 'rgba(234, 179, 8, 0.1)', fontWeight: 'bold' }}>
                <span>Total Ventas</span>
                <strong>{formatMoney(summary?.totalSales)}</strong>
              </div>
            </div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <tbody>
                {summary && Object.entries(summary.salesByMethod).map(([method, total]: any) => (
                  <tr key={method} style={{ borderBottom: '1px solid var(--border)' }}>
                    <td style={{ padding: 8 }}>{translateMethod(method)}</td>
                    <td style={{ padding: 8, textAlign: 'right' }}>{formatMoney(total)}</td>
                  </tr>
                ))}
                <tr style={{ fontWeight: 'bold' }}>
                  <td style={{ padding: 8 }}>Total Ventas</td>
                  <td style={{ padding: 8, textAlign: 'right' }}>{formatMoney(summary?.totalSales)}</td>
                </tr>
              </tbody>
            </table>
          )}
        </div>

        <div className="card">
          <h3>Abonos a Crédito por Método</h3>
          {isMobileViewport ? (
            <div style={{ display: 'grid', gap: 10, marginBottom: 16 }}>
              {Object.keys(creditPaymentsByMethod).length === 0 ? (
                <div style={{ padding: 12, textAlign: 'center', color: 'var(--muted)', background: 'var(--surface)', borderRadius: 10 }}>
                  Sin abonos de crédito en este turno.
                </div>
              ) : (
                Object.entries(creditPaymentsByMethod).map(([method, total]: any) => (
                  <div key={method} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: 10, borderRadius: 10, background: 'var(--surface)' }}>
                    <span>{translateMethod(method)}</span>
                    <strong>{formatMoney(total)}</strong>
                  </div>
                ))
              )}
            </div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 16 }}>
              <tbody>
                {Object.keys(creditPaymentsByMethod).length === 0 ? (
                  <tr>
                    <td colSpan={2} style={{ padding: 12, textAlign: 'center', color: 'var(--muted)' }}>
                      Sin abonos de crédito en este turno.
                    </td>
                  </tr>
                ) : (
                  Object.entries(creditPaymentsByMethod).map(([method, total]: any) => (
                    <tr key={method} style={{ borderBottom: '1px solid var(--border)' }}>
                      <td style={{ padding: 8 }}>{translateMethod(method)}</td>
                      <td style={{ padding: 8, textAlign: 'right' }}>{formatMoney(total)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          )}

          <h3>Movimientos de Efectivo</h3>
          <div style={{ maxHeight: 300, overflowY: 'auto' }}>
            {movements.length === 0 ? (
                <div style={{ color: 'var(--muted)', textAlign: 'center', padding: 20 }}>Sin movimientos</div>
            ) : isMobileViewport ? (
                <div style={{ display: 'grid', gap: 10 }}>
                  {movements.map(m => (
                    <div key={m.id} style={{ padding: 10, borderRadius: 10, background: 'var(--surface)', display: 'grid', gap: 6 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                        <span style={{ fontSize: '0.85rem', color: 'var(--muted)' }}>{formatDateTime(new Date(m.created_at)).split(' ')[1]}</span>
                        <span style={{
                          padding: '2px 6px',
                          borderRadius: 4,
                          background: m.type === 'IN' ? 'rgba(34, 197, 94, 0.1)' : 'rgba(239, 68, 68, 0.1)',
                          color: m.type === 'IN' ? '#22c55e' : '#ef4444',
                          fontSize: '0.75rem',
                          fontWeight: 'bold'
                        }}>
                          {m.type === 'IN' ? 'ENTRADA' : 'SALIDA'}
                        </span>
                      </div>
                      <div style={{ fontSize: '0.9rem' }}>{m.description}</div>
                      <div style={{ textAlign: 'right', fontWeight: 700 }}>{formatMoney(m.amount)}</div>
                    </div>
                  ))}
                </div>
            ) : (
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                        <tr style={{ borderBottom: '2px solid var(--border)', textAlign: 'left', fontSize: '0.85rem' }}>
                            <th style={{ padding: 5 }}>Hora</th>
                            <th style={{ padding: 5 }}>Tipo</th>
                            <th style={{ padding: 5 }}>Desc.</th>
                            <th style={{ padding: 5, textAlign: 'right' }}>Monto</th>
                        </tr>
                    </thead>
                    <tbody>
                        {movements.map(m => (
                            <tr key={m.id} style={{ borderBottom: '1px solid var(--border)' }}>
                                <td style={{ padding: 5, fontSize: '0.85rem' }}>{formatDateTime(new Date(m.created_at)).split(' ')[1]}</td>
                                <td style={{ padding: 5 }}>
                                    <span style={{ 
                                        padding: '2px 6px', 
                                        borderRadius: 4, 
                                        background: m.type === 'IN' ? 'rgba(34, 197, 94, 0.1)' : 'rgba(239, 68, 68, 0.1)',
                                        color: m.type === 'IN' ? '#22c55e' : '#ef4444',
                                        fontSize: '0.75rem',
                                        fontWeight: 'bold'
                                    }}>
                                        {m.type === 'IN' ? 'ENTRADA' : 'SALIDA'}
                                    </span>
                                </td>
                                <td style={{ padding: 5, fontSize: '0.9rem' }}>{m.description}</td>
                                <td style={{ padding: 5, textAlign: 'right', fontWeight: 600 }}>{formatMoney(m.amount)}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}
          </div>
        </div>
      </div>

      {/* Modal Movimiento */}
      {showMovementModal && (
        <Modal mobile={isMobileViewport} onClose={() => setShowMovementModal(false)} title={`Registrar ${movementType === 'IN' ? 'Entrada' : 'Salida'}`}>
          <form onSubmit={handleAddMovement}>
             <div style={{ marginBottom: 15 }}>
                <label>Monto</label>
                <input 
                    type="number" 
                    step="0.01" 
                    min="0.01"
                    value={movementAmount}
                    onChange={e => setMovementAmount(e.target.value)}
                    style={{ width: '100%', padding: 10, fontSize: '1.2rem' }}
                    autoFocus
                    required
                />
             </div>
             <div style={{ marginBottom: 15 }}>
                <label>Descripción / Motivo</label>
                <input 
                    type="text" 
                    value={movementDesc}
                    onChange={e => setMovementDesc(e.target.value)}
                    style={{ width: '100%', padding: 10 }}
                    placeholder="Ej. Pago de luz, Cambio inicial..."
                    required
                />
             </div>
             <div style={{ display: 'flex', justifyContent: 'flex-end', flexDirection: isMobileViewport ? 'column' : 'row', gap: 10 }}>
                <button type="button" onClick={() => setShowMovementModal(false)} className="btn-secondary" style={{ width: isMobileViewport ? '100%' : 'auto' }} disabled={savingMovement}>Cancelar</button>
                <button type="submit" className="btn-primary" style={{ width: isMobileViewport ? '100%' : 'auto' }} disabled={savingMovement}>
                  {savingMovement ? 'Registrando...' : 'Registrar'}
                </button>
             </div>
          </form>
        </Modal>
      )}

      {/* Modal Cierre */}
      {showCloseModal && (
        <Modal mobile={isMobileViewport} onClose={() => setShowCloseModal(false)} title="Cierre de Caja">
           <div style={{ marginBottom: 20, padding: 15, background: 'var(--bg)', borderRadius: 8 }}>
              <div style={{ fontSize: '0.9rem', color: 'var(--muted)' }}>Total Esperado en Sistema</div>
              <div style={{ fontSize: '1.5rem', fontWeight: 'bold' }}>{formatMoney(summary?.expectedCash)}</div>
           </div>
           <form onSubmit={handleCloseRegister}>
             <div style={{ marginBottom: 15 }}>
                <label>Monto Real (Conteo Físico)</label>
                <input 
                    type="number" 
                    step="0.01" 
                    min="0"
                    value={closingAmount}
                    onChange={e => setClosingAmount(e.target.value)}
                    style={{ width: '100%', padding: 10, fontSize: '1.5rem', fontWeight: 'bold' }}
                    required
                />
             </div>
             {closingAmount && (
                 <div style={{ marginBottom: 15, textAlign: 'right', fontWeight: 'bold', color: (Number(closingAmount) - (summary?.expectedCash || 0)) === 0 ? 'green' : 'red' }}>
                    Diferencia: {formatMoney(Number(closingAmount) - (summary?.expectedCash || 0))}
                 </div>
             )}
             <div style={{ marginBottom: 15 }}>
                <label>Notas de Cierre</label>
                <textarea 
                    value={notes}
                    onChange={e => setNotes(e.target.value)}
                    style={{ width: '100%', padding: 10 }}
                    rows={3}
                    placeholder="Observaciones..."
                />
             </div>
             <div style={{ display: 'flex', justifyContent: 'flex-end', flexDirection: isMobileViewport ? 'column' : 'row', gap: 10 }}>
                <button type="button" onClick={() => setShowCloseModal(false)} className="btn-secondary" style={{ width: isMobileViewport ? '100%' : 'auto' }} disabled={closingCash}>Cancelar</button>
                <button type="submit" className="btn-danger" style={{ width: isMobileViewport ? '100%' : 'auto' }} disabled={closingCash}>
                  {closingCash ? 'Cerrando caja...' : 'Confirmar Cierre'}
                </button>
             </div>
           </form>
        </Modal>
      )}

      {showCollectModal && collectingSale && (
        <Modal mobile={isMobileViewport} width={720} onClose={() => setShowCollectModal(false)} title={`Cobrar venta #${collectingSale.id}`}>
          <div style={{ marginBottom: 16, padding: 14, background: 'var(--bg)', borderRadius: 10 }}>
            <div style={{ marginBottom: 6 }}><strong>Cliente:</strong> {collectingSale.customerName}</div>
            <div style={{ marginBottom: 6 }}><strong>Vendedor:</strong> {collectingSale.sellerName}</div>
            <div style={{ marginBottom: 6 }}><strong>Ítems:</strong> {collectingSale.itemsCount}</div>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
              <strong>Total:</strong>
              <span style={{ fontWeight: 800, overflowX: 'auto', whiteSpace: 'nowrap', maxWidth: '65%' }}>
                {formatMoney(collectingSale.total)}
              </span>
            </div>
          </div>

          <form onSubmit={handleCollectPendingSale}>
            {collectInlineAlert && (
              <div
                style={{
                  marginBottom: 14,
                  padding: '10px 12px',
                  borderRadius: 10,
                  border: collectInlineAlert.kind === 'error'
                    ? '1px solid rgba(239, 68, 68, 0.25)'
                    : (collectInlineAlert.kind === 'warn'
                      ? '1px solid rgba(245, 158, 11, 0.25)'
                      : '1px solid rgba(22, 163, 74, 0.25)'),
                  background: collectInlineAlert.kind === 'error'
                    ? 'rgba(239, 68, 68, 0.08)'
                    : (collectInlineAlert.kind === 'warn'
                      ? 'rgba(245, 158, 11, 0.08)'
                      : 'rgba(22, 163, 74, 0.08)'),
                  color: collectInlineAlert.kind === 'error'
                    ? '#ef4444'
                    : (collectInlineAlert.kind === 'warn' ? '#f59e0b' : '#16a34a'),
                  fontWeight: 800,
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  gap: 12,
                  flexWrap: 'wrap',
                }}
              >
                <div>{collectInlineAlert.text}</div>
                {collectInlineAlert.action === 'goCredits' && collectingSale && (
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => {
                      setShowCollectModal(false)
                      setCollectingSale(null)
                      navigate(`/credits?saleId=${collectingSale.id}`)
                    }}
                    disabled={collectingPayment}
                    style={{ whiteSpace: 'nowrap' }}
                  >
                    Ir a firmar
                  </button>
                )}
              </div>
            )}
            <div style={{ marginBottom: 15 }}>
              <label style={{ display: 'block', marginBottom: 8 }}>Tipo de venta (definido por vendedor)</label>
              <div style={{ padding: 10, borderRadius: 10, background: 'var(--bg)', border: '1px solid var(--border)', fontWeight: 800 }}>
                {collectPaymentMethod === 'CREDIT'
                  ? 'Crédito (por cuotas)'
                  : (collectPaymentMethod === 'CARD'
                    ? 'Contado (Tarjeta)'
                    : (collectPaymentMethod === 'DEPOSIT'
                      ? 'Contado (Depósito / Transferencia)'
                      : 'Contado (Efectivo)'))}
              </div>
            </div>

            {collectPaymentMethod === 'CASH' && (
              <div style={{ marginBottom: 15 }}>
                <label style={{ display: 'block', marginBottom: 8 }}>Monto recibido</label>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={collectReceivedAmount}
                  onChange={e => setCollectReceivedAmount(e.target.value)}
                  style={{ width: '100%', padding: 10, fontSize: '1.2rem' }}
                  required
                />
                <div style={{ marginTop: 8, textAlign: 'right', fontWeight: 700, color: Number(collectReceivedAmount || 0) >= Number(collectingSale.total || 0) ? '#16a34a' : '#dc2626' }}>
                  Cambio: {formatMoney(Math.max(0, Number(collectReceivedAmount || 0) - Number(collectingSale.total || 0)))}
                </div>
              </div>
            )}

            {(collectPaymentMethod === 'CARD' || collectPaymentMethod === 'DEPOSIT') && (
              <div style={{ marginBottom: 15 }}>
                <label style={{ display: 'block', marginBottom: 8 }}>Referencia</label>
                <input
                  type="text"
                  value={collectReferenceNumber}
                  onChange={e => setCollectReferenceNumber(e.target.value)}
                  style={{ width: '100%', padding: 10 }}
                  placeholder="Número de operación o referencia"
                  required
                />
              </div>
            )}

            {collectPaymentMethod === 'DEPOSIT' && (
              <div style={{ marginBottom: 15 }}>
                <label style={{ display: 'block', marginBottom: 8 }}>Foto del comprobante (obligatorio)</label>
                <input
                  type="file"
                  accept="image/*"
                  capture="environment"
                  onChange={(e) => setCollectPaymentDocument(e.target.files?.[0] || null)}
                  style={{ width: '100%', padding: 10, borderRadius: 8, background: 'var(--modal)', color: 'var(--text)', border: '1px solid var(--border)' }}
                  required
                />
                {collectPaymentDocumentPreview && (
                  <div style={{ marginTop: 10 }}>
                    <img src={collectPaymentDocumentPreview} alt="Comprobante" style={{ width: '100%', maxHeight: 240, objectFit: 'contain', borderRadius: 10, border: '1px solid var(--border)', background: 'var(--surface)' }} />
                    <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
                      <button type="button" className="btn-secondary" onClick={() => setCollectPaymentDocument(null)}>
                        Quitar foto
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {collectPaymentMethod === 'CREDIT' && (
              <div style={{ display: 'grid', gap: 12, marginBottom: 15 }}>
                <div style={{ padding: 12, borderRadius: 10, background: 'rgba(245, 158, 11, 0.1)', color: 'var(--text)' }}>
                  Venta a crédito preparada por el vendedor. Caja únicamente registra el cobro del enganche.
                </div>

                <div style={{ padding: 12, borderRadius: 10, background: 'rgba(59, 130, 246, 0.12)', color: 'var(--text)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                  <div style={{ fontWeight: 800 }}>
                    Contrato: {collectContractChecking ? 'Verificando...' : (collectContractSigned ? 'Firmado' : 'Pendiente de firma')}
                  </div>
                  {!collectContractSigned && (
                    <button
                      type="button"
                      className="btn-secondary"
                      onClick={() => {
                        if (!collectingSale) return
                        setShowCollectModal(false)
                        setCollectingSale(null)
                        navigate(`/credits?saleId=${collectingSale.id}`)
                      }}
                      style={{ whiteSpace: 'nowrap' }}
                    >
                      Ir a firmar
                    </button>
                  )}
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: isMobileViewport ? '1fr' : 'minmax(0, 1.2fr) minmax(0, 0.8fr)', gap: 10 }}>
                  <div style={{ padding: 12, borderRadius: 10, border: '1px solid var(--border)', background: 'var(--surface)' }}>
                    <div style={{ fontWeight: 800, marginBottom: 10 }}>Enganche</div>
                    <div style={{ display: 'grid', gap: 10 }}>
                      <div>
                        <label style={{ display: 'block', marginBottom: 6, fontWeight: 700, color: 'var(--muted)' }}>Monto</label>
                        <input
                          type="number"
                          value={collectCreditDownPayment}
                          disabled
                          style={{ width: '100%', padding: 10, borderRadius: 8, background: 'var(--bg)', color: 'var(--text)', border: '1px solid var(--border)' }}
                        />
                      </div>
                      <div>
                        <label style={{ display: 'block', marginBottom: 6, fontWeight: 700, color: 'var(--muted)' }}>Método</label>
                        <input
                          type="text"
                          value={collectCreditDownPaymentMethod === 'CARD' ? 'Tarjeta' : (collectCreditDownPaymentMethod === 'DEPOSIT' ? 'Depósito / Transferencia' : 'Efectivo')}
                          disabled
                          style={{ width: '100%', padding: 10, borderRadius: 8, background: 'var(--bg)', color: 'var(--text)', border: '1px solid var(--border)' }}
                        />
                      </div>
                      {(collectCreditDownPaymentMethod === 'CARD' || collectCreditDownPaymentMethod === 'DEPOSIT') && (
                        <div>
                          <label style={{ display: 'block', marginBottom: 6, fontWeight: 700, color: 'var(--muted)' }}>Referencia</label>
                          <input
                            type="text"
                            value={collectCreditDownPaymentReference}
                            onChange={e => setCollectCreditDownPaymentReference(e.target.value)}
                            placeholder="Número de operación o referencia"
                            required={collectDownPaymentAmount > 0}
                            style={{ width: '100%', padding: 10, borderRadius: 8, background: 'var(--modal)', color: 'var(--text)', border: '1px solid var(--border)' }}
                          />
                        </div>
                      )}

                      {collectCreditDownPaymentMethod === 'DEPOSIT' && (
                        <div>
                          <label style={{ display: 'block', marginBottom: 6, fontWeight: 700, color: 'var(--muted)' }}>Foto del comprobante (Enganche)</label>
                          <input
                            type="file"
                            accept="image/*"
                            capture="environment"
                            onChange={(e) => setCollectCreditDownPaymentDocument(e.target.files?.[0] || null)}
                            style={{ width: '100%', padding: 10, borderRadius: 8, background: 'var(--modal)', color: 'var(--text)', border: '1px solid var(--border)' }}
                            required={collectDownPaymentAmount > 0}
                          />
                          {collectCreditDownPaymentDocumentPreview && (
                            <div style={{ marginTop: 10 }}>
                              <img src={collectCreditDownPaymentDocumentPreview} alt="Comprobante" style={{ width: '100%', maxHeight: 240, objectFit: 'contain', borderRadius: 10, border: '1px solid var(--border)', background: 'var(--surface)' }} />
                              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
                                <button type="button" className="btn-secondary" onClick={() => setCollectCreditDownPaymentDocument(null)}>
                                  Quitar foto
                                </button>
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>

                  <div style={{ padding: 12, borderRadius: 10, border: '1px solid var(--border)', background: 'var(--surface)', alignSelf: 'start', height: 'fit-content' }}>
                    <div style={{ fontSize: '0.8rem', color: 'var(--muted)' }}>Saldo a crédito</div>
                    <div style={{ fontWeight: 800, marginTop: 4 }}>{formatMoney(collectCreditBaseTotal)}</div>
                    <div style={{ marginTop: 10, fontSize: '0.8rem', color: 'var(--muted)' }}>Cuotas (pendientes)</div>
                    <div style={{ fontWeight: 800, marginTop: 4 }}>{collectSaleInstallments.length}</div>
                  </div>
                </div>

                <div style={{ padding: 12, borderRadius: 10, border: '1px solid var(--border)', background: 'var(--surface)' }}>
                  <div style={{ fontWeight: 800, marginBottom: 10 }}>Cuotas</div>
                  {collectSaleInstallmentsLoading ? (
                    <div style={{ color: 'var(--muted)', fontWeight: 700 }}>Cargando cuotas...</div>
                  ) : (collectSaleInstallments.length === 0 ? (
                    <div style={{ color: '#ef4444', fontWeight: 800 }}>
                      No hay cuotas preparadas para esta venta. Regrésala al vendedor para definir el plan.
                    </div>
                  ) : (
                    <div style={{ display: 'grid', gap: 10 }}>
                      {collectSaleInstallments.map((installment, index) => (
                        <div key={installment.id || index} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, padding: 10, borderRadius: 10, border: '1px solid var(--border)', background: 'var(--bg)' }}>
                          <div style={{ fontWeight: 800 }}>Cuota {index + 1}</div>
                          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                            <div style={{ color: 'var(--muted)', fontWeight: 700 }}>Vence: {String(installment.due_date || '').slice(0, 10)}</div>
                            <div style={{ fontWeight: 800, whiteSpace: 'nowrap' }}>{formatMoney(installment.amount)}</div>
                          </div>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: isMobileViewport ? '1fr' : 'repeat(4, minmax(0, 1fr))', gap: 10 }}>
                  <div style={{ padding: 10, borderRadius: 8, background: 'var(--surface)', border: '1px solid var(--border)' }}>
                    <div style={{ fontSize: '0.8rem', color: 'var(--muted)' }}>Total venta</div>
                    <div style={{ fontWeight: 800, marginTop: 4, overflowX: 'auto', whiteSpace: 'nowrap' }}>{formatMoney(collectingSale.total)}</div>
                  </div>
                  <div style={{ padding: 10, borderRadius: 8, background: 'var(--surface)', border: '1px solid var(--border)' }}>
                    <div style={{ fontSize: '0.8rem', color: 'var(--muted)' }}>Enganche</div>
                    <div style={{ fontWeight: 800, marginTop: 4, overflowX: 'auto', whiteSpace: 'nowrap' }}>{formatMoney(collectDownPaymentAmount)}</div>
                  </div>
                  <div style={{ padding: 10, borderRadius: 8, background: 'var(--surface)', border: '1px solid var(--border)' }}>
                    <div style={{ fontSize: '0.8rem', color: 'var(--muted)' }}>Total cuotas</div>
                    <div style={{ fontWeight: 800, marginTop: 4, overflowX: 'auto', whiteSpace: 'nowrap' }}>{formatMoney(collectPreparedInstallmentsTotal)}</div>
                  </div>
                  <div style={{ padding: 10, borderRadius: 8, background: 'var(--surface)', border: '1px solid var(--border)' }}>
                    <div style={{ fontSize: '0.8rem', color: 'var(--muted)' }}>Saldo a crédito</div>
                    <div style={{ fontWeight: 800, marginTop: 4, overflowX: 'auto', whiteSpace: 'nowrap' }}>{formatMoney(collectCreditBaseTotal)}</div>
                  </div>
                </div>
              </div>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end', flexDirection: isMobileViewport ? 'column' : 'row', gap: 10 }}>
              <button type="button" onClick={() => setShowCollectModal(false)} className="btn-secondary" style={{ width: isMobileViewport ? '100%' : 'auto' }} disabled={collectingPayment}>
                Cancelar
              </button>
              <button type="submit" className="btn-primary" style={{ width: isMobileViewport ? '100%' : 'auto' }} disabled={collectingPayment}>
                {collectingPayment ? 'Cobrando...' : 'Confirmar cobro'}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  )
}

function StatCard({ title, value, color, negative, highlight }: any) {
    return (
        <div className="card" style={{ borderLeft: `4px solid ${color}`, background: highlight ? 'rgba(234, 179, 8, 0.1)' : undefined }}>
            <div style={{ fontSize: '0.85rem', color: 'var(--muted)', marginBottom: 5 }}>{title}</div>
            <div style={{ fontSize: '1.4rem', fontWeight: 'bold', color: 'var(--text)' }}>
                {negative ? '-' : ''}{formatMoney(value)}
            </div>
        </div>
    )
}

function Modal({ children, onClose, title, mobile, width }: any) {
    return (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', justifyContent: 'center', alignItems: mobile ? 'flex-end' : 'center', zIndex: 1000, padding: mobile ? 0 : 16 }}>
            <div style={{ background: 'var(--modal)', padding: mobile ? 14 : 20, borderRadius: mobile ? '18px 18px 0 0' : 12, width: mobile ? '100%' : (width ?? 520), maxWidth: mobile ? '100%' : '98%', maxHeight: mobile ? '88vh' : '90vh', overflowY: 'auto', overflowX: 'auto', boxShadow: '0 4px 20px rgba(0,0,0,0.2)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 15 }}>
                    <h3 style={{ margin: 0 }}>{title}</h3>
                    <button type="button" onClick={onClose} style={{ background: 'none', border: 'none', fontSize: '1.2rem', cursor: 'pointer' }}>×</button>
                </div>
                {children}
            </div>
        </div>
    )
}

function translateMethod(method: string) {
    const map: any = {
        'CASH': 'Efectivo',
        'CARD': 'Tarjeta',
        'DEPOSIT': 'Depósito/Transferencia',
        'TRANSFER': 'Depósito/Transferencia',
        'CREDIT': 'Crédito'
    }
    return map[method] || method
}

function formatMoney(value: unknown) {
    return formatNumber(Number(value || 0))
}

function escapeHtml(value: string) {
    return value
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;')
}
