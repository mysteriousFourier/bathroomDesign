import type { AnalysisResponse, Asset, CaptureAssessment, ChatMessage, ChatSession, ChatSessionSummary, DesignChatResponse, Health, ImportedModelAsset, MeasurementImportInspection, MeasurementImportResponse, Project, RoomSpec } from './types'
import type { ModelImportFile } from './modelImport'

const defaultTimeoutMs = 90_000

async function request<T>(url: string, init?: RequestInit & { timeoutMs?: number }): Promise<T> {
  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), init?.timeoutMs ?? defaultTimeoutMs)
  let response: Response
  try {
    response = await fetch(url, { ...init, signal: init?.signal ?? controller.signal })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      const timeoutError = new Error('本地等待已超时，后台可能仍在解析；请稍后刷新项目查看结果。')
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
  modelAssets: (id: string) => request<ImportedModelAsset[]>(`/api/projects/${id}/model-assets`),
  uploadModelAsset: async (id: string, entries: ModelImportFile[]) => {
    const form = new FormData()
    for (const entry of entries) {
      form.append('files', entry.file, entry.file.name)
      form.append('relative_paths', entry.path)
    }
    return request<ImportedModelAsset>(`/api/projects/${id}/model-assets`, { method: 'POST', body: form, timeoutMs: 300_000 })
  },
  deleteModelAsset: (projectId: string, assetId: string) => request<void>(`/api/projects/${projectId}/model-assets/${assetId}`, { method: 'DELETE' }),
  captureAssessment: (assetId: string) => request<CaptureAssessment>(`/api/assets/${assetId}/capture-assessment`),
  analyzePlan: (id: string, rotationDegrees: number | null = null) => request<AnalysisResponse>(
    `/api/projects/${id}/analyze-plan${rotationDegrees === null ? '' : `?rotation_degrees=${rotationDegrees}`}`,
    // PaddleOCR plus the visual topology review can legitimately take several minutes.
    { method: 'POST', timeoutMs: 600_000 },
  ),
  analyzePhotos: (id: string) => request<AnalysisResponse>(`/api/projects/${id}/analyze-photos`, { method: 'POST', timeoutMs: 300_000 }),
  inspectMeasurementImport: async (id: string, file: File) => {
    const form = new FormData()
    form.append('file', file)
    return request<MeasurementImportInspection>(`/api/projects/${id}/measurement/import/inspect`, { method: 'POST', body: form, timeoutMs: 120_000 })
  },
  importMeasurement: async (id: string, file: File, options: { unit: string; layer: string; heightMm: number }) => {
    const form = new FormData()
    form.append('file', file)
    form.append('unit', options.unit)
    if (options.layer) form.append('layer', options.layer)
    form.append('height_mm', String(options.heightMm))
    return request<MeasurementImportResponse>(`/api/projects/${id}/measurement/import`, { method: 'POST', body: form, timeoutMs: 180_000 })
  },
  designChat: (messages: ChatMessage[], room: RoomSpec | null) => request<DesignChatResponse>('/api/design-chat', { method:'POST', headers:jsonHeaders, body:JSON.stringify({messages,room}), timeoutMs:150_000 }),
  chatSessions: (projectId: string) => request<ChatSessionSummary[]>(`/api/projects/${projectId}/chat-sessions`),
  createChatSession: (projectId: string) => request<ChatSession>(`/api/projects/${projectId}/chat-sessions`, { method:'POST', headers:jsonHeaders, body:JSON.stringify({ title:'新对话' }) }),
  chatSession: (projectId: string, sessionId: string) => request<ChatSession>(`/api/projects/${projectId}/chat-sessions/${sessionId}`),
  deleteChatSession: (projectId: string, sessionId: string) => request<void>(`/api/projects/${projectId}/chat-sessions/${sessionId}`, { method:'DELETE' }),
  sendChatMessage: (projectId: string, sessionId: string, content: string, room: RoomSpec | null) => request<ChatSession>(`/api/projects/${projectId}/chat-sessions/${sessionId}/messages`, { method:'POST', headers:jsonHeaders, body:JSON.stringify({ content, room }), timeoutMs:150_000 }),
  measurementDownloadUrl: (id: string) => `/api/projects/${id}/measurement/download`,
}
