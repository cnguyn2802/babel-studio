'use client'

import {
  type AnyNode,
  type AnyNodeId,
  type BuildingNode,
  emitter,
  type NodeEvent,
  sceneRegistry,
  useScene,
} from '@pascal-app/core'
import type { SceneGraph } from '@pascal-app/core/clone-scene-graph'
import { Grid, ImportPlacementTool, useEditor } from '@pascal-app/editor'
import { ExportManager } from '@pascal-app/editor/export-manager'
import { useViewer, Viewer } from '@pascal-app/viewer'
import { CameraControls, CameraControlsImpl } from '@react-three/drei'
import { useThree } from '@react-three/fiber'
import { Maximize } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Box3, type Camera, type Object3D, Vector3 } from 'three'

type SceneViewMode = '2d' | '3d'
type CameraProjectionMode = 'perspective' | 'orthographic'

const TOP_DOWN_MIN_EXTENT = 50
const TOP_DOWN_PADDING = 1.18
const TOP_DOWN_MIN_HEIGHT = 60
const TOP_DOWN_MIN_ZOOM = 4
const TOP_DOWN_MAX_ZOOM = 80
const AI_SELECTABLE_NODE_TYPES = [
  'wall',
  'fence',
  'item',
  'column',
  'slab',
  'ceiling',
  'roof',
  'roof-segment',
  'window',
  'door',
  'stair',
  'stair-segment',
  'elevator',
  'scan',
] as const
const AI_SELECTABLE_NODE_TYPE_SET = new Set<string>(AI_SELECTABLE_NODE_TYPES)
const topDownBox = new Box3()
const topDownCenter = new Vector3()
const topDownSize = new Vector3()
const restorePosition = new Vector3()
const restoreTarget = new Vector3()

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function getPreviewSceneBounds(sceneRoot: Object3D) {
  topDownBox.makeEmpty()

  for (const object of sceneRegistry.nodes.values()) {
    if (!object.visible) continue
    const nodeBox = new Box3().setFromObject(object)
    if (!nodeBox.isEmpty()) topDownBox.union(nodeBox)
  }

  if (!topDownBox.isEmpty()) return topDownBox

  const rootBox = new Box3().setFromObject(sceneRoot)
  if (rootBox.isEmpty()) return null

  rootBox.getSize(topDownSize)
  const rootExtent = Math.max(topDownSize.x, topDownSize.z)
  return rootExtent <= 300 ? rootBox : null
}

function frameTopDownView(
  controls: CameraControlsImpl,
  camera: Camera,
  sceneRoot: Object3D,
  viewport: { width: number; height: number },
  enableTransition: boolean,
) {
  const bounds = getPreviewSceneBounds(sceneRoot)

  if (bounds) {
    bounds.getCenter(topDownCenter)
    bounds.getSize(topDownSize)
  } else {
    topDownCenter.set(0, 0, 0)
    topDownSize.set(TOP_DOWN_MIN_EXTENT, 1, TOP_DOWN_MIN_EXTENT)
  }

  const fitWidth = Math.max(topDownSize.x, TOP_DOWN_MIN_EXTENT) * TOP_DOWN_PADDING
  const fitDepth = Math.max(topDownSize.z, TOP_DOWN_MIN_EXTENT) * TOP_DOWN_PADDING
  const zoom = Math.min(viewport.width / fitWidth, viewport.height / fitDepth)
  const maybeOrthographic = camera as Camera & {
    isOrthographicCamera?: boolean
    zoom?: number
    updateProjectionMatrix?: () => void
  }

  if (maybeOrthographic.isOrthographicCamera && typeof maybeOrthographic.zoom === 'number') {
    maybeOrthographic.zoom = clamp(zoom, TOP_DOWN_MIN_ZOOM, TOP_DOWN_MAX_ZOOM)
    maybeOrthographic.updateProjectionMatrix?.()
  }

  const maxExtent = Math.max(topDownSize.x, topDownSize.z, TOP_DOWN_MIN_EXTENT)
  const cameraY = Math.max(topDownCenter.y + TOP_DOWN_MIN_HEIGHT, topDownCenter.y + maxExtent * 1.4)

  controls.setLookAt(
    topDownCenter.x,
    cameraY,
    topDownCenter.z,
    topDownCenter.x,
    topDownCenter.y,
    topDownCenter.z,
    enableTransition,
  )
}

