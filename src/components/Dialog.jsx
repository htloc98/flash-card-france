'use client'

import React, { useEffect, useRef } from 'react'
import { X } from 'lucide-react'

export default function Dialog({ title, children, onClose, busy = false, className = '' }) {
  const ref = useRef(null)
  const busyRef = useRef(busy)
  busyRef.current = busy
  useEffect(() => {
    const previous = document.activeElement
    const element = ref.current
    element.focus()
    return () => previous?.focus?.()
  }, [])
  function handleKey(event) {
    if (event.key === 'Escape' && !busyRef.current) onClose()
    if (event.key !== 'Tab') return
    const controls = [...ref.current.querySelectorAll('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]')]
    const first = controls[0]
    const last = controls.at(-1)
    if (event.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) { event.preventDefault(); last?.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
  }
  return <div className="overlay" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose() }}>
    <section ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-label={title} aria-busy={busy} className={`dialog ${className}`} onKeyDown={handleKey}>
      <button className="icon-button dialog-close" aria-label="Đóng" title="Đóng" disabled={busy} onClick={onClose}><X size={18} /></button>
      <h2>{title}</h2>{children}
    </section>
  </div>
}