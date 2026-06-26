import {
  type AnyNode,
  type AnyNodeId,
  emitter,
  saveAsset,
  useScene,
  validateBuildJson,
} from '@pascal-app/core'
import { useViewer } from '@pascal-app/viewer'
import { TreeView, VisualJson } from '@visual-json/react'
import { Camera, Download, Save, Trash2, Upload } from 'lucide-react'
import {
  type KeyboardEvent,
  type SyntheticEvent,
  useCallback,
  useMemo,
  useRef,
  useState,
} from 'react'
import { Button } from './../../../../../components/ui/primitives/button'
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from './../../../../../components/ui/primitives/dialog'
import { Switch } from './../../../../../components/ui/primitives/switch'
import useEditor, {
  type ImportedModelFormat,
  selectDefaultBuildingAndLevel,
} from './../../../../../store/use-editor'
import { AudioSettingsDialog } from './audio-settings-dialog'
import { KeyboardShortcutsDialog } from './keyboard-shortcuts-dialog'
import { LoadBuildDialog, type PendingImport } from './load-build-dialog'

type SceneNode = Record<string, unknown> & {
  id?: unknown
  type?: unknown
  name?: unknown
  parentId?: unknown
  children?: unknown
}

type SceneGraphNode = {
  id: string
  type: string
  name: string | null
  parentId: string | null
  children: SceneGraphNode[]
  missing?: true
  cycle?: true
}

type SceneGraphValue = {
  roots: SceneGraphNode[]
  detachedNodes?: SceneGraphNode[]
}

type Importable3DFormat = ImportedModelFormat | 'ifc'

type ImportableSceneGraph = {
  nodes: Record<string, unknown>
  rootNodeIds: string[]
}

const MODEL_IMPORT_EXTENSIONS: Record<string, Importable3DFormat> = {
  glb: 'glb',
  gltf: 'gltf',
  stl: 'stl',
  obj: 'obj',
  ifc: 'ifc',
}

const MODEL_IMPORT_ACCEPT = '.ifc,.glb,.gltf,.stl,.obj'
const MAX_MODEL_IMPORT_SIZE = 250 * 1024 * 1024

function getFileExtension(fileName: string) {
  return fileName.split('.').pop()?.toLowerCase() ?? ''
}

function detectImportable3DFormat(fileName: string): Importable3DFormat | null {
  return MODEL_IMPORT_EXTENSIONS[getFileExtension(fileName)] ?? null
}

function getImportDisplayName(fileName: string) {
  const trimmed = fileName.trim()
  const dotIndex = trimmed.lastIndexOf('.')
  return dotIndex > 0 ? trimmed.slice(0, dotIndex) : trimmed || 'Imported model'
}

const isSceneNode = (value: unknown): value is SceneNode => {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    typeof (value as { id: unknown }).id === 'string'
  )
}

const getChildIdsFromNode = (node: SceneNode): string[] => {
  if (!Array.isArray(node.children)) {
    return []
  }

  const childIds = new Set<string>()

  for (const child of node.children) {
    if (typeof child === 'string') {
      childIds.add(child)
      continue
    }

    if (isSceneNode(child)) {
      childIds.add(child.id as string)
    }
  }

  return Array.from(childIds)
}

const buildSceneGraphValue = (
  nodes: Record<string, SceneNode>,
  rootNodeIds: string[],
): SceneGraphValue => {
  const childIdsByParent = new Map<string, Set<string>>()

  for (const [id, node] of Object.entries(nodes)) {
    const childIds = getChildIdsFromNode(node)
    if (childIds.length > 0) {
      childIdsByParent.set(id, new Set(childIds))
    }
  }

  for (const [id, node] of Object.entries(nodes)) {
    if (typeof node.parentId !== 'string') {
      continue
    }

    const siblings = childIdsByParent.get(node.parentId) ?? new Set<string>()
    siblings.add(id)
    childIdsByParent.set(node.parentId, siblings)
  }

  const visited = new Set<string>()

  const buildNode = (id: string, path: Set<string>): SceneGraphNode => {
    const node = nodes[id]
    if (!node) {
      return {
        id,
        type: 'missing',
        name: null,
        parentId: null,
        missing: true,
        children: [],
      }
    }

    const nodeType = typeof node.type === 'string' ? node.type : 'unknown'
    const nodeName = typeof node.name === 'string' ? node.name : null
    const parentId = typeof node.parentId === 'string' ? node.parentId : null

    if (path.has(id)) {
      return {
        id,
        type: nodeType,
        name: nodeName,
        parentId,
        cycle: true,
        children: [],
      }
    }

    visited.add(id)
    const nextPath = new Set(path)
    nextPath.add(id)

    const childIds = Array.from(childIdsByParent.get(id) ?? [])
    return {
      id,
      type: nodeType,
      name: nodeName,
      parentId,
      children: childIds.map((childId) => buildNode(childId, nextPath)),
    }
  }

  const roots = rootNodeIds.map((id) => buildNode(id, new Set()))
  const detachedNodeIds = Object.keys(nodes).filter((id) => !visited.has(id))

  if (detachedNodeIds.length === 0) {
    return { roots }
  }

  return {
    roots,
    detachedNodes: detachedNodeIds.map((id) => buildNode(id, new Set())),
  }
}

