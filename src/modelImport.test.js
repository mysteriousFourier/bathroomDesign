import { describe, expect, it } from 'vitest'
import { validateModelImport } from './modelImport'

function file(name, path = name) {
  return { file: new File(['x'], name), path }
}

describe('model import validation', () => {
  it('accepts one primary model with GLTF dependencies', () => {
    expect(() => validateModelImport([file('model.gltf'), file('model.bin'), file('albedo.png', 'textures/albedo.png')])).not.toThrow()
  })

  it('accepts one SKP source for automatic conversion', () => {
    expect(validateModelImport([file('single-switch.skp')]).path).toBe('single-switch.skp')
  })

  it('requires exactly one primary model', () => {
    expect(() => validateModelImport([file('a.glb'), file('b.obj')])).toThrow('每次请选择一个主模型')
    expect(() => validateModelImport([file('model.bin')])).toThrow('每次请选择一个主模型')
  })

  it('rejects unsupported files', () => {
    expect(() => validateModelImport([file('model.glb'), file('notes.txt')])).toThrow('不支持的文件')
  })
})
