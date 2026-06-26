import { useThree } from '@react-three/fiber'
import { useLayoutEffect } from 'react'

type FrameLimiterProps = {
  fps?: number
}

const FrameLimiter: React.FC<FrameLimiterProps> = ({ fps = 60 }) => {
  const { advance, set, frameloop: initFrameloop } = useThree()

  useLayoutEffect(() => {
    let startedAt: number | null = null
    let then: number | null = null
    let raf: number | null = null
    const interval = 1000 / Math.max(1, fps)

    function tick(t: DOMHighResTimeStamp) {
      raf = requestAnimationFrame(tick)

      if (startedAt === null || then === null) {
        startedAt = t
        then = t
        advance(0)
        return
      }

      const elapsed = t - then
      if (elapsed + 0.5 < interval) return

      then = t - (elapsed % interval)
      advance((t - startedAt) / 1000)
    }

    // Set frameloop to never, it will shut down the default render loop
    set({ frameloop: 'never' })
    // Kick off custom render loop
    raf = requestAnimationFrame(tick)
    // Restore initial setting
    return () => {
      if (raf) {
        cancelAnimationFrame(raf)
      }
      set({ frameloop: initFrameloop })
    }
  }, [fps, advance, set, initFrameloop])

  return null
}

export default FrameLimiter
