'use client'

import {
  type AnyNode,
  type AnyNodeId,
  type BuildingNode,
  CeilingNode,
  type EventSuffix,
  emitter,
  FenceNode,
  type GridEvent,
  ItemNode,
  type LevelNode,
  type NodeEvent,
  RoofNode,
  RoofSegmentNode,
  ScanNode,
  SlabNode,
  sceneRegistry,
  useLiveTransforms,
  useScene,
  WallNode,
} from '@pascal-app/core'
import { useViewer } from '@pascal-app/viewer'
import { Html } from '@react-three/drei'
import { Box } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { DoubleSide, Vector3 } from 'three'
import { markToolCancelConsumed } from '../../hooks/use-keyboard'
import { sfxEmitter } from '../../lib/sfx-bus'
import useEditor, { type PendingImportPlacement } from '../../store/use-editor'
import { CursorSphere } from './shared/cursor-sphere'

type CoordinateSpace = 'building' | 'world'
type PlacementPoint = [number, number, number]

const snapScalar = (value: number, step: number) =>
  step > 0 ? Math.round(value / step) * step : value
const DEFAULT_PLANE_Y = 0
const BUILD_MIN_LENGTH = 0.01
const BUILD_MIN_RECT_SIZE = 0.1
const BUILD_ANGLE_SNAP_STEP = Math.PI / 4
const DEFAULT_ROOF_PITCH_DEG = 40

type ClickTriggerEvent = GridEvent | NodeEvent<AnyNode>
type MoveExistingPlacement = Extract<PendingImportPlacement, { kind: 'move-existing' }>

const CLICK_TRIGGER_KINDS = [
  'building',
  'scan',
  'wall',
  'fence',
  'slab',
  'ceiling',
  'roof',
  'roof-segment',
  'item',
  'column',
  'door',
  'window',
  'stair',
  'stair-segment',
  'elevator',
] as const

function getChildren(node: AnyNode | undefined): AnyNodeId[] {
  if (!node || !('children' in node) || !Array.isArray(node.children)) return []
  return node.children as AnyNodeId[]
}

function getCurrentSiteId(): AnyNodeId | null {
  const scene = useScene.getState()
  for (const id of scene.rootNodeIds) {
    if (scene.nodes[id]?.type === 'site') return id
  }
  return null
}

function getImportedTopNodeIds(placement: Extract<PendingImportPlacement, { kind: 'ifc-scene' }>) {
  const ids: AnyNodeId[] = []

  for (const rootId of placement.rootNodeIds) {
    const root = placement.nodes[rootId]
    if (root?.type !== 'site') continue
    for (const childId of getChildren(root)) {
      if (placement.nodes[childId]?.type === 'building') ids.push(childId)
    }
  }

  if (ids.length > 0) return ids

  return placement.rootNodeIds.filter((id) => placement.nodes[id]?.type !== 'site')
}

function collectSubtreeIds(nodes: Record<AnyNodeId, AnyNode>, rootIds: AnyNodeId[]) {
  const ordered: AnyNodeId[] = []
  const seen = new Set<AnyNodeId>()

  const visit = (id: AnyNodeId) => {
    if (seen.has(id)) return
    const node = nodes[id]
    if (!node) return
    seen.add(id)
    ordered.push(id)
    for (const childId of getChildren(node)) visit(childId)
  }

  for (const rootId of rootIds) visit(rootId)
  return ordered
}

function cloneNode(node: AnyNode) {
  return structuredClone(node) as AnyNode
}

function getVector3(value: unknown): [number, number, number] {
  return Array.isArray(value) && value.length >= 3
    ? [
        typeof value[0] === 'number' ? value[0] : 0,
        typeof value[1] === 'number' ? value[1] : 0,
        typeof value[2] === 'number' ? value[2] : 0,
      ]
    : [0, 0, 0]
}

function getNodePosition(node: AnyNode | undefined): [number, number, number] | null {
  const position = (node as { position?: unknown } | undefined)?.position
  if (!Array.isArray(position) || position.length < 3) return null
  return [
    typeof position[0] === 'number' ? position[0] : 0,
    typeof position[1] === 'number' ? position[1] : 0,
    typeof position[2] === 'number' ? position[2] : 0,
  ]
}

function getNodeRotationY(node: AnyNode | undefined) {
  const rotation = (node as { rotation?: unknown } | undefined)?.rotation
  if (typeof rotation === 'number') return rotation
  if (Array.isArray(rotation)) return typeof rotation[1] === 'number' ? rotation[1] : 0
  return 0
}

