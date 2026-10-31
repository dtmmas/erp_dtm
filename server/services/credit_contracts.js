import crypto from 'crypto'

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
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

export function guessFrequencyLabel(installments) {
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

export function computeSha256(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex')
}

export function renderCreditContractHtml(payload) {
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
  const settlementDate = escapeHtml(payload.settlementDate || '')
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

  const paymentsRows = (payload.payments || []).map((p) => {
    return `
      <tr>
        <td>${escapeHtml(p.date)}</td>
        <td>${escapeHtml(p.receiptNo)}</td>
        <td class="money">${p.amount === '' ? '' : formatMoneyQ(p.amount)}</td>
        <td class="money">${p.balance === '' ? '' : formatMoneyQ(p.balance)}</td>
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
