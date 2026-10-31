import crypto from 'crypto'
import express from 'express'
import { authMiddleware, getUserWarehouseId, isAdminUser } from '../auth.js'
import { getPool } from '../db.js'

const router = express.Router()

function userHasPermission(user, permission) {
  if (isAdminUser(user)) return true
  return Array.isArray(user?.permissions) && user.permissions.includes(permission)
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function normalizeSignatureDataUrl(value) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  if (raw.startsWith('data:image/')) return raw
  const lower = raw.toLowerCase()
  if (lower.startsWith('data:application/octet-stream;base64,')) {
    return `data:image/png;base64,${raw.slice(raw.indexOf(',') + 1)}`
  }
  if (lower.startsWith('data:;base64,')) {
    return `data:image/png;base64,${raw.slice(raw.indexOf(',') + 1)}`
  }
  if (lower.startsWith('data:') && lower.includes(';base64,')) {
    return `data:image/png;base64,${raw.slice(raw.indexOf(',') + 1)}`
  }
  return raw
}

function formatMoneyQ(value) {
  const n = Number(value || 0)
  const fixed = Number.isFinite(n) ? n.toFixed(2) : '0.00'
  return `Q${fixed}`
}

function formatDateEs(value) {
  if (!value) return ''
  if (value instanceof Date) {
    const y = value.getFullYear()
    const m = String(value.getMonth() + 1).padStart(2, '0')
    const d = String(value.getDate()).padStart(2, '0')
    return `${d}/${m}/${y}`
  }

  const raw = String(value || '').trim()
  if (!raw) return ''
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(raw)) return raw
  const datePart = raw.includes('T') ? raw.split('T')[0] : raw
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(datePart)
  if (m) return `${m[3]}/${m[2]}/${m[1]}`

  const parsed = new Date(raw)
  if (!Number.isNaN(parsed.getTime())) return formatDateEs(parsed)
  return raw
}

function toYmd(value) {
  if (!value) return ''
  if (value instanceof Date) {
    const y = value.getFullYear()
    const m = String(value.getMonth() + 1).padStart(2, '0')
    const d = String(value.getDate()).padStart(2, '0')
    return `${y}-${m}-${d}`
  }
  const raw = String(value || '').trim()
  if (!raw) return ''
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw
  if (raw.includes('T')) return raw.split('T')[0]
  const parsed = new Date(raw)
  if (!Number.isNaN(parsed.getTime())) return toYmd(parsed)
  return raw
}

function guessFrequencyLabel(installments) {
  if (!Array.isArray(installments) || installments.length < 2) return 'MENSUAL'
  const msDay = 1000 * 60 * 60 * 24
  const points = installments
    .map((it) => {
      const raw = it?.due_date ?? it?.dueDate
      const d = raw instanceof Date ? raw : new Date(String(raw || ''))
      if (Number.isNaN(d.getTime())) return null
      return d
    })
    .filter(Boolean)
    .sort((a, b) => a.getTime() - b.getTime())
  if (points.length < 2) return 'MENSUAL'
  const diffDays = Math.round(Math.abs(points[1].getTime() - points[0].getTime()) / msDay)
  if (diffDays <= 8) return 'SEMANAL'
  if (diffDays <= 16) return 'QUINCENAL'
  return 'MENSUAL'
}

