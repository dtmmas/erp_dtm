# Flujo operativo de ventas a crédito (Contrato obligatorio)

## Objetivo
Establecer un flujo secuencial y verificable para ventas a crédito donde:
- No se formaliza una venta a crédito sin contrato completo y firmado.
- No se avanza a la etapa financiera (cuotas/enganche/cobro) si faltan requisitos contractuales.
- Existen puntos de control en frontend y backend para asegurar cumplimiento operativo.

## Alcance
- Aplica únicamente a **ventas a crédito** (incluye ventas creadas en POS como crédito y ventas pendientes que Caja intenta convertir a crédito).

## Secuencia obligatoria (orden de actividades)

### Paso 1 — Identificación del cliente (obligatorio)
1) Seleccionar un cliente existente o crear uno nuevo con nombre real.
2) Punto de control:
   - Si no existe cliente o no tiene nombre, no se permite continuar con crédito.

### Paso 2 — Contrato (obligatorio y previo a la formalización)
1) Completar los datos del contrato.
2) Capturar la firma digital del comprador.
3) Punto de control:
   - Si falta cualquier dato requerido o la firma, no se permite avanzar.

#### Campos obligatorios del contrato (validados)
- Teléfono
- Edad
- Nacionalidad
- Estado civil
- Profesión u oficio
- Dirección
- Municipio
- Departamento
- DPI
- Firma del comprador (imagen)

#### Datos de referencia
- Se capturan al menos 4 filas (pueden quedar vacías, pero la estructura se mantiene).

### Paso 3 — Formalización financiera del crédito
1) Definir plan de cuotas (monto y fecha).
2) Validar que la suma de cuotas sea igual al total del crédito (con tolerancia).
3) Punto de control:
   - Si la suma no coincide o hay cuotas inválidas, no se permite continuar.

### Paso 4 — Registro de venta a crédito
1) Se crea la venta con `is_credit=1` y se registra el plan de cuotas.
2) Se genera y almacena el contrato firmado vinculado a la venta.
3) Punto de control:
   - Si el contrato firmado no puede almacenarse, la transacción se revierte y la venta no se registra como crédito.

### Paso 5 — Controles de Caja (ventas pendientes)
1) Si Caja intenta convertir una venta pendiente a crédito:
   - Debe existir un contrato firmado asociado a esa venta.
2) Punto de control:
   - Si no hay contrato firmado, el sistema bloquea la conversión a crédito.

### Paso 6 — Impresión (bloqueada sin contrato firmado)
1) Ticket / plan de cuotas (POS):
   - Solo se imprime si el contrato está firmado.
2) Comprobantes de abonos (Gestión de créditos):
   - Solo se imprime si el contrato está firmado.

## Mecanismos de verificación

### Frontend (operativo)
- POS:
  - Botón “Contrato” obligatorio en el panel de crédito.
  - La confirmación de venta a crédito se bloquea si no existe contrato firmado en memoria.
- Gestión de créditos:
  - Botón “Contrato” por venta: si no está firmado, fuerza el flujo de generación y firma.

### Backend (normativo/antifraude)
- Validación al crear venta a crédito:
  - Requiere `creditContract` completo + firma en la petición.
- Validación al convertir a crédito en Caja:
  - Requiere contrato firmado persistido (no solo generado).

## Buenas prácticas operativas
- No permitir “excepciones silenciosas”: si falta firma o datos, el sistema debe bloquear con un mensaje claro.
- Mantener trazabilidad: el contrato se vincula siempre a `sale_id`, `customer_id`, `warehouse_id` y usuario emisor.
- Evitar reprocesos: si cambia el cliente o cambia la venta, obligar a regenerar contrato.
- Mantener consistencia por sucursal: los datos del encabezado se configuran en “Almacenes y Tiendas” (dirección, CEL, Facebook).
