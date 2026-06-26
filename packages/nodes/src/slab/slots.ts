import type { SlotDeclaration } from '@pascal-app/core'

export type SlabSlotId = 'surface' | 'side'

export const SLAB_TOP_SLOT_DEFAULT = 'library:wood-woodplank48'
export const SLAB_SIDE_SLOT_DEFAULT = '#cccccc'

export function slabSlots(): SlotDeclaration[] {
  return [
    { slotId: 'surface', label: 'Top', default: SLAB_TOP_SLOT_DEFAULT },
    { slotId: 'side', label: 'Sides', default: SLAB_SIDE_SLOT_DEFAULT },
  ]
}