function renderContractHtml(payload) {
  const branchName = escapeHtml(payload.branchName || '')
  const branchAddress = escapeHtml(payload.branchAddress)
  const branchPhone = escapeHtml(payload.branchPhone)
  const branchFacebook = escapeHtml(payload.branchFacebook)

  const customerName = escapeHtml(payload.customerName)
  const customerPhone = escapeHtml(payload.customerPhone)
  const customerAge = escapeHtml(payload.customerAge)
  const customerNationality = escapeHtml(payload.customerNationality)
  const customerCivilStatus = escapeHtml(payload.customerCivilStatus)
  const customerOccupation = escapeHtml(payload.customerOccupation)
  const customerAddress = escapeHtml(payload.customerAddress)
  const customerMunicipality = escapeHtml(payload.customerMunicipality)
  const customerDepartment = escapeHtml(payload.customerDepartment)
  const customerDpi = escapeHtml(payload.customerDpi)

  const issueDay = escapeHtml(payload.issueDay)
  const issueMonth = escapeHtml(payload.issueMonth)
  const issueYear = escapeHtml(payload.issueYear)
  const issuerName = escapeHtml(payload.issuerName)

  const totalCredit = formatMoneyQ(payload.totalCredit)
  const downPayment = formatMoneyQ(payload.downPayment)
  const paymentsCount = escapeHtml(payload.paymentsCount)
  const installmentAmount = formatMoneyQ(payload.installmentAmount)
  const warrantyTime = escapeHtml(payload.warrantyTime || '')
  const isSettled = Boolean(payload.isSettled)
  const settlementDate = escapeHtml(formatDateEs(payload.settlementDate || ''))
  const totalPaid = formatMoneyQ(payload.totalPaid)
  const remainingBalance = formatMoneyQ(payload.remainingBalance)

  const frequency = String(payload.frequency || 'MENSUAL').toUpperCase()
  const freqMark = (k) => (frequency === k ? 'X' : '')

  const buyerSignatureData = String(payload.buyerSignatureData || '').trim()
  const signatureImg = buyerSignatureData
    ? `<img src="${escapeHtml(buyerSignatureData)}" style="max-height: 90px; max-width: 70%; object-fit: contain; display:block; margin: 0 auto 6px;" />`
    : ''

  const itemsRows = (payload.items || []).map((it) => {
    return `
      <tr>
        <td>${escapeHtml(it.product)}</td>
        <td>${escapeHtml(it.brand)}</td>
        <td>${escapeHtml(it.model)}</td>
        <td>${escapeHtml(it.series)}</td>
        <td class="money">${formatMoneyQ(it.price)}</td>
      </tr>
    `
  }).join('')

  const installmentsRows = (payload.installmentsStatus || []).map((it) => {
    return `
      <tr>
        <td>${escapeHtml(it.no)}</td>
        <td>${escapeHtml(formatDateEs(it.dueDate))}</td>
        <td class="money">${it.amount === '' ? '' : formatMoneyQ(it.amount)}</td>
      </tr>
    `
  }).join('')

  const referencesRows = (payload.references || []).map((r) => {
    return `
      <tr>
        <td>${escapeHtml(r.no)}</td>
        <td>${escapeHtml(r.name)}</td>
        <td>${escapeHtml(r.phone)}</td>
      </tr>
    `
  }).join('')

  const codeText = `
ART. 376 Código De Comercio. El contratante deberá ser condenado a admitir la rescisión del contrato o bien a contrato cumplirlo y en cualquiera de los dos casos el pago de los daños y perjuicios.
ART. 2346. Para que la promesa de contrato sea válida debe constar por escrito, contener los elementos característicos del contrato definitivo.
ART. 2247. Si el prometiente revisa firmas los documentos necesarios para dar forma legal al contrato que el colaborador le acreditara, en su rebeldía de no informarla, lo firmara el juez, salvo el caso de que la cosa ofrecida haya pasado por oneroso a la propiedad del tercero de buena fe, pues entonces la promesa quedara sin efecto, siendo responsable el que la hizo de todos los daños y perjuicios que se hayan originado a la otra parte.
ARTICULO 677. Código de comercio Mora. En las obligaciones y contratos mercantiles se incurre en mora, sin necesidad de requerimiento, desde el día siguiente a aquél en que venzan o sean exigibles. Se exceptúan de lo dispuesto en este artículo los títulos de crédito y las obligaciones y contratos en que expresamente se haya pactado de lo contrario. Por lo tanto, la aplicación incurre en mora después del sexto día de la fecha sugerida de pago equivalente Q25.00 por día de atraso.
  `.trim()

  return `<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Contrato de Créditos</title>
    <style>
      :root { color-scheme: light; }
      html, body { margin: 0; padding: 0; font-family: Arial, Helvetica, sans-serif; color: #0f172a; }
      .page { width: 210mm; min-height: 297mm; padding: 16mm 14mm 26mm; box-sizing: border-box; position: relative; }
      .page + .page { margin-top: 12px; }
      .title { text-align: center; font-size: 18px; font-weight: 800; letter-spacing: 0.3px; margin: 4px 0 12px; }
      .p { font-size: 13px; line-height: 1.4; margin: 8px 0; }
      .label { font-weight: 700; }
      .mono { font-variant-numeric: tabular-nums; }
      table { width: 100%; border-collapse: collapse; font-size: 12px; }
      th, td { border: 1px solid #111827; padding: 6px 6px; vertical-align: top; }
      th { text-align: left; background: #f8fafc; }
      td.money { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
      .section-title { font-weight: 800; margin-top: 12px; font-size: 13px; }
      .box { border: 1px solid #111827; padding: 8px; border-radius: 2px; }
      .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
      .sign { margin-top: 22px; text-align: center; }
      .sign .line { margin: 18px auto 6px; width: 70%; border-top: 1px solid #111827; }
      .sign-big { margin-top: 30px; }
      .sign-big .line { margin: 70px auto 10px; width: 85%; }
      .small { font-size: 11px; color: #334155; }
      .freq { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 10px; margin-top: 6px; }
      .freq .cell { border: 1px solid #111827; padding: 6px; display: flex; justify-content: space-between; align-items: center; }
      .freq .mark { width: 18px; height: 18px; border: 1px solid #111827; display: inline-flex; align-items: center; justify-content: center; font-weight: 800; }
      .footer { position: absolute; left: 14mm; right: 14mm; bottom: 10mm; display: flex; justify-content: space-between; gap: 10px; font-size: 10.5px; color: #334155; }
      .footer .left { min-width: 50%; }
      .footer .right { text-align: right; }
      @page { size: A4; margin: 0; }
      @media print {
        body { background: #fff; }
        html, body { width: auto; height: auto; }
        .page { margin: 0; width: auto; min-height: auto; padding: 0; }
        .page + .page { margin-top: 0; page-break-before: auto; break-before: auto; }
        .page { page-break-after: always; break-after: page; }
        .page:last-child { page-break-after: auto; break-after: auto; }
        .footer { position: static; left: auto; right: auto; bottom: auto; margin-top: 12px; }
      }
    </style>
  </head>
  <body>
    <div class="page">
      <div class="title">CONTRATO DE CRÉDITOS</div>

      <div class="p">
        <span class="label">Yo:</span> ${customerName} &nbsp;&nbsp;
        <span class="label">con teléfono No:</span> ${customerPhone} &nbsp;&nbsp;
        <span class="label">de</span> ${customerAge} <span class="label">años de edad</span> ${customerNationality}
        <span class="label">estado civil</span> ${customerCivilStatus}, <span class="label">de profesión</span> ${customerOccupation}
        <span class="label">con domicilio en</span> ${customerAddress},
        <span class="label">municipio de:</span> ${customerMunicipality},
        <span class="label">departamento de:</span> ${customerDepartment},
        <span class="label">quien se identifica con el Documento Personal de Identificación Número:</span>
        <span class="mono">${customerDpi}</span> extendida en Registro Nacional De Las Personas (RENAP).
      </div>

      <div class="p">
        Por lo tanto, acepto todas las condiciones estipuladas por la empresa del contrato extendido.
        Me responsabilizo a cancelar todo artículo adquirido por mi persona en la empresa.
      </div>

      <div class="p">
        El contrato fue extendido la fecha <span class="mono">${issueDay}</span> de <span class="mono">${issueMonth}</span> del <span class="mono">${issueYear}</span>
        por <span class="mono">${issuerName}</span> &nbsp;&nbsp; F: ______________________
      </div>

      <div class="p">De la misma manera se le hace mención de algunos artículos del código de comercio.</div>

      <div class="section-title">CONDICIONES DEL CÓDIGO DE COMERCIO:</div>
      <div class="box small" style="white-space: pre-wrap;">${escapeHtml(codeText)}</div>

      <div class="section-title" style="margin-top: 14px;">Datos generales del crédito:</div>
      <table>
        <thead>
          <tr>
            <th>PRODUCTO</th>
            <th>MARCA</th>
            <th>MODELO</th>
            <th>SERIE</th>
            <th style="text-align:right;">PRECIO</th>
          </tr>
        </thead>
        <tbody>
          ${itemsRows || '<tr><td colspan="5">Sin artículos</td></tr>'}
        </tbody>
      </table>
      <div class="footer">
        <div class="left">
          <div><span class="label">Tienda:</span> ${branchName || 'Tienda'}</div>
          <div>${branchAddress} · CEL ${branchPhone} · FACEBOOK ${branchFacebook}</div>
        </div>
        <div class="right">
          <div>Contrato generado por ${issuerName}</div>
          <div>${issueDay}/${issueMonth}/${issueYear} · Venta #${escapeHtml(payload.saleId)}</div>
        </div>
      </div>
    </div>

    <div class="page">
      <div class="p">
        <span class="label">Total, Crédito</span> <span class="mono">${totalCredit}</span> &nbsp;&nbsp;
        ${Number(payload.downPayment || 0) > 0 ? `<span class="label">Enganche:</span> <span class="mono">${downPayment}</span> &nbsp;&nbsp;` : ''}
        <span class="label">No. De pagos a realizar:</span> <span class="mono">${paymentsCount}</span>
      </div>

      <div class="p">
        <span class="label">De</span> <span class="mono">${installmentAmount}</span>
      </div>

      <div class="freq">
        <div class="cell"><span>MENSUAL</span><span class="mark">${freqMark('MENSUAL')}</span></div>
        <div class="cell"><span>QUINCENAL</span><span class="mark">${freqMark('QUINCENAL')}</span></div>
        <div class="cell"><span>SEMANAL</span><span class="mark">${freqMark('SEMANAL')}</span></div>
      </div>

      <div class="p" style="margin-top: 10px;">
        <span class="label">Tiempo de Garantía:</span> <span class="mono">${warrantyTime}</span>
      </div>

      <div class="section-title">PLAN DE CUOTAS:</div>
      <table>
        <thead>
          <tr>
            <th style="width: 70px;">CUOTA</th>
            <th style="width: 120px;">VENCE</th>
            <th style="text-align:right; width: 120px;">MONTO (Q)</th>
          </tr>
        </thead>
        <tbody>
          ${installmentsRows || '<tr><td colspan="3">Sin cuotas</td></tr>'}
        </tbody>
      </table>

      <div class="section-title" style="margin-top: 14px;">DATOS DE REFERENCIA:</div>
      <div class="small" style="margin-bottom: 6px;">
        APLICACIÓN DE LA PENA CONVENCIONAL, ES LA ACTIVIDAD DETERMINADA EN QUETZALES PARA EL CONTRATANTE INCUMPLIDO A PAGAR AL CONTRATANTE CUMPLIDO AL COBRADOR DEL COMERCIO.
      </div>
      <table>
        <thead>
          <tr>
            <th style="width: 55px;">NO.</th>
            <th>NOMBRE</th>
            <th style="width: 170px;">NO. TEL / CEL</th>
          </tr>
        </thead>
        <tbody>
          ${referencesRows || '<tr><td colspan="3">Sin referencias</td></tr>'}
        </tbody>
      </table>

      <div class="p" style="margin-top: 14px;">
        <span class="label">NOTA:</span> Si el comprador no cancela el tiempo estipulado se recogerá el producto sin devolución del dinero ya abonado. De contrario será procesado ante la ley.
      </div>

      <div class="p"><span class="label">Por Lo Cual Acepto Y Firmo Las Condiciones.</span></div>

      <div class="sign">
        ${signatureImg}
        <div class="line"></div>
        <div class="label">F.</div>
      </div>
      <div class="footer">
        <div class="left">
          <div><span class="label">Tienda:</span> ${branchName || 'Tienda'}</div>
          <div>${branchAddress} · CEL ${branchPhone} · FACEBOOK ${branchFacebook}</div>
        </div>
        <div class="right">
          <div>Contrato generado por ${issuerName}</div>
          <div>${issueDay}/${issueMonth}/${issueYear} · Venta #${escapeHtml(payload.saleId)}</div>
        </div>
      </div>
    </div>

    ${isSettled ? `
    <div class="page">
      <div class="title">FINIQUITO DE CRÉDITO</div>

      <div class="p">
        Por este medio se hace constar que <span class="label">${customerName}</span>, identificado con DPI <span class="mono">${customerDpi}</span>,
        ha cancelado en su totalidad el crédito correspondiente a la <span class="label">Venta #${escapeHtml(payload.saleId)}</span>.
      </div>

      <div class="p">
        <span class="label">Total del crédito:</span> <span class="mono">${totalCredit}</span> &nbsp;&nbsp;
        <span class="label">Total pagado:</span> <span class="mono">${totalPaid}</span> &nbsp;&nbsp;
        <span class="label">Saldo:</span> <span class="mono">${remainingBalance}</span>
      </div>

      <div class="p">
        <span class="label">Fecha de finiquito:</span> <span class="mono">${settlementDate}</span>
      </div>

      <div class="sign sign-big">
        <div class="line"></div>
        <div class="label">Firma del cliente</div>
      </div>

      <div class="sign sign-big">
        <div class="line"></div>
        <div class="label">Firma y sello de la empresa</div>
      </div>

      <div class="footer">
        <div class="left">
          <div><span class="label">Tienda:</span> ${branchName || 'Tienda'}</div>
          <div>${branchAddress} · CEL ${branchPhone} · FACEBOOK ${branchFacebook}</div>
        </div>
        <div class="right">
          <div>Finiquito generado por ${issuerName}</div>
          <div>${issueDay}/${issueMonth}/${issueYear} · Venta #${escapeHtml(payload.saleId)}</div>
        </div>
      </div>
    </div>
    ` : ''}
  </body>
</html>`
}

