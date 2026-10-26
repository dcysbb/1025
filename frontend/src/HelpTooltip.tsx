import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { CircleHelp } from 'lucide-react'

export default function HelpTooltip({label = '说明', children}: {label?: string; children: ReactNode}) {
  const [open, setOpen] = useState(false), [position, setPosition] = useState({left: 12, top: 12})
  const trigger = useRef<HTMLButtonElement>(null), tip = useRef<HTMLDivElement>(null)
  const id = useId(), dismissed = useRef(false), pinned = useRef(false)
  useEffect(() => {
    if (!open) return
    const place = () => {
      const rect = trigger.current?.getBoundingClientRect(), height = tip.current?.getBoundingClientRect().height ?? 80
      if (rect) setPosition({left: Math.max(12, Math.min(rect.left, window.innerWidth - Math.min(340, window.innerWidth - 24) - 12)), top: rect.bottom + height + 16 < window.innerHeight ? rect.bottom + 8 : Math.max(12, rect.top - height - 8)})
    }
    const key = (event: KeyboardEvent) => {if (event.key === 'Escape') {dismissed.current = true; pinned.current = false; setOpen(false)}}
    const outside = (event: PointerEvent) => {if (!trigger.current?.contains(event.target as Node) && !tip.current?.contains(event.target as Node)) {pinned.current = false; setOpen(false)}}
    place()
    window.addEventListener('keydown', key); window.addEventListener('pointerdown', outside); window.addEventListener('resize', place); window.addEventListener('scroll', place, true)
    return () => {window.removeEventListener('keydown', key); window.removeEventListener('pointerdown', outside); window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true)}
  }, [open])
  return <span className="help-tooltip-anchor"><button ref={trigger} type="button" className="help-tooltip-trigger" aria-label={label} aria-describedby={open ? id : undefined} aria-expanded={open}
    onPointerEnter={() => {dismissed.current = false; setOpen(true)}} onPointerLeave={() => {if (!pinned.current && document.activeElement !== trigger.current) setOpen(false)}}
    onFocus={() => {if (!dismissed.current) setOpen(true)}} onBlur={() => {setOpen(false); dismissed.current = false; pinned.current = false}}
    onClick={event => {event.preventDefault(); event.stopPropagation(); dismissed.current = false; pinned.current = !pinned.current; setOpen(pinned.current)}}><CircleHelp size={15}/></button>
    {open && createPortal(<div ref={tip} id={id} role="tooltip" className="help-tooltip-content" style={position}>{children}</div>, document.body)}
  </span>
}
