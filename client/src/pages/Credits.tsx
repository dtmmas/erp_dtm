import { useEffect, useMemo, useState } from 'react'
import { useLocation } from 'react-router-dom'
import {
  generateCreditContractBySale,
  getCreditContractBySale,
  getCreditContractHtmlBySale,
  getCreditContractSettlementHtmlBySale,
  getCredits,
  getConfig,
  getCreditSalePayments,
  getSaleDetails,
  payCredit,
  payCreditSale,
} from '../api'
import { formatDate, formatDateTime } from '../utils/date'
import { formatMoney as formatCurrency } from '../utils/currency'
import { buildPrintLogoHtml } from '../utils/printBranding'
import CameraCaptureButton from '../components/CameraCaptureButton'
import SignaturePad from '../components/SignaturePad'
import { useAuthStore } from '../store/auth'
import { GUATEMALA_DEPARTMENTS, getGuatemalaMunicipalities } from '../data/gt_locations'

interface Credit {
  id: number
  sale_id: number
  due_date: string
  total_amount: number | string
  sale_total?: number | string
  paid: number
  doc_no: string
  sale_date: string
  customer_name: string
  paid_amount: number | string
  penalty_paid_amount?: number | string
  penalty_accrued?: number | string
  penalty_due?: number | string
  penalty_waived?: number
  installments_count?: number
  installment_number?: number
}

interface Payment {
  id: number
  amount: string | number
  payment_type?: string
  payment_method: string
  reference: string
  created_at: string
  received_by: string
  document_url?: string
  installment_id?: number
  installment_due_date?: string
  installment_amount?: string | number
  installment_number?: number
}

interface Config {
  currency: string
  name?: string
  logoUrl?: string
}

type GroupedCredit = {
  sale_id: number
  doc_no: string
  sale_date: string
  customer_name: string
  sale_total: number
  installments_count: number
  total_paid: number
  total_pending: number
  next_due_date: string
  is_fully_paid: boolean
  first_pending_installment: Credit | null
}

function getInstallmentLabel(credit: Credit) {
  return credit.installments_count && credit.installments_count > 1
    ? `Cuota ${credit.installment_number || 1} de ${credit.installments_count}`
    : 'Cuota única'
}

function getInstallmentPrincipalPending(credit: Pick<Credit, 'total_amount' | 'paid_amount'>) {
  return Math.max(0, Number(credit.total_amount || 0) - Number(credit.paid_amount || 0))
}

function getInstallmentPending(credit: Pick<Credit, 'total_amount' | 'paid_amount' | 'penalty_due'>) {
  const principal = getInstallmentPrincipalPending(credit)
  const penalty = Math.max(0, Number(credit.penalty_due || 0))
  return Math.max(0, Math.round((principal + penalty) * 100) / 100)
}

function getCreditPaidTotal(installments: Array<Pick<Credit, 'paid_amount' | 'penalty_paid_amount'>>) {
  return installments.reduce((sum, installment) => sum + Number(installment.paid_amount || 0) + Number(installment.penalty_paid_amount || 0), 0)
}

function getCreditGrandTotal(installments: Array<Pick<Credit, 'total_amount' | 'paid_amount'>>) {
  return installments.reduce((sum, installment) => sum + Number(installment.total_amount || 0), 0)
}

function getNextPayableInstallment<T extends Pick<Credit, 'paid' | 'id' | 'due_date' | 'total_amount' | 'paid_amount'>>(installments: T[]) {
  return [...installments]
    .filter(installment => installment.paid !== 1 && getInstallmentPending(installment) >= 0.01)
    .sort((a, b) => {
      const aDate = new Date(a.due_date).getTime()
      const bDate = new Date(b.due_date).getTime()
      if (aDate !== bDate) return aDate - bDate
      return a.id - b.id
    })[0] || null
}

function openHtmlInNewWindow(html: string) {
  const win = window.open('', '_blank')
  if (!win) return alert('El navegador bloqueó la ventana emergente. Permite popups para imprimir el contrato.')
  win.document.open()
  win.document.write(html)
  win.document.close()
  win.focus()
  setTimeout(() => {
    try {
      win.print()
    } catch {}
  }, 250)
}

function getApiErrorMessage(err: any, fallback: string) {
  const data = err?.response?.data
  if (data && typeof data === 'object' && typeof data.error === 'string') return data.error
  if (typeof data === 'string') {
    const raw = data.trim()
    try {
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed.error === 'string') return parsed.error
    } catch {}
    if (raw) return raw
  }
  if (typeof err?.message === 'string' && err.message.trim()) return err.message
  return fallback
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