function renderSettlementHtml(payload) {
  const branchName = escapeHtml(payload.branchName || '')
  const branchAddress = escapeHtml(payload.branchAddress)
  const branchPhone = escapeHtml(payload.branchPhone)
  const branchFacebook = escapeHtml(payload.branchFacebook)

  const customerName = escapeHtml(payload.customerName)
  const customerDpi = escapeHtml(payload.customerDpi)
  const issuerName = escapeHtml(payload.issuerName)

  const totalCredit = formatMoneyQ(payload.totalCredit)
  const totalPaid = formatMoneyQ(payload.totalPaid)
  const remainingBalance = formatMoneyQ(payload.remainingBalance)
  const settlementDate = escapeHtml(formatDateEs(payload.settlementDate || ''))

  const issueDay = escapeHtml(payload.issueDay)
  const issueMonth = escapeHtml(payload.issueMonth)
  const issueYear = escapeHtml(payload.issueYear)

  const paidInstallmentsRows = (payload.installmentsStatus || [])
    .filter((it) => String(it?.status || '').toUpperCase() === 'PAGADA' || String(it?.paidAt || '').trim())
    .map((it) => {
      return `
        <tr>
          <td>${escapeHtml(it.no)}</td>
          <td>${escapeHtml(formatDateEs(it.dueDate))}</td>
          <td class="money">${it.amount === '' ? '' : formatMoneyQ(it.amount)}</td>
          <td>${escapeHtml(formatDateEs(it.paidAt))}</td>
        </tr>
      `
    }).join('')

  const paidInstallmentsTotal = (payload.installmentsStatus || [])
    .filter((it) => String(it?.status || '').toUpperCase() === 'PAGADA' || String(it?.paidAt || '').trim())
    .reduce((sum, it) => sum + Number(it?.amount || 0), 0)

  const receiptsRows = (payload.payments || [])
    .filter((p) => String(p?.date || '').trim() || String(p?.receiptNo || '').trim() || (p?.amount !== '' && p?.amount !== null && p?.amount !== undefined))
    .map((p) => {
      return `
        <tr>
          <td>${escapeHtml(formatDateEs(p.date))}</td>
          <td>${escapeHtml(p.receiptNo)}</td>
          <td>${escapeHtml(p.typeLabel || '')}</td>
          <td class="money">${p.amount === '' ? '' : formatMoneyQ(p.amount)}</td>
        </tr>
      `
    }).join('')

  return `<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Finiquito de Crédito</title>
    <style>
      :root { color-scheme: light; }
      html, body { margin: 0; padding: 0; font-family: Arial, Helvetica, sans-serif; color: #0f172a; }
      .page { width: 210mm; min-height: 297mm; padding: 16mm 14mm 26mm; box-sizing: border-box; position: relative; }
      .title { text-align: center; font-size: 18px; font-weight: 800; letter-spacing: 0.3px; margin: 4px 0 12px; }
      .p { font-size: 13px; line-height: 1.4; margin: 8px 0; }
      .label { font-weight: 700; }
      .mono { font-variant-numeric: tabular-nums; }
      table { width: 100%; border-collapse: collapse; font-size: 12px; }
      th, td { border: 1px solid #111827; padding: 6px 6px; vertical-align: top; }
      th { text-align: left; background: #f8fafc; }
      td.money { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
      .section-title { font-weight: 800; margin-top: 12px; font-size: 13px; }
      .sign { margin-top: 22px; text-align: center; }
      .sign .line { margin: 18px auto 6px; width: 70%; border-top: 1px solid #111827; }
      .sign-big { margin-top: 30px; }
      .sign-big .line { margin: 70px auto 10px; width: 85%; }
      .footer { position: absolute; left: 14mm; right: 14mm; bottom: 10mm; display: flex; justify-content: space-between; gap: 10px; font-size: 10.5px; color: #334155; }
      .footer .left { min-width: 50%; }
      .footer .right { text-align: right; }
      @page { size: A4; margin: 0; }
      @media print {
        body { background: #fff; }
        html, body { width: auto; height: auto; }
        .page { margin: 0; width: auto; min-height: auto; padding: 0; }
        .footer { position: static; left: auto; right: auto; bottom: auto; margin-top: 12px; }
      }
    </style>
  </head>
  <body>
    <div class="page">
      <div class="title">FINIQUITO DE CRÉDITO</div>

      <div class="p">
        Por este medio se hace constar que <span class="label">${customerName}</span>, identificado con DPI <span class="mono">${customerDpi}</span>,
        ha cancelado en su totalidad el crédito correspondiente a la <span class="label">Venta #${escapeHtml(payload.saleId)}</span>.
      </div>

      <div class="p">
        <span class="label">Total del crédito:</span> <span class="mono">${totalCredit}</span> &nbsp;&nbsp;
        <span class="label">Total pagado:</span> <span class="mono">${totalPaid}</span> &nbsp;&nbsp;
        <span class="label">Saldo:</span> <span class="mono">${remainingBalance}</span>
      </div>

      <div class="p">
        <span class="label">Fecha de finiquito:</span> <span class="mono">${settlementDate}</span>
      </div>

      <div class="section-title">CUOTAS PAGADAS:</div>
      <table>
        <thead>
          <tr>
            <th style="width: 70px;">CUOTA</th>
            <th style="width: 120px;">VENCE</th>
            <th style="text-align:right; width: 140px;">MONTO (Q)</th>
            <th style="width: 120px;">PAGADA EL</th>
          </tr>
        </thead>
        <tbody>
          ${paidInstallmentsRows || '<tr><td colspan="4">Sin cuotas pagadas</td></tr>'}
        </tbody>
      </table>

      <div class="p" style="margin-top: 10px;">
        <span class="label">Total cuotas pagadas:</span> <span class="mono">${formatMoneyQ(paidInstallmentsTotal)}</span>
      </div>

      <div class="section-title" style="margin-top: 14px;">ABONOS / RECIBOS REALIZADOS:</div>
      <table>
        <thead>
          <tr>
            <th>FECHA</th>
            <th>NO. RECIBO</th>
            <th>TIPO</th>
            <th style="text-align:right;">MONTO (Q)</th>
          </tr>
        </thead>
        <tbody>
          ${receiptsRows || '<tr><td colspan="4">Sin abonos registrados</td></tr>'}
        </tbody>
      </table>

      <div class="sign sign-big">
        <div class="line"></div>
        <div class="label">Firma del cliente</div>
      </div>

      <div class="sign sign-big">
        <div class="line"></div>
        <div class="label">Firma y sello de la empresa</div>
      </div>

      <div class="footer">
        <div class="left">
          <div><span class="label">Tienda:</span> ${branchName || 'Tienda'}</div>
          <div>${branchAddress} · CEL ${branchPhone} · FACEBOOK ${branchFacebook}</div>
        </div>
        <div class="right">
          <div>Finiquito generado por ${issuerName}</div>
          <div>${issueDay}/${issueMonth}/${issueYear} · Venta #${escapeHtml(payload.saleId)}</div>
        </div>
      </div>
    </div>
  </body>
</html>`
}

