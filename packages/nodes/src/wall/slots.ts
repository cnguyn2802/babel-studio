import { type SlotDeclaration, WALL_SLOT_DEFAULT } from '@pascal-app/core'

export function wallSlots(): SlotDeclaration[] {
  return [
    { slotId: 'interior', label: 'Interior', default: WALL_SLOT_DEFAULT.interior },
    { slotId: 'exterior', label: 'Exterior', default: WALL_SLOT_DEFAULT.exterior },
  ]
}
