'use client'

import {
  type CeilingNode,
  getMaterialPresetByRef,
  resolveMaterial,
  useRegistry,
  useScene,
} from '@pascal-app/core'
import {
  createSurfaceRoleMaterial,
  NodeRenderer,
  resolveSurfaceColor,
  useNodeEvents,
  useViewer,
} from '@pascal-app/viewer'
import { useEffect, useMemo, useRef } from 'react'
import { BufferGeometry, Float32BufferAttribute } from 'three'
import { BackSide, FrontSide, type Mesh } from 'three/webgpu'
import { ceilingColorFromRef, getCeilingMaterials } from './materials'
import { CEILING_SLOT_DEFAULT_COLOR } from './slots'

function createEmptyGeometry() {
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new Float32BufferAttribute([], 3))
  return geometry
}

export const CeilingRenderer = ({ node }: { node: CeilingNode }) => {
  const ref = useRef<Mesh>(null!)
  const placeholderGeometry = useMemo(createEmptyGeometry, [])
  const gridPlaceholderGeometry = useMemo(createEmptyGeometry, [])

  useRegistry(node.id, 'ceiling', ref)
  const handlers = useNodeEvents(node, 'ceiling')
  const textures = useViewer((s) => s.textures)
  const colorPreset = useViewer((s) => s.colorPreset)
  const sceneTheme = useViewer((s) => s.sceneTheme)
  const sceneMaterials = useScene((s) => s.materials)

  useEffect(
    () => () => {
      placeholderGeometry.dispose()
      gridPlaceholderGeometry.dispose()
    },
    [gridPlaceholderGeometry, placeholderGeometry],
  )

  const materials = useMemo(() => {
    if (!textures) {
      const ceilingColor = resolveSurfaceColor('ceiling', colorPreset, sceneTheme)
      return {
        topMaterial: getCeilingMaterials(ceilingColor).topMaterial,
        bottomMaterial: createSurfaceRoleMaterial('ceiling', colorPreset, BackSide, sceneTheme),
      }
    }

    const slotColor = ceilingColorFromRef(node.slots?.surface, sceneMaterials)
    if (slotColor) return getCeilingMaterials(slotColor)

    const preset = getMaterialPresetByRef(node.materialPreset)
    if (preset || node.material) {
      const props = preset?.mapProperties ?? resolveMaterial(node.material)
      return getCeilingMaterials(props.color || '#999999')
    }

    return getCeilingMaterials(CEILING_SLOT_DEFAULT_COLOR)
  }, [
    textures,
    colorPreset,
    sceneTheme,
    sceneMaterials,
    node.slots,
    node.materialPreset,
    node.material,
    node.material?.preset,
    node.material?.properties,
    node.material?.texture,
  ])

  return (
    <mesh geometry={placeholderGeometry} material={materials.bottomMaterial} ref={ref}>
      <mesh
        geometry={gridPlaceholderGeometry}
        material={materials.topMaterial}
        name="ceiling-grid"
        {...handlers}
        scale={0}
        visible={false}
      />
      {node.children.map((childId) => (
        <NodeRenderer key={childId} nodeId={childId} />
      ))}
    </mesh>
  )
}

export default CeilingRenderer
