import { Check, X } from 'lucide-react'

interface ToastProps {
  message: string
  onClose: () => void
}

export function Toast({ message, onClose }: ToastProps) {
  return (
    <div className="toast-message" role="status">
      <span>
        <Check size={16} />
      </span>
      {message}
      <button onClick={onClose}>
        <X size={15} />
      </button>
    </div>
  )
}
