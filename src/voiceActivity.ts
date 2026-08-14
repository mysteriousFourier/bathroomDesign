export const VOICE_NOISE_CALIBRATION_MS = 750
export const VOICE_PAUSE_MS = 1_800
export const VOICE_MIN_TURN_MS = 700
export const VOICE_MAX_TURN_MS = 45_000

const INITIAL_NOISE_FLOOR = 0.008

export type VoiceActivitySample = {
  speaking: boolean
  activationThreshold: number
  continuationThreshold: number
}

export class VoiceActivityDetector {
  private startedAt: number | null = null
  private noiseFloor = INITIAL_NOISE_FLOOR

  reset() {
    this.startedAt = null
    this.noiseFloor = INITIAL_NOISE_FLOOR
  }

  sample(volume: number, timestamp: number): VoiceActivitySample {
    if (this.startedAt === null) this.startedAt = timestamp
    const calibrating = timestamp - this.startedAt < VOICE_NOISE_CALIBRATION_MS
    const activationThreshold = Math.min(0.09, Math.max(0.025, this.noiseFloor * 2.8))
    const continuationThreshold = Math.min(0.06, Math.max(0.014, this.noiseFloor * 1.7))
    const speaking = !calibrating && volume > activationThreshold

    // Learn stable background sound, but do not let actual speech raise the floor.
    if (calibrating || volume <= activationThreshold) {
      const weight = calibrating ? 0.12 : 0.015
      this.noiseFloor += (Math.min(volume, 0.04) - this.noiseFloor) * weight
    }

    return { speaking, activationThreshold, continuationThreshold }
  }
}
