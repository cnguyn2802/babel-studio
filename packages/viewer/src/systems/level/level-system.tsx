import { type LevelNode, useScene } from '@pascal-app/core'
import { useFrame } from '@react-three/fiber'
import { lerp } from 'three/src/math/MathUtils.js'
import useViewer from '../../store/use-viewer'
import { getLevelBaseYById, getSortedLevelGroups } from './level-utils'

const EXPLODED_GAP = 5

export const LevelSystem = () => {
  useFrame((_, delta) => {
    const nodes = useScene.getState().nodes
    const levelMode = useViewer.getState().levelMode
    const selectedLevel = useViewer.getState().selection.levelId

    for (const group of getSortedLevelGroups(nodes)) {
      const baseYById = getLevelBaseYById(group, nodes)
      for (const { levelId, index, obj } of group) {
        const level = nodes[levelId as LevelNode['id']]
        const baseY = baseYById.get(levelId) ?? 0
        const explodedExtra = levelMode === 'exploded' ? index * EXPLODED_GAP : 0
        const targetY = baseY + explodedExtra

        obj.position.y = lerp(obj.position.y, targetY, delta * 12)
        obj.visible = levelMode !== 'solo' || level?.id === selectedLevel || !selectedLevel
      }
    }
  }, 5) // Using a lower priority so it runs after transforms from other systems have settled
  return null
}