function getMoveExistingStartPosition(placement: MoveExistingPlacement): PlacementPoint {
  const position = getNodePosition(useScene.getState().nodes[placement.nodeId])
  return position ? [position[0], 0, position[2]] : [0, 0, 0]
}

function setMoveExistingPreview(placement: MoveExistingPlacement, position: PlacementPoint) {
  const node = useScene.getState().nodes[placement.nodeId]
  const current = getNodePosition(node)
  if (!current) return

  useLiveTransforms.getState().set(placement.nodeId, {
    position: [position[0], current[1], position[2]],
    rotation: getNodeRotationY(node),
  })
}

function clearMoveExistingPreview(placement: MoveExistingPlacement) {
  useLiveTransforms.getState().clear(placement.nodeId)
}

function disableNodeRaycast(nodeId: AnyNodeId) {
  const object = sceneRegistry.nodes.get(nodeId)
  const restore: Array<() => void> = []
  if (!object) return restore

  object.traverse((child) => {
    const original = child.raycast
    child.raycast = () => {}
    restore.push(() => {
      child.raycast = original
    })
  })

  return restore
}

function stopClickTriggerPropagation(event: ClickTriggerEvent) {
  if ('stopPropagation' in event) event.stopPropagation()
  event.nativeEvent?.stopPropagation?.()
}

function getLevelLocalYForPlane(levelId: LevelNode['id'], planeY: number) {
  const levelObject = sceneRegistry.nodes.get(levelId)
  if (!levelObject) return planeY

  levelObject.updateWorldMatrix(true, false)
  const levelWorldPosition = new Vector3()
  levelObject.getWorldPosition(levelWorldPosition)
  return planeY - levelWorldPosition.y
}

function commitModelPlacement(
  placement: Extract<PendingImportPlacement, { kind: 'model' }>,
  position: [number, number, number],
) {
  if (!useScene.getState().nodes[placement.levelId]) return
  const localY = getLevelLocalYForPlane(placement.levelId, DEFAULT_PLANE_Y)

  const scan = ScanNode.parse({
    name: placement.name,
    url: placement.url,
    position: [position[0], localY, position[2]],
    rotation: [0, 0, 0],
    scale: 1,
    opacity: 100,
    metadata: {
      importedModel: {
        format: placement.format,
        alignToPlane: true,
        centerPivot: true,
        planeY: DEFAULT_PLANE_Y,
        snapToGrid: placement.snapToGrid,
      },
    },
  })

  useScene.getState().createNode(scan, placement.levelId)
  useViewer.getState().setShowScans(true)
  useViewer.getState().setSelection({
    levelId: placement.levelId,
    selectedIds: [],
    zoneId: null,
  })
  useEditor.getState().setSelectedReferenceId(scan.id)
}

function commitMoveExistingPlacement(placement: MoveExistingPlacement, position: PlacementPoint) {
  const scene = useScene.getState()
  const node = scene.nodes[placement.nodeId]
  const current = getNodePosition(node)
  if (!(node && current)) return false

  scene.updateNode(placement.nodeId, {
    position: [position[0], current[1], position[2]],
  } as Partial<AnyNode>)
  clearMoveExistingPreview(placement)

  const viewer = useViewer.getState()
  const editor = useEditor.getState()
  if (placement.selectAsReference) {
    editor.setSelectedReferenceId(placement.nodeId)
    viewer.setSelection({ selectedIds: [], zoneId: null })
  } else {
    editor.setSelectedReferenceId(null)
    if (node.type === 'building') {
      viewer.setSelection({
        buildingId: placement.nodeId as BuildingNode['id'],
        selectedIds: [placement.nodeId],
        zoneId: null,
      })
    } else {
      viewer.setSelection({ selectedIds: [placement.nodeId], zoneId: null })
    }
  }

  return true
}

function commitCatalogItemPlacement(
  placement: Extract<PendingImportPlacement, { kind: 'catalog-item' }>,
  position: [number, number, number],
) {
  if (!useScene.getState().nodes[placement.levelId]) return
  const localY = getLevelLocalYForPlane(placement.levelId, DEFAULT_PLANE_Y)

  const item = ItemNode.parse({
    name: placement.name,
    asset: placement.asset,
    position: [position[0], localY, position[2]],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
  })

  useScene.getState().createNode(item, placement.levelId)
  useEditor.getState().setSelectedReferenceId(null)
  useViewer.getState().setSelection({
    levelId: placement.levelId,
    selectedIds: [item.id],
    zoneId: null,
  })
}