export default function Credits() {
  const user = useAuthStore(s => s.user)
  const location = useLocation()
  const [credits, setCredits] = useState<Credit[]>([])
  const [loading, setLoading] = useState(false)
  const [search, setSearch] = useState('')
  const [config, setConfig] = useState<Config | null>(null)
  const [isMobileViewport, setIsMobileViewport] = useState(false)
  const [autoContractSaleHandled, setAutoContractSaleHandled] = useState<number | null>(null)
  
  // Modal state
  const [selectedCredit, setSelectedCredit] = useState<Credit | null>(null)
  const [payAmount, setPayAmount] = useState('')
  const [paymentMethod, setPaymentMethod] = useState('CASH')
  const [reference, setReference] = useState('')
  const [paymentDate, setPaymentDate] = useState('')
  const [responsible, setResponsible] = useState('')
  const [documentFile, setDocumentFile] = useState<File | null>(null)
  const [waivePenalty, setWaivePenalty] = useState(false)
  const [payMode, setPayMode] = useState<'INSTALLMENT' | 'DISTRIBUTE'>('INSTALLMENT')
  const [processingPayment, setProcessingPayment] = useState(false)

  // History state
  const [historyModalOpen, setHistoryModalOpen] = useState(false)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyError, setHistoryError] = useState('')
  const [historyPayments, setHistoryPayments] = useState<Payment[]>([])
  const [selectedCreditHistory, setSelectedCreditHistory] = useState<GroupedCredit | null>(null)

  const [contractInfo, setContractInfo] = useState<any | null>(null)
  const [contractLoading, setContractLoading] = useState(false)
  const [contractModalOpen, setContractModalOpen] = useState(false)
  const [contractSaleId, setContractSaleId] = useState<number | null>(null)
  const [contractSignatureFile, setContractSignatureFile] = useState<File | null>(null)
  const [contractCustomer, setContractCustomer] = useState({
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
  const [contractWarrantyTime, setContractWarrantyTime] = useState('')
  const [contractRefs, setContractRefs] = useState<Array<{ name: string; phone: string }>>([
    { name: '', phone: '' },
    { name: '', phone: '' },
    { name: '', phone: '' },
    { name: '', phone: '' },
  ])
  const guatemalaDepartments = useMemo(() => GUATEMALA_DEPARTMENTS.map(d => d.name), [])
  const guatemalaMunicipalities = useMemo(() => getGuatemalaMunicipalities(contractCustomer.department), [contractCustomer.department])

  useEffect(() => {
    loadCredits()
    getConfig().then(setConfig)
  }, [])

  useEffect(() => {
    if (!selectedCredit) return
    if (!user?.name) return
    if (responsible === user.name) return
    setResponsible(user.name)
  }, [selectedCredit, user?.name, responsible])

  useEffect(() => {
    const mediaQuery = window.matchMedia('(max-width: 768px)')
    const syncViewport = () => setIsMobileViewport(mediaQuery.matches)
    syncViewport()
    mediaQuery.addEventListener('change', syncViewport)
    return () => mediaQuery.removeEventListener('change', syncViewport)
  }, [])

  const formatMoney = (value?: number | string) => formatCurrency(Number(value || 0), config?.currency)
  const groupedCredits = useMemo<GroupedCredit[]>(() => {
    const installmentsBySale = new Map<number, Credit[]>()

    for (const credit of credits) {
      const saleId = Number(credit.sale_id)
      const existing = installmentsBySale.get(saleId) || []
      existing.push(credit)
      installmentsBySale.set(saleId, existing)
    }

    return Array.from(installmentsBySale.entries()).map(([saleId, saleInstallments]) => {
      const orderedInstallments = [...saleInstallments].sort((a, b) => {
        const aDate = new Date(a.due_date).getTime()
        const bDate = new Date(b.due_date).getTime()
        if (aDate !== bDate) return aDate - bDate
        return a.id - b.id
      })

      const firstInstallment = orderedInstallments[0]
      const totalPaid = getCreditPaidTotal(saleInstallments)
      const installmentsTotal = getCreditGrandTotal(saleInstallments)
      const saleTotal = Number(firstInstallment?.sale_total || 0)
      const grandTotal = Math.max(saleTotal, installmentsTotal)
      const totalPending = Math.round(orderedInstallments.reduce((sum, installment) => sum + getInstallmentPending(installment), 0) * 100) / 100
      const pendingInstallments = orderedInstallments.filter(installment => installment.paid !== 1 && getInstallmentPending(installment) >= 0.01)
      const firstPendingInstallment = pendingInstallments[0] || null

      return {
        sale_id: saleId,
        doc_no: firstInstallment?.doc_no || '',
        sale_date: firstInstallment?.sale_date || '',
        customer_name: firstInstallment?.customer_name || '',
        sale_total: grandTotal,
        installments_count: Math.max(...saleInstallments.map(installment => Number(installment.installments_count || 1))),
        total_paid: totalPaid,
        total_pending: totalPending,
        next_due_date: firstPendingInstallment?.due_date || firstInstallment?.due_date || firstInstallment?.sale_date || '',
        is_fully_paid: totalPending < 0.01,
        first_pending_installment: firstPendingInstallment,
      }
    }).sort((a, b) => {
      if (a.is_fully_paid !== b.is_fully_paid) return a.is_fully_paid ? 1 : -1
      return new Date(a.next_due_date).getTime() - new Date(b.next_due_date).getTime()
    })
  }, [credits])
  const groupedTotals = useMemo(() => {
    const total = groupedCredits.reduce((sum, credit) => sum + Number(credit.sale_total || 0), 0)
    const pending = groupedCredits.reduce((sum, credit) => sum + Number(credit.total_pending || 0), 0)
    const paid = Math.max(0, total - pending)
    return {
      count: groupedCredits.length,
      total,
      pending,
      paid,
    }
  }, [groupedCredits])
  const selectedCreditInstallments = useMemo(() => {
    if (!selectedCredit) return []
    return credits
      .filter(credit => credit.sale_id === selectedCredit.sale_id)
      .sort((a, b) => {
        const aIndex = Number(a.installment_number || 0)
        const bIndex = Number(b.installment_number || 0)
        if (aIndex && bIndex) return aIndex - bIndex
        return a.id - b.id
      })
  }, [credits, selectedCredit])
  const selectedCreditGrandTotal = useMemo(
    () => Math.max(Number(selectedCredit?.sale_total || 0), getCreditGrandTotal(selectedCreditInstallments)),
    [selectedCreditInstallments, selectedCredit]
  )
  const selectedCreditPaidTotal = useMemo(() => getCreditPaidTotal(selectedCreditInstallments), [selectedCreditInstallments])
  const selectedCreditPendingTotal = useMemo(
    () => Math.round(selectedCreditInstallments.reduce((sum, installment) => sum + getInstallmentPending(installment), 0) * 100) / 100,
    [selectedCreditInstallments]
  )
  const nextPayableInstallment = useMemo(
    () => getNextPayableInstallment(selectedCreditInstallments),
    [selectedCreditInstallments]
  )

  async function loadCredits() {
    setLoading(true)
    try {
      const data = await getCredits({ search })
      setCredits(data)
    } catch (err) {
      console.error(err)
      alert('Error cargando créditos')
    } finally {
      setLoading(false)
    }
  }

  function handleSearch(e: React.FormEvent) {
    e.preventDefault()
    loadCredits()
  }

  function openPayModal(credit: Credit) {
    setSelectedCredit(credit)
    const pending = getInstallmentPrincipalPending(credit)
    setPayAmount(pending.toFixed(2))
    setPaymentMethod('CASH')
    setReference('')
    setPaymentDate('')
    setResponsible(user?.name || '')
    setDocumentFile(null)
    setWaivePenalty(false)
    setPayMode('INSTALLMENT')
  }

  function closePayModal() {
    setSelectedCredit(null)
    setPayAmount('')
    setPaymentMethod('CASH')
    setReference('')
    setPaymentDate('')
    setResponsible('')
    setDocumentFile(null)
    setWaivePenalty(false)
    setPayMode('INSTALLMENT')
  }

  async function openContractModalForSale(saleId: number) {
    setContractSaleId(saleId)
    setContractModalOpen(true)
    setContractSignatureFile(null)
    setContractLoading(true)
    try {
      const [meta, sale] = await Promise.all([getCreditContractBySale(saleId), getSaleDetails(saleId).catch(() => null)])
      setContractInfo(meta?.contract || null)
      if (sale) {
        setContractCustomer((prev) => ({
          ...prev,
          phone: String((sale as any)?.customer_phone || prev.phone || ''),
          address: String((sale as any)?.customer_address || prev.address || ''),
          dpi: String((sale as any)?.customer_document || prev.dpi || ''),
        }))
      }
    } finally {
      setContractLoading(false)
    }
  }

  async function handleContractAction(saleId: number) {
    setContractLoading(true)
    try {
      const meta = await getCreditContractBySale(saleId)
      if (meta?.contract && meta.contract.buyer_signed_at) {
        const html = await getCreditContractHtmlBySale(saleId)
        openHtmlInNewWindow(html)
        return
      }
    } catch (err: any) {
      setContractLoading(false)
      return alert(getApiErrorMessage(err, 'No se pudo abrir el contrato'))
    } finally {
      setContractLoading(false)
    }
    await openContractModalForSale(saleId)
  }

  async function handleSettlementAction(saleId: number) {
    setContractLoading(true)
    try {
      const ok = await ensureSignedContractOrAlert(saleId, 'imprimir finiquito')
      if (!ok) return
      const html = await getCreditContractSettlementHtmlBySale(saleId)
      openHtmlInNewWindow(html)
    } catch (err: any) {
      alert(getApiErrorMessage(err, 'No se pudo abrir el finiquito'))
    } finally {
      setContractLoading(false)
    }
  }

  useEffect(() => {
    const params = new URLSearchParams(location.search || '')
    const raw = params.get('saleId')
    const saleId = raw ? Number(raw) : 0
    if (!saleId || !Number.isFinite(saleId)) return
    if (autoContractSaleHandled === saleId) return
    setAutoContractSaleHandled(saleId)
    void handleContractAction(saleId)
  }, [location.search, autoContractSaleHandled])

  async function ensureSignedContractOrAlert(saleId: number, actionLabel: string) {
    try {
      const meta = await getCreditContractBySale(saleId)
      if (meta?.contract && meta.contract.buyer_signed_at) return true
      alert(`No se puede ${actionLabel} sin contrato firmado`)
      return false
    } catch (err: any) {
      alert(err?.response?.data?.error || `No se pudo validar contrato para ${actionLabel}`)
      return false
    }
  }

  async function handlePrintPayment(
    payment: Payment,
    credit: { sale_id: number; doc_no?: string | null; customer_name?: string | null },
    totals?: { grandTotal?: number; paidAfter?: number; pendingAfter?: number },
    details?: {
      payments?: Payment[]
      installments?: Array<Pick<Credit, 'due_date' | 'total_amount' | 'paid_amount' | 'paid' | 'installment_number' | 'installments_count'>>
    }
  ) {
    const ok = await ensureSignedContractOrAlert(credit.sale_id, 'imprimir comprobante')
    if (!ok) return
    printPayment(payment, credit, totals, details)
  }

  async function generateContract() {
    if (!contractSaleId) return
    if (!contractSignatureFile) {
      return alert('Firma del comprador requerida')
    }
    setContractLoading(true)
    try {
      const buyerSignatureData = await fileToDataUrl(contractSignatureFile)
      const resp = await generateCreditContractBySale(contractSaleId, {
        customer: {
          phone: contractCustomer.phone,
          address: contractCustomer.address,
          dpi: contractCustomer.dpi,
          age: contractCustomer.age,
          nationality: contractCustomer.nationality,
          civilStatus: contractCustomer.civilStatus,
          occupation: contractCustomer.occupation,
          municipality: contractCustomer.municipality,
          department: contractCustomer.department,
        },
        warrantyTime: contractWarrantyTime,
        references: contractRefs.map(r => ({ name: r.name, phone: r.phone })),
        buyerSignatureData,
      })
      setContractModalOpen(false)
      setContractSaleId(null)
      setContractInfo({ id: resp.contractId, sha256: resp.sha256 })
      openHtmlInNewWindow(resp.html)
    } catch (err: any) {
      alert(err?.response?.data?.error || 'Error generando contrato')
    } finally {
      setContractLoading(false)
    }
  }

  function selectInstallmentForPayment(credit: Credit) {
    if (nextPayableInstallment && credit.id !== nextPayableInstallment.id) return
    setSelectedCredit(credit)
    const pending = getInstallmentPrincipalPending(credit)
    setPayAmount(pending.toFixed(2))
    setWaivePenalty(false)
    setPayMode('INSTALLMENT')
  }

  useEffect(() => {
    if (!selectedCredit || !nextPayableInstallment) return
    if (selectedCredit.id !== nextPayableInstallment.id) {
      setSelectedCredit(nextPayableInstallment)
      setPayAmount(getInstallmentPrincipalPending(nextPayableInstallment).toFixed(2))
      setWaivePenalty(false)
    }
  }, [selectedCredit, nextPayableInstallment])

  async function openHistoryModal(credit: GroupedCredit) {
    setSelectedCreditHistory(credit)
    setHistoryPayments([])
    setHistoryError('')
    setHistoryModalOpen(true)
    setHistoryLoading(true)
    try {
      const payments = await getCreditSalePayments(credit.sale_id)
      setHistoryPayments(payments)
    } catch (err) {
      console.error(err)
      setHistoryError((err as any)?.response?.data?.error || 'Error cargando historial')
    } finally {
      setHistoryLoading(false)
    }
  }

  function closeHistoryModal() {
    setHistoryModalOpen(false)
    setHistoryLoading(false)
    setHistoryError('')
    setHistoryPayments([])
    setSelectedCreditHistory(null)
  }

  function getPaymentTypeLabel(payment: Payment) {
    const normalized = String(payment.payment_type || '').trim().toUpperCase()
    if (normalized === 'PENALTY') return 'Penalización'
    if (normalized === 'DOWN_PAYMENT') return 'Enganche'
    return 'Abono'
  }

  function printPayment(
    payment: Payment,
    credit: { sale_id: number; doc_no?: string | null; customer_name?: string | null },
    totals?: { grandTotal?: number; paidAfter?: number; pendingAfter?: number },
    details?: {
      payments?: Payment[]
      installments?: Array<Pick<Credit, 'due_date' | 'total_amount' | 'paid_amount' | 'paid' | 'installment_number' | 'installments_count'>>
    }
  ) {
    const printWindow = window.open('', '_blank', 'width=400,height=600')
    if (!printWindow) return
    const logoBlock = buildPrintLogoHtml(config?.logoUrl, config?.name || 'Logo empresa', { maxWidth: 120, maxHeight: 42, marginBottom: 8 })
    const creditInstallments = credits.filter(item => item.sale_id === credit.sale_id)
    const computedGrandTotal = getCreditGrandTotal(creditInstallments)
    const grandTotal = Number(totals?.grandTotal ?? computedGrandTotal)
    const paidAfter = totals?.paidAfter != null ? Number(totals.paidAfter) : null
    const pendingAfter = totals?.pendingAfter != null ? Number(totals.pendingAfter) : null
    const paymentTypeLabel = getPaymentTypeLabel(payment)
    const paymentInstallmentDueDate = payment.installment_due_date ? formatDate(payment.installment_due_date) : null
    const saleRef = String(credit.doc_no || '').trim() || `#${credit.sale_id}`
    const installments = (details?.installments || []).map(it => ({ ...it }))
    const mergedPayments = (() => {
      const list = Array.isArray(details?.payments) ? [...details!.payments] : []
      const hasCurrent = list.some(p => Number(p.id) === Number(payment.id))
      if (!hasCurrent) list.push(payment)
      return list
        .filter(p => p && p.id != null)
        .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
    })()
    const pendingInstallments = installments
      .map(it => ({
        ...it,
        pending: getInstallmentPending(it),
      }))
      .filter(it => Number(it.paid) !== 1 && it.pending >= 0.01)
      .sort((a, b) => new Date(a.due_date).getTime() - new Date(b.due_date).getTime())

    const html = `
      <html>
        <head>
          <title>Comprobante de Pago</title>
          <style>
            body { font-family: monospace; padding: 16px; }
            .receipt { width: 100%; max-width: 360px; margin: 0 auto; }
            .header { text-align: center; margin-bottom: 20px; }
            .row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); column-gap: 12px; align-items: baseline; margin-bottom: 5px; }
            .label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
            .value { justify-self: end; text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; overflow: hidden; }
            .money { display: block; }
            .divider { border-top: 1px dashed #000; margin: 10px 0; }
            .footer { text-align: center; margin-top: 20px; font-size: 0.8em; }
            .section-title { margin: 12px 0 8px; font-weight: 700; text-align: center; }
            .mini-table { width: 100%; border-collapse: collapse; font-size: 12px; }
            .mini-table th, .mini-table td { padding: 4px 0; vertical-align: top; }
            .mini-table th { text-align: left; border-bottom: 1px dashed #000; padding-bottom: 6px; }
            .mini-table td.amount { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
            .mini-table td.date { white-space: nowrap; }
          </style>
        </head>
        <body>
          <div class="receipt">
            <div class="header">
              ${logoBlock}
              <h3>COMPROBANTE DE PAGO</h3>
              <p>${formatDateTime(payment.created_at)}</p>
            </div>
            
            <div class="row">
              <span class="label">Recibo N°:</span>
              <span class="value">${payment.id}</span>
            </div>
            <div class="row">
              <span class="label">Cliente:</span>
              <span class="value">${credit.customer_name || ''}</span>
            </div>
            <div class="row">
              <span class="label">Venta Ref:</span>
              <span class="value">${saleRef}</span>
            </div>
            
            <div class="divider"></div>
            
            <div class="row">
              <strong class="label">MONTO ABONADO:</strong>
              <strong class="value money">${formatMoney(payment.amount)}</strong>
            </div>
            
            <div class="divider"></div>
            
            <div class="row">
              <span class="label">Método:</span>
              <span class="value">${payment.payment_method === 'CASH' ? 'Efectivo' : payment.payment_method === 'CARD' ? 'Tarjeta' : 'Depósito'}</span>
            </div>
            <div class="row">
              <span class="label">Tipo:</span>
              <span class="value">${paymentTypeLabel}</span>
            </div>
          ${paymentInstallmentDueDate ? `
          <div class="row">
            <span class="label">Cuota vence:</span>
            <span class="value">${paymentInstallmentDueDate}</span>
          </div>` : ''}
          ${payment.reference ? `
          <div class="row">
            <span class="label">Referencia:</span>
            <span class="value">${payment.reference}</span>
          </div>` : ''}
          ${payment.received_by ? `
          <div class="row">
            <span class="label">Recibido por:</span>
            <span class="value">${payment.received_by}</span>
          </div>` : ''}
          
          <div class="divider"></div>
          
          <div class="row">
            <span class="label">Deuda Total:</span>
            <span class="value money">${formatMoney(grandTotal)}</span>
          </div>
          ${paidAfter != null ? `
          <div class="row">
            <span class="label">Total Abonado:</span>
            <span class="value money">${formatMoney(paidAfter)}</span>
          </div>` : ''}
          ${pendingAfter != null ? `
          <div class="row">
            <span class="label">Pendiente:</span>
            <span class="value money">${formatMoney(pendingAfter)}</span>
          </div>` : ''}

          ${(mergedPayments.length > 0) ? `
          <div class="divider"></div>
          <div class="section-title">HISTORIAL DE PAGOS</div>
          <table class="mini-table">
            <thead>
              <tr>
                <th>Fecha</th>
                <th>Tipo</th>
                <th>Método</th>
                <th style="text-align:right;">Monto</th>
              </tr>
            </thead>
            <tbody>
              ${mergedPayments.map(p => {
                const methodLabel = p.payment_method === 'CASH'
                  ? 'Efectivo'
                  : p.payment_method === 'CARD'
                    ? 'Tarjeta'
                    : 'Depósito'
                const typeLabel = getPaymentTypeLabel(p)
                return `
                  <tr>
                    <td class="date">${formatDate(p.created_at)}</td>
                    <td>${typeLabel}</td>
                    <td>${methodLabel}</td>
                    <td class="amount">${formatMoney(p.amount)}</td>
                  </tr>
                `
              }).join('')}
            </tbody>
          </table>
          ` : ''}

          ${(pendingInstallments.length > 0) ? `
          <div class="divider"></div>
          <div class="section-title">CUOTAS PENDIENTES</div>
          <table class="mini-table">
            <thead>
              <tr>
                <th>Cuota</th>
                <th>Vence</th>
                <th style="text-align:right;">Pendiente</th>
              </tr>
            </thead>
            <tbody>
              ${pendingInstallments.slice(0, 12).map(it => {
                const label = it.installments_count && Number(it.installments_count) > 1
                  ? `#${it.installment_number || 1}/${it.installments_count}`
                  : '#1/1'
                return `
                  <tr>
                    <td>${label}</td>
                    <td class="date">${formatDate(it.due_date)}</td>
                    <td class="amount">${formatMoney(it.pending)}</td>
                  </tr>
                `
              }).join('')}
            </tbody>
          </table>
          ${pendingInstallments.length > 12 ? `<div style="margin-top:6px; font-size: 11px; text-align:center;">(Mostrando 12 de ${pendingInstallments.length})</div>` : ''}
          ` : ''}
          
          <div class="footer">
            <p>Gracias por su pago</p>
          </div>
          </div>
          
          <script>
            function fitMoney(el) {
              if (!el) return
              const min = 10
              let size = parseFloat(window.getComputedStyle(el).fontSize || '14')
              for (let i = 0; i < 20; i++) {
                if (el.scrollWidth <= el.clientWidth) break
                if (size <= min) break
                size -= 1
                el.style.fontSize = size + 'px'
              }
            }
            window.onload = function() {
              document.querySelectorAll('.money').forEach((el) => fitMoney(el))
              window.print()
              window.close()
            }
          </script>
        </body>
      </html>
    `
    printWindow.document.write(html)
    printWindow.document.close()
  }

  async function handlePayment(e: React.FormEvent) {
    e.preventDefault()
    if (!selectedCredit) return

    const amount = parseFloat(payAmount)
    if (isNaN(amount) || amount <= 0) {
      alert('Monto inválido')
      return
    }

    if (payMode === 'INSTALLMENT') {
      const pending = getInstallmentPrincipalPending(selectedCredit)
      if (amount > pending + 0.01) {
        alert('El monto excede la deuda pendiente')
        return
      }
    } else {
      if (amount > Number(selectedCreditPendingTotal || 0) + 0.01) {
        alert('El monto excede la deuda pendiente del crédito')
        return
      }
    }

    if ((paymentMethod === 'CARD' || paymentMethod === 'DEPOSIT') && !reference.trim()) {
      alert('Debe ingresar una referencia para pagos con tarjeta o depósito')
      return
    }

    setProcessingPayment(true)
    try {
      const formData = new FormData()
      formData.append('amount', String(amount))
      formData.append('paymentMethod', paymentMethod)
      if (reference) formData.append('reference', reference)
      if (paymentMethod !== 'CASH' && paymentDate) formData.append('paymentDate', paymentDate)
      if (responsible) formData.append('responsible', responsible)
      if (waivePenalty) formData.append('waivePenalty', '1')
      if (documentFile) formData.append('document', documentFile)

      if (payMode === 'INSTALLMENT') {
        formData.append('installmentId', String(selectedCredit.id))
        const result = await payCredit(formData)
        alert('Pago registrado exitosamente')

        const payment: Payment = {
          id: result.paymentId,
          amount: amount + (waivePenalty ? 0 : Number(selectedCredit.penalty_due || 0)),
          payment_method: paymentMethod,
          reference: reference,
          created_at: new Date().toISOString(),
          received_by: responsible
        }
        const penaltyCharged = waivePenalty ? 0 : Math.max(0, Number(selectedCredit.penalty_due || 0))
        const paidAfter = Math.max(0, selectedCreditPaidTotal + amount + penaltyCharged)
        const pendingAfter = Math.max(0, selectedCreditPendingTotal - amount - penaltyCharged)
        let paymentsForReceipt: Payment[] | undefined
        try {
          paymentsForReceipt = await getCreditSalePayments(selectedCredit.sale_id)
        } catch {}
        const installmentsForReceipt = selectedCreditInstallments.map(it => {
          if (it.id !== selectedCredit.id) return it
          const nextPaid = Math.min(Number(it.total_amount || 0), Number(it.paid_amount || 0) + amount)
          const nextPending = Math.max(0, Number(it.total_amount || 0) - nextPaid)
          return {
            ...it,
            paid_amount: nextPaid,
            paid: nextPending < 0.01 ? 1 : it.paid,
            penalty_due: waivePenalty ? 0 : Math.max(0, Number(it.penalty_due || 0) - penaltyCharged),
            penalty_paid_amount: Number(it.penalty_paid_amount || 0) + penaltyCharged,
          }
        })
        const canPrint = await ensureSignedContractOrAlert(selectedCredit.sale_id, 'imprimir comprobante')
        if (canPrint) {
          printPayment(
            payment,
            selectedCredit,
            { grandTotal: selectedCreditGrandTotal, paidAfter, pendingAfter },
            { payments: paymentsForReceipt, installments: installmentsForReceipt }
          )
        }
      } else {
        formData.append('saleId', String(selectedCredit.sale_id))
        const result = await payCreditSale(formData)
        alert(`Pago registrado exitosamente. Aplicado: ${formatMoney(result.totalApplied)}`)

        const firstId = result.paymentIds?.[0] || 0
        const payment: Payment = {
          id: firstId,
          amount: result.totalApplied,
          payment_method: paymentMethod,
          reference: reference,
          created_at: new Date().toISOString(),
          received_by: responsible,
        }
        const paidAfter = Math.max(0, selectedCreditPaidTotal + result.totalApplied)
        const pendingAfter = Math.max(0, selectedCreditPendingTotal - result.totalApplied)
        let paymentsForReceipt: Payment[] | undefined
        try {
          paymentsForReceipt = await getCreditSalePayments(selectedCredit.sale_id)
        } catch {}
        const installmentsForReceipt = selectedCreditInstallments.map(it => ({ ...it }))
        for (const alloc of result.allocations || []) {
          const target = installmentsForReceipt.find(it => Number(it.id) === Number(alloc.installmentId))
          if (!target) continue
          if (String(alloc.paymentType || '').toUpperCase() === 'PENALTY') {
            target.penalty_paid_amount = Number(target.penalty_paid_amount || 0) + Number(alloc.amount || 0)
            target.penalty_due = Math.max(0, Number(target.penalty_due || 0) - Number(alloc.amount || 0))
          } else {
            target.paid_amount = Number(target.paid_amount || 0) + Number(alloc.amount || 0)
          }
          const principalPending = getInstallmentPrincipalPending(target)
          if (principalPending < 0.01) {
            target.paid = 1
          }
        }
        const canPrint = await ensureSignedContractOrAlert(selectedCredit.sale_id, 'imprimir comprobante')
        if (canPrint) {
          printPayment(
            payment,
            selectedCredit,
            { grandTotal: selectedCreditGrandTotal, paidAfter, pendingAfter },
            { payments: paymentsForReceipt, installments: installmentsForReceipt }
          )
        }
      }

      closePayModal()
      loadCredits()
    } catch (err) {
      console.error(err)
      alert((err as any)?.response?.data?.error || 'Error registrando pago')
    } finally {
      setProcessingPayment(false)
    }
  }

  return (
    <div className="page-shell">
      <div className="page-toolbar" style={{ marginBottom: 20 }}>
        <h2 style={{ margin: 0 }}>Gestión de Créditos</h2>
        <form onSubmit={handleSearch} className="page-toolbar-actions" style={{ flex: 1, justifyContent: 'flex-end', width: isMobileViewport ? '100%' : undefined }}>
          <input
            type="text"
            placeholder="Buscar por cliente o No. documento..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            style={{
              flex: 1,
              maxWidth: isMobileViewport ? '100%' : 400
            }}
          />
          <button 
            type="submit"
            className="primary-btn"
          >
            Buscar
          </button>
        </form>
      </div>

      {search.trim() && !loading && groupedTotals.count > 0 && (
        <div style={{ marginBottom: 16, display: 'grid', gridTemplateColumns: isMobileViewport ? '1fr' : 'repeat(3, minmax(0, 1fr))', gap: 12 }}>
          <div style={{ border: '1px solid var(--border)', borderRadius: 12, padding: 12, background: 'var(--modal)' }}>
            <div style={{ fontSize: '0.8rem', color: 'var(--muted)', marginBottom: 4 }}>Crédito total (cliente)</div>
            <div style={{ fontWeight: 800, whiteSpace: 'nowrap', overflowX: 'auto', fontVariantNumeric: 'tabular-nums' }}>{formatMoney(groupedTotals.total)}</div>
          </div>
          <div style={{ border: '1px solid var(--border)', borderRadius: 12, padding: 12, background: 'var(--modal)' }}>
            <div style={{ fontSize: '0.8rem', color: 'var(--muted)', marginBottom: 4 }}>Pendiente total</div>
            <div style={{ fontWeight: 800, color: '#ef4444', whiteSpace: 'nowrap', overflowX: 'auto', fontVariantNumeric: 'tabular-nums' }}>{formatMoney(groupedTotals.pending)}</div>
          </div>
          <div style={{ border: '1px solid var(--border)', borderRadius: 12, padding: 12, background: 'var(--modal)' }}>
            <div style={{ fontSize: '0.8rem', color: 'var(--muted)', marginBottom: 4 }}>Total abonado</div>
            <div style={{ fontWeight: 800, color: '#22c55e', whiteSpace: 'nowrap', overflowX: 'auto', fontVariantNumeric: 'tabular-nums' }}>{formatMoney(groupedTotals.paid)}</div>
          </div>
        </div>
      )}

      {loading ? (
        <p style={{ color: 'var(--muted)' }}>Cargando créditos...</p>
      ) : isMobileViewport ? (
        <div style={{ display: 'grid', gap: 12 }}>
          {groupedCredits.length === 0 ? (
            <div style={{ padding: 24, textAlign: 'center', color: 'var(--muted)', border: '1px solid var(--border)', borderRadius: 12, background: 'var(--modal)' }}>
              No hay créditos pendientes
            </div>
          ) : (
            groupedCredits.map(credit => {
              const isFullyPaid = credit.is_fully_paid

              return (
                <div key={credit.sale_id} style={{ background: 'var(--modal)', borderRadius: 12, border: '1px solid var(--border)', padding: 14, display: 'grid', gap: 10 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'flex-start' }}>
                    <div>
                      <div style={{ fontWeight: 700 }}>{credit.customer_name || 'Consumidor Final'}</div>
                      <div style={{ fontSize: '0.8rem', color: 'var(--muted)' }}>{credit.doc_no || `#${credit.sale_id}`}</div>
                      <div style={{ fontSize: '0.8rem', color: '#2563eb', fontWeight: 700, marginTop: 4 }}>{credit.installments_count} cuota(s)</div>
                    </div>
                    <span style={{
                      padding: '4px 8px',
                      borderRadius: 999,
                      background: isFullyPaid ? 'rgba(34, 197, 94, 0.12)' : 'rgba(239, 68, 68, 0.12)',
                      color: isFullyPaid ? '#22c55e' : '#ef4444',
                      fontWeight: 700,
                      fontSize: '0.75rem'
                    }}>
                      {isFullyPaid ? 'COMPLETADO' : 'PENDIENTE'}
                    </span>
                  </div>

                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 10, fontSize: '0.9rem' }}>
                    <div>
                      <div style={{ color: 'var(--muted)', fontSize: '0.75rem' }}>Fecha venta</div>
                      <div>{formatDate(credit.sale_date)}</div>
                    </div>
                    <div>
                      <div style={{ color: 'var(--muted)', fontSize: '0.75rem' }}>Próximo vencimiento</div>
                      <div>{formatDate(credit.next_due_date)}</div>
                    </div>
                    <div>
                      <div style={{ color: 'var(--muted)', fontSize: '0.75rem' }}>Crédito total</div>
                      <div style={{ fontWeight: 700 }}>{formatMoney(credit.sale_total)}</div>
                    </div>
                    <div>
                      <div style={{ color: 'var(--muted)', fontSize: '0.75rem' }}>Pagado</div>
                      <div style={{ fontWeight: 700, color: '#22c55e' }}>{formatMoney(credit.total_paid)}</div>
                    </div>
                  </div>

                  <div style={{ padding: 10, borderRadius: 10, background: isFullyPaid ? 'rgba(34, 197, 94, 0.08)' : 'rgba(239, 68, 68, 0.08)', color: isFullyPaid ? '#22c55e' : '#ef4444', fontWeight: 800, textAlign: 'center' }}>
                    {isFullyPaid ? 'COMPLETADO' : `Pendiente: ${formatMoney(credit.total_pending)}`}
                  </div>

                  <div style={{ display: 'grid', gridTemplateColumns: !isFullyPaid ? '1fr 1fr 1fr' : '1fr 1fr 1fr', gap: 10 }}>
                    <button
                      className="icon-btn"
                      onClick={() => openHistoryModal(credit)}
                      title="Ver historial de pagos"
                      style={{ width: '100%', justifyContent: 'center', padding: '0 16px' }}
                    >
                      Historial
                    </button>
                    <button
                      className="icon-btn"
                      onClick={() => handleContractAction(credit.sale_id)}
                      title="Ver o generar contrato"
                      style={{ width: '100%', justifyContent: 'center', padding: '0 16px' }}
                      disabled={contractLoading}
                    >
                      Contrato
                    </button>
                    {isFullyPaid && (
                      <button
                        className="icon-btn"
                        onClick={() => handleSettlementAction(credit.sale_id)}
                        title="Imprimir finiquito"
                        style={{ width: '100%', justifyContent: 'center', padding: '0 16px' }}
                        disabled={contractLoading}
                      >
                        Finiquito
                      </button>
                    )}
                    {!isFullyPaid && (
                      <button
                        className="icon-btn primary"
                        onClick={() => openPayModal(credit.first_pending_installment || credits.find(item => item.sale_id === credit.sale_id)!)}
                        title="Abonar"
                        style={{ width: '100%', justifyContent: 'center', padding: '0 16px' }}
                      >
                        Abonar
                      </button>
                    )}
                  </div>
                </div>
              )
            })
          )}
        </div>
      ) : (
        <div className="table-scroll" style={{ background: 'var(--modal)', borderRadius: 12, border: '1px solid var(--border)' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: 'var(--modal)', borderBottom: '1px solid var(--border)' }}>
                <th style={{ padding: 12, textAlign: 'left' }}>Fecha Venta</th>
                <th style={{ padding: 12, textAlign: 'left' }}>Próximo vencimiento</th>
                <th style={{ padding: 12, textAlign: 'left' }}>Cliente</th>
                <th style={{ padding: 12, textAlign: 'left' }}>Documento</th>
                <th style={{ padding: 12, textAlign: 'right' }}>Crédito total</th>
                <th style={{ padding: 12, textAlign: 'center' }}>Cuotas</th>
                <th style={{ padding: 12, textAlign: 'right' }}>Pagado</th>
                <th style={{ padding: 12, textAlign: 'right' }}>Pendiente</th>
                <th style={{ padding: 12, textAlign: 'center' }}>Acción</th>
              </tr>
            </thead>
            <tbody>
              {groupedCredits.length === 0 ? (
                <tr>
                  <td colSpan={9} style={{ padding: 32, textAlign: 'center', color: 'var(--muted)' }}>
                    No hay créditos pendientes
                  </td>
                </tr>
              ) : (
                groupedCredits.map(credit => {
                  const isFullyPaid = credit.is_fully_paid
                  
                  return (
                    <tr key={credit.sale_id} style={{ borderBottom: '1px solid var(--border)' }}>
                      <td style={{ padding: 12 }}>{formatDate(credit.sale_date)}</td>
                      <td style={{ padding: 12 }}>{formatDate(credit.next_due_date)}</td>
                      <td style={{ padding: 12, fontWeight: 600 }}>{credit.customer_name || 'Consumidor Final'}</td>
                      <td style={{ padding: 12 }}>
                        <div>{credit.doc_no || `#${credit.sale_id}`}</div>
                        <div style={{ fontSize: '0.75rem', color: '#2563eb', fontWeight: 700, marginTop: 4 }}>{credit.installments_count} cuota(s)</div>
                      </td>
                      <td style={{ padding: 12, textAlign: 'right' }}>
                        {formatMoney(credit.sale_total)}
                      </td>
                      <td style={{ padding: 12, textAlign: 'center', fontWeight: 700 }}>
                        {credit.installments_count}
                      </td>
                      <td style={{ padding: 12, textAlign: 'right', color: '#22c55e' }}>
                        {formatMoney(credit.total_paid)}
                      </td>
                      <td style={{ padding: 12, textAlign: 'right', color: isFullyPaid ? '#22c55e' : '#ef4444', fontWeight: 600 }}>
                        {isFullyPaid ? 'COMPLETADO' : formatMoney(credit.total_pending)}
                      </td>
                      <td style={{ padding: 12, textAlign: 'center', display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
                        <button
                          className="icon-btn"
                          onClick={() => openHistoryModal(credit)}
                          title="Ver historial de pagos"
                        >
                          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <circle cx="12" cy="12" r="10" />
                            <polyline points="12 6 12 12 16 14" />
                          </svg>
                        </button>
                        <button
                          className="icon-btn"
                          onClick={() => handleContractAction(credit.sale_id)}
                          title="Ver o generar contrato"
                          disabled={contractLoading}
                        >
                          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                            <path d="M14 2v6h6" />
                            <path d="M16 13H8" />
                            <path d="M16 17H8" />
                            <path d="M10 9H8" />
                          </svg>
                        </button>
                        {isFullyPaid && (
                          <button
                            className="icon-btn"
                            onClick={() => handleSettlementAction(credit.sale_id)}
                            title="Imprimir finiquito"
                            disabled={contractLoading}
                          >
                            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M6 2h9l3 3v17H6z" />
                              <path d="M9 13h6" />
                              <path d="M9 17h6" />
                              <path d="M9 9h3" />
                            </svg>
                          </button>
                        )}
                        {!isFullyPaid && (
                        <button
                          className="icon-btn primary"
                          onClick={() => openPayModal(credit.first_pending_installment || credits.find(item => item.sale_id === credit.sale_id)!)}
                          title="Abonar"
                        >
                          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <rect x="2" y="6" width="20" height="12" rx="2" />
                            <circle cx="12" cy="12" r="2" />
                            <path d="M6 12h.01M18 12h.01" />
                          </svg>
                        </button>
                        )}
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>
      )}

      {selectedCredit && (
        <div style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(0,0,0,0.6)',
          display: 'flex',
          justifyContent: 'center',
          alignItems: isMobileViewport ? 'flex-end' : 'center',
          zIndex: 1000,
          padding: isMobileViewport ? 0 : 16
        }}>
          <div className="responsive-modal" style={{
            background: 'var(--modal)',
            padding: isMobileViewport ? 16 : 20,
            borderRadius: isMobileViewport ? '18px 18px 0 0' : 12,
            border: '1px solid var(--border)',
            width: isMobileViewport ? '100%' : '90%',
            maxWidth: 780,
            maxHeight: '90vh',
            overflowY: 'auto',
            overflowX: 'hidden'
          }}>
            <h2 style={{ marginTop: 0, marginBottom: 16 }}>Registrar Abono</h2>
            <div style={{ marginBottom: 20, lineHeight: '1.6' }}>
              <p><strong>Cliente:</strong> {selectedCredit.customer_name}</p>
              <p><strong>Documento:</strong> {selectedCredit.doc_no || `#${selectedCredit.sale_id}`}</p>
              <p><strong>Crédito total:</strong> {formatMoney(selectedCreditGrandTotal || selectedCredit.sale_total || selectedCredit.total_amount)}</p>
              <p><strong>Total abonado:</strong> {formatMoney(selectedCreditPaidTotal)}</p>
              <p style={{ fontSize: '1.05rem', color: '#ef4444' }}>
                <strong>Pendiente total: {formatMoney(selectedCreditPendingTotal)}</strong>
              </p>
              <p><strong>Cuota:</strong> {getInstallmentLabel(selectedCredit)}</p>
              <p><strong>Monto cuota:</strong> {formatMoney(selectedCredit.total_amount)}</p>
              <p><strong>Pagado:</strong> {formatMoney(selectedCredit.paid_amount)}</p>
              <p style={{ fontSize: '1.2rem', color: '#ef4444' }}>
                <strong>Pendiente cuota: {formatMoney(getInstallmentPending(selectedCredit))}</strong>
              </p>
            </div>

            <div style={{ marginBottom: 20 }}>
              <div style={{ fontWeight: 700, marginBottom: 10 }}>Cuotas disponibles de esta venta</div>
              <div style={{ marginBottom: 12, fontSize: '0.9rem', color: 'var(--muted)' }}>
                Solo se puede abonar la cuota con vencimiento m&aacute;s pr&oacute;ximo. Las siguientes quedar&aacute;n bloqueadas hasta completar la actual.
              </div>
              <div style={{ display: 'grid', gap: 10 }}>
                {selectedCreditInstallments.map(installment => {
                  const installmentTotal = Number(installment.total_amount)
                  const paid = Number(installment.paid_amount)
                  const pending = getInstallmentPending(installment)
                  const isCurrent = installment.id === selectedCredit.id
                  const isPaid = installment.paid === 1 || pending < 0.01
                  const isNextPayable = nextPayableInstallment?.id === installment.id
                  const isBlocked = !isPaid && !isNextPayable

                  return (
                    <div
                      key={installment.id}
                      onClick={() => !isPaid && !isBlocked && selectInstallmentForPayment(installment)}
                      style={{
                        display: 'grid',
                        gridTemplateColumns: isMobileViewport ? '1fr' : 'minmax(0, 1fr) auto auto auto',
                        gap: 10,
                        alignItems: 'center',
                        padding: 12,
                        borderRadius: 10,
                        border: isCurrent ? '1px solid #2563eb' : '1px solid var(--border)',
                        background: isCurrent ? 'rgba(37, 99, 235, 0.08)' : isBlocked ? 'rgba(148, 163, 184, 0.08)' : 'var(--bg)',
                        cursor: isPaid || isBlocked ? 'not-allowed' : 'pointer',
                        opacity: isBlocked ? 0.65 : 1
                      }}
                    >
                      <div>
                        <div style={{ fontWeight: 700, color: 'var(--text)' }}>{getInstallmentLabel(installment)}</div>
                        <div style={{ fontSize: '0.85rem', color: 'var(--muted)' }}>Vence: {formatDate(installment.due_date)}</div>
                      </div>
                      <div style={{ textAlign: isMobileViewport ? 'left' : 'right' }}>
                        <div style={{ fontSize: '0.75rem', color: 'var(--muted)' }}>Monto</div>
                        <div style={{ fontWeight: 700 }}>{formatMoney(installmentTotal)}</div>
                      </div>
                      <div style={{ textAlign: isMobileViewport ? 'left' : 'right' }}>
                        <div style={{ fontSize: '0.75rem', color: 'var(--muted)' }}>Pendiente</div>
                        <div style={{ fontWeight: 700, color: isPaid ? '#16a34a' : '#ef4444' }}>{isPaid ? '0.00' : formatMoney(pending)}</div>
                      </div>
                      <div style={{ justifySelf: isMobileViewport ? 'start' : 'end' }}>
                        <span style={{
                          display: 'inline-flex',
                          padding: '4px 8px',
                          borderRadius: 999,
                          background: isCurrent
                            ? 'rgba(37, 99, 235, 0.12)'
                            : isPaid
                              ? 'rgba(34, 197, 94, 0.12)'
                              : isBlocked
                                ? 'rgba(148, 163, 184, 0.16)'
                                : 'rgba(245, 158, 11, 0.14)',
                          color: isCurrent
                            ? '#2563eb'
                            : isPaid
                              ? '#16a34a'
                              : isBlocked
                                ? '#64748b'
                                : '#d97706',
                          fontWeight: 700,
                          fontSize: '0.75rem'
                        }}>
                          {isCurrent ? 'Seleccionada' : isPaid ? 'Pagada' : isBlocked ? 'Bloqueada' : 'Próxima'}
                        </span>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>

            <form onSubmit={handlePayment}>
              <div style={{ marginBottom: 16 }}>
                <label style={{ display: 'block', marginBottom: 6, fontWeight: 600 }}>Monto a Abonar</label>
                <input
                  type="number"
                  step="0.01"
                  min="0.01"
                  required
                  value={payAmount}
                  onChange={e => setPayAmount(e.target.value)}
                  style={{
                    width: '100%',
                    fontSize: '1.2rem'
                  }}
                />
                {selectedCredit && Math.max(0, Number(selectedCredit.penalty_due || 0)) > 0 && (
                  <div style={{ marginTop: 10, padding: 10, borderRadius: 10, border: '1px solid var(--border)', background: 'rgba(239, 68, 68, 0.08)' }}>
                    <div style={{ fontSize: '0.9rem', fontWeight: 700, marginBottom: 6 }}>
                      Penalización por mora: {formatMoney(selectedCredit.penalty_due)}
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 10 }}>
                      Se cobra Q25 por día por cada cuota vencida, iniciando 5 días después del vencimiento.
                    </div>
                    <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <input
                        type="checkbox"
                        checked={waivePenalty}
                        onChange={(e) => setWaivePenalty(e.target.checked)}
                      />
                      <span>{payMode === 'DISTRIBUTE' ? 'Omitir penalizaciones (acuerdo de pago)' : 'Omitir penalización (acuerdo de pago)'}</span>
                    </label>
                  </div>
                )}
                {selectedCredit && (
                  <div style={{ marginTop: 10, display: 'flex', justifyContent: 'space-between', gap: 12, fontWeight: 800 }}>
                    <span>Total a cobrar:</span>
                    <span style={{ whiteSpace: 'nowrap', overflowX: 'auto', fontVariantNumeric: 'tabular-nums' }}>
                      {formatMoney(Math.max(0, Number(payAmount || 0) + (waivePenalty ? 0 : Math.max(0, Number(selectedCredit.penalty_due || 0)))))}
                    </span>
                  </div>
                )}
              </div>

              <div style={{ marginBottom: 16 }}>
                <label style={{ display: 'block', marginBottom: 6, fontWeight: 600 }}>Modo de pago</label>
                <select
                  value={payMode}
                  onChange={(e) => {
                    const nextMode = e.target.value as 'INSTALLMENT' | 'DISTRIBUTE'
                    setPayMode(nextMode)
                    setWaivePenalty(false)
                    if (nextMode === 'DISTRIBUTE') {
                      setPayAmount(String(Math.max(0, Number(selectedCreditPendingTotal || 0)).toFixed(2)))
                    } else if (selectedCredit) {
                      setPayAmount(getInstallmentPrincipalPending(selectedCredit).toFixed(2))
                    }
                  }}
                  style={{ width: '100%' }}
                >
                  <option value="INSTALLMENT">Abonar cuota actual</option>
                  <option value="DISTRIBUTE">Pago libre (repartir a cuotas)</option>
                </select>
                {payMode === 'DISTRIBUTE' && (
                  <div style={{ marginTop: 8, fontSize: 12, color: 'var(--muted)' }}>
                    El monto se reparte automáticamente desde la cuota más antigua pendiente hacia adelante.
                  </div>
                )}
              </div>

              <div style={{ marginBottom: 16 }}>
                <label style={{ display: 'block', marginBottom: 6, fontWeight: 600 }}>Método de Pago</label>
                <select
                  value={paymentMethod}
                  onChange={e => {
                    const next = e.target.value
                    setPaymentMethod(next)
                    if (next === 'CASH') {
                      setReference('')
                      setDocumentFile(null)
                      setPaymentDate('')
                    }
                  }}
                  style={{
                    width: '100%'
                  }}
                >
                  <option value="CASH">Efectivo</option>
                  <option value="CARD">Tarjeta</option>
                  <option value="DEPOSIT">Depósito</option>
                </select>
              </div>

              {paymentMethod !== 'CASH' && (
                <div style={{ marginBottom: 16 }}>
                  <label style={{ display: 'block', marginBottom: 6, fontWeight: 600 }}>
                    Fecha de Pago
                  </label>
                  <input
                    type="datetime-local"
                    value={paymentDate}
                    onChange={e => setPaymentDate(e.target.value)}
                    style={{
                      width: '100%'
                    }}
                  />
                </div>
              )}

              {paymentMethod !== 'CASH' && (
                <div style={{ marginBottom: 16 }}>
                  <label style={{ display: 'block', marginBottom: 6, fontWeight: 600 }}>
                    Documento / Referencia {paymentMethod === 'CARD' ? '(Voucher)' : paymentMethod === 'DEPOSIT' ? '(No. Operación)' : ''}
                    {(paymentMethod === 'CARD' || paymentMethod === 'DEPOSIT') && <span style={{ color: 'red' }}> *</span>}
                  </label>
                  <input
                    type="text"
                    required={paymentMethod === 'CARD' || paymentMethod === 'DEPOSIT'}
                    value={reference}
                    onChange={e => setReference(e.target.value)}
                    placeholder="Número de operación o referencia"
                    style={{
                      width: '100%'
                    }}
                  />
                </div>
              )}

              <div style={{ marginBottom: 16 }}>
                <label style={{ display: 'block', marginBottom: 6, fontWeight: 600 }}>Usuario que registra el abono</label>
                <input
                  type="text"
                  value={responsible}
                  placeholder="Usuario logeado"
                  disabled
                  style={{
                    width: '100%'
                  }}
                />
              </div>

              {paymentMethod !== 'CASH' && (
                <div style={{ marginBottom: 16 }}>
                  <label style={{ display: 'block', marginBottom: 6, fontWeight: 600 }}>Comprobante (Opcional)</label>
                  <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                    <input
                      type="file"
                      accept="image/*,.pdf"
                      onChange={e => setDocumentFile(e.target.files ? e.target.files[0] : null)}
                      style={{
                        width: '100%'
                      }}
                    />
                    <CameraCaptureButton
                      onCapture={file => setDocumentFile(file)}
                      modalTitle="Capturar comprobante del pago"
                      buttonTitle="Tomar foto del comprobante"
                      fileNamePrefix="comprobante"
                    />
                  </div>
                  {documentFile && (
                    <div className="file-name" style={{ marginTop: 6 }}>
                      {documentFile.name}
                    </div>
                  )}
                  <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6 }}>
                    Puedes subir un PDF/imagen o tomar una foto desde el telefono o webcam USB.
                  </div>
                </div>
              )}

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, flexWrap: 'wrap', flexDirection: isMobileViewport ? 'column' : 'row' }}>
                <button
                  type="button"
                  onClick={closePayModal}
                  disabled={processingPayment}
                  className="icon-btn"
                  style={{ width: isMobileViewport ? '100%' : 'auto', padding: '0 16px' }}
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={processingPayment}
                  className="primary-btn"
                  style={{ width: isMobileViewport ? '100%' : 'auto' }}
                >
                  {processingPayment ? 'Procesando...' : 'Confirmar Pago'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {contractModalOpen && contractSaleId && (
        <div style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(0,0,0,0.6)',
          display: 'flex',
          justifyContent: 'center',
          alignItems: isMobileViewport ? 'flex-end' : 'center',
          zIndex: 1001,
          padding: isMobileViewport ? 0 : 16
        }}>
          <div className="responsive-modal" style={{
            background: 'var(--modal)',
            padding: isMobileViewport ? 16 : 20,
            borderRadius: isMobileViewport ? '18px 18px 0 0' : 12,
            border: '1px solid var(--border)',
            width: isMobileViewport ? '100%' : '90%',
            maxWidth: 860,
            maxHeight: '90vh',
            overflowY: 'auto',
            overflowX: 'hidden'
          }}>
            <h2 style={{ marginTop: 0, marginBottom: 16 }}>Generar contrato de crédito</h2>

            <div style={{ marginBottom: 14, fontSize: 12, color: 'var(--muted)' }}>
              Completa los datos obligatorios para que el contrato quede igual al formato de la sucursal.
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: isMobileViewport ? '1fr' : '1fr 1fr', gap: 12 }}>
              <div>
                <label style={{ display: 'block', marginBottom: 6, fontWeight: 700 }}>Teléfono *</label>
                <input
                  value={contractCustomer.phone}
                  onChange={(e) => setContractCustomer({ ...contractCustomer, phone: e.target.value })}
                  style={{ width: '100%' }}
                />
              </div>
              <div>
                <label style={{ display: 'block', marginBottom: 6, fontWeight: 700 }}>DPI *</label>
                <input
                  value={contractCustomer.dpi}
                  onChange={(e) => setContractCustomer({ ...contractCustomer, dpi: e.target.value })}
                  style={{ width: '100%' }}
                />
              </div>
              <div>
                <label style={{ display: 'block', marginBottom: 6, fontWeight: 700 }}>Edad *</label>
                <input
                  type="number"
                  min="0"
                  value={contractCustomer.age}
                  onChange={(e) => setContractCustomer({ ...contractCustomer, age: e.target.value })}
                  style={{ width: '100%' }}
                />
              </div>
              <div>
                <label style={{ display: 'block', marginBottom: 6, fontWeight: 700 }}>Nacionalidad *</label>
                <input
                  value={contractCustomer.nationality}
                  onChange={(e) => setContractCustomer({ ...contractCustomer, nationality: e.target.value })}
                  style={{ width: '100%' }}
                />
              </div>
              <div>
                <label style={{ display: 'block', marginBottom: 6, fontWeight: 700 }}>Estado civil *</label>
                <input
                  value={contractCustomer.civilStatus}
                  onChange={(e) => setContractCustomer({ ...contractCustomer, civilStatus: e.target.value })}
                  style={{ width: '100%' }}
                />
              </div>
              <div>
                <label style={{ display: 'block', marginBottom: 6, fontWeight: 700 }}>Profesión u oficio *</label>
                <input
                  value={contractCustomer.occupation}
                  onChange={(e) => setContractCustomer({ ...contractCustomer, occupation: e.target.value })}
                  style={{ width: '100%' }}
                />
              </div>
              <div style={{ gridColumn: isMobileViewport ? 'auto' : '1 / span 2' }}>
                <label style={{ display: 'block', marginBottom: 6, fontWeight: 700 }}>Dirección *</label>
                <input
                  value={contractCustomer.address}
                  onChange={(e) => setContractCustomer({ ...contractCustomer, address: e.target.value })}
                  style={{ width: '100%' }}
                />
              </div>
              <div>
                <label style={{ display: 'block', marginBottom: 6, fontWeight: 700 }}>Departamento *</label>
                <select
                  value={contractCustomer.department}
                  onChange={(e) => setContractCustomer({ ...contractCustomer, department: e.target.value, municipality: '' })}
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
                  value={contractCustomer.municipality}
                  onChange={(e) => setContractCustomer({ ...contractCustomer, municipality: e.target.value })}
                  disabled={!contractCustomer.department}
                  style={{ width: '100%', padding: 10, borderRadius: 8, background: 'var(--modal)', color: 'var(--text)', border: '1px solid var(--border)' }}
                >
                  <option value="">
                    {contractCustomer.department ? 'Selecciona un municipio…' : 'Selecciona primero un departamento…'}
                  </option>
                  {guatemalaMunicipalities.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </div>
              <div style={{ gridColumn: isMobileViewport ? 'auto' : '1 / span 2' }}>
                <label style={{ display: 'block', marginBottom: 6, fontWeight: 700 }}>Tiempo de garantía</label>
                <input
                  value={contractWarrantyTime}
                  onChange={(e) => setContractWarrantyTime(e.target.value)}
                  placeholder="Ej: 30 días / 3 meses"
                  style={{ width: '100%' }}
                />
              </div>
            </div>

            <div style={{ marginTop: 18, borderTop: '1px solid var(--border)', paddingTop: 14 }}>
              <div style={{ fontWeight: 800, marginBottom: 10 }}>Referencias</div>
              <div style={{ display: 'grid', gap: 10 }}>
                {contractRefs.map((r, idx) => (
                  <div key={idx} style={{ display: 'grid', gridTemplateColumns: isMobileViewport ? '1fr' : '70px 1fr 220px', gap: 10, alignItems: 'center' }}>
                    <div style={{ fontWeight: 800, color: 'var(--muted)' }}>#{idx + 1}</div>
                    <input
                      value={r.name}
                      placeholder="Nombre"
                      onChange={(e) => {
                        const next = contractRefs.map((x, i) => i === idx ? { ...x, name: e.target.value } : x)
                        setContractRefs(next)
                      }}
                      style={{ width: '100%' }}
                    />
                    <input
                      value={r.phone}
                      placeholder="Tel/Cel"
                      onChange={(e) => {
                        const next = contractRefs.map((x, i) => i === idx ? { ...x, phone: e.target.value } : x)
                        setContractRefs(next)
                      }}
                      style={{ width: '100%' }}
                    />
                  </div>
                ))}
              </div>
            </div>

            <div style={{ marginTop: 18, borderTop: '1px solid var(--border)', paddingTop: 14 }}>
              <div style={{ fontWeight: 800, marginBottom: 10 }}>Firma del comprador *</div>
              <SignaturePad onChange={setContractSignatureFile} height={180} />
              {contractSignatureFile && (
                <div style={{ marginTop: 8, fontSize: 12, color: 'var(--muted)' }}>
                  {contractSignatureFile.name}
                </div>
              )}
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, flexWrap: 'wrap', flexDirection: isMobileViewport ? 'column' : 'row', marginTop: 18 }}>
              <button
                type="button"
                onClick={() => { setContractModalOpen(false); setContractSaleId(null); setContractSignatureFile(null) }}
                disabled={contractLoading}
                className="icon-btn"
                style={{ width: isMobileViewport ? '100%' : 'auto', padding: '0 16px' }}
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={generateContract}
                disabled={contractLoading}
                className="primary-btn"
                style={{ width: isMobileViewport ? '100%' : 'auto' }}
              >
                {contractLoading ? 'Generando...' : 'Generar y imprimir'}
              </button>
            </div>
          </div>
        </div>
      )}

      {historyModalOpen && selectedCreditHistory && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: 'rgba(0,0,0,0.5)',
          display: 'flex',
          justifyContent: 'center',
          alignItems: isMobileViewport ? 'flex-end' : 'center',
          zIndex: 1000,
          padding: isMobileViewport ? 0 : 16
        }}>
          <div className="responsive-modal" style={{
            backgroundColor: 'var(--modal)',
            color: 'var(--text)',
            padding: isMobileViewport ? '1rem' : '2rem',
            borderRadius: isMobileViewport ? '18px 18px 0 0' : '12px',
            border: '1px solid var(--border)',
            width: isMobileViewport ? '100%' : '95%',
            maxWidth: '900px',
            maxHeight: isMobileViewport ? '90vh' : '80vh',
            overflowY: 'auto',
            boxShadow: '0 4px 6px rgba(0,0,0,0.1)'
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1rem', flexWrap: 'wrap', marginBottom: '1.5rem' }}>
              <h2 style={{ margin: 0 }}>Historial de Pagos</h2>
              <button
                onClick={closeHistoryModal}
                style={{
                  background: 'none',
                  border: 'none',
                  fontSize: '1.5rem',
                  cursor: 'pointer',
                  color: 'var(--text)'
                }}
              >
                &times;
              </button>
            </div>

            <div style={{ marginBottom: '1rem' }}>
              <p><strong>Cliente:</strong> {selectedCreditHistory.customer_name}</p>
              <p><strong>Documento:</strong> {selectedCreditHistory.doc_no}</p>
            </div>

            {isMobileViewport ? (
              <div style={{ display: 'grid', gap: 12, marginBottom: '1.5rem' }}>
                {historyLoading ? (
                  <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--muted)' }}>
                    Cargando historial...
                  </div>
                ) : historyError ? (
                  <div style={{ padding: '2rem', textAlign: 'center', color: '#ef4444' }}>
                    {historyError}
                  </div>
                ) : historyPayments.length === 0 ? (
                  <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--muted)' }}>
                    No hay pagos registrados
                  </div>
                ) : (
                  historyPayments.map(payment => (
                    <div key={payment.id} style={{ border: '1px solid var(--border)', borderRadius: 12, padding: 14, background: 'var(--bg)', display: 'grid', gap: 10 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'flex-start' }}>
                        <div>
                          <div style={{ fontWeight: 700 }}>{formatDate(payment.created_at)}</div>
                          <div style={{ fontSize: '0.8rem', color: 'var(--muted)' }}>{payment.received_by || '-'}</div>
                        </div>
                        <span style={{
                          padding: '4px 8px',
                          borderRadius: '12px',
                          backgroundColor: payment.payment_method === 'CASH' ? 'rgba(52, 152, 219, 0.1)' : 'rgba(241, 196, 15, 0.1)',
                          color: payment.payment_method === 'CASH' ? '#3498db' : '#f1c40f',
                          fontSize: '0.85rem',
                          fontWeight: 'bold',
                          border: `1px solid ${payment.payment_method === 'CASH' ? '#3498db' : '#f1c40f'}`
                        }}>
                          {payment.payment_method === 'CASH' ? 'Efectivo' :
                           payment.payment_method === 'CARD' ? 'Tarjeta' : 'Depósito'}
                        </span>
                      </div>
                      <div style={{ fontWeight: 800, fontSize: '1rem', whiteSpace: 'nowrap', overflowX: 'auto', fontVariantNumeric: 'tabular-nums' }}>{formatMoney(payment.amount)}</div>
                      <div style={{ fontSize: '0.85rem', color: 'var(--muted)' }}>
                        {getPaymentTypeLabel(payment)}{payment.installment_due_date ? ` · Cuota vence: ${formatDate(payment.installment_due_date)}` : ''}
                      </div>
                      <div style={{ fontSize: '0.85rem', color: 'var(--muted)' }}>Ref: {payment.reference || '-'}</div>
                      <div style={{ display: 'grid', gridTemplateColumns: payment.document_url ? '1fr 1fr 1fr' : '1fr 1fr', gap: 8 }}>
                        {payment.document_url ? (
                          <a
                            href={payment.document_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            style={{
                              color: 'var(--accent)',
                              textDecoration: 'none',
                              fontWeight: 'bold',
                              border: '1px solid var(--accent)',
                              padding: '8px 10px',
                              borderRadius: '8px',
                              textAlign: 'center'
                            }}
                          >
                            Ver Doc
                          </a>
                        ) : null}
                        <button
                          className="icon-btn"
                          onClick={() => handlePrintPayment(
                            payment,
                            selectedCreditHistory,
                            { grandTotal: selectedCreditHistory.sale_total, paidAfter: selectedCreditHistory.total_paid, pendingAfter: selectedCreditHistory.total_pending },
                            { payments: historyPayments, installments: credits.filter(it => it.sale_id === selectedCreditHistory.sale_id) }
                          )}
                          title="Imprimir comprobante"
                          style={{ width: '100%', justifyContent: 'center', padding: '0 12px', gridColumn: payment.document_url ? 'span 2' : 'span 2' }}
                        >
                          Imprimir
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            ) : (
            <div className="table-scroll">
              <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: '1.5rem' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--border)', backgroundColor: 'var(--bg)' }}>
                    <th style={{ padding: '1rem', textAlign: 'left', minWidth: '100px' }}>Fecha</th>
                    <th style={{ padding: '1rem', textAlign: 'right', minWidth: '160px', whiteSpace: 'nowrap' }}>Monto</th>
                    <th style={{ padding: '1rem', textAlign: 'left', minWidth: '120px' }}>Tipo</th>
                    <th style={{ padding: '1rem', textAlign: 'left', minWidth: '140px' }}>Cuota</th>
                    <th style={{ padding: '1rem', textAlign: 'center', minWidth: '100px' }}>Método</th>
                    <th style={{ padding: '1rem', textAlign: 'left', minWidth: '120px' }}>Ref.</th>
                    <th style={{ padding: '1rem', textAlign: 'left', minWidth: '150px' }}>Responsable</th>
                    <th style={{ padding: '1rem', textAlign: 'center', minWidth: '60px' }}>Doc</th>
                    <th style={{ padding: '1rem', textAlign: 'center', minWidth: '100px' }}>Acción</th>
                  </tr>
                </thead>
                <tbody>
                  {historyLoading ? (
                    <tr>
                      <td colSpan={9} style={{ padding: '2rem', textAlign: 'center', color: 'var(--muted)' }}>
                        Cargando historial...
                      </td>
                    </tr>
                  ) : historyError ? (
                    <tr>
                      <td colSpan={9} style={{ padding: '2rem', textAlign: 'center', color: '#ef4444' }}>
                        {historyError}
                      </td>
                    </tr>
                  ) : historyPayments.length === 0 ? (
                    <tr>
                      <td colSpan={9} style={{ padding: '2rem', textAlign: 'center', color: 'var(--muted)' }}>
                        No hay pagos registrados
                      </td>
                    </tr>
                  ) : (
                    historyPayments.map(payment => (
                      <tr key={payment.id} style={{ borderBottom: '1px solid var(--border)' }}>
                        <td style={{ padding: '1rem' }}>
                          {formatDate(payment.created_at)}
                        </td>
                        <td style={{ padding: '1rem', textAlign: 'right', fontWeight: 'bold', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
                          {formatMoney(payment.amount)}
                        </td>
                        <td style={{ padding: '1rem', color: 'var(--muted)' }}>
                          {getPaymentTypeLabel(payment)}
                        </td>
                        <td style={{ padding: '1rem', color: 'var(--muted)' }}>
                          {payment.installment_due_date ? formatDate(payment.installment_due_date) : '-'}
                        </td>
                        <td style={{ padding: '1rem', textAlign: 'center' }}>
                          <span style={{
                            padding: '4px 8px',
                            borderRadius: '12px',
                            backgroundColor: payment.payment_method === 'CASH' ? 'rgba(52, 152, 219, 0.1)' : 'rgba(241, 196, 15, 0.1)',
                            color: payment.payment_method === 'CASH' ? '#3498db' : '#f1c40f',
                            fontSize: '0.85rem',
                            fontWeight: 'bold',
                            border: `1px solid ${payment.payment_method === 'CASH' ? '#3498db' : '#f1c40f'}`
                          }}>
                            {payment.payment_method === 'CASH' ? 'Efectivo' : 
                             payment.payment_method === 'CARD' ? 'Tarjeta' : 'Depósito'}
                          </span>
                        </td>
                        <td style={{ padding: '1rem', color: 'var(--muted)' }}>{payment.reference || '-'}</td>
                        <td style={{ padding: '1rem', color: 'var(--muted)' }}>{payment.received_by || '-'}</td>
                        <td style={{ padding: '1rem', textAlign: 'center' }}>
                          {payment.document_url ? (
                            <a 
                              href={payment.document_url}
                              target="_blank" 
                              rel="noopener noreferrer"
                              style={{ 
                                color: 'var(--accent)', 
                                textDecoration: 'none', 
                                fontWeight: 'bold',
                                border: '1px solid var(--accent)',
                                padding: '2px 8px',
                                borderRadius: '4px'
                              }}
                            >
                              Ver
                            </a>
                          ) : '-'}
                        </td>
                        <td style={{ padding: '1rem', textAlign: 'center' }}>
                          <button
                            className="icon-btn"
                            onClick={() => handlePrintPayment(
                              payment,
                              selectedCreditHistory,
                              { grandTotal: selectedCreditHistory.sale_total, paidAfter: selectedCreditHistory.total_paid, pendingAfter: selectedCreditHistory.total_pending },
                              { payments: historyPayments, installments: credits.filter(it => it.sale_id === selectedCreditHistory.sale_id) }
                            )}
                            title="Imprimir comprobante"
                            style={{ margin: '0 auto' }}
                          >
                            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <polyline points="6 9 6 2 18 2 18 9" />
                              <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
                              <rect x="6" y="14" width="12" height="8" />
                            </svg>
                          </button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
            )}

            <div style={{ textAlign: 'right' }}>
              <button
                onClick={closeHistoryModal}
                style={{
                  padding: '0.5rem 1rem',
                  background: 'transparent',
                  color: 'var(--text)',
                  border: '1px solid var(--border)',
                  borderRadius: '8px',
                  cursor: 'pointer',
                  width: isMobileViewport ? '100%' : 'auto'
                }}
              >
                Cerrar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
