import {
  type CeilingNode,
  type LevelNode,
  sceneRegistry,
  useScene,
  type WallNode,
} from '@pascal-app/core'

export const DEFAULT_LEVEL_HEIGHT = 2.5

type SceneNodes = ReturnType<typeof useScene.getState>['nodes']
type LevelObject = NonNullable<ReturnType<typeof sceneRegistry.nodes.get>>

export type SortedLevelEntry = {
  index: number
  levelId: string
  obj: LevelObject
}

export function getSortedLevelGroups(
  nodes: SceneNodes,
): SortedLevelEntry[][] {
  const levelIds = sceneRegistry.byType.level
  if (!levelIds) return []

  const groups = new Map<string, SortedLevelEntry[]>()

  levelIds.forEach((levelId) => {
    const obj = sceneRegistry.nodes.get(levelId)
    const level = nodes[levelId as LevelNode['id']]
    if (!obj || !level) return

    const groupKey = (level as LevelNode).parentId ?? '__unparented__'
    const entries = groups.get(groupKey) ?? []
    entries.push({ levelId, index: (level as LevelNode).level ?? 0, obj })
    groups.set(groupKey, entries)
  })

  return Array.from(groups.values()).map((entries) =>
    [...entries].sort((a, b) => a.index - b.index),
  )
}

type LevelMetadata = {
  ifcType?: unknown
  elevation?: unknown
}

function getIfcStoreyElevation(level: LevelNode | undefined): number | null {
  const metadata = level?.metadata
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null

  const { ifcType, elevation } = metadata as LevelMetadata
  if (ifcType !== 'IFCBUILDINGSTOREY') return null
  if (typeof elevation !== 'number' || !Number.isFinite(elevation)) return null

  return elevation
}

function hasMeaningfulIfcElevations(elevations: number[]): boolean {
  if (elevations.length < 2) return false

  const min = Math.min(...elevations)
  const max = Math.max(...elevations)
  return max - min > 1e-4
}

export function getLevelBaseYById(
  group: SortedLevelEntry[],
  nodes: SceneNodes,
): Map<string, number> {
  const elevations = group
    .map(({ levelId }) => getIfcStoreyElevation(nodes[levelId as LevelNode['id']] as LevelNode))
    .filter((elevation): elevation is number => elevation !== null)
  const useIfcElevations = hasMeaningfulIfcElevations(elevations)
  const minIfcElevation = useIfcElevations ? Math.min(...elevations) : 0
  const baseYById = new Map<string, number>()

  let cumulativeY = 0
  for (const { levelId } of group) {
    const level = nodes[levelId as LevelNode['id']] as LevelNode | undefined
    const ifcElevation = useIfcElevations ? getIfcStoreyElevation(level) : null
    const baseY = ifcElevation === null ? cumulativeY : ifcElevation - minIfcElevation

    baseYById.set(levelId, baseY)
    cumulativeY += getLevelHeight(levelId, nodes)
  }

  return baseYById
}

// Cache: levelId → computed height. Invalidated when the nodes reference changes.
// Zustand produces a new `nodes` object on every mutation, so reference equality
// is a zero-cost way to detect stale data without any subscription overhead.
const heightCache = new Map<string, number>()
let lastNodesRef: object | null = null

export function getLevelHeight(
  levelId: string,
  nodes: SceneNodes,
): number {
  if (nodes !== lastNodesRef) {
    heightCache.clear()
    lastNodesRef = nodes
  }

  if (heightCache.has(levelId)) return heightCache.get(levelId)!

  const level = nodes[levelId as LevelNode['id']] as LevelNode | undefined
  if (!level) return DEFAULT_LEVEL_HEIGHT

  let maxTop = 0

  for (const childId of level.children) {
    const child = nodes[childId as keyof typeof nodes]
    if (!child) continue
    if (child.type === 'ceiling') {
      const ch = (child as CeilingNode).height ?? DEFAULT_LEVEL_HEIGHT
      if (ch > maxTop) maxTop = ch
    } else if (child.type === 'wall') {
      let meshY = sceneRegistry.nodes.get(childId as any)?.position.y ?? 0
      if (meshY < 0) meshY = 0
      const top = meshY + ((child as WallNode).height ?? DEFAULT_LEVEL_HEIGHT)
      if (top > maxTop) maxTop = top
    }
  }

  const height = maxTop > 0 ? maxTop : DEFAULT_LEVEL_HEIGHT
  heightCache.set(levelId, height)
  return height
}

/**
 * Instantly snaps all level Objects3D to their true stacked Y positions
 * (ignores levelMode — always uses stacked, no exploded gap).
 *
 * Returns a restore function that reverts each level's Y to what it was
 * before the snap, so lerp animations in LevelSystem can continue undisturbed.
 *
 * Usage:
 *   const restore = snapLevelsToTruePositions()
 *   renderer.render(scene, camera)
 *   restore()
 */
export function snapLevelsToTruePositions(): () => void {
  const nodes = useScene.getState().nodes
  const levelGroups = getSortedLevelGroups(nodes)
  const entries = levelGroups.flat()

  // Snapshot current Y and visibility so we can restore them after the render
  const snapshot = new Map(
    entries.map(({ levelId, obj }) => [levelId, { y: obj.position.y, visible: obj.visible }]),
  )

  // Snap to true stacked positions and make all levels visible
  for (const group of levelGroups) {
    const baseYById = getLevelBaseYById(group, nodes)
    for (const { levelId, obj } of group) {
      obj.position.y = baseYById.get(levelId) ?? 0
      obj.visible = true
    }
  }

  return () => {
    for (const { levelId, obj } of entries) {
      const saved = snapshot.get(levelId)
      if (saved !== undefined) {
        obj.position.y = saved.y
        obj.visible = saved.visible
      }
    }
  }
}
