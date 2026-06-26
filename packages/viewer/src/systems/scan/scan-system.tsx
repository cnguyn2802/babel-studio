import { type AnyNodeId, sceneRegistry, useScene } from '@pascal-app/core'
import { useEffect } from 'react'
import useViewer from '../../store/use-viewer'

export const ScanSystem = () => {
  const showScans = useViewer((state) => state.showScans)
  const nodes = useScene((state) => state.nodes)

  useEffect(() => {
    const scans = sceneRegistry.byType.scan || new Set()
    scans.forEach((scanId) => {
      const object = sceneRegistry.nodes.get(scanId)
      const node = nodes[scanId as AnyNodeId]
      if (object) {
        object.visible = showScans && node?.visible !== false
      }
    })
  }, [nodes, showScans])

  return null
}
