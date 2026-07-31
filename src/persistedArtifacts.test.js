import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

describe('persisted issue artifacts', () => {
  it('keeps the AGEN-27 uploaded sample image in the repository', () => {
    const source = 'evidence/samples/real/agen-27-dry-wet-zones/source.jpg'

    expect(statSync(source).size).toBe(346634)
    expect(sha256(source)).toBe('730063335afdc908ea91b569e1516a8df0f82c399d8fcaff4ebd9b03b24773b4')
  })

  it('keeps the final AGEN-26 full-flow screenshot evidence in the repository', () => {
    const screenshots = [
      '00-uploaded-sample-image-parsed.png',
      '01-auto-initial-annotation.png',
      '02-manual-corrected-annotation.png',
      '03-generated-2d-and-points.png',
      '04-finish-surface-minus-20mm-real-wall.png',
      '05-generated-3d-model.png',
    ]

    for (const filename of screenshots) {
      expect(statSync(`reports/screenshots/agen-26-full-flow/${filename}`).size).toBeGreaterThan(10_000)
    }
  })
})
