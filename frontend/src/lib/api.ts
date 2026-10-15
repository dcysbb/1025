const API = '/api'

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    credentials: 'same-origin',
    ...init,
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  })
  const kind = response.headers.get('content-type') || ''
  const data = kind.includes('json') ? await response.json() : undefined
  if (!response.ok) {
    if (response.status === 401) window.dispatchEvent(new Event('auth-needed'))
    throw new Error(data?.detail || `请求失败 (${response.status})`)
  }
  return data as T
}
