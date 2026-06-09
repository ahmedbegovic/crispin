/** Typed client for the orion-tools FastAPI sidecar. Grows with each milestone. */
export class ToolsClient {
  constructor(private readonly baseUrl: () => string) {}

  private async request<T>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl()}${path}`, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`tools ${method} ${path} → ${res.status}: ${text.slice(0, 300)}`)
    }
    return (await res.json()) as T
  }

  healthz(): Promise<{ status: string; service: string; version: string }> {
    return this.request('GET', '/healthz')
  }

  job(id: string): Promise<{ id: string; status: string; progress: number; detail?: string; error?: string }> {
    return this.request('GET', `/jobs/${id}`)
  }

  cancelJob(id: string): Promise<{ ok: boolean }> {
    return this.request('POST', `/jobs/${id}/cancel`)
  }
}
