import { useEffect, useMemo, useState } from 'react'
import CameraCaptureButton from '../components/CameraCaptureButton'
import SignaturePad from '../components/SignaturePad'
import { addShipmentEvent, completeShipment, getMyShipments, getShipment } from '../api'
import { formatDateTime } from '../utils/date'
import { issueStatusLabel, shipmentEventTypeLabel, shipmentStatusLabel, shipmentTypeLabel } from '../utils/shipments'

type ShipmentRow = any

function buildFormData(obj: Record<string, any>) {
  const fd = new FormData()
  Object.entries(obj).forEach(([k, v]) => {
    if (v == null) return
    fd.append(k, String(v))
  })
  return fd
}

export default function MyShipments() {
  const [shipments, setShipments] = useState<ShipmentRow[]>([])
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [detail, setDetail] = useState<any | null>(null)
  const [loading, setLoading] = useState(false)

  const [eventPhotos, setEventPhotos] = useState<File[]>([])
  const [eventNote, setEventNote] = useState('')

  const [receiverName, setReceiverName] = useState('')
  const [receiverDpi, setReceiverDpi] = useState('')
  const [signatureFile, setSignatureFile] = useState<File | null>(null)
  const [deliveryPhotos, setDeliveryPhotos] = useState<File[]>([])
  const [completeNote, setCompleteNote] = useState('')
  const [completeItems, setCompleteItems] = useState<Record<number, { received: string; damaged: string }>>({})
  const [processing, setProcessing] = useState(false)

  const shipment = detail?.shipment || null
  const items = detail?.items || []
  const events = detail?.events || []
  const media = detail?.media || []
  const issues = detail?.issues || []

  async function loadList() {
    const rows = await getMyShipments()
    setShipments(rows)
  }

  async function loadDetail(id: number) {
    setLoading(true)
    try {
      const d = await getShipment(id)
      setDetail(d)
      setReceiverName('')
      setReceiverDpi('')
      setSignatureFile(null)
      setDeliveryPhotos([])
      setCompleteNote('')
      setEventPhotos([])
      setEventNote('')
      const next: Record<number, { received: string; damaged: string }> = {}
      for (const it of d.items || []) {
        next[Number(it.id)] = {
          received: String(it.qty_dispatched ?? it.qty_planned ?? 0),
          damaged: String(it.qty_damaged ?? 0),
        }
      }
      setCompleteItems(next)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadList()
  }, [])

  useEffect(() => {
    if (!selectedId) return
    loadDetail(selectedId)
  }, [selectedId])

  const photosByEventId = useMemo(() => {
    const out: Record<number, any[]> = {}
    for (const m of media) {
      const eid = Number(m.event_id || 0)
      if (!eid) continue
      if (!out[eid]) out[eid] = []
      out[eid].push(m)
    }
    return out
  }, [media])

  async function submitStatusEvent(eventType: string, status?: string) {
    if (!selectedId) return
    setProcessing(true)
    try {
      const fd = buildFormData({ eventType, notes: eventNote, status: status || '' })
      eventPhotos.forEach((f) => fd.append('photos', f))
      await addShipmentEvent(selectedId, fd)
      await loadDetail(selectedId)
      await loadList()
      setEventPhotos([])
      setEventNote('')
      alert('Evento registrado')
    } catch (err: any) {
      alert(err?.response?.data?.error || 'Error registrando evento')
    } finally {
      setProcessing(false)
    }
  }

  async function submitComplete() {
    if (!selectedId) return
    if (!receiverName.trim()) return alert('Nombre de quien recibe requerido')
    if (!receiverDpi.trim()) return alert('DPI requerido')
    if (!signatureFile) return alert('Firma requerida')
    if (deliveryPhotos.length === 0) return alert('Adjunta al menos una foto')

    setProcessing(true)
    try {
      const fd = buildFormData({
        action: shipment?.type === 'STORE_TRANSFER' ? 'RECEIVE' : 'DELIVER',
        receiverName,
        receiverDpi,
        notes: completeNote,
        items: JSON.stringify(Object.entries(completeItems).map(([id, v]) => ({
          itemId: Number(id),
          qtyReceived: Number(v.received || 0),
          qtyDamaged: Number(v.damaged || 0),
        }))),
      })
      deliveryPhotos.forEach((f) => fd.append('photos', f))
      fd.append('signature', signatureFile)
      const res = await completeShipment(selectedId, fd)
      alert(`Envío finalizado (${res.status})`)
      await loadDetail(selectedId)
      await loadList()
    } catch (err: any) {
      alert(err?.response?.data?.error || 'Error finalizando envío')
    } finally {
      setProcessing(false)
    }
  }

  return (
    <div className="page-shell">
      <div className="page-toolbar" style={{ marginBottom: 20 }}>
        <h2 style={{ margin: 0 }}>Mis Entregas</h2>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: selectedId ? '360px minmax(0, 1fr)' : 'minmax(0, 1fr)', gap: 16 }}>
        <div style={{ border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
          <div style={{ padding: 12, borderBottom: '1px solid var(--border)', fontWeight: 900 }}>Asignadas</div>
          <div style={{ maxHeight: '70vh', overflowY: 'auto' }}>
            {shipments.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => setSelectedId(Number(s.id))}
                style={{
                  width: '100%',
                  textAlign: 'left',
                  padding: 12,
                  border: 'none',
                  borderBottom: '1px solid var(--border)',
                  background: selectedId === Number(s.id) ? 'rgba(59, 130, 246, 0.08)' : 'transparent',
                  cursor: 'pointer',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                  <div style={{ fontWeight: 900, whiteSpace: 'nowrap' }}>#{s.id}</div>
                  <div style={{ fontWeight: 900, whiteSpace: 'nowrap' }}>{shipmentStatusLabel(s.status)}</div>
                </div>
                <div style={{ marginTop: 6, fontSize: 12, color: 'var(--muted)' }}>
                  {shipmentTypeLabel(s.type)} {s.sale_doc_no ? `(${s.sale_doc_no})` : ''}
                </div>
                <div style={{ marginTop: 6, fontSize: 12, whiteSpace: 'nowrap', overflowX: 'auto' }}>
                  {s.from_warehouse_name || s.from_warehouse_id} → {s.to_warehouse_name || s.to_warehouse_id || 'DOMICILIO'}
                </div>
                {s.delivery_address && (
                  <div style={{ marginTop: 6, fontSize: 12, whiteSpace: 'nowrap', overflowX: 'auto' }}>
                    {s.delivery_address}
                  </div>
                )}
              </button>
            ))}
            {shipments.length === 0 && <div style={{ padding: 12, color: 'var(--muted)' }}>No hay envíos asignados</div>}
          </div>
        </div>

        {selectedId && (
          <div style={{ border: '1px solid var(--border)', borderRadius: 12, padding: 14, overflow: 'hidden' }}>
            {loading ? (
              <div>Cargando...</div>
            ) : (
              <>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, marginBottom: 10 }}>
                  <div style={{ fontWeight: 900 }}>Envío #{shipment?.id}</div>
                  <div style={{ fontWeight: 900 }}>{shipmentStatusLabel(shipment?.status)}</div>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 10, marginBottom: 14 }}>
                  <div style={{ padding: 10, border: '1px solid var(--border)', borderRadius: 12 }}>
                    <div style={{ fontSize: 12, color: 'var(--muted)' }}>Origen</div>
                    <div style={{ fontWeight: 800, whiteSpace: 'nowrap', overflowX: 'auto' }}>{shipment?.from_warehouse_id}</div>
                  </div>
                  <div style={{ padding: 10, border: '1px solid var(--border)', borderRadius: 12 }}>
                    <div style={{ fontSize: 12, color: 'var(--muted)' }}>Destino</div>
                    <div style={{ fontWeight: 800, whiteSpace: 'nowrap', overflowX: 'auto' }}>{shipment?.to_warehouse_id || 'DOMICILIO'}</div>
                  </div>
                </div>

                <div style={{ borderTop: '1px solid var(--border)', paddingTop: 12, marginTop: 12 }}>
                  <div style={{ fontWeight: 900, marginBottom: 10 }}>Acciones</div>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <button type="button" className="primary-btn" onClick={() => submitStatusEvent('PICKED_UP', 'PICKED_UP')} disabled={processing}>
                      Retirado
                    </button>
                    <button type="button" className="primary-btn" onClick={() => submitStatusEvent('IN_TRANSIT', 'IN_TRANSIT')} disabled={processing}>
                      En ruta
                    </button>
                  </div>

                  <div style={{ marginTop: 12, display: 'grid', gap: 10 }}>
                    <div style={{ display: 'grid', gap: 10 }}>
                      <div style={{ fontWeight: 800 }}>Fotos (evento)</div>
                      <CameraCaptureButton
                        onCapture={(file) => setEventPhotos((prev) => [...prev, file])}
                        label="Tomar foto"
                      />
                      <input
                        type="file"
                        accept="image/*"
                        multiple
                        onChange={(e) => {
                          const files = Array.from(e.target.files || [])
                          if (files.length) setEventPhotos((prev) => [...prev, ...files])
                        }}
                      />
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                        {eventPhotos.map((f, idx) => (
                          <div key={`${f.name}_${idx}`} style={{ fontSize: 12, padding: '6px 8px', border: '1px solid var(--border)', borderRadius: 10, whiteSpace: 'nowrap' }}>
                            {f.name}
                          </div>
                        ))}
                      </div>
                      <input
                        type="text"
                        placeholder="Nota (opcional)"
                        value={eventNote}
                        onChange={(e) => setEventNote(e.target.value)}
                      />
                    </div>
                  </div>
                </div>

                <div style={{ borderTop: '1px solid var(--border)', paddingTop: 12, marginTop: 14 }}>
                  <div style={{ fontWeight: 900, marginBottom: 10 }}>
                    {shipment?.type === 'STORE_TRANSFER' ? 'Confirmar recepción' : 'Confirmar entrega'}
                  </div>

                  <div style={{ display: 'grid', gap: 10, marginBottom: 10 }}>
                    <input
                      type="text"
                      placeholder="Nombre de quien recibe"
                      value={receiverName}
                      onChange={(e) => setReceiverName(e.target.value)}
                    />
                    <input
                      type="text"
                      placeholder="DPI de quien recibe"
                      value={receiverDpi}
                      onChange={(e) => setReceiverDpi(e.target.value)}
                    />
                  </div>

                  <SignaturePad onChange={setSignatureFile} />

                  <div style={{ marginTop: 12 }}>
                    <div style={{ fontWeight: 800, marginBottom: 8 }}>Fotos (entrega/recepción)</div>
                    <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                      <CameraCaptureButton onCapture={(file) => setDeliveryPhotos((prev) => [...prev, file])} label="Tomar foto" />
                      <input
                        type="file"
                        accept="image/*"
                        multiple
                        onChange={(e) => {
                          const files = Array.from(e.target.files || [])
                          if (files.length) setDeliveryPhotos((prev) => [...prev, ...files])
                        }}
                      />
                    </div>
                    <div style={{ marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      {deliveryPhotos.map((f, idx) => (
                        <div key={`${f.name}_${idx}`} style={{ fontSize: 12, padding: '6px 8px', border: '1px solid var(--border)', borderRadius: 10, whiteSpace: 'nowrap' }}>
                          {f.name}
                        </div>
                      ))}
                    </div>
                  </div>

                  <div style={{ marginTop: 12 }}>
                    <div style={{ fontWeight: 800, marginBottom: 8 }}>Productos</div>
                    <div style={{ overflowX: 'auto' }}>
                      <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 540 }}>
                        <thead>
                          <tr style={{ borderBottom: '1px solid var(--border)' }}>
                            <th style={{ textAlign: 'left', padding: 8 }}>Producto</th>
                            <th style={{ textAlign: 'right', padding: 8 }}>Despachado</th>
                            <th style={{ textAlign: 'right', padding: 8 }}>Recibido</th>
                            <th style={{ textAlign: 'right', padding: 8 }}>Dañado</th>
                          </tr>
                        </thead>
                        <tbody>
                          {items.map((it: any) => (
                            <tr key={it.id} style={{ borderBottom: '1px solid var(--border)' }}>
                              <td style={{ padding: 8, whiteSpace: 'nowrap', overflowX: 'auto' }}>{it.product_name}</td>
                              <td style={{ padding: 8, textAlign: 'right', whiteSpace: 'nowrap' }}>{Number(it.qty_dispatched ?? it.qty_planned ?? 0)}</td>
                              <td style={{ padding: 8, textAlign: 'right' }}>
                                <input
                                  type="number"
                                  step="0.01"
                                  min="0"
                                  value={completeItems?.[Number(it.id)]?.received ?? ''}
                                  onChange={(e) => setCompleteItems(prev => ({ ...prev, [Number(it.id)]: { received: e.target.value, damaged: prev?.[Number(it.id)]?.damaged ?? '0' } }))}
                                  style={{ width: 110, textAlign: 'right' }}
                                />
                              </td>
                              <td style={{ padding: 8, textAlign: 'right' }}>
                                <input
                                  type="number"
                                  step="0.01"
                                  min="0"
                                  value={completeItems?.[Number(it.id)]?.damaged ?? ''}
                                  onChange={(e) => setCompleteItems(prev => ({ ...prev, [Number(it.id)]: { received: prev?.[Number(it.id)]?.received ?? '0', damaged: e.target.value } }))}
                                  style={{ width: 110, textAlign: 'right' }}
                                />
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  <div style={{ marginTop: 10 }}>
                    <input
                      type="text"
                      placeholder="Observaciones (opcional)"
                      value={completeNote}
                      onChange={(e) => setCompleteNote(e.target.value)}
                      style={{ width: '100%' }}
                    />
                  </div>

                  <div style={{ marginTop: 12, display: 'flex', justifyContent: 'flex-end' }}>
                    <button type="button" className="primary-btn" onClick={submitComplete} disabled={processing}>
                      Finalizar
                    </button>
                  </div>
                </div>

                <div style={{ borderTop: '1px solid var(--border)', paddingTop: 12, marginTop: 14 }}>
                  <div style={{ fontWeight: 900, marginBottom: 10 }}>Historial</div>
                  <div style={{ display: 'grid', gap: 10 }}>
                    {events.map((e: any) => (
                      <div key={e.id} style={{ border: '1px solid var(--border)', borderRadius: 12, padding: 10 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                          <div style={{ fontWeight: 900, whiteSpace: 'nowrap' }}>{shipmentEventTypeLabel(e.event_type)}</div>
                          <div style={{ fontSize: 12, color: 'var(--muted)', whiteSpace: 'nowrap' }}>{e.created_at ? formatDateTime(e.created_at) : ''}</div>
                        </div>
                        {e.notes && <div style={{ marginTop: 6, fontSize: 12 }}>{e.notes}</div>}
                        {(e.receiver_name || e.receiver_dpi) && (
                          <div style={{ marginTop: 6, fontSize: 12, color: 'var(--muted)' }}>
                            Recibe: {e.receiver_name} {e.receiver_dpi ? `(${e.receiver_dpi})` : ''}
                          </div>
                        )}
                        {(photosByEventId?.[Number(e.id)] || []).length > 0 && (
                          <div style={{ marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                            {(photosByEventId?.[Number(e.id)] || []).map((m: any) => (
                              <a key={m.id} href={m.url} target="_blank" rel="noreferrer" style={{ fontSize: 12, border: '1px solid var(--border)', borderRadius: 10, padding: '6px 8px', whiteSpace: 'nowrap' }}>
                                {m.media_type === 'SIGNATURE' ? 'Firma' : 'Foto'}
                              </a>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                    {events.length === 0 && <div style={{ color: 'var(--muted)' }}>Sin eventos</div>}
                  </div>
                </div>

                {issues.length > 0 && (
                  <div style={{ borderTop: '1px solid var(--border)', paddingTop: 12, marginTop: 14 }}>
                    <div style={{ fontWeight: 900, marginBottom: 10 }}>Incidencias</div>
                    {issues.map((iss: any) => (
                      <div key={iss.id} style={{ border: '1px solid var(--border)', borderRadius: 12, padding: 10, marginBottom: 10 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                          <div style={{ fontWeight: 900 }}>#{iss.id}</div>
                          <div style={{ fontWeight: 900 }}>{issueStatusLabel(iss.status)}</div>
                        </div>
                        {iss.reason && <div style={{ marginTop: 6, fontSize: 12 }}>{iss.reason}</div>}
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