async function ensureCreditContractsSchema(conn) {
  await conn.query(`CREATE TABLE IF NOT EXISTS credit_contracts (
    id INT AUTO_INCREMENT PRIMARY KEY,
    sale_id INT NOT NULL,
    customer_id INT NOT NULL,
    warehouse_id INT NOT NULL,
    template_version VARCHAR(20) NOT NULL DEFAULT 'v1',
    html LONGTEXT NOT NULL,
    data_json LONGTEXT NOT NULL,
    sha256 CHAR(64) NOT NULL,
    buyer_signature_data LONGTEXT NULL,
    buyer_signed_at DATETIME NULL,
    created_by_user_id INT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NULL
  )`)
  await conn.query(`CREATE TABLE IF NOT EXISTS credit_contract_references (
    id INT AUTO_INCREMENT PRIMARY KEY,
    contract_id INT NOT NULL,
    ref_no INT NOT NULL,
    name VARCHAR(160) NULL,
    phone VARCHAR(60) NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`)
}

async function loadContractMetaBySale(conn, saleId) {
  const [rows] = await conn.query(
    'SELECT id, sale_id, customer_id, warehouse_id, template_version, sha256, buyer_signed_at, created_at, updated_at FROM credit_contracts WHERE sale_id = ? ORDER BY id DESC LIMIT 1',
    [saleId]
  )
  return rows?.[0] || null
}

