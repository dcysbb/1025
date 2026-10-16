import { useEffect, useId, useState, useSyncExternalStore, type ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'

/** Keep content mounted so CSS can reverse a height transition at any point. */
export function Reveal({ open, children, id, className = '' }: { open: boolean; children: ReactNode; id?: string; className?: string }) {
  return <div id={id} className={`motion-reveal ${className}`} data-open={open} inert={!open} aria-hidden={!open}>
    <div className="motion-reveal__clip"><div className="motion-reveal__content">{children}</div></div>
  </div>
}

export function Disclosure({ title, children, className = '' }: { title: string; children: ReactNode; className?: string }) {
  const [open, setOpen] = useState(false)
  const id = useId()
  return <div className={`disclosure ${className}`}>
    <button type="button" className="disclosure__toggle" aria-expanded={open} aria-controls={id} onClick={() => setOpen(value => !value)}>
      <ChevronRight size={14} aria-hidden="true"/>{title}
    </button>
    <Reveal open={open} id={id}>{children}</Reveal>
  </div>
}

/** Exit visuals become inert immediately; dismissal never waits for the animation. */
export function Presence({ show, children }: { show: boolean; children: ReactNode }) {
  const [retained, setRetained] = useState<ReactNode>(show ? children : null)
  const reducedMotion = useSyncExternalStore(subscribeMotion, prefersReducedMotion, () => false)
  if (show && retained !== children) setRetained(children)
  useEffect(() => {
    if (show) return
    const timer = window.setTimeout(() => setRetained(null), reducedMotion ? 0 : 220)
    return () => window.clearTimeout(timer)
  }, [show, reducedMotion])
  if (!show && (retained == null || reducedMotion)) return null
  return <div className="motion-presence" data-open={show} inert={!show} aria-hidden={!show || undefined}>
    {show ? children : retained}
  </div>
}

function prefersReducedMotion() { return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false }
function subscribeMotion(callback: () => void) {
  const media = window.matchMedia?.('(prefers-reduced-motion: reduce)')
  media?.addEventListener('change', callback)
  return () => media?.removeEventListener('change', callback)
}
