import { useSyncExternalStore } from 'react'

export type ThemeSetting = 'light' | 'dark' | 'system'
export type ResolvedTheme = 'light' | 'dark'
export type Skin = 'atelier' | 'classic'

const THEME_KEY = 'liangjie-theme'
const SKIN_KEY = 'liangjie-skin'

function readStored<T extends string>(key: string, fallback: T, allowed: readonly T[]): T {
  try {
    const value = localStorage.getItem(key) as T | null
    return value && allowed.includes(value) ? value : fallback
  } catch {
    return fallback
  }
}

function writeStored(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Storage can be unavailable (private mode quotas); appearance still works in-session.
  }
}

const media = window.matchMedia('(prefers-color-scheme: dark)')

let themeSetting: ThemeSetting = readStored(THEME_KEY, 'system', ['light', 'dark', 'system'])
let skin: Skin = readStored(SKIN_KEY, 'atelier', ['atelier', 'classic'])

const listeners = new Set<() => void>()
const emit = () => listeners.forEach((listener) => listener())
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

const resolvedTheme = (): ResolvedTheme => (themeSetting === 'system' ? (media.matches ? 'dark' : 'light') : themeSetting)

function apply() {
  const root = document.documentElement
  const resolved = resolvedTheme()
  root.dataset.themeSetting = themeSetting
  root.dataset.theme = resolved
  root.dataset.skin = skin
  root.style.colorScheme = resolved
}

export const appearance = {
  subscribe,
  getThemeSetting: () => themeSetting,
  getResolvedTheme: resolvedTheme,
  getSkin: () => skin,
  setThemeSetting(next: ThemeSetting) {
    if (next === themeSetting) return
    themeSetting = next
    writeStored(THEME_KEY, next)
    apply()
    emit()
  },
  setSkin(next: Skin) {
    if (next === skin) return
    skin = next
    writeStored(SKIN_KEY, next)
    apply()
    emit()
  },
}

media.addEventListener('change', () => {
  if (themeSetting !== 'system') return
  apply()
  emit()
})

apply()

export function useThemeSetting(): ThemeSetting {
  return useSyncExternalStore(subscribe, appearance.getThemeSetting)
}

export function useResolvedTheme(): ResolvedTheme {
  return useSyncExternalStore(subscribe, appearance.getResolvedTheme)
}

export function useSkin(): Skin {
  return useSyncExternalStore(subscribe, appearance.getSkin)
}
