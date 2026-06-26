import { type GeometryContext, getMaterialPresetByRef } from '@pascal-app/core'
import {
  applyMaterialPresetToMaterials,
  type ColorPreset,
  createDefaultMaterial,
  createMaterial,
  createSurfaceRoleMaterial,
  generateFenceSlotGeometries,
  type RenderShading,
  resolveMaterialRef,
  resolveSlotDefaultMaterial,
} from '@pascal-app/viewer'
import { FrontSide, Group, type Material, Mesh, type Texture } from 'three'
import type { FenceNode } from './schema'
import { FENCE_SLOT_DEFAULTS, type FenceSlotId } from './slots'

/**
 * Stage B builder for fence. Splits the generated fence into paintable slots
 * so the generic geometry system can rebuild a Group whose child meshes each
 * expose `userData.slotId` for paint hit-testing and previews.
 */
type FenceMaterial = Material & {
  alphaMap?: Texture | null
  depthWrite: boolean
  opacity: number
  transparent: boolean
}

const FENCE_SLOT_ORDER: FenceSlotId[] = ['posts', 'infill', 'base', 'rail']

const fenceMaterialCache = new Map<string, Material>()

function getLegacyFenceMaterial(node: FenceNode, shading: RenderShading): Material {
  const cacheKey = JSON.stringify({
    shading,
    material: node.material ?? null,
    materialPreset: node.materialPreset ?? null,
  })
  const cached = fenceMaterialCache.get(cacheKey)
  if (cached) return cached

  const preset = getMaterialPresetByRef(node.materialPreset)
  const material = preset
    ? createDefaultMaterial('#ffffff', 0.5, shading)
    : node.material
      ? createMaterial(node.material, shading).clone()
      : createDefaultMaterial('#ffffff', 0.9, shading)

  if (preset) {
    applyMaterialPresetToMaterials(material, preset)
  }

  const fenceMaterial = material as FenceMaterial
  fenceMaterial.transparent = false
  fenceMaterial.opacity = 1
  fenceMaterial.alphaMap = null
  fenceMaterial.side = FrontSide
  fenceMaterial.depthWrite = true
  fenceMaterial.needsUpdate = true

  fenceMaterialCache.set(cacheKey, material)
  return material
}

function getFenceSlotMaterial(
  node: FenceNode,
  slotId: FenceSlotId,
  shading: RenderShading,
  textures: boolean,
  colorPreset: ColorPreset,
  sceneTheme: string | undefined,
  sceneMaterials: GeometryContext['materials'],
): Material {
  if (!textures) {
    return createSurfaceRoleMaterial('joinery', colorPreset, FrontSide, sceneTheme)
  }

  const slotRef = node.slots?.[slotId]
  if (slotRef) {
    const resolved = resolveMaterialRef(slotRef, sceneMaterials, shading)
    if (resolved) return resolved
  }

  if (node.materialPreset || node.material) {
    return getLegacyFenceMaterial(node, shading)
  }

  return resolveSlotDefaultMaterial(FENCE_SLOT_DEFAULTS[slotId], shading, 0.8)
}

export function buildFenceGeometry(
  node: FenceNode,
  ctx?: GeometryContext,
  shading: RenderShading = 'rendered',
  textures = true,
  colorPreset: ColorPreset = 'clay',
  sceneTheme?: string,
): Group {
  const group = new Group()
  const geometries = generateFenceSlotGeometries(node)

  for (const slotId of FENCE_SLOT_ORDER) {
    const geometry = geometries[slotId]
    if (geometry.getAttribute('position') === undefined) continue
    const material = getFenceSlotMaterial(
      node,
      slotId,
      shading,
      textures,
      colorPreset,
      sceneTheme,
      ctx?.materials,
    )
    const mesh = new Mesh(geometry, material)
    mesh.castShadow = true
    mesh.receiveShadow = true
    mesh.userData.slotId = slotId
    mesh.userData.surfaceRole = 'joinery'
    group.add(mesh)
  }

  return group
}