export interface ProjectVisibility {
  isPrivate: boolean
  showScansPublic: boolean
  showGuidesPublic: boolean
}

export interface SettingsPanelProps {
  projectId?: string
  projectVisibility?: ProjectVisibility
  onImportIfcFile?: (file: File) => Promise<ImportableSceneGraph>
  onVisibilityChange?: (
    field: 'isPrivate' | 'showScansPublic' | 'showGuidesPublic',
    value: boolean,
  ) => Promise<void>
}

export function SettingsPanel({
  onImportIfcFile,
  projectId,
  projectVisibility,
  onVisibilityChange,
}: SettingsPanelProps = {}) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const modelInputRef = useRef<HTMLInputElement>(null)
  const nodes = useScene((state) => state.nodes)
  const rootNodeIds = useScene((state) => state.rootNodeIds)
  const setScene = useScene((state) => state.setScene)
  const clearScene = useScene((state) => state.clearScene)
  const resetSelection = useViewer((state) => state.resetSelection)
  const exportScene = useViewer((state) => state.exportScene)
  const showGrid = useViewer((state) => state.showGrid)
  const shadows = useViewer((state) => state.shadows)
  const setShowGrid = useViewer((state) => state.setShowGrid)
  const setShowScans = useViewer((state) => state.setShowScans)
  const setSelection = useViewer((state) => state.setSelection)
  const setPhase = useEditor((state) => state.setPhase)
  const setMode = useEditor((state) => state.setMode)
  const pendingImportPlacement = useEditor((state) => state.pendingImportPlacement)
  const setPendingImportPlacement = useEditor((state) => state.setPendingImportPlacement)
  const [isGeneratingThumbnail, setIsGeneratingThumbnail] = useState(false)
  const [isPreparingModelImport, setIsPreparingModelImport] = useState(false)
  const [modelImportError, setModelImportError] = useState<string | null>(null)
  const [pendingImport, setPendingImport] = useState<PendingImport | null>(null)
  const sceneGraphValue = useMemo(
    () => buildSceneGraphValue(nodes as Record<string, SceneNode>, rootNodeIds),
    [nodes, rootNodeIds],
  )
  const blockSceneGraphMutations = useCallback((event: SyntheticEvent) => {
    event.preventDefault()
    event.stopPropagation()
  }, [])
  const blockSceneGraphDeletion = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault()
      event.stopPropagation()
    }
  }, [])

  const isLocalProject = false // Props-based; only show cloud sections when projectId provided

  const handleSaveBuild = () => {
    const sceneData = { nodes, rootNodeIds }
    const json = JSON.stringify(sceneData, null, 2)
    const blob = new Blob([json], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    const date = new Date().toISOString().split('T')[0]
    link.download = `layout_${date}.json`
    link.click()
    URL.revokeObjectURL(url)
  }

  const handleFileLoad = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    const reader = new FileReader()
    reader.onload = (event) => {
      const text = event.target?.result as string
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        setPendingImport({
          fileName: file.name,
          fileSizeBytes: file.size,
          result: {
            ok: false,
            parsed: null,
            stats: { total: 0, byType: {}, unknownTypes: {}, floorAreaM2: 0 },
            errors: [
              {
                severity: 'error',
                code: 'invalid_json',
                message: 'File could not be parsed as JSON.',
              },
            ],
            warnings: [],
            schemaIssues: [],
            schemaIssueCount: 0,
          },
        })
        return
      }
      setPendingImport({
        fileName: file.name,
        fileSizeBytes: file.size,
        result: validateBuildJson(parsed),
      })
    }
    reader.readAsText(file)

    // Reset input so the same file can be loaded again
    e.target.value = ''
  }

  const handleConfirmImport = (parsed: {
    nodes: Record<string, unknown>
    rootNodeIds: string[]
    collections?: Record<string, unknown>
    materials?: Record<string, unknown>
  }) => {
    setScene(
      parsed.nodes as Parameters<typeof setScene>[0],
      parsed.rootNodeIds as Parameters<typeof setScene>[1],
      {
        collections: parsed.collections as any,
        materials: parsed.materials as any,
      },
    )
    resetSelection()
    setPhase('site')
    setPendingImport(null)
  }

  const handleModelImportLoad = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return

    const format = detectImportable3DFormat(file.name)
    if (!format) {
      setModelImportError('Choose an IFC, GLB, GLTF, STL, or OBJ file.')
      return
    }

    if (file.size > MAX_MODEL_IMPORT_SIZE) {
      setModelImportError(
        `File is too large (${(file.size / 1024 / 1024).toFixed(0)} MB). Maximum size is 250 MB.`,
      )
      return
    }

    setIsPreparingModelImport(true)
    setModelImportError(null)
    setPendingImportPlacement(null)

    try {
      setPhase('structure')
      setMode('select')
      setShowGrid(true)
      setSelection({ selectedIds: [], zoneId: null })

      if (format === 'ifc') {
        if (!onImportIfcFile) {
          throw new Error('IFC import is not configured in this app.')
        }

        const graph = await onImportIfcFile(file)
        const result = validateBuildJson(graph)
        if (!(result.ok && result.parsed)) {
          throw new Error(result.errors[0]?.message ?? 'IFC conversion produced an invalid scene.')
        }

        setPendingImportPlacement({
          kind: 'ifc-scene',
          name: getImportDisplayName(file.name),
          nodes: result.parsed.nodes as Record<AnyNodeId, AnyNode>,
          rootNodeIds: result.parsed.rootNodeIds as AnyNodeId[],
          snapToGrid: true,
        })
        return
      }

      selectDefaultBuildingAndLevel()
      const levelId = useViewer.getState().selection.levelId
      if (!levelId) {
        throw new Error('No active level found for model import.')
      }

      const assetUrl = await saveAsset(file)
      setShowScans(true)
      setPendingImportPlacement({
        kind: 'model',
        name: getImportDisplayName(file.name),
        url: assetUrl,
        format,
        levelId,
        snapToGrid: true,
      })
    } catch (error) {
      setModelImportError(error instanceof Error ? error.message : 'Could not prepare that import.')
    } finally {
      setIsPreparingModelImport(false)
    }
  }

  const handleResetToDefault = () => {
    clearScene()
    resetSelection()
    setPhase('structure')
    selectDefaultBuildingAndLevel()
  }

  const handleGenerateThumbnail = () => {
    if (!projectId) return
    setIsGeneratingThumbnail(true)
    emitter.emit('camera-controls:generate-thumbnail', { projectId })
    setTimeout(() => setIsGeneratingThumbnail(false), 3000)
  }

  const handleVisibilityChange = async (
    field: 'isPrivate' | 'showScansPublic' | 'showGuidesPublic',
    value: boolean,
  ) => {
    await onVisibilityChange?.(field, value)
  }

  return (
    <div className="flex flex-col gap-6 p-3">
      {/* Visibility Section (only for cloud projects) */}
      {projectId && !isLocalProject && (
        <div className="space-y-3">
          <label className="font-medium text-muted-foreground text-xs uppercase">Visibility</label>
          <div className="flex items-center justify-between">
            <div>
              <div className="font-medium text-sm">Public</div>
              <div className="text-muted-foreground text-xs">
                {projectVisibility?.isPrivate ? 'Only you' : 'Anyone'} can view
              </div>
            </div>
            <Switch
              checked={!(projectVisibility?.isPrivate ?? false)}
              onCheckedChange={(checked) => handleVisibilityChange('isPrivate', !checked)}
            />
          </div>
          <div className="flex items-center justify-between">
            <div>
              <div className="font-medium text-sm">Show 3D Scans</div>
              <div className="text-muted-foreground text-xs">Visible to public viewers</div>
            </div>
            <Switch
              checked={projectVisibility?.showScansPublic ?? true}
              onCheckedChange={(checked) => handleVisibilityChange('showScansPublic', checked)}
            />
          </div>
          <div className="flex items-center justify-between">
            <div>
              <div className="font-medium text-sm">Show Floorplans</div>
              <div className="text-muted-foreground text-xs">Visible to public viewers</div>
            </div>
            <Switch
              checked={projectVisibility?.showGuidesPublic ?? true}
              onCheckedChange={(checked) => handleVisibilityChange('showGuidesPublic', checked)}
            />
          </div>
          <div className="flex items-center justify-between">
            <div>
              <div className="font-medium text-sm">Show Grid</div>
              <div className="text-muted-foreground text-xs">Visible only in the editor</div>
            </div>
            <Switch
              checked={showGrid}
              onCheckedChange={(checked) => useViewer.getState().setShowGrid(checked)}
            />
          </div>
          <div className="flex items-center justify-between">
            <div>
              <div className="font-medium text-sm">Shadows</div>
              <div className="text-muted-foreground text-xs">Cast shadows from lights</div>
            </div>
            <Switch
              checked={shadows}
              onCheckedChange={(checked) => useViewer.getState().setShadows(checked)}
            />
          </div>
        </div>
      )}

      {/* Export Section */}
      <div className="space-y-2">
        <label className="font-medium text-muted-foreground text-xs uppercase">Export</label>
        <Button
          className="w-full justify-start gap-2"
          onClick={() => exportScene?.('glb')}
          variant="outline"
        >
          <Download className="size-4" />
          Export GLB
        </Button>
        <Button
          className="w-full justify-start gap-2"
          onClick={() => exportScene?.('stl')}
          variant="outline"
        >
          <Download className="size-4" />
          Export STL
        </Button>
        <Button
          className="w-full justify-start gap-2"
          onClick={() => exportScene?.('obj')}
          variant="outline"
        >
          <Download className="size-4" />
          Export OBJ
        </Button>
      </div>

      {/* Thumbnail Section (only for cloud projects) */}
      {projectId && !isLocalProject && (
        <div className="space-y-2">
          <label className="font-medium text-muted-foreground text-xs uppercase">Thumbnail</label>
          <Button
            className="w-full justify-start gap-2"
            disabled={isGeneratingThumbnail}
            onClick={handleGenerateThumbnail}
            variant="outline"
          >
            <Camera className="size-4" />
            {isGeneratingThumbnail ? 'Generating...' : 'Generate Thumbnail'}
          </Button>
        </div>
      )}

      {/* Save/Load Section */}
      <div className="space-y-2">
        <label className="font-medium text-muted-foreground text-xs uppercase">Save & Load</label>

        <Button className="w-full justify-start gap-2" onClick={handleSaveBuild} variant="outline">
          <Save className="size-4" />
          Save Build
        </Button>

        <Button
          className="w-full justify-start gap-2"
          onClick={() => fileInputRef.current?.click()}
          variant="outline"
        >
          <Upload className="size-4" />
          Load Build
        </Button>

        <input
          accept="application/json"
          className="hidden"
          onChange={handleFileLoad}
          ref={fileInputRef}
          type="file"
        />

        <Button
          className="w-full justify-start gap-2"
          disabled={isPreparingModelImport}
          onClick={() => modelInputRef.current?.click()}
          variant="outline"
        >
          <Upload className="size-4" />
          {isPreparingModelImport ? 'Preparing Import...' : 'Import IFC / 3D Model'}
        </Button>

        <input
          accept={MODEL_IMPORT_ACCEPT}
          className="hidden"
          onChange={handleModelImportLoad}
          ref={modelInputRef}
          type="file"
        />

        {pendingImportPlacement && (
          <div className="rounded-md border border-border/60 bg-muted/40 px-2 py-1.5 text-muted-foreground text-xs">
            Ready: {pendingImportPlacement.name}
          </div>
        )}

        {modelImportError && (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 px-2 py-1.5 text-destructive text-xs">
            {modelImportError}
          </div>
        )}

        <LoadBuildDialog
          onCancel={() => setPendingImport(null)}
          onConfirm={handleConfirmImport}
          pending={pendingImport}
        />
      </div>

      {/* Audio Section */}
      <div className="space-y-2">
        <label className="font-medium text-muted-foreground text-xs uppercase">Audio</label>
        <AudioSettingsDialog />
      </div>

      {/* Keyboard Section */}
      <div className="space-y-2">
        <label className="font-medium text-muted-foreground text-xs uppercase">Keyboard</label>
        <KeyboardShortcutsDialog />
      </div>

      {/* Scene Graph */}
      <div className="space-y-1">
        <label className="font-medium text-muted-foreground text-xs uppercase">Scene Graph</label>
        <Dialog>
          <DialogTrigger asChild>
            <Button className="h-auto justify-start p-0 text-sm" variant="link">
              Explore scene graph
            </Button>
          </DialogTrigger>
          <DialogContent className="h-[80vh] max-w-[95vw] gap-0 overflow-hidden border-0 bg-[#1e1e1e] p-0 shadow-none sm:max-w-5xl">
            <DialogTitle className="sr-only">Scene Graph</DialogTitle>
            <div
              className="flex h-full min-h-0 w-full min-w-0 *:h-full *:w-full *:overflow-y-auto"
              onContextMenuCapture={blockSceneGraphMutations}
              onDragStartCapture={blockSceneGraphMutations}
              onDropCapture={blockSceneGraphMutations}
              onKeyDownCapture={blockSceneGraphDeletion}
            >
              <VisualJson value={sceneGraphValue}>
                <TreeView showCounts />
              </VisualJson>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      {/* Danger Zone */}
      <div className="space-y-2">
        <label className="font-medium text-destructive text-xs uppercase">Danger Zone</label>

        <Button
          className="w-full justify-start gap-2"
          onClick={handleResetToDefault}
          variant="destructive"
        >
          <Trash2 className="size-4" />
          Clear & Start New
        </Button>
      </div>
    </div>
  )
}