function getShiftKey(event: GridEvent) {
  const native = event.nativeEvent as unknown as {
    nativeEvent?: { shiftKey?: boolean }
    shiftKey?: boolean
  }
  return native.shiftKey ?? native.nativeEvent?.shiftKey ?? false
}

function snapBuildEndTo45Degrees(
  start: PlacementPoint,
  end: PlacementPoint,
  snapToGrid: boolean,
  gridSnapStep: number,
): PlacementPoint {
  const dx = end[0] - start[0]
  const dz = end[2] - start[2]
  const distance = Math.hypot(dx, dz)
  if (distance < BUILD_MIN_LENGTH) return end

  const angle = Math.atan2(dz, dx)
  const snappedAngle = Math.round(angle / BUILD_ANGLE_SNAP_STEP) * BUILD_ANGLE_SNAP_STEP
  const x = start[0] + Math.cos(snappedAngle) * distance
  const z = start[2] + Math.sin(snappedAngle) * distance

  return [
    snapToGrid ? snapScalar(x, gridSnapStep) : x,
    end[1],
    snapToGrid ? snapScalar(z, gridSnapStep) : z,
  ]
}

function getSegmentLength(start: PlacementPoint, end: PlacementPoint) {
  return Math.hypot(end[0] - start[0], end[2] - start[2])
}

function formatSegmentLength(length: number) {
  return `${length >= 10 ? length.toFixed(1) : length.toFixed(2)}m`
}

function isSegmentBuildKind(
  kind: Extract<PendingImportPlacement, { kind: 'catalog-build' }>['buildKind'],
) {
  return kind === 'wall' || kind === 'fence'
}

function getRectanglePolygon(start: PlacementPoint, end: PlacementPoint): Array<[number, number]> {
  return [
    [start[0], start[2]],
    [end[0], start[2]],
    [end[0], end[2]],
    [start[0], end[2]],
  ]
}

function getRectangleSize(start: PlacementPoint, end: PlacementPoint) {
  return {
    width: Math.abs(end[0] - start[0]),
    depth: Math.abs(end[2] - start[2]),
  }
}

function commitCatalogBuildSegment(
  placement: Extract<PendingImportPlacement, { kind: 'catalog-build' }>,
  startPosition: PlacementPoint,
  endPosition: PlacementPoint,
) {
  if (!useScene.getState().nodes[placement.levelId]) return
  if (getSegmentLength(startPosition, endPosition) < BUILD_MIN_LENGTH) return
  const start: [number, number] = [startPosition[0], startPosition[2]]
  const end: [number, number] = [endPosition[0], endPosition[2]]

  const node =
    placement.buildKind === 'wall'
      ? WallNode.parse({
          name: placement.name,
          start,
          end,
          height: placement.height,
          thickness: placement.thickness,
        })
      : FenceNode.parse({
          name: placement.name,
          start,
          end,
          height: placement.height,
          thickness: placement.thickness,
          style: 'slat',
          baseStyle: 'grounded',
          color: '#ffffff',
        })

  useScene.getState().createNode(node, placement.levelId)
  useEditor.getState().setSelectedReferenceId(null)
  useViewer.getState().setSelection({
    levelId: placement.levelId,
    selectedIds: [node.id],
    zoneId: null,
  })
  return node.id
}

