import type { AnalysisResponse, Asset, Health, Project, RoomSpec } from './types'

const defaultTimeoutMs = 90_000

async function request<T>(url: string, init?: RequestInit & { timeoutMs?: number }): Promise<T> {
  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), init?.timeoutMs ?? defaultTimeoutMs)
  let response: Response
  try {
    response = await fetch(url, { ...init, signal: init?.signal ?? controller.signal })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      const timeoutError = new Error('请求超时，请稍后重试或改用手动录入。')
      timeoutError.name = 'TimeoutError'
      throw timeoutError
    }
    throw error
  } finally {
    window.clearTimeout(timeout)
  }
  if (!response.ok) {
    let message = `请求失败 (${response.status})`
    try {
      const body = await response.json() as { detail?: string }
      if (body.detail) message = body.detail
    } catch {
      // Keep the status-based message for non-JSON failures.
    }
    throw new Error(message)
  }
  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}

const jsonHeaders = { 'Content-Type': 'application/json' }

export const studioApi = {
  health: () => request<Health>('/api/health'),
  projects: () => request<Project[]>('/api/projects'),
  project: (id: string) => request<Project>(`/api/projects/${id}`),
  createProject: (name: string) => request<Project>('/api/projects', {
    method: 'POST', headers: jsonHeaders, body: JSON.stringify({ name }),
  }),
  deleteProject: (id: string) => request<void>(`/api/projects/${id}`, { method: 'DELETE' }),
  saveSpec: (id: string, spec: RoomSpec) => request<Project>(`/api/projects/${id}/spec`, {
    method: 'PUT', headers: jsonHeaders, body: JSON.stringify(spec),
  }),
  upload: async (id: string, role: 'floorplan' | 'photo', file: File) => {
    const form = new FormData()
    form.append('role', role)
    form.append('file', file)
    return request<Asset>(`/api/projects/${id}/assets`, { method: 'POST', body: form })
  },
  analyzePlan: (id: string, rotationDegrees: number | null = null) => request<AnalysisResponse>(
    `/api/projects/${id}/analyze-plan${rotationDegrees === null ? '' : `?rotation_degrees=${rotationDegrees}`}`,
    { method: 'POST', timeoutMs: 150_000 },
  ),
  analyzePhotos: (id: string) => request<AnalysisResponse>(`/api/projects/${id}/analyze-photos`, { method: 'POST', timeoutMs: 150_000 }),
  measurementDownloadUrl: (id: string) => `/api/projects/${id}/measurement/download`,
}