function ViewModeToggle({
  mode,
  onChange,
}: {
  mode: SceneViewMode
  onChange: (mode: SceneViewMode) => void
}) {
  return (
    <div className="absolute top-3 left-1/2 z-10 -translate-x-1/2">
      <div className="flex h-9 items-center rounded-full border border-slate-200 bg-white/90 p-1 shadow-lg backdrop-blur-md">
        {(['2d', '3d'] as const).map((option) => {
          const active = mode === option
          return (
            <button
              aria-label={`Switch to ${option.toUpperCase()} view`}
              aria-pressed={active}
              className={[
                'h-7 min-w-12 rounded-full px-3 font-bold text-xs transition-colors',
                active
                  ? 'bg-orange-400 text-white shadow-sm'
                  : 'text-slate-500 hover:bg-slate-100 hover:text-slate-800',
              ].join(' ')}
              key={option}
              onClick={() => onChange(option)}
              type="button"
            >
              {option.toUpperCase()}
            </button>
          )
        })}
      </div>
    </div>
  )
}

function SceneViewControls({ fitTrigger, mode }: { fitTrigger: number; mode: SceneViewMode }) {
  const sceneRoot = useThree((s) => s.scene)
  const camera = useThree((s) => s.camera)
  const viewport = useThree((s) => s.size)
  const invalidate = useThree((s) => s.invalidate)
  const controlsRef = useRef<CameraControlsImpl>(null)
  const lastFitTriggerRef = useRef(-1)
  const previousModeRef = useRef<SceneViewMode>(mode)
  const cameraModeBefore2DRef = useRef<CameraProjectionMode | null>(null)
  const orbitPoseBefore2DRef = useRef<{
    position: Vector3
    target: Vector3
  } | null>(null)

  const run3DFit = useCallback(
    (enableTransition: boolean) => {
      const controls = controlsRef.current
      if (!controls) return

      const box = new Box3().setFromObject(sceneRoot)
      if (!box.isEmpty()) {
        void controls.fitToBox(sceneRoot, enableTransition, {
          paddingTop: 1,
          paddingBottom: 1,
          paddingLeft: 1,
          paddingRight: 1,
        })
      }
    },
    [sceneRoot],
  )

  const runTopDownFit = useCallback(
    (enableTransition: boolean) => {
      const controls = controlsRef.current
      if (!controls) return
      frameTopDownView(controls, camera, sceneRoot, viewport, enableTransition)
      invalidate()
    },
    [camera, invalidate, sceneRoot, viewport],
  )

  useEffect(() => {
    const previousMode = previousModeRef.current
    const controls = controlsRef.current

    if (mode === '2d' && previousMode !== '2d' && controls) {
      controls.getPosition(restorePosition)
      controls.getTarget(restoreTarget)
      orbitPoseBefore2DRef.current = {
        position: restorePosition.clone(),
        target: restoreTarget.clone(),
      }
    }

    if (mode === '3d' && previousMode === '2d' && controls) {
      const pose = orbitPoseBefore2DRef.current
      orbitPoseBefore2DRef.current = null
      if (pose) {
        void controls.setLookAt(
          pose.position.x,
          pose.position.y,
          pose.position.z,
          pose.target.x,
          pose.target.y,
          pose.target.z,
          true,
        )
      } else {
        run3DFit(true)
      }
    }

    previousModeRef.current = mode
  }, [mode, run3DFit])

  useEffect(() => {
    const viewer = useViewer.getState()

    if (mode === '2d') {
      if (!cameraModeBefore2DRef.current) {
        cameraModeBefore2DRef.current = viewer.cameraMode
      }
      if (viewer.cameraMode !== 'orthographic') {
        viewer.setCameraMode('orthographic')
      }
      return
    }

    const restoreMode = cameraModeBefore2DRef.current
    if (restoreMode) {
      cameraModeBefore2DRef.current = null
      if (viewer.cameraMode !== restoreMode) {
        viewer.setCameraMode(restoreMode)
      }
    }
  }, [mode])

  useEffect(() => {
    return () => {
      const restoreMode = cameraModeBefore2DRef.current
      if (restoreMode) {
        useViewer.getState().setCameraMode(restoreMode)
      }
    }
  }, [])

  useEffect(() => {
    if (fitTrigger === lastFitTriggerRef.current) return
    lastFitTriggerRef.current = fitTrigger

    let cancelled = false
    let id1 = 0
    const id0 = requestAnimationFrame(() => {
      if (cancelled) return
      id1 = requestAnimationFrame(() => {
        if (cancelled) return
        if (mode === '2d') runTopDownFit(true)
        else run3DFit(true)
      })
    })

    return () => {
      cancelled = true
      cancelAnimationFrame(id0)
      cancelAnimationFrame(id1)
    }
  }, [fitTrigger, mode, run3DFit, runTopDownFit])

  useEffect(() => {
    if (mode !== '2d') return

    let cancelled = false
    const id = requestAnimationFrame(() => {
      if (!cancelled) runTopDownFit(true)
    })

    return () => {
      cancelled = true
      cancelAnimationFrame(id)
    }
  }, [mode, runTopDownFit])

  const topDownMouseButtons =
    mode === '2d'
      ? {
          left: CameraControlsImpl.ACTION.TRUCK,
          middle: CameraControlsImpl.ACTION.TRUCK,
          right: CameraControlsImpl.ACTION.NONE,
          wheel: CameraControlsImpl.ACTION.ZOOM,
        }
      : undefined
  const topDownTouches =
    mode === '2d'
      ? {
          one: CameraControlsImpl.ACTION.TOUCH_TRUCK,
          two: CameraControlsImpl.ACTION.TOUCH_ZOOM_TRUCK,
          three: CameraControlsImpl.ACTION.NONE,
        }
      : undefined
  const lockedPolarProps = mode === '2d' ? { minPolarAngle: 0, maxPolarAngle: 0 } : {}

  return (
    <CameraControls
      makeDefault
      mouseButtons={topDownMouseButtons}
      ref={controlsRef}
      touches={topDownTouches}
      {...lockedPolarProps}
    />
  )
}

