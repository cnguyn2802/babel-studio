import {
  type AnyNode,
  type AnyNodeId,
  generateSceneMaterialId,
  type MaterialSchema,
  type PaintCapability,
  type PaintPreviewArgs,
  type PaintResolveArgs,
  parseMaterialRef,
  type SceneMaterial,
  type SceneMaterialId,
  toSceneMaterialRef,
  useScene,
} from '@pascal-app/core'
import { createMaterial, createMaterialFromPresetRef, useViewer } from '@pascal-app/viewer'
import { type Material, type Mesh, type Object3D } from 'three'

type SlotsNode = AnyNode & { slots?: Record<string, string> }

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== typeof b) return false
  if (a === null || b === null) return false
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    for (let index = 0; index < a.length; index += 1) {
      if (!deepEqual(a[index], b[index])) return false
    }
    return true
  }
  if (typeof a === 'object') {
    const aRecord = a as Record<string, unknown>
    const bRecord = b as Record<string, unknown>
    const aKeys = Object.keys(aRecord)
    const bKeys = Object.keys(bRecord)
    if (aKeys.length !== bKeys.length) return false
    for (const key of aKeys) {
      if (!Object.prototype.hasOwnProperty.call(bRecord, key)) return false
      if (!deepEqual(aRecord[key], bRecord[key])) return false
    }
    return true
  }
  return false
}

function findMatchingSceneMaterial(
  materials: Record<SceneMaterialId, SceneMaterial>,
  material: MaterialSchema,
): SceneMaterial | null {
  for (const sceneMaterial of Object.values(materials)) {
    if (deepEqual(sceneMaterial.material, material)) return sceneMaterial
  }
  return null
}

function commitSlotPaint(
  node: SlotsNode,
  role: string,
  material: MaterialSchema | undefined,
  materialPreset: string | undefined,
): void {
  const nodeId = node.id as AnyNodeId
  const state = useScene.getState()
  const currentNode = (state.nodes[nodeId] as SlotsNode | undefined) ?? node

  let ref: string | undefined
  let newSceneMaterial: SceneMaterial | null = null

  if (material === undefined && materialPreset === undefined) {
    ref = undefined
  } else if (materialPreset) {
    ref = materialPreset
  } else if (material) {
    const existing = findMatchingSceneMaterial(state.materials, material)
    if (existing) {
      ref = toSceneMaterialRef(existing.id)
    } else {
      const id = generateSceneMaterialId()
      newSceneMaterial = {
        id,
        name: `Material ${Object.keys(state.materials).length + 1}`,
        material,
      }
      ref = toSceneMaterialRef(id)
    }
  } else {
    return
  }

  const nextSlots = { ...(currentNode.slots ?? {}) }
  if (ref) nextSlots[role] = ref
  else delete nextSlots[role]

  if (newSceneMaterial) {
    const sceneMaterial = newSceneMaterial
    useScene.setState((state) => {
      if (state.readOnly) return state
      const node2 = state.nodes[nodeId] as SlotsNode | undefined
      if (!node2) return state
      return {
        materials: { ...state.materials, [sceneMaterial.id as SceneMaterialId]: sceneMaterial },
        nodes: {
          ...state.nodes,
          [nodeId]: { ...node2, slots: nextSlots } as AnyNode,
        },
      }
    })
    useScene.getState().markDirty(nodeId)
    return
  }

  state.updateNode(nodeId, { slots: nextSlots } as Partial<AnyNode>)
}

export function buildSlotPreviewMaterial(
  material: MaterialSchema | undefined,
  materialPreset: string | undefined,
): Material | null {
  const shading = useViewer.getState().shading
  if (materialPreset) {
    const parsed = parseMaterialRef(materialPreset)
    if (parsed?.kind === 'scene') {
      const sceneMaterial = useScene.getState().materials[parsed.id as SceneMaterialId]
      return sceneMaterial ? createMaterial(sceneMaterial.material, shading) : null
    }
    return createMaterialFromPresetRef(materialPreset, shading)
  }
  if (material) return createMaterial(material, shading)
  return null
}

export function previewGeometrySlot(args: PaintPreviewArgs): (() => void) | null {
  const { role, root, material, materialPreset } = args
  const preview = buildSlotPreviewMaterial(material, materialPreset)
  if (!preview) return () => {}

  const restores: Array<() => void> = []
  ;(root as Object3D).traverse((object) => {
    const mesh = object as Mesh
    if (!mesh.isMesh) return
    const userData = mesh.userData as { slotId?: string | null; __fromGeometry?: boolean }
    if (userData.__fromGeometry !== true) return
    if (userData.slotId !== role) return
    const previous = mesh.material
    mesh.material = preview
    restores.push(() => {
      mesh.material = previous
    })
  })

  if (restores.length === 0) return null
  return () => {
    for (let index = restores.length - 1; index >= 0; index -= 1) restores[index]?.()
  }
}

export function previewSlotByUserData(args: PaintPreviewArgs): (() => void) | null {
  const { role, root, material, materialPreset } = args
  const preview = buildSlotPreviewMaterial(material, materialPreset)
  if (!preview) return () => {}

  const restores: Array<() => void> = []
  ;(root as Object3D).traverse((object) => {
    const mesh = object as Mesh
    if (!mesh.isMesh) return
    if ((mesh.userData as { slotId?: string | null }).slotId !== role) return
    const previous = mesh.material
    mesh.material = preview
    restores.push(() => {
      mesh.material = previous
    })
  })

  if (restores.length === 0) return null
  return () => {
    for (let index = restores.length - 1; index >= 0; index -= 1) restores[index]?.()
  }
}

export type SlotPaintConfig = {
  resolveRole: (args: PaintResolveArgs) => string | null
  applyPreview: (args: PaintPreviewArgs) => (() => void) | null
  legacyEffective?: (
    node: AnyNode,
    role: string,
  ) => { material: MaterialSchema | undefined; materialPreset: string | undefined } | null
}

export function createSlotPaintCapability(config: SlotPaintConfig): PaintCapability {
  return {
    resolveRole: config.resolveRole,
    buildPatch: ({ node, role, materialPreset }) => {
      const slots = { ...((node as SlotsNode).slots ?? {}) }
      if (materialPreset) slots[role] = materialPreset
      else delete slots[role]
      return { slots } as Partial<AnyNode>
    },
    commit: ({ node, role, material, materialPreset }) =>
      commitSlotPaint(node as SlotsNode, role, material, materialPreset),
    applyPreview: config.applyPreview,
    getEffectiveMaterial: ({ node, role }) => {
      const ref = (node as SlotsNode).slots?.[role]
      const parsed = parseMaterialRef(ref)
      if (parsed) {
        if (parsed.kind === 'library') return { material: undefined, materialPreset: ref }
        const sceneMaterial = useScene.getState().materials[parsed.id as SceneMaterialId]
        if (sceneMaterial) return { material: sceneMaterial.material, materialPreset: undefined }
      }
      return config.legacyEffective?.(node, role) ?? null
    },
  }
}