function commitCatalogBuildRectangle(
  placement: Extract<PendingImportPlacement, { kind: 'catalog-build' }>,
  startPosition: PlacementPoint,
  endPosition: PlacementPoint,
) {
  if (!useScene.getState().nodes[placement.levelId]) return null
  const { width, depth } = getRectangleSize(startPosition, endPosition)
  if (width < BUILD_MIN_RECT_SIZE || depth < BUILD_MIN_RECT_SIZE) return null

  const scene = useScene.getState()
  const polygon = getRectanglePolygon(startPosition, endPosition)
  const centerX = (startPosition[0] + endPosition[0]) / 2
  const centerZ = (startPosition[2] + endPosition[2]) / 2

  if (placement.buildKind === 'slab') {
    const slabCount = Object.values(scene.nodes).filter((node) => node.type === 'slab').length
    const slab = SlabNode.parse({
      name: `${placement.name} ${slabCount + 1}`,
      polygon,
      elevation: placement.height,
    })
    scene.createNode(slab, placement.levelId)
    useEditor.getState().setSelectedReferenceId(null)
    useViewer.getState().setSelection({
      levelId: placement.levelId,
      selectedIds: [slab.id],
      zoneId: null,
    })
    return slab.id
  }

  if (placement.buildKind === 'ceiling') {
    const ceilingCount = Object.values(scene.nodes).filter((node) => node.type === 'ceiling').length
    const ceiling = CeilingNode.parse({
      name: `${placement.name} ${ceilingCount + 1}`,
      polygon,
      height: placement.height,
    })
    scene.createNode(ceiling, placement.levelId)
    useEditor.getState().setSelectedReferenceId(null)
    useViewer.getState().setSelection({
      levelId: placement.levelId,
      selectedIds: [ceiling.id],
      zoneId: null,
    })
    return ceiling.id
  }

  const roofCount = Object.values(scene.nodes).filter((node) => node.type === 'roof').length
  const segment = RoofSegmentNode.parse({
    width: Math.max(width, 1),
    depth: Math.max(depth, 1),
    wallHeight: placement.height,
    pitch: DEFAULT_ROOF_PITCH_DEG,
    roofType: 'gable',
    position: [0, 0, 0],
  })
  const roof = RoofNode.parse({
    name: `${placement.name} ${roofCount + 1}`,
    position: [centerX, 0, centerZ],
    children: [segment.id],
  })

  scene.createNodes([
    { node: roof, parentId: placement.levelId },
    { node: segment, parentId: roof.id },
  ])
  useEditor.getState().setSelectedReferenceId(null)
  useViewer.getState().setSelection({
    levelId: placement.levelId,
    selectedIds: [roof.id],
    zoneId: null,
  })
  return roof.id
}

function commitCatalogBuildPlacement(
  placement: Extract<PendingImportPlacement, { kind: 'catalog-build' }>,
  startPosition: PlacementPoint,
  endPosition: PlacementPoint,
) {
  return isSegmentBuildKind(placement.buildKind)
    ? commitCatalogBuildSegment(placement, startPosition, endPosition)
    : commitCatalogBuildRectangle(placement, startPosition, endPosition)
}

function commitIfcScenePlacement(
  placement: Extract<PendingImportPlacement, { kind: 'ifc-scene' }>,
  position: [number, number, number],
) {
  const currentSiteId = getCurrentSiteId()
  const topNodeIds = getImportedTopNodeIds(placement)
  const orderedIds = collectSubtreeIds(placement.nodes, topNodeIds)
  const topNodeIdSet = new Set(topNodeIds)

  if (!currentSiteId) {
    const nextNodes = structuredClone(placement.nodes)
    for (const id of topNodeIds) {
      const node = nextNodes[id]
      if (node?.type !== 'building') continue
      const building = node as BuildingNode
      const base = getVector3(building.position)
      nextNodes[id] = {
        ...building,
        position: [position[0] + base[0], 0, position[2] + base[2]],
      }
    }
    useScene.getState().setScene(nextNodes, placement.rootNodeIds)
    return
  }

  const createOps: { node: AnyNode; parentId?: AnyNodeId }[] = []

  for (const id of orderedIds) {
    const original = placement.nodes[id]
    if (!original || original.type === 'site') continue

    let node = cloneNode(original)
    let parentId = node.parentId as AnyNodeId | null

    if (topNodeIdSet.has(id)) {
      parentId = currentSiteId
      if (node.type === 'building') {
        const building = node as BuildingNode
        const base = getVector3(building.position)
        node = {
          ...building,
          position: [position[0] + base[0], 0, position[2] + base[2]],
        }
      }
    }

    createOps.push({ node, parentId: parentId ?? undefined })
  }

  if (createOps.length === 0) return

  useScene.getState().createNodes(createOps)

  const firstBuildingId = topNodeIds.find((id) => placement.nodes[id]?.type === 'building') ?? null
  const firstLevelId =
    (orderedIds.find((id) => placement.nodes[id]?.type === 'level') as
      | LevelNode['id']
      | undefined) ?? useViewer.getState().selection.levelId

  useEditor.getState().setSelectedReferenceId(null)
  useViewer.getState().setSelection({
    buildingId: firstBuildingId as BuildingNode['id'] | null,
    levelId: firstLevelId,
    selectedIds: firstBuildingId ? [firstBuildingId] : [],
    zoneId: null,
  })
}

