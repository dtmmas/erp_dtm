export type ShipmentType = 'SALE_DELIVERY' | 'STORE_TRANSFER' | string
export type ShipmentStatus =
  | 'DRAFT'
  | 'ASSIGNED'
  | 'PICKED_UP'
  | 'IN_TRANSIT'
  | 'DELIVERED'
  | 'DELIVERED_WITH_ISSUES'
  | 'RECEIVED'
  | 'RECEIVED_WITH_ISSUES'
  | 'CANCELLED'
  | string

export function shipmentTypeLabel(type?: ShipmentType | null) {
  if (type === 'STORE_TRANSFER') return 'Traslado'
  if (type === 'SALE_DELIVERY') return 'Entrega'
  return type ? String(type) : ''
}

export function shipmentStatusLabel(status?: ShipmentStatus | null) {
  switch (status) {
    case 'DRAFT':
      return 'Borrador'
    case 'ASSIGNED':
      return 'Asignado'
    case 'PICKED_UP':
      return 'Retirado'
    case 'IN_TRANSIT':
      return 'En ruta'
    case 'DELIVERED':
      return 'Entregado'
    case 'DELIVERED_WITH_ISSUES':
      return 'Entregado con incidencias'
    case 'RECEIVED':
      return 'Recibido'
    case 'RECEIVED_WITH_ISSUES':
      return 'Recibido con incidencias'
    case 'CANCELLED':
      return 'Cancelado'
    default:
      return status ? String(status) : ''
  }
}

export function shipmentEventTypeLabel(eventType?: string | null) {
  const t = String(eventType || '').toUpperCase()
  switch (t) {
    case 'ASSIGNMENT':
      return 'Asignado'
    case 'PICKED_UP':
      return 'Retirado'
    case 'IN_TRANSIT':
      return 'En ruta'
    case 'DELIVERED':
      return 'Entregado'
    case 'RECEIVED':
      return 'Recibido'
    case 'NOTE':
      return 'Nota'
    case 'ISSUE':
      return 'Incidencia'
    case 'FOLLOWUP':
      return 'Seguimiento'
    default:
      return eventType ? String(eventType) : ''
  }
}

export function issueStatusLabel(status?: string | null) {
  const s = String(status || '').toUpperCase()
  switch (s) {
    case 'OPEN':
      return 'Abierta'
    case 'IN_PROGRESS':
      return 'En proceso'
    case 'RESOLVED':
      return 'Resuelta'
    case 'CANCELLED':
      return 'Cancelada'
    default:
      return status ? String(status) : ''
  }
}
