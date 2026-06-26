import { KTX2Loader } from 'three/examples/jsm/Addons.js'

export const ktx2Loader = new KTX2Loader()
ktx2Loader.setTranscoderPath('https://cdn.jsdelivr.net/gh/pmndrs/drei-assets@master/basis/')

const configuredRenderers = new WeakSet<object>()
const warnedRenderers = new WeakSet<object>()

export function ensureKtx2Support(renderer: unknown): boolean {
  const key = renderer as object | null
  if (!key) return false
  if (configuredRenderers.has(key)) return true
  try {
    ;(ktx2Loader as unknown as { detectSupport: (r: unknown) => void }).detectSupport(renderer)
    configuredRenderers.add(key)
    return true
  } catch (error) {
    if (!warnedRenderers.has(key)) {
      console.warn('[viewer] Skipping KTX2 support detection for now.', error)
      warnedRenderers.add(key)
    }
    return false
  }
}

export function isKtx2Url(url: string): boolean {
  return url.toLowerCase().endsWith('.ktx2')
}