function BuildSegmentPreview({
  end,
  placement,
  start,
}: {
  end: PlacementPoint
  placement: Extract<PendingImportPlacement, { kind: 'catalog-build' }>
  start: PlacementPoint
}) {
  if (!isSegmentBuildKind(placement.buildKind)) {
    const { width, depth } = getRectangleSize(start, end)
    if (width < BUILD_MIN_RECT_SIZE || depth < BUILD_MIN_RECT_SIZE) return null

    const color =
      placement.buildKind === 'roof'
        ? '#818cf8'
        : placement.buildKind === 'ceiling'
          ? '#38bdf8'
          : '#f97316'
    const previewY =
      placement.buildKind === 'ceiling' ? start[1] + placement.height : start[1] + 0.03
    const midpoint: PlacementPoint = [(start[0] + end[0]) / 2, previewY, (start[2] + end[2]) / 2]

    return (
      <>
        <mesh position={midpoint} renderOrder={1} rotation={[-Math.PI / 2, 0, 0]}>
          <planeGeometry args={[width, depth]} />
          <meshBasicMaterial
            color={color}
            depthTest={false}
            depthWrite={false}
            opacity={0.18}
            side={DoubleSide}
            transparent
          />
        </mesh>
        <Html center position={[midpoint[0], previewY + 0.3, midpoint[2]]}>
          <div className="pointer-events-none rounded-md bg-slate-950/90 px-2 py-1 font-bold text-white text-xs shadow-lg">
            {formatSegmentLength(width)} x {formatSegmentLength(depth)}
          </div>
        </Html>
      </>
    )
  }

  const length = getSegmentLength(start, end)
  if (length < BUILD_MIN_LENGTH) return null

  const height = placement.height
  const thickness = placement.thickness
  const angle = Math.atan2(end[2] - start[2], end[0] - start[0])
  const color = placement.buildKind === 'wall' ? '#818cf8' : '#f97316'
  const midpoint: PlacementPoint = [
    (start[0] + end[0]) / 2,
    (start[1] + end[1]) / 2,
    (start[2] + end[2]) / 2,
  ]

  return (
    <>
      <mesh
        position={[midpoint[0], midpoint[1] + height / 2, midpoint[2]]}
        renderOrder={1}
        rotation={[0, -angle, 0]}
      >
        <boxGeometry args={[length, height, thickness]} />
        <meshBasicMaterial
          color={color}
          depthTest={false}
          depthWrite={false}
          opacity={0.5}
          side={DoubleSide}
          transparent
        />
      </mesh>
      <Html center position={[midpoint[0], midpoint[1] + height + 0.3, midpoint[2]]}>
        <div className="pointer-events-none rounded-md bg-slate-950/90 px-2 py-1 font-bold text-white text-xs shadow-lg">
          {formatSegmentLength(length)}
        </div>
      </Html>
    </>
  )
}

