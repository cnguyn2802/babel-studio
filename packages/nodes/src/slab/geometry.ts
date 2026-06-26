import { type GeometryContext, getMaterialPresetByRef, type SlabNode } from '@pascal-app/core'
import {
  applyMaterialPresetToMaterials,
  type ColorPreset,
  createDefaultMaterial,
  createMaterial,
  createSurfaceRoleMaterial,
  generateSlabGeometry,
  type RenderShading,
  resolveMaterialRef,
  resolveSlotDefaultMaterial,
} from '@pascal-app/viewer'
import {
  BufferGeometry,
  Float32BufferAttribute,
  FrontSide,
  Group,
  type Material,
  Mesh,
  type Texture,
  Vector3,
} from 'three'
import { SLAB_SIDE_SLOT_DEFAULT, SLAB_TOP_SLOT_DEFAULT, type SlabSlotId } from './slots'

type SlabMaterial = Material & {
  alphaMap?: Texture | null
  depthWrite: boolean
  opacity: number
  transparent: boolean
}

const slabMaterialCache = new Map<string, Material>()

function getLegacySlabMaterial(node: SlabNode, shading: RenderShading): Material {
  const cacheKey = JSON.stringify({
    shading,
    material: node.material ?? null,
    materialPreset: node.materialPreset ?? null,
  })
  const cached = slabMaterialCache.get(cacheKey)
  if (cached) return cached

  const preset = getMaterialPresetByRef(node.materialPreset)
  const material = preset
    ? createDefaultMaterial('#ffffff', 0.5, shading)
    : node.material
      ? createMaterial(node.material, shading).clone()
      : createDefaultMaterial('#e5e5e5', 0.8, shading)

  if (preset) {
    applyMaterialPresetToMaterials(material, preset)
  }

  const slabMaterial = material as SlabMaterial
  slabMaterial.transparent = false
  slabMaterial.opacity = 1
  slabMaterial.alphaMap = null
  slabMaterial.side = FrontSide
  slabMaterial.depthWrite = true
  slabMaterial.needsUpdate = true

  slabMaterialCache.set(cacheKey, material)
  return material
}

function getSlabSlotMaterial(
  node: SlabNode,
  slotId: SlabSlotId,
  shading: RenderShading,
  textures: boolean,
  colorPreset: ColorPreset,
  sceneTheme: string | undefined,
  sceneMaterials: GeometryContext['materials'],
): Material {
  if (!textures) {
    return createSurfaceRoleMaterial('floor', colorPreset, FrontSide, sceneTheme)
  }

  const slotRef = node.slots?.[slotId]
  if (slotRef) {
    const resolved = resolveMaterialRef(slotRef, sceneMaterials, shading)
    if (resolved) return resolved
  }

  if (slotId === 'surface' && (node.materialPreset || node.material)) {
    return getLegacySlabMaterial(node, shading)
  }

  const slotDefault = slotId === 'side' ? SLAB_SIDE_SLOT_DEFAULT : SLAB_TOP_SLOT_DEFAULT
  return resolveSlotDefaultMaterial(slotDefault, shading, 0.8)
}

function splitSlabFacesByFacing(geometry: BufferGeometry): {
  top: BufferGeometry
  side: BufferGeometry
} {
  const position = geometry.getAttribute('position')
  const uv = geometry.getAttribute('uv')
  const index = geometry.getIndex()
  const triangleCount = index ? index.count / 3 : position.count / 3

  const top = { pos: [] as number[], uv: [] as number[] }
  const side = { pos: [] as number[], uv: [] as number[] }
  const a = new Vector3()
  const b = new Vector3()
  const c = new Vector3()
  const ab = new Vector3()
  const ac = new Vector3()
  const normal = new Vector3()

  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    const i0 = index ? index.getX(triangle * 3) : triangle * 3
    const i1 = index ? index.getX(triangle * 3 + 1) : triangle * 3 + 1
    const i2 = index ? index.getX(triangle * 3 + 2) : triangle * 3 + 2
    a.fromBufferAttribute(position, i0)
    b.fromBufferAttribute(position, i1)
    c.fromBufferAttribute(position, i2)
    ab.subVectors(b, a)
    ac.subVectors(c, a)
    normal.crossVectors(ab, ac)
    const lengthSq = normal.lengthSq()
    const isTop = lengthSq > 1e-12 && normal.y / Math.sqrt(lengthSq) > 0.5
    const target = isTop ? top : side
    for (const i of [i0, i1, i2]) {
      target.pos.push(position.getX(i), position.getY(i), position.getZ(i))
      if (uv) target.uv.push(uv.getX(i), uv.getY(i))
    }
  }

  const build = (data: { pos: number[]; uv: number[] }) => {
    const geo = new BufferGeometry()
    geo.setAttribute('position', new Float32BufferAttribute(data.pos, 3))
    if (data.uv.length > 0) geo.setAttribute('uv', new Float32BufferAttribute(data.uv, 2))
    geo.computeVertexNormals()
    return geo
  }

  return { top: build(top), side: build(side) }
}

export function buildSlabGeometry(
  node: SlabNode,
  ctx?: GeometryContext,
  shading: RenderShading = 'rendered',
  textures = true,
  colorPreset: ColorPreset = 'clay',
  sceneTheme?: string,
): Group {
  const group = new Group()
  const merged = generateSlabGeometry(node)
  const { top, side } = splitSlabFacesByFacing(merged)
  merged.dispose()

  const elevation = node.elevation ?? 0.05
  for (const [slotId, geometry] of [
    ['surface', top],
    ['side', side],
  ] as const) {
    const material = getSlabSlotMaterial(
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
    if (elevation < 0) mesh.position.y = elevation
    group.add(mesh)
  }

  return group
}
