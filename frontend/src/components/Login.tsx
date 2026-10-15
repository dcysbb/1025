import { useState, type FormEvent } from 'react'
import { Shield, TriangleAlert, X } from 'lucide-react'
import { api } from '../lib/api'

interface LoginProps {
  kind: 'setup' | 'login'
  onDone: () => void
  onClose: () => void
}

export default function Login({ kind, onDone, onClose }: LoginProps) {
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError('')
    if (kind === 'setup' && password !== confirm) {
      setError('两次输入的密码不一致')
      return
    }
    setBusy(true)
    try {
      await api(kind === 'setup' ? '/auth/setup' : '/auth/login', {
        method: 'POST',
        body: JSON.stringify({ password }),
      })
      onDone()
    } catch (x) {
      setError(x instanceof Error ? x.message : '无法登录')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={kind === 'setup' ? '设置操作员密码' : '操作员登录'}
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <form className="login-card glass-shell" onSubmit={submit}>
        <button
          className="icon-button modal-close"
          aria-label="关闭登录窗口"
          type="button"
          onClick={onClose}
        >
          <X size={17} />
        </button>
        <div className="brand-mark brand-mark--large">
          <Shield size={24} />
        </div>
        <h2>{kind === 'setup' ? '设置操作员密码' : '操作员登录'}</h2>
        <p>
          {kind === 'setup'
            ? '首次设置至少 12 位密码。密码只保存在运行设备本机。'
            : '控制与设置需要操作员登录。'}
        </p>
        <label className="field">
          密码
          <input
            autoFocus
            type="password"
            minLength={12}
            maxLength={256}
            autoComplete={kind === 'setup' ? 'new-password' : 'current-password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>
        {kind === 'setup' && (
          <label className="field">
            再次输入
            <input
              type="password"
              minLength={12}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              required
            />
          </label>
        )}
        {error && (
          <div className="inline-error">
            <TriangleAlert size={15} />
            {error}
          </div>
        )}
        <button className="button button--primary login-submit" disabled={busy}>
          {busy ? '正在验证…' : kind === 'setup' ? '保存并登录' : '登录控制台'}
        </button>
      </form>
    </div>
  )
}