async function loadContractFullBySale(conn, saleId) {
  const [rows] = await conn.query('SELECT * FROM credit_contracts WHERE sale_id = ? ORDER BY id DESC LIMIT 1', [saleId])
  return rows?.[0] || null
}

async function assertSaleAccessOrThrow(conn, reqUser, saleId, options = {}) {
  const allowPendingNonCredit = Boolean(options?.allowPendingNonCredit)
  const isAdmin = isAdminUser(reqUser)
  const userWarehouseId = getUserWarehouseId(reqUser)
  if (!isAdmin && !userWarehouseId) {
    const err = new Error('No tienes una tienda asignada')
    err.status = 403
    throw err
  }

  const [rows] = await conn.query(
    `
      SELECT s.id, s.total, s.is_credit, s.warehouse_id, s.status, s.payment_method,
             c.id AS customer_id, c.name AS customer_name, c.document AS customer_document, c.phone AS customer_phone, c.address AS customer_address,
             c.age AS customer_age, c.nationality AS customer_nationality, c.civil_status AS customer_civil_status, c.occupation AS customer_occupation,
             c.municipality AS customer_municipality, c.department AS customer_department,
             w.name AS warehouse_name, w.address AS warehouse_address, w.contract_phone AS warehouse_contract_phone, w.contract_facebook AS warehouse_contract_facebook
      FROM sales s
      LEFT JOIN customers c ON c.id = s.customer_id
      LEFT JOIN warehouses w ON w.id = s.warehouse_id
      WHERE s.id = ?
      LIMIT 1
    `,
    [saleId]
  )
  const sale = rows?.[0]
  if (!sale) {
    const err = new Error('Venta no encontrada')
    err.status = 404
    throw err
  }
  if (!Number(sale.is_credit || 0)) {
    const isPendingCashierSale = String(sale.status || '').toUpperCase() === 'PENDING_PAYMENT'
      && String(sale.payment_method || '').toUpperCase() === 'PENDING'
    if (!allowPendingNonCredit || !isPendingCashierSale) {
      const err = new Error('La venta no está marcada como crédito')
      err.status = 400
      throw err
    }
  }
  if (!isAdmin && Number(sale.warehouse_id || 0) !== Number(userWarehouseId || 0)) {
    const err = new Error('No tienes acceso a esta venta desde tu sucursal')
    err.status = 403
    throw err
  }
  if (!sale.customer_id) {
    const err = new Error('La venta no tiene cliente asignado')
    err.status = 400
    throw err
  }
  if (!sale.warehouse_id) {
    const err = new Error('La venta no tiene sucursal asignada')
    err.status = 400
    throw err
  }
  return sale
}