function LevelFocus() {
  const levelId = useViewer((s) => s.selection.levelId)
  const controls = useThree((s) => s.controls) as CameraControlsImpl | null
  const target = useRef(new Vector3())
  const seededRef = useRef(false)

  useEffect(() => {
    if (!controls) return
    if (!seededRef.current) {
      seededRef.current = true
      return
    }
    if (!levelId) return
    const levelMesh = sceneRegistry.nodes.get(levelId)
    if (!levelMesh) return
    controls.getTarget(target.current)
    controls.moveTo(target.current.x, levelMesh.position.y, target.current.z, true)
  }, [levelId, controls])

  return null
}

function PlacementGrid() {
  const gridSnapStep = useEditor((s) => s.gridSnapStep)
  return <Grid cellColor="#aaa" cellSize={gridSnapStep} fadeDistance={500} sectionColor="#ccc" />
}

function PlacementTools() {
  const pendingImportPlacement = useEditor((s) => s.pendingImportPlacement)
  const buildingId = useViewer((s) => s.selection.buildingId)
  const nodes = useScene((s) => s.nodes)

  useEffect(() => {
    if (!pendingImportPlacement) return

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        emitter.emit('tool:cancel')
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [pendingImportPlacement])

  if (!pendingImportPlacement) return null

  const building = buildingId
    ? (nodes[buildingId as AnyNodeId] as BuildingNode | undefined)
    : undefined
  const buildingPosition = building?.position ?? [0, 0, 0]
  const buildingRotation = building?.rotation ?? [0, 0, 0]

  return (
    <>
      <PlacementGrid />
      {(pendingImportPlacement.kind === 'ifc-scene' ||
        (pendingImportPlacement.kind === 'move-existing' &&
          pendingImportPlacement.space === 'world')) && (
        <ImportPlacementTool coordinateSpace="world" placement={pendingImportPlacement} />
      )}
      <group
        position={buildingPosition as [number, number, number]}
        rotation={buildingRotation as [number, number, number]}
      >
        {pendingImportPlacement.kind === 'model' && (
          <ImportPlacementTool coordinateSpace="building" placement={pendingImportPlacement} />
        )}
        {pendingImportPlacement.kind === 'catalog-item' && (
          <ImportPlacementTool coordinateSpace="building" placement={pendingImportPlacement} />
        )}
        {pendingImportPlacement.kind === 'catalog-build' && (
          <ImportPlacementTool coordinateSpace="building" placement={pendingImportPlacement} />
        )}
        {pendingImportPlacement.kind === 'move-existing' &&
          pendingImportPlacement.space === 'building' && (
            <ImportPlacementTool coordinateSpace="building" placement={pendingImportPlacement} />
          )}
      </group>
    </>
  )
}

function isAdditiveSelectionEvent(event: NodeEvent) {
  const native = event.nativeEvent as unknown as {
    ctrlKey?: boolean
    metaKey?: boolean
    nativeEvent?: {
      ctrlKey?: boolean
      metaKey?: boolean
    }
  }
  return Boolean(
    native.ctrlKey || native.metaKey || native.nativeEvent?.ctrlKey || native.nativeEvent?.metaKey,
  )
}

function getAiSelectableNode(node: AnyNode): AnyNode | null {
  if (node.type === 'roof-segment' && node.parentId) {
    const parent = useScene.getState().nodes[node.parentId as AnyNodeId]
    if (parent?.type === 'roof') return parent
  }
  if (node.type === 'scan') {
    const metadata = node.metadata as
      | {
          importedModel?: { source?: unknown }
          ifcProduct?: { ifcType?: unknown }
        }
      | undefined
    const importedSource = metadata?.importedModel?.source
    const ifcType = metadata?.ifcProduct?.ifcType

    if (importedSource === 'ifc-roof-layer-pipeline' || ifcType === 'IFCROOF') {
      return node
    }

    if (importedSource === 'ifc-visual-pipeline') {
      let current = node.parentId ? useScene.getState().nodes[node.parentId as AnyNodeId] : null
      while (current) {
        if (current.type === 'building') return current
        current = current.parentId ? useScene.getState().nodes[current.parentId as AnyNodeId] : null
      }
    }
  }
  return AI_SELECTABLE_NODE_TYPE_SET.has(node.type) ? node : null
}

function computeAiSelection(nodeId: AnyNodeId, selectedIds: AnyNodeId[], additive: boolean) {
  if (!additive) return [nodeId]
  if (selectedIds.includes(nodeId)) return selectedIds.filter((id) => id !== nodeId)
  return [...selectedIds, nodeId]
}

function AiSceneSelectionManager() {
  const gl = useThree((s) => s.gl)
  const selection = useViewer((s) => s.selection)
  const hoveredId = useViewer((s) => s.hoveredId)
  const outliner = useViewer((s) => s.outliner)
  const clickHandledRef = useRef(false)

  useEffect(() => {
    const handleEnter = (event: NodeEvent) => {
      if (useEditor.getState().pendingImportPlacement) return
      const node = getAiSelectableNode(event.node)
      if (!node) return
      event.stopPropagation()
      useViewer.setState({ hoveredId: node.id })
    }

    const handleLeave = (event: NodeEvent) => {
      if (useEditor.getState().pendingImportPlacement) return
      const node = getAiSelectableNode(event.node)
      if (!node) return
      event.stopPropagation()
      useViewer.setState({ hoveredId: null })
    }

    const handleClick = (event: NodeEvent) => {
      if (useEditor.getState().pendingImportPlacement) return
      const node = getAiSelectableNode(event.node)
      if (!node) return

      event.stopPropagation()
      clickHandledRef.current = true

      const selectedIds = useViewer.getState().selection.selectedIds as AnyNodeId[]
      useEditor.getState().setSelectedReferenceId(null)
      useViewer.getState().setSelection({
        selectedIds: computeAiSelection(
          node.id as AnyNodeId,
          selectedIds,
          isAdditiveSelectionEvent(event),
        ),
        zoneId: null,
      })
      useViewer.setState({ hoveredId: null })
    }

    for (const type of AI_SELECTABLE_NODE_TYPES) {
      emitter.on(`${type}:enter` as never, handleEnter as never)
      emitter.on(`${type}:leave` as never, handleLeave as never)
      emitter.on(`${type}:click` as never, handleClick as never)
    }

    return () => {
      for (const type of AI_SELECTABLE_NODE_TYPES) {
        emitter.off(`${type}:enter` as never, handleEnter as never)
        emitter.off(`${type}:leave` as never, handleLeave as never)
        emitter.off(`${type}:click` as never, handleClick as never)
      }
    }
  }, [])

  useEffect(() => {
    const handleCanvasClick = (event: MouseEvent) => {
      if (useEditor.getState().pendingImportPlacement) return
      if (useViewer.getState().cameraDragging || useViewer.getState().inputDragging) return
      if (event.button !== 0) return

      requestAnimationFrame(() => {
        if (clickHandledRef.current) {
          clickHandledRef.current = false
          return
        }

        useViewer.getState().setSelection({ selectedIds: [], zoneId: null })
        useEditor.getState().setSelectedReferenceId(null)
        useViewer.setState({ hoveredId: null })
      })
    }

    gl.domElement.addEventListener('click', handleCanvasClick)
    return () => {
      gl.domElement.removeEventListener('click', handleCanvasClick)
    }
  }, [gl])

  useEffect(() => {
    outliner.selectedObjects.length = 0
    for (const id of selection.selectedIds) {
      const obj = sceneRegistry.nodes.get(id as AnyNodeId)
      if (obj) outliner.selectedObjects.push(obj)
    }

    outliner.hoveredObjects.length = 0
    if (hoveredId) {
      const obj = sceneRegistry.nodes.get(hoveredId as AnyNodeId)
      if (obj) outliner.hoveredObjects.push(obj)
    }
  }, [hoveredId, outliner, selection.selectedIds])

  return null
}

export default function ViewerPreview({
  onSceneGraphChange,
  onSelectNode,
  sceneGraph,
}: {
  onSceneGraphChange?: (graph: SceneGraph) => void
  onSelectNode?: (nodeId: string | null) => void
  sceneGraph: SceneGraph | null
}) {
  const setScene = useScene((s) => s.setScene)
  const setSelection = useViewer((s) => s.setSelection)
  const [fitTrigger, setFitTrigger] = useState(0)
  const [viewMode, setViewMode] = useState<SceneViewMode>('3d')
  const emittedSceneGraphRef = useRef<SceneGraph | null>(null)
  const lastSceneRefs = useRef({
    nodes: useScene.getState().nodes,
    rootNodeIds: useScene.getState().rootNodeIds,
  })

  useEffect(() => {
    return useScene.subscribe((state) => {
      if (
        state.nodes === lastSceneRefs.current.nodes &&
        state.rootNodeIds === lastSceneRefs.current.rootNodeIds
      ) {
        return
      }

      const nextGraph = {
        nodes: state.nodes as unknown as SceneGraph['nodes'],
        rootNodeIds: state.rootNodeIds as unknown as SceneGraph['rootNodeIds'],
      }
      lastSceneRefs.current = {
        nodes: state.nodes,
        rootNodeIds: state.rootNodeIds,
      }
      emittedSceneGraphRef.current = nextGraph
      onSceneGraphChange?.(nextGraph)
    })
  }, [onSceneGraphChange])

  useEffect(() => {
    if (sceneGraph === emittedSceneGraphRef.current) return

    if (!sceneGraph) {
      setScene({}, [])
      setSelection({
        buildingId: null,
        levelId: null,
        zoneId: null,
        selectedIds: [],
      })
      setFitTrigger((n) => n + 1)
      return
    }

    setScene(sceneGraph.nodes as Record<AnyNodeId, AnyNode>, sceneGraph.rootNodeIds as AnyNodeId[])
    const allNodes = Object.values(sceneGraph.nodes) as AnyNode[]
    const firstBuilding = allNodes.find((n) => n.type === 'building')
    const firstLevel = allNodes.find((n) => n.type === 'level')
    setSelection({
      buildingId: (firstBuilding?.id ?? null) as never,
      levelId: (firstLevel?.id ?? null) as never,
      zoneId: null,
      selectedIds: [],
    })
    setFitTrigger((n) => n + 1)
  }, [sceneGraph, setScene, setSelection])

  const selectedIds = useViewer((s) => s.selection.selectedIds)
  const zoneId = useViewer((s) => s.selection.zoneId)
  useEffect(() => {
    onSelectNode?.((selectedIds[0] as string | undefined) ?? zoneId ?? null)
  }, [selectedIds, zoneId, onSelectNode])

  const onFit = useCallback(() => setFitTrigger((n) => n + 1), [])

  return (
    <div className="relative h-full w-full overflow-hidden bg-[#f8fafc]" data-testid="ai-3d-viewer">
      <ViewModeToggle mode={viewMode} onChange={setViewMode} />
      <button
        className="absolute top-3 right-3 z-10 flex h-9 items-center gap-2 rounded-md border border-slate-200 bg-white/90 px-3 font-semibold text-slate-700 text-xs shadow-lg backdrop-blur-md transition-colors hover:bg-white"
        onClick={onFit}
        type="button"
      >
        <Maximize className="h-4 w-4" />
        Fit
      </button>
      <Viewer
        defaultRender={{ shading: 'solid' }}
        renderContext="viewer"
        selectionManager="custom"
      >
        <ExportManager />
        <PlacementTools />
        <AiSceneSelectionManager />
        <SceneViewControls fitTrigger={fitTrigger} mode={viewMode} />
        <LevelFocus />
      </Viewer>
    </div>
  )
}
