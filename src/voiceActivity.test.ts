import { describe, expect, it } from 'vitest'
import { VOICE_PAUSE_MS, VoiceActivityDetector } from './voiceActivity'

describe('VoiceActivityDetector', () => {
  it('calibrates to steady environmental noise instead of treating it as speech', () => {
    const detector = new VoiceActivityDetector()
    for (let timestamp = 0; timestamp <= 800; timestamp += 16) detector.sample(0.03, timestamp)

    const ambient = detector.sample(0.03, 816)
    expect(ambient.speaking).toBe(false)
    expect(ambient.activationThreshold).toBeGreaterThan(0.06)
    expect(detector.sample(0.1, 832).speaking).toBe(true)
  })

  it('does not trigger during the initial noise calibration window', () => {
    const detector = new VoiceActivityDetector()
    expect(detector.sample(0.08, 0).speaking).toBe(false)
    expect(detector.sample(0.08, 500).speaking).toBe(false)
  })

  it('allows a natural pause longer than the old 900ms cutoff', () => {
    expect(VOICE_PAUSE_MS).toBe(1_800)
  })
})