async function buildContractDataForSale(conn, { saleId, sale, contract, issuerNameFallback }) {
  let stored = {}
  try {
    stored = contract?.data_json ? JSON.parse(String(contract.data_json)) : {}
  } catch {}

  const storedCustomer = stored?.customer || {}
  const storedRefs = Array.isArray(stored?.references) ? stored.references : []
  const warrantyTime = String(stored?.warrantyTime || '').trim()

  const createdAt = contract?.created_at ? new Date(contract.created_at) : new Date()
  const issueDay = String(stored?.issueDay || String(createdAt.getDate()).padStart(2, '0'))
  const issueMonth = String(stored?.issueMonth || String(createdAt.getMonth() + 1).padStart(2, '0'))
  const issueYear = String(stored?.issueYear || String(createdAt.getFullYear()))
  const issuerName = String(stored?.issuerName || issuerNameFallback || '').trim() || 'SISTEMA'

  const buyerSignatureData = normalizeSignatureDataUrl(contract?.buyer_signature_data || stored?.buyerSignatureData || '')

  const branchAddress = String(sale.warehouse_address || '').trim()
  const branchPhone = String(sale.warehouse_contract_phone || '').trim()
  const branchFacebook = String(sale.warehouse_contract_facebook || 'Muebles Yatir.').trim()

  const customerName = String(sale.customer_name || '').trim()
  const customerPhone = String(storedCustomer.phone ?? sale.customer_phone ?? '').trim()
  const customerAge = String(storedCustomer.age ?? sale.customer_age ?? '').trim()
  const customerNationality = String(storedCustomer.nationality ?? sale.customer_nationality ?? 'guatemalteco(a)').trim()
  const customerCivilStatus = String(storedCustomer.civilStatus ?? sale.customer_civil_status ?? '').trim()
  const customerOccupation = String(storedCustomer.occupation ?? sale.customer_occupation ?? '').trim()
  const customerAddress = String(storedCustomer.address ?? sale.customer_address ?? '').trim()
  const customerMunicipality = String(storedCustomer.municipality ?? sale.customer_municipality ?? '').trim()
  const customerDepartment = String(storedCustomer.department ?? sale.customer_department ?? '').trim()
  const customerDpi = String(storedCustomer.dpi ?? sale.customer_document ?? '').trim()

  const [items] = await conn.query(
    `
      SELECT si.quantity, si.unit_price, si.total, si.serial, si.imei,
             p.name AS product_name, p.product_code, b.name AS brand_name
      FROM sale_items si
      JOIN products p ON p.id = si.product_id
      LEFT JOIN brands b ON b.id = p.brand_id
      WHERE si.sale_id = ?
      ORDER BY si.id ASC
    `,
    [saleId]
  )

  const itemPayload = (items || []).map((row) => ({
    product: row.product_name || '',
    brand: row.brand_name || '',
    model: row.product_code || '',
    series: row.serial || row.imei || '',
    price: Number(row.total || 0),
  }))

  const [installments] = await conn.query(
    'SELECT id, due_date, amount, paid, paid_at FROM installments WHERE sale_id = ? ORDER BY due_date ASC, id ASC',
    [saleId]
  )

  const [downInstallments] = await conn.query(
    `
      SELECT DISTINCT cp.installment_id
      FROM credit_payments cp
      JOIN installments i ON i.id = cp.installment_id
      WHERE i.sale_id = ? AND cp.payment_type = 'DOWN_PAYMENT'
    `,
    [saleId]
  )
  const downIds = new Set((downInstallments || []).map(r => Number(r.installment_id || 0)).filter(Boolean))
  const planInstallments = (installments || []).filter(it => !downIds.has(Number(it.id || 0)))

  const installmentsStatus = (planInstallments || []).map((it, index) => ({
    no: index + 1,
    dueDate: toYmd(it.due_date),
    amount: Number(it.amount || 0),
    status: Number(it.paid || 0) ? 'PAGADA' : 'PENDIENTE',
    paidAt: it.paid_at ? toYmd(it.paid_at) : '',
  }))

  const totalCredit = Number(sale.total || 0)
  const paymentsCount = Array.isArray(planInstallments) ? planInstallments.length : 0
  const installmentAmount = paymentsCount > 0 ? Number(planInstallments[0].amount || 0) : 0
  const frequency = guessFrequencyLabel(planInstallments || [])

  const [downRows] = await conn.query(
    `
      SELECT COALESCE(SUM(cp.amount), 0) AS down_payment
      FROM credit_payments cp
      JOIN installments i ON i.id = cp.installment_id
      WHERE i.sale_id = ? AND cp.payment_type = 'DOWN_PAYMENT'
    `,
    [saleId]
  )
  const downPayment = Number(downRows?.[0]?.down_payment || 0)
  const storedDownPayment = Number(stored?.downPayment ?? stored?.down_payment ?? 0)
  const resolvedDownPayment = downPayment > 0 ? downPayment : (storedDownPayment > 0 ? storedDownPayment : 0)

  const [payRows] = await conn.query(
    `
      SELECT cp.id, cp.amount, cp.paid_at, cp.payment_type
      FROM credit_payments cp
      JOIN installments i ON i.id = cp.installment_id
      WHERE i.sale_id = ? AND cp.payment_type IN ('DOWN_PAYMENT','INSTALLMENT')
      ORDER BY cp.paid_at ASC, cp.id ASC
    `,
    [saleId]
  )

  let running = 0
  let lastPaidAt = ''
  const paymentPayload = (payRows || []).map((p) => {
    running += Number(p.amount || 0)
    if (p.paid_at) lastPaidAt = toYmd(p.paid_at)
    const rawType = String(p.payment_type || '').toUpperCase()
    const typeLabel = rawType === 'DOWN_PAYMENT' ? 'ENGANCHE' : (rawType === 'INSTALLMENT' ? 'CUOTA' : rawType)
    return {
      date: toYmd(p.paid_at),
      receiptNo: `#${p.id}`,
      typeLabel,
      amount: Number(p.amount || 0),
      balance: Math.max(0, totalCredit - running),
    }
  })

  const paymentRowsTarget = 14
  while (paymentPayload.length < paymentRowsTarget) {
    paymentPayload.push({ date: '', receiptNo: '', typeLabel: '', amount: '', balance: '' })
  }

  const refTarget = 4
  const refsPayload = []
  for (let i = 0; i < Math.max(refTarget, storedRefs.length); i++) {
    const r = storedRefs[i] || {}
    refsPayload.push({
      no: i + 1,
      name: String(r.name || '').trim(),
      phone: String(r.phone || '').trim(),
    })
  }

  const totalPaid = Math.round(running * 100) / 100
  const remainingBalance = Math.round(Math.max(0, totalCredit - totalPaid) * 100) / 100
  const isSettled = remainingBalance <= 0.01 && paymentsCount > 0
  const settlementDate = isSettled ? (lastPaidAt || `${issueYear}-${issueMonth}-${issueDay}`) : ''

  return {
    saleId,
    warehouseId: Number(sale.warehouse_id),
    customerId: Number(sale.customer_id),
    branchName: String(sale.warehouse_name || '').trim(),
    branchAddress,
    branchPhone,
    branchFacebook,
    customerName,
    customerPhone,
    customerAge,
    customerNationality,
    customerCivilStatus,
    customerOccupation,
    customerAddress,
    customerMunicipality,
    customerDepartment,
    customerDpi,
    issueDay,
    issueMonth,
    issueYear,
    issuerName,
    totalCredit,
    downPayment: resolvedDownPayment,
    paymentsCount,
    installmentAmount,
    frequency,
    warrantyTime,
    buyerSignatureData,
    items: itemPayload,
    installmentsStatus,
    totalPaid,
    remainingBalance,
    isSettled,
    settlementDate,
    payments: paymentPayload,
    references: refsPayload,
  }
}

router.get('/sale/:saleId', authMiddleware, async (req, res) => {
  try {
    if (!userHasPermission(req.user, 'credits:write')) {
      return res.status(403).json({ error: 'Forbidden: Missing permission credits:write' })
    }
    const saleId = Number(req.params.saleId)
    const pool = await getPool()
    await assertSaleAccessOrThrow(pool, req.user, saleId, { allowPendingNonCredit: true })
    const contract = await loadContractMetaBySale(pool, saleId)
    return res.json({ contract })
  } catch (err) {
    const status = err?.status || 500
    if (status === 500) console.error('credit_contracts sale GET error:', err)
    return res.status(status).json({ error: err?.message || 'Server error' })
  }
})

router.get('/sale/:saleId/html', authMiddleware, async (req, res) => {
  try {
    if (!userHasPermission(req.user, 'credits:write')) {
      return res.status(403).json({ error: 'Forbidden: Missing permission credits:write' })
    }
    const saleId = Number(req.params.saleId)
    const pool = await getPool()
    const sale = await assertSaleAccessOrThrow(pool, req.user, saleId, { allowPendingNonCredit: true })
    const contract = await loadContractFullBySale(pool, saleId)
    if (!contract) return res.status(404).json({ error: 'Contrato no encontrado' })

    const contractData = await buildContractDataForSale(pool, {
      saleId,
      sale,
      contract,
      issuerNameFallback: String(req.user?.name || '').trim(),
    })
    const html = renderContractHtml(contractData)

    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    return res.send(html)
  } catch (err) {
    const status = err?.status || 500
    if (status === 500) console.error('credit_contracts sale HTML error:', err)
    return res.status(status).json({ error: err?.message || 'Server error' })
  }
})

