import { useEffect, useMemo, useRef, useState } from 'react'

export default function SignaturePad(props: {
  onChange: (file: File | null) => void
  height?: number
}) {
  const { onChange, height = 180 } = props
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const drawingRef = useRef(false)
  const lastRef = useRef<{ x: number; y: number } | null>(null)
  const [hasInk, setHasInk] = useState(false)

  const dpr = useMemo(() => (typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1), [])

  function getCtx() {
    const canvas = canvasRef.current
    if (!canvas) return null
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    return ctx
  }

  function resizeCanvas() {
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const w = Math.max(1, Math.floor(rect.width))
    const h = Math.max(1, Math.floor(rect.height))
    canvas.width = Math.floor(w * dpr)
    canvas.height = Math.floor(h * dpr)
    const ctx = getCtx()
    if (!ctx) return
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.scale(dpr, dpr)
    ctx.lineWidth = 2.2
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.strokeStyle = '#111827'
  }

  function clear() {
    const canvas = canvasRef.current
    const ctx = getCtx()
    if (!canvas || !ctx) return
    const rect = canvas.getBoundingClientRect()
    ctx.clearRect(0, 0, rect.width, rect.height)
    lastRef.current = null
    drawingRef.current = false
    setHasInk(false)
    onChange(null)
  }

  function pointFromEvent(e: PointerEvent) {
    const canvas = canvasRef.current
    if (!canvas) return null
    const rect = canvas.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  function drawLine(from: { x: number; y: number }, to: { x: number; y: number }) {
    const ctx = getCtx()
    if (!ctx) return
    ctx.beginPath()
    ctx.moveTo(from.x, from.y)
    ctx.lineTo(to.x, to.y)
    ctx.stroke()
  }

  async function emitFile() {
    const canvas = canvasRef.current
    if (!canvas) return
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob((b) => resolve(b), 'image/png'))
    if (!blob) return
    const file = new File([blob], `signature_${Date.now()}.png`, { type: 'image/png' })
    onChange(file)
  }

  useEffect(() => {
    resizeCanvas()
    const onResize = () => resizeCanvas()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [dpr])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const onPointerDown = (e: PointerEvent) => {
      e.preventDefault()
      drawingRef.current = true
      const p = pointFromEvent(e)
      if (!p) return
      lastRef.current = p
      setHasInk(true)
    }
    const onPointerMove = (e: PointerEvent) => {
      if (!drawingRef.current) return
      const p = pointFromEvent(e)
      const last = lastRef.current
      if (!p || !last) return
      drawLine(last, p)
      lastRef.current = p
    }
    const onPointerUp = async () => {
      if (!drawingRef.current) return
      drawingRef.current = false
      lastRef.current = null
      if (hasInk) await emitFile()
    }

    canvas.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
    return () => {
      canvas.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
    }
  }, [hasInk])

  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden', background: '#fff' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: 10, background: 'rgba(148, 163, 184, 0.12)' }}>
        <div style={{ fontWeight: 800 }}>Firma</div>
        <button type="button" onClick={clear} style={{ border: '1px solid var(--border)', borderRadius: 10, padding: '6px 10px', background: '#fff' }}>
          Limpiar
        </button>
      </div>
      <div style={{ padding: 10 }}>
        <canvas
          ref={canvasRef}
          style={{ width: '100%', height, touchAction: 'none', display: 'block', background: '#fff' }}
        />
      </div>
    </div>
  )
}