export function ImportPlacementTool({
  coordinateSpace,
  placement,
}: {
  coordinateSpace: CoordinateSpace
  placement: PendingImportPlacement
}) {
  const gridSnapStep = useEditor((state) => state.gridSnapStep)
  const [cursorPosition, setCursorPosition] = useState<PlacementPoint>([0, 0, 0])
  const [buildStart, setBuildStart] = useState<PlacementPoint | null>(null)
  const [buildEnd, setBuildEnd] = useState<PlacementPoint | null>(null)
  const lastCursorRef = useRef<PlacementPoint>([0, 0, 0])
  const buildStartRef = useRef<PlacementPoint | null>(null)
  const previousSnapRef = useRef<[number, number] | null>(null)

  useEffect(() => {
    previousSnapRef.current = null
    buildStartRef.current = null
    setBuildStart(null)
    setBuildEnd(null)

    const initialPosition: PlacementPoint =
      placement.kind === 'move-existing' ? getMoveExistingStartPosition(placement) : [0, 0, 0]
    setCursorPosition(initialPosition)
    lastCursorRef.current = initialPosition

    const restoreRaycasts =
      placement.kind === 'move-existing' ? disableNodeRaycast(placement.nodeId) : []
    if (placement.kind === 'move-existing') {
      setMoveExistingPreview(placement, initialPosition)
    }

    const getPlacementPosition = (event: GridEvent): PlacementPoint => {
      const raw = coordinateSpace === 'world' ? event.position : event.localPosition
      const x = placement.snapToGrid ? snapScalar(raw[0], gridSnapStep) : raw[0]
      const z = placement.snapToGrid ? snapScalar(raw[2], gridSnapStep) : raw[2]
      const position: PlacementPoint = [x, 0, z]
      const start = buildStartRef.current
      if (
        placement.kind !== 'catalog-build' ||
        !start ||
        !isSegmentBuildKind(placement.buildKind) ||
        getShiftKey(event)
      ) {
        return position
      }
      return snapBuildEndTo45Degrees(start, position, placement.snapToGrid, gridSnapStep)
    }

    const onGridMove = (event: GridEvent) => {
      const position = getPlacementPosition(event)
      setCursorPosition(position)
      lastCursorRef.current = position
      if (placement.kind === 'catalog-build' && buildStartRef.current) {
        setBuildEnd(position)
      }
      if (placement.kind === 'move-existing') {
        setMoveExistingPreview(placement, position)
      }

      const prev = previousSnapRef.current
      if (!prev || prev[0] !== position[0] || prev[1] !== position[2]) {
        sfxEmitter.emit('sfx:grid-snap')
        previousSnapRef.current = [position[0], position[2]]
      }
    }

    const commitAtPosition = (position: PlacementPoint, event: ClickTriggerEvent) => {
      setCursorPosition(position)
      lastCursorRef.current = position
      if (placement.kind === 'model') {
        commitModelPlacement(placement, position)
      } else if (placement.kind === 'catalog-item') {
        commitCatalogItemPlacement(placement, position)
      } else if (placement.kind === 'catalog-build') {
        const start = buildStartRef.current
        if (!start) {
          buildStartRef.current = position
          setBuildStart(position)
          setBuildEnd(position)
          sfxEmitter.emit('sfx:grid-snap')
          return
        }

        const nodeId = commitCatalogBuildPlacement(placement, start, position)
        if (!nodeId) return
        sfxEmitter.emit('sfx:structure-build')
      } else if (placement.kind === 'move-existing') {
        if (!commitMoveExistingPlacement(placement, position)) return
      } else {
        commitIfcScenePlacement(placement, position)
      }
      if (placement.kind !== 'catalog-build') {
        sfxEmitter.emit('sfx:item-place')
      }
      useEditor.getState().setPendingImportPlacement(null)
      useEditor.getState().setMode('select')
      stopClickTriggerPropagation(event)
    }

    const onGridClick = (event: GridEvent) => {
      commitAtPosition(getPlacementPosition(event), event)
    }

    const onNodeClick = (event: NodeEvent<AnyNode>) => {
      commitAtPosition(lastCursorRef.current, event)
    }

    const onCancel = () => {
      markToolCancelConsumed()
      if (placement.kind === 'catalog-build' && buildStartRef.current) {
        buildStartRef.current = null
        setBuildStart(null)
        setBuildEnd(null)
        return
      }
      if (placement.kind === 'move-existing') {
        clearMoveExistingPreview(placement)
      }
      useEditor.getState().setPendingImportPlacement(null)
    }

    emitter.on('grid:move', onGridMove)
    emitter.on('grid:click', onGridClick)
    for (const kind of CLICK_TRIGGER_KINDS) {
      emitter.on(`${kind}:click` as `${typeof kind}:${EventSuffix}`, onNodeClick as never)
    }
    emitter.on('tool:cancel', onCancel)

    return () => {
      for (const restore of restoreRaycasts) restore()
      if (placement.kind === 'move-existing') {
        clearMoveExistingPreview(placement)
      }
      emitter.off('grid:move', onGridMove)
      emitter.off('grid:click', onGridClick)
      for (const kind of CLICK_TRIGGER_KINDS) {
        emitter.off(`${kind}:click` as `${typeof kind}:${EventSuffix}`, onNodeClick as never)
      }
      emitter.off('tool:cancel', onCancel)
    }
  }, [coordinateSpace, gridSnapStep, placement])

  return (
    <>
      {placement.kind === 'catalog-build' && buildStart && buildEnd && (
        <BuildSegmentPreview end={buildEnd} placement={placement} start={buildStart} />
      )}
      <CursorSphere
        color={
          placement.kind === 'ifc-scene'
            ? '#f59e0b'
            : placement.kind === 'move-existing'
              ? '#2563eb'
              : placement.kind === 'catalog-item' || placement.kind === 'catalog-build'
                ? '#f97316'
                : '#38bdf8'
        }
        height={placement.kind === 'catalog-build' ? placement.height : 2.5}
        position={cursorPosition}
        tooltipContent={<Box aria-hidden="true" className="h-5 w-5 text-white" />}
      />
    </>
  )
}