router.get('/sale/:saleId/settlement-html', authMiddleware, async (req, res) => {
  try {
    if (!userHasPermission(req.user, 'credits:write')) {
      return res.status(403).json({ error: 'Forbidden: Missing permission credits:write' })
    }
    const saleId = Number(req.params.saleId)
    const pool = await getPool()
    const sale = await assertSaleAccessOrThrow(pool, req.user, saleId, { allowPendingNonCredit: true })
    const contract = await loadContractFullBySale(pool, saleId)
    if (!contract) return res.status(404).json({ error: 'Contrato no encontrado' })

    const contractData = await buildContractDataForSale(pool, {
      saleId,
      sale,
      contract,
      issuerNameFallback: String(req.user?.name || '').trim(),
    })
    if (!contractData.isSettled) {
      return res.status(400).json({ error: 'El crédito aún no está finiquitado' })
    }
    const html = renderSettlementHtml(contractData)

    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    return res.send(html)
  } catch (err) {
    const status = err?.status || 500
    if (status === 500) console.error('credit_contracts settlement HTML error:', err)
    return res.status(status).json({ error: err?.message || 'Server error' })
  }
})

router.post('/sale/:saleId/generate', authMiddleware, async (req, res) => {
  const pool = await getPool()
  const conn = await pool.getConnection()
  try {
    if (!userHasPermission(req.user, 'credits:write')) {
      conn.release()
      return res.status(403).json({ error: 'Forbidden: Missing permission credits:write' })
    }
    const saleId = Number(req.params.saleId)
    await ensureCreditContractsSchema(conn)
    const sale = await assertSaleAccessOrThrow(conn, req.user, saleId, { allowPendingNonCredit: true })

    const body = req.body || {}
    const customerOverrides = body.customer || {}
    const warrantyTime = String(body.warrantyTime || '').trim()
    const references = Array.isArray(body.references) ? body.references : []
    const buyerSignatureData = normalizeSignatureDataUrl(body.buyerSignatureData)

    const branchAddress = String(sale.warehouse_address || '').trim()
    const branchPhone = String(sale.warehouse_contract_phone || '').trim()
    const branchFacebook = String(sale.warehouse_contract_facebook || 'Muebles Yatir.').trim()

    if (!branchAddress) {
      conn.release()
      return res.status(400).json({ error: 'La sucursal no tiene dirección configurada' })
    }
    if (!branchPhone) {
      conn.release()
      return res.status(400).json({ error: 'La sucursal no tiene CEL configurado para contratos (configúralo en Almacenes y Tiendas)' })
    }

    const customerName = String(sale.customer_name || '').trim()
    const customerPhone = String(customerOverrides.phone ?? sale.customer_phone ?? '').trim()
    const customerAge = String(customerOverrides.age ?? sale.customer_age ?? '').trim()
    const customerNationality = String(customerOverrides.nationality ?? sale.customer_nationality ?? 'guatemalteco(a)').trim()
    const customerCivilStatus = String(customerOverrides.civilStatus ?? sale.customer_civil_status ?? '').trim()
    const customerOccupation = String(customerOverrides.occupation ?? sale.customer_occupation ?? '').trim()
    const customerAddress = String(customerOverrides.address ?? sale.customer_address ?? '').trim()
    const customerMunicipality = String(customerOverrides.municipality ?? sale.customer_municipality ?? '').trim()
    const customerDepartment = String(customerOverrides.department ?? sale.customer_department ?? '').trim()
    const customerDpi = String(customerOverrides.dpi ?? sale.customer_document ?? '').trim()

    const requiredMissing = []
    if (!customerName) requiredMissing.push('Nombre del cliente')
    if (!customerPhone) requiredMissing.push('Teléfono del cliente')
    if (!customerAge) requiredMissing.push('Edad del cliente')
    if (!customerCivilStatus) requiredMissing.push('Estado civil')
    if (!customerOccupation) requiredMissing.push('Profesión u oficio')
    if (!customerAddress) requiredMissing.push('Dirección del cliente')
    if (!customerMunicipality) requiredMissing.push('Municipio')
    if (!customerDepartment) requiredMissing.push('Departamento')
    if (!customerDpi) requiredMissing.push('DPI')

    if (requiredMissing.length > 0) {
      conn.release()
      return res.status(400).json({ error: `Campos obligatorios faltantes: ${requiredMissing.join(', ')}` })
    }

    if (!buyerSignatureData) {
      conn.release()
      return res.status(400).json({ error: 'Firma del comprador requerida' })
    }
    if (!buyerSignatureData.startsWith('data:image/')) {
      conn.release()
      return res.status(400).json({ error: 'Firma inválida' })
    }

    const now = new Date()
    const issueDay = String(now.getDate()).padStart(2, '0')
    const issueMonth = String(now.getMonth() + 1).padStart(2, '0')
    const issueYear = String(now.getFullYear())
    const issuerName = String(req.user?.name || '').trim() || 'SISTEMA'

    const [items] = await conn.query(
      `
        SELECT si.quantity, si.unit_price, si.total, si.serial, si.imei,
               p.name AS product_name, p.product_code, b.name AS brand_name
        FROM sale_items si
        JOIN products p ON p.id = si.product_id
        LEFT JOIN brands b ON b.id = p.brand_id
        WHERE si.sale_id = ?
        ORDER BY si.id ASC
      `,
      [saleId]
    )

    const itemPayload = (items || []).map((row) => ({
      product: row.product_name || '',
      brand: row.brand_name || '',
      model: row.product_code || '',
      series: row.serial || row.imei || '',
      price: Number(row.total || 0),
    }))

    const [installments] = await conn.query(
      'SELECT id, due_date, amount, paid, paid_at FROM installments WHERE sale_id = ? ORDER BY due_date ASC, id ASC',
      [saleId]
    )

    const totalCredit = Number(sale.total || 0)
    const paymentsCount = Array.isArray(installments) ? installments.length : 0
    const installmentAmount = paymentsCount > 0 ? Number(installments[0].amount || 0) : 0
    const frequency = guessFrequencyLabel(installments || [])

    const [downRows] = await conn.query(
      `
        SELECT COALESCE(SUM(cp.amount), 0) AS down_payment
        FROM credit_payments cp
        JOIN installments i ON i.id = cp.installment_id
        WHERE i.sale_id = ? AND cp.payment_type = 'DOWN_PAYMENT'
      `,
      [saleId]
    )
    const downPayment = Number(downRows?.[0]?.down_payment || 0)

    const [payRows] = await conn.query(
      `
        SELECT cp.id, cp.amount, cp.paid_at
        FROM credit_payments cp
        JOIN installments i ON i.id = cp.installment_id
        WHERE i.sale_id = ? AND cp.payment_type IN ('DOWN_PAYMENT','INSTALLMENT')
        ORDER BY cp.paid_at ASC, cp.id ASC
      `,
      [saleId]
    )

    let running = 0
    const paymentPayload = (payRows || []).map((p) => {
      running += Number(p.amount || 0)
      return {
        date: String(p.paid_at || '').slice(0, 10),
        receiptNo: `#${p.id}`,
        amount: Number(p.amount || 0),
        balance: Math.max(0, totalCredit - running),
      }
    })

    const paymentRowsTarget = 14
    while (paymentPayload.length < paymentRowsTarget) {
      paymentPayload.push({ date: '', receiptNo: '', amount: '', balance: '' })
    }

    const refTarget = 4
    const refsPayload = []
    for (let i = 0; i < Math.max(refTarget, references.length); i++) {
      const r = references[i] || {}
      refsPayload.push({
        no: i + 1,
        name: String(r.name || '').trim(),
        phone: String(r.phone || '').trim(),
      })
    }

    const contractData = {
      saleId,
      warehouseId: Number(sale.warehouse_id),
      customerId: Number(sale.customer_id),
      branchName: String(sale.warehouse_name || '').trim(),
      branchAddress,
      branchPhone,
      branchFacebook,
      customerName,
      customerPhone,
      customerAge,
      customerNationality,
      customerCivilStatus,
      customerOccupation,
      customerAddress,
      customerMunicipality,
      customerDepartment,
      customerDpi,
      issueDay,
      issueMonth,
      issueYear,
      issuerName,
      totalCredit,
      downPayment,
      paymentsCount,
      installmentAmount,
      frequency,
      warrantyTime,
      buyerSignatureData,
      items: itemPayload,
      payments: paymentPayload,
      references: refsPayload,
    }

    const html = renderContractHtml(contractData)
    const sha256 = crypto.createHash('sha256').update(html).digest('hex')

    await conn.beginTransaction()
    const existing = await loadContractMetaBySale(conn, saleId)
    let contractId = existing?.id || null

    if (contractId) {
      await conn.query(
        `
          UPDATE credit_contracts
          SET customer_id = ?, warehouse_id = ?, template_version = ?, html = ?, data_json = ?, sha256 = ?, buyer_signature_data = ?, buyer_signed_at = NOW(), updated_at = NOW()
          WHERE id = ?
        `,
        [
          Number(sale.customer_id),
          Number(sale.warehouse_id),
          'v1',
          html,
          JSON.stringify(contractData),
          sha256,
          buyerSignatureData,
          contractId,
        ]
      )
      await conn.query('DELETE FROM credit_contract_references WHERE contract_id = ?', [contractId])
    } else {
      const [ins] = await conn.query(
        `
          INSERT INTO credit_contracts (sale_id, customer_id, warehouse_id, template_version, html, data_json, sha256, buyer_signature_data, buyer_signed_at, created_by_user_id, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?, NOW())
        `,
        [
          saleId,
          Number(sale.customer_id),
          Number(sale.warehouse_id),
          'v1',
          html,
          JSON.stringify(contractData),
          sha256,
          buyerSignatureData,
          req.user?.id || null,
        ]
      )
      contractId = ins.insertId
    }

    for (const ref of refsPayload) {
      await conn.query(
        'INSERT INTO credit_contract_references (contract_id, ref_no, name, phone) VALUES (?, ?, ?, ?)',
        [contractId, Number(ref.no), ref.name || null, ref.phone || null]
      )
    }

    await conn.query(
      `
        UPDATE customers
        SET phone = ?, address = ?, document = ?, age = ?, nationality = ?, civil_status = ?, occupation = ?, municipality = ?, department = ?
        WHERE id = ?
      `,
      [
        customerPhone || null,
        customerAddress || null,
        customerDpi || null,
        Number.isFinite(Number(customerAge)) ? Number(customerAge) : null,
        customerNationality || null,
        customerCivilStatus || null,
        customerOccupation || null,
        customerMunicipality || null,
        customerDepartment || null,
        Number(sale.customer_id),
      ]
    )

    await conn.commit()

    conn.release()
    return res.json({ contractId, sha256, html })
  } catch (err) {
    try {
      await conn.rollback()
    } catch {}
    conn.release()
    const status = err?.status || 500
    if (status === 500) console.error('credit_contracts generate error:', err)
    return res.status(status).json({ error: err?.message || 'Server error' })
  }
})

