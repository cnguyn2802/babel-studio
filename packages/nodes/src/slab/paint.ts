import type { AnyNode, SlabNode } from '@pascal-app/core'
import { createSlotPaintCapability, previewGeometrySlot } from '../shared/slot-paint'

export const slabPaint = createSlotPaintCapability({
  resolveRole: ({ hitObject }) => {
    const slotId = (hitObject?.userData as { slotId?: string } | undefined)?.slotId
    return slotId === 'side' ? 'side' : 'surface'
  },
  applyPreview: previewGeometrySlot,
  legacyEffective: (node: AnyNode, role: string) => {
    if (role !== 'surface') return null
    const slab = node as SlabNode
    if (slab.materialPreset || slab.material) {
      return { material: slab.material, materialPreset: slab.materialPreset }
    }
    return null
  },
})
