import { spawn } from 'node:child_process'

const ANALYZE_PY = '/opt/demucs-venv/bin/python3'

/**
 * Extract BPM + key via librosa.
 * Returns nulls if librosa is unavailable or analysis fails.
 */
export async function aubioAnalyze(
  filePath: string
): Promise<{ bpm: number | null; key: string | null }> {
  const script = `
import sys, json, numpy as np
try:
    import librosa
    y, sr = librosa.load(sys.argv[1], sr=None, mono=True)
    if y.size < sr:
        print(json.dumps({"bpm": None, "key": None})); sys.exit(0)

    # Tempo (librosa returns np.ndarray in 0.10+)
    tempo, _ = librosa.beat.beat_track(y=y, sr=sr)
    tempo_scalar = float(np.atleast_1d(tempo)[0]) if tempo is not None else 0.0
    bpm = tempo_scalar if tempo_scalar > 0 else None

    # Key via chroma: dominant pitch class over whole track.
    chroma = librosa.feature.chroma_cqt(y=y, sr=sr)
    chroma_mean = chroma.mean(axis=1)
    keys = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"]
    # Major/minor discrimination via Krumhansl-Schmuckler profiles.
    maj = np.array([6.35,2.23,3.48,2.33,4.38,4.09,2.52,5.19,2.39,3.66,2.29,2.88])
    minr= np.array([6.33,2.68,3.52,5.38,2.60,3.53,2.54,4.75,3.98,2.69,3.34,3.17])
    best_score, best_label = -1e9, None
    for i in range(12):
        for profile, suffix in ((maj, ""), (minr, "m")):
            rolled = np.roll(profile, i)
            score = float(np.corrcoef(chroma_mean, rolled)[0,1])
            if score > best_score:
                best_score = score
                best_label = keys[i] + suffix
    print(json.dumps({"bpm": bpm, "key": best_label}))
except Exception as e:
    print(json.dumps({"bpm": None, "key": None, "error": str(e)}))
`.trim()

  return new Promise((resolve) => {
    const p = spawn(ANALYZE_PY, ['-c', script, filePath])
    let out = ''
    let err = ''
    p.stdout.on('data', (d) => { out += d.toString() })
    p.stderr.on('data', (d) => { err += d.toString() })
    p.on('close', () => {
      try {
        const line = out.trim().split('\n').pop() || '{}'
        const parsed = JSON.parse(line)
        const bpm = typeof parsed.bpm === 'number' && Number.isFinite(parsed.bpm) ? parsed.bpm : null
        const key = typeof parsed.key === 'string' ? parsed.key : null
        resolve({ bpm, key })
      } catch {
        resolve({ bpm: null, key: null })
      }
    })
    p.on('error', () => resolve({ bpm: null, key: null }))
  })
}
