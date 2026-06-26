import type { SlotDeclaration } from '@pascal-app/core'

export type CeilingSlotId = 'surface'

export const CEILING_SLOT_DEFAULT_COLOR = '#f2eee6'

export function ceilingSlots(): SlotDeclaration[] {
  return [{ slotId: 'surface', label: 'Surface', default: CEILING_SLOT_DEFAULT_COLOR }]
}
