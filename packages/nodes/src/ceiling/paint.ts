import {
  type AnyNode,
  type CeilingNode,
  getMaterialPresetByRef,
  parseMaterialRef,
  resolveMaterial,
  type SceneMaterialId,
  useScene,
} from '@pascal-app/core'
import type { Mesh } from 'three'
import { createSlotPaintCapability } from '../shared/slot-paint'
import { getCeilingMaterials } from './materials'

export const ceilingPaint = createSlotPaintCapability({
  resolveRole: () => 'surface',
  applyPreview: ({ material, materialPreset, root }) => {
    const color = (() => {
      if (materialPreset) {
        const parsed = parseMaterialRef(materialPreset)
        if (parsed?.kind === 'scene') {
          const sceneMaterial = useScene.getState().materials[parsed.id as SceneMaterialId]
          return sceneMaterial ? (resolveMaterial(sceneMaterial.material).color ?? null) : null
        }
        return getMaterialPresetByRef(materialPreset)?.mapProperties.color ?? null
      }
      return material ? (resolveMaterial(material).color ?? null) : null
    })()
    if (!color) return () => {}

    const mesh = root as Mesh
    if (!mesh.isMesh) return null
    const previous = mesh.material
    mesh.material = getCeilingMaterials(color).bottomMaterial
    return () => {
      mesh.material = previous
    }
  },
  legacyEffective: (node: AnyNode) => {
    const ceiling = node as CeilingNode
    if (ceiling.materialPreset || ceiling.material) {
      return { material: ceiling.material, materialPreset: ceiling.materialPreset }
    }
    return null
  },
})