router.get('/:id/html', authMiddleware, async (req, res) => {
  try {
    if (!userHasPermission(req.user, 'credits:write')) {
      return res.status(403).json({ error: 'Forbidden: Missing permission credits:write' })
    }
    const id = Number(req.params.id)
    const pool = await getPool()
    const [rows] = await pool.query('SELECT * FROM credit_contracts WHERE id = ? LIMIT 1', [id])
    const contract = rows?.[0]
    if (!contract) return res.status(404).json({ error: 'Contrato no encontrado' })

    const saleId = Number(contract.sale_id)
    const sale = await assertSaleAccessOrThrow(pool, req.user, saleId, { allowPendingNonCredit: true })
    const contractData = await buildContractDataForSale(pool, {
      saleId,
      sale,
      contract,
      issuerNameFallback: String(req.user?.name || '').trim(),
    })
    const html = renderContractHtml(contractData)

    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    return res.send(html)
  } catch (err) {
    const status = err?.status || 500
    if (status === 500) console.error('credit_contracts html error:', err)
    return res.status(status).json({ error: err?.message || 'Server error' })
  }
})

router.get('/:id/settlement-html', authMiddleware, async (req, res) => {
  try {
    if (!userHasPermission(req.user, 'credits:write')) {
      return res.status(403).json({ error: 'Forbidden: Missing permission credits:write' })
    }
    const id = Number(req.params.id)
    const pool = await getPool()
    const [rows] = await pool.query('SELECT * FROM credit_contracts WHERE id = ? LIMIT 1', [id])
    const contract = rows?.[0]
    if (!contract) return res.status(404).json({ error: 'Contrato no encontrado' })

    const saleId = Number(contract.sale_id)
    const sale = await assertSaleAccessOrThrow(pool, req.user, saleId, { allowPendingNonCredit: true })
    const contractData = await buildContractDataForSale(pool, {
      saleId,
      sale,
      contract,
      issuerNameFallback: String(req.user?.name || '').trim(),
    })
    if (!contractData.isSettled) {
      return res.status(400).json({ error: 'El crédito aún no está finiquitado' })
    }
    const html = renderSettlementHtml(contractData)

    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    return res.send(html)
  } catch (err) {
    const status = err?.status || 500
    if (status === 500) console.error('credit_contracts settlement html error:', err)
    return res.status(status).json({ error: err?.message || 'Server error' })
  }
})

export default router
