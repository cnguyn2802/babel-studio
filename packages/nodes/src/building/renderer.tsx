'use client'

import { type BuildingNode, useLiveTransforms, useRegistry } from '@pascal-app/core'
import { NodeRenderer, useNodeEvents } from '@pascal-app/viewer'
import { useRef } from 'react'
import type { Group } from 'three'

export const BuildingRenderer = ({ node }: { node: BuildingNode }) => {
  const ref = useRef<Group>(null!)

  useRegistry(node.id, node.type, ref)
  const handlers = useNodeEvents(node, 'building')
  const liveTransform = useLiveTransforms((state) => state.get(node.id))

  return (
    <group
      position={liveTransform?.position ?? node.position}
      ref={ref}
      rotation={
        liveTransform?.rotation !== undefined
          ? [node.rotation[0], liveTransform.rotation, node.rotation[2]]
          : [node.rotation[0], node.rotation[1], node.rotation[2]]
      }
      {...handlers}
    >
      {node.children.map((childId) => (
        <NodeRenderer key={childId} nodeId={childId} />
      ))}
    </group>
  )
}

export default BuildingRenderer
