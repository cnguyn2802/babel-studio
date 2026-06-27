'use client'

import {
  type AnyNode,
  type AnyNodeId,
  type AssetInput,
  generateId,
  ScanNode,
  saveAsset,
  sceneRegistry,
  useScene,
  validateBuildJson,
} from '@pascal-app/core'
import type { SceneGraph } from '@pascal-app/core/clone-scene-graph'
import {
  type ImportedModelFormat,
  selectDefaultBuildingAndLevel,
  useEditor,
} from '@pascal-app/editor'
import { Canvas, useThree } from '@react-three/fiber'
import { useGLTFKTX2, useViewer } from '@pascal-app/viewer'
import {
  Box,
  Building2,
  BedDouble,
  ChevronRight,
  CircleDot,
  Download,
  Eye,
  EyeOff,
  FileUp,
  Home,
  Layers,
  Loader2,
  type LucideIcon,
  MessageSquare,
  MousePointer2,
  Move,
  Package,
  RotateCcw,
  RotateCw,
  Search,
  Send,
  Sofa,
  Sparkles,
  Trash2,
  UploadCloud,
  Wand2,
  Workflow,
  X,
} from 'lucide-react'
import dynamic from 'next/dynamic'
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Box3, type Object3D, Vector3 } from 'three'
import { createIfcVisualImportWithRoofLayer } from './ifc-visual-import'

const ScenePreview = dynamic(() => import('./viewer-preview'), { ssr: false })

type ActiveTool = 'hierarchy' | 'ai' | 'ifc' | 'placement' | 'model'
type ExportFormat = 'glb' | 'stl' | 'obj'
type ModelFormat = ImportedModelFormat
type ExportSceneFn = (format?: ExportFormat) => Promise<void>
type AiStatus = 'idle' | 'generating' | 'ready' | 'error'
type IfcStatus = 'idle' | 'loading' | 'converting' | 'ready' | 'error'
type PlacementCategoryId = 'furniture' | 'interior' | 'outdoor' | 'appliances'

type BusyOverlay = {
  title: string
  detail?: string
  progress?: number
} | null

type Ai3DResponse = {
  message: string
  title?: string
  steps?: number
  reads?: number
  changes?: number
  graph?: SceneGraph
  actions?: Array<{ tool: string; result: unknown }>
  error?: string
}

type AiChatRole = 'user' | 'assistant'

type AiChatMessage = {
  id: string
  role: AiChatRole
  content: string
  title?: string
  stats?: { steps: number; reads: number; changes: number }
  variant?: 'error'
}

type AiProviderId = 'openai' | 'qwen' | 'ollama' | 'abacus'

type AiModelOption = {
  provider: AiProviderId
  model: string
  label: string
  configured: boolean
  configurationError: string | null
}

type AiModelInfo = {
  requestedProvider: string
  provider: AiProviderId | null
  model: string
  label: string
  configured: boolean
  configurationError: string | null
  options?: AiModelOption[]
}

type ConverterMetadata = {
  ifcType?: string
  expressID?: number
  globalId?: string
  levelId?: string
  elevation?: number
  material?: string
  materialLayers?: { name: string; thickness?: number }[]
  typeName?: string
  properties?: Record<string, Record<string, string | number | boolean>>
  [key: string]: unknown
}

type IfcVisualImportMetadata = {
  fileName: string
  fileSize: number
  meshCount?: number
  productCount: number
  skippedAuxiliaryCount?: number
  skippedInteriorCount?: number
  triangleCount: number
  typeCounts: Record<string, number>
  mode?: 'single-visual' | 'roof-layered-visual'
}

type IfcProductMetadata = {
  expressID: number
  ifcType: string
  globalId?: string
  levelExpressID?: number
  levelName?: string
  triangleCount: number
}

type ImportedModelAsset = {
  name: string
  url: string
  format: ModelFormat
  size: number
}

type PlanPoint = [number, number]

type LocalPlacementItemBase = {
  id: string
  name: string
  category: PlacementCategoryId
  dimensions: [number, number, number]
  thumbnailPath?: string
  tags?: string[]
}

type LocalAssetPlacementItem = LocalPlacementItemBase & {
  placementKind?: 'asset'
  modelPath?: string
  surfaceHeight?: number
}

type LocalBuildPlacementItem = LocalPlacementItemBase & {
  placementKind: 'wall' | 'fence' | 'slab' | 'ceiling' | 'roof'
}

type LocalPlacementItem = LocalAssetPlacementItem | LocalBuildPlacementItem

const EXAMPLES = [
  'Create a compact living room',
  'Design a backyard garden',
  'Generate a deck with pergola',
  'Add a door and window',
] as const

const STARTER_TEMPLATES: Array<{
  id: string
  title: string
  prompt: string
  icon: LucideIcon
  iconClass: string
  shellClass: string
}> = [
  {
    id: 'living-room',
    title: 'Living room',
    prompt:
      'Use starter template living-room. Create a cozy living room with local assetIds: sofa, coffee-table, livingroom-chair, television, tv-stand, rectangular-carpet, floor-lamp, indoor-plant.',
    icon: Sofa,
    iconClass: 'bg-orange-50 text-orange-600',
    shellClass: 'hover:border-orange-200 hover:bg-orange-50/45',
  },
  {
    id: 'bed-room',
    title: 'Bed room',
    prompt:
      'Use starter template bed-room. Create a calm bedroom with local assetIds: double-bed, bedside-table, table-lamp, dresser, closet, rectangular-carpet.',
    icon: BedDouble,
    iconClass: 'bg-blue-50 text-blue-600',
    shellClass: 'hover:border-blue-200 hover:bg-blue-50/55',
  },
  {
    id: 'deck-pergola',
    title: 'Deck pergola',
    prompt:
      'Use starter template deck-pergola. Create an outdoor living deck with local assetIds: deck-082523, pergola-3.',
    icon: Package,
    iconClass: 'bg-emerald-50 text-emerald-600',
    shellClass: 'hover:border-emerald-200 hover:bg-emerald-50/50',
  },
  {
    id: 'garden',
    title: 'Garden',
    prompt: 'Use starter template garden. Create an outdoor garden layout.',
    icon: CircleDot,
    iconClass: 'bg-lime-50 text-lime-700',
    shellClass: 'hover:border-lime-200 hover:bg-lime-50/50',
  },
]

const AI_HISTORY_LIMIT = 16

const AI_THINKING_UPDATES = [
  'Reading your request...',
  'Checking the current scene...',
  'Choosing the next edit...',
  'Applying the response...',
  'Polishing the result...',
] as const

const AI_MODEL_PROVIDER_ORDER: AiProviderId[] = ['openai', 'qwen', 'ollama']

const TOOL_ITEMS: Array<{ id: ActiveTool; label: string; short: string; icon: LucideIcon }> = [
  { id: 'placement', label: 'Placement', short: 'Place', icon: Package },
  { id: 'ai', label: 'AI 3D', short: 'AI', icon: Wand2 },
  { id: 'ifc', label: 'IFC', short: 'IFC', icon: FileUp },
  { id: 'model', label: '3D Files', short: '3D', icon: Box },
  { id: 'hierarchy', label: 'Layer', short: 'Layer', icon: Workflow },
]

const PLACEMENT_CATEGORIES: Array<{ id: PlacementCategoryId; label: string }> = [
  { id: 'interior', label: 'Interior' },
  { id: 'furniture', label: 'Furniture' },
  { id: 'outdoor', label: 'Outdoor' },
  { id: 'appliances', label: 'Appliances' },
]

const PLACEMENT_ASSET_CATEGORY: Record<PlacementCategoryId, string> = {
  furniture: 'furniture',
  interior: 'interior',
  outdoor: 'outdoor',
  appliances: 'appliance',
}

const LOCAL_PLACEMENT_ITEMS: LocalPlacementItem[] = [
  {
    id: 'build-wall',
    name: 'Wall',
    category: 'interior',
    placementKind: 'wall',
    thumbnailPath: '/icons/wall.png',
    dimensions: [3, 2.8, 0.12],
    tags: ['build', 'structure', 'partition'],
  },
  {
    id: 'build-fence',
    name: 'Fence',
    category: 'interior',
    placementKind: 'fence',
    thumbnailPath: '/icons/fence.png',
    dimensions: [3, 1.2, 0.08],
    tags: ['build', 'boundary', 'timber'],
  },
  {
    id: 'build-slab',
    name: 'Slab',
    category: 'interior',
    placementKind: 'slab',
    thumbnailPath: '/icons/floor.png',
    dimensions: [4, 0.05, 4],
    tags: ['build', 'floor', 'slab'],
  },
  {
    id: 'build-ceiling',
    name: 'Ceiling',
    category: 'interior',
    placementKind: 'ceiling',
    thumbnailPath: '/icons/ceiling.png',
    dimensions: [4, 2.5, 4],
    tags: ['build', 'ceiling'],
  },
  {
    id: 'build-roof',
    name: 'Roof',
    category: 'interior',
    placementKind: 'roof',
    thumbnailPath: '/icons/roof.png',
    dimensions: [4, 0.5, 4],
    tags: ['build', 'roof'],
  },
  {
    id: 'sofa',
    name: 'Sofa',
    category: 'furniture',
    dimensions: [2.06, 0.74, 1.01],
    tags: ['seating', 'living-room'],
  },
  {
    id: 'couch-medium',
    name: 'Medium Couch',
    category: 'furniture',
    dimensions: [2.1, 0.75, 1],
    tags: ['seating', 'living-room'],
  },
  {
    id: 'livingroom-chair',
    name: 'Lounge Chair',
    category: 'furniture',
    dimensions: [1.1, 0.75, 1.07],
    tags: ['seating'],
  },
  {
    id: 'dining-chair',
    name: 'Dining Chair',
    category: 'furniture',
    dimensions: [0.47, 0.87, 0.5],
    tags: ['seating', 'dining'],
  },
  {
    id: 'table',
    name: 'Table',
    category: 'furniture',
    dimensions: [1.2, 0.75, 0.8],
    surfaceHeight: 0.75,
    tags: ['table'],
  },
  {
    id: 'coffee-table',
    name: 'Coffee Table',
    category: 'furniture',
    dimensions: [1.72, 0.3, 1.04],
    surfaceHeight: 0.3,
    tags: ['table', 'living-room'],
  },
  {
    id: 'dining-table',
    name: 'Dining Table',
    category: 'furniture',
    dimensions: [2.16, 0.7, 0.95],
    surfaceHeight: 0.7,
    tags: ['table', 'dining'],
  },
  {
    id: 'desk',
    name: 'Desk',
    category: 'furniture',
    dimensions: [1.5, 0.76, 0.7],
    surfaceHeight: 0.75,
    tags: ['office', 'table'],
  },
  {
    id: 'bookshelf',
    name: 'Bookshelf',
    category: 'furniture',
    dimensions: [0.93, 1.99, 0.33],
    tags: ['storage'],
  },
  {
    id: 'single-bed',
    name: 'Single Bed',
    category: 'furniture',
    dimensions: [1.08, 0.6, 2.14],
    tags: ['bedroom'],
  },
  {
    id: 'double-bed',
    name: 'Double Bed',
    category: 'furniture',
    dimensions: [1.52, 0.71, 2],
    tags: ['bedroom'],
  },
  {
    id: 'stool',
    name: 'Stool',
    category: 'furniture',
    dimensions: [0.45, 0.5, 0.45],
    tags: ['seating'],
  },
  {
    id: 'door',
    name: 'Door',
    category: 'interior',
    dimensions: [0.9, 2.1, 0.12],
    tags: ['opening'],
  },
  {
    id: 'glass-door',
    name: 'Glass Door',
    category: 'interior',
    dimensions: [0.95, 2.1, 0.12],
    tags: ['opening'],
  },
  {
    id: 'doorway-front',
    name: 'Doorway',
    category: 'interior',
    dimensions: [1, 2.1, 0.16],
    tags: ['opening'],
  },
  {
    id: 'window-simple',
    name: 'Window',
    category: 'interior',
    dimensions: [1.2, 1.2, 0.12],
    tags: ['opening'],
  },
  {
    id: 'window-double',
    name: 'Double Window',
    category: 'interior',
    dimensions: [1.6, 1.2, 0.12],
    tags: ['opening'],
  },
  {
    id: 'window-round',
    name: 'Round Window',
    category: 'interior',
    dimensions: [1, 1, 0.12],
    tags: ['opening'],
  },
  {
    id: 'ceiling-light',
    name: 'Ceiling Light',
    category: 'interior',
    dimensions: [0.5, 0.12, 0.5],
    tags: ['lighting'],
  },
  {
    id: 'recessed-light',
    name: 'Recessed Light',
    category: 'interior',
    dimensions: [0.23, 0.06, 0.23],
    tags: ['lighting'],
  },
  {
    id: 'column',
    name: 'Column',
    category: 'interior',
    dimensions: [0.35, 2.8, 0.35],
    tags: ['structure'],
  },
  {
    id: 'stairs',
    name: 'Stairs',
    category: 'interior',
    dimensions: [1, 1.2, 2.8],
    tags: ['circulation'],
  },
  {
    id: 'rectangular-carpet',
    name: 'Carpet',
    category: 'interior',
    dimensions: [2.78, 0.04, 1.81],
    tags: ['floor'],
  },
  {
    id: 'round-carpet',
    name: 'Round Carpet',
    category: 'interior',
    dimensions: [1.6, 0.04, 1.6],
    tags: ['floor'],
  },
  {
    id: 'tree',
    name: 'Tree',
    category: 'outdoor',
    dimensions: [1.8, 3.2, 1.8],
    tags: ['landscape', 'botanical'],
  },
  {
    id: 'fir-tree',
    name: 'Fir Tree',
    category: 'outdoor',
    dimensions: [1.8, 3.4, 1.8],
    tags: ['landscape', 'botanical'],
  },
  {
    id: 'palm',
    name: 'Palm',
    category: 'outdoor',
    dimensions: [1.8, 3.8, 1.8],
    tags: ['landscape', 'botanical'],
  },
  {
    id: 'bush',
    name: 'Bush',
    category: 'outdoor',
    dimensions: [1.2, 0.8, 1.2],
    tags: ['landscape', 'botanical'],
  },
  {
    id: 'hedge',
    name: 'Hedge',
    category: 'outdoor',
    dimensions: [2, 1, 0.6],
    tags: ['landscape', 'botanical'],
  },
  {
    id: 'cactus',
    name: 'Cactus',
    category: 'outdoor',
    dimensions: [0.34, 0.39, 0.27],
    tags: ['landscape', 'botanical'],
  },
  {
    id: 'patio-umbrella',
    name: 'Patio Umbrella',
    category: 'outdoor',
    dimensions: [2.6, 2.4, 2.6],
    tags: ['backyard'],
  },
  {
    id: 'sunbed',
    name: 'Sunbed',
    category: 'outdoor',
    dimensions: [2, 0.5, 0.75],
    tags: ['backyard', 'seating'],
  },
  {
    id: 'deck-082523',
    name: 'Deck',
    category: 'outdoor',
    modelPath: '/items/deck/deck_082523.glb',
    dimensions: [14.4, 1.05, 9.6],
    surfaceHeight: 4.405,
    tags: ['deck', 'patio', 'outdoor-living', 'platform'],
  },
  {
    id: 'deck-chair-hanged',
    name: 'Hanging Deck Chair',
    category: 'outdoor',
    modelPath: '/items/deck/deck_chair_hanged_bbdw.glb',
    dimensions: [1.4, 2.1, 1.4],
    tags: ['deck', 'chair', 'seating', 'outdoor-living'],
  },
  {
    id: 'deck-stairs-guardrails',
    name: 'Deck with Stairs',
    category: 'outdoor',
    modelPath: '/items/deck/deck_wit_sets_of_stairs_and_guardrails.glb',
    dimensions: [16.5, 4.2, 11.4],
    tags: ['deck', 'stairs', 'guardrail', 'outdoor-living'],
  },
  {
    id: 'ship-deck-balcony',
    name: 'Ship Deck Balcony',
    category: 'outdoor',
    modelPath: '/items/deck/ship_deck_balcony.glb',
    dimensions: [13.5, 4.2, 7.2],
    tags: ['deck', 'balcony', 'railing', 'outdoor-living'],
  },
  {
    id: 'pergola',
    name: 'Pergola',
    category: 'outdoor',
    modelPath: '/items/pergola/pergola.glb',
    dimensions: [11.4, 8.1, 9.6],
    tags: ['pergola', 'shade', 'patio', 'outdoor-living'],
  },
  {
    id: 'pergola-3',
    name: 'Pergola 3',
    category: 'outdoor',
    modelPath: '/items/pergola/pergola_3.glb',
    dimensions: [12, 8.4, 9.6],
    tags: ['pergola', 'shade', 'garden', 'outdoor-living'],
  },
  {
    id: 'timber-pergola',
    name: 'Timber Pergola',
    category: 'outdoor',
    modelPath: '/items/pergola/timber_pergola_3d_model.glb',
    dimensions: [13.5, 8.4, 10.5],
    tags: ['pergola', 'timber', 'shade', 'outdoor-living'],
  },
  {
    id: 'wooden-garden-pergola',
    name: 'Garden Pergola',
    category: 'outdoor',
    modelPath: '/items/pergola/wooden_garden_pergola.glb',
    dimensions: [12.6, 8.1, 9.6],
    tags: ['pergola', 'wooden', 'garden', 'outdoor-living'],
  },
  {
    id: 'wooden-building-pergola',
    name: 'Wooden Pergola',
    category: 'outdoor',
    modelPath: '/items/pergola/wooden_pergola_-_3d_building.glb',
    dimensions: [15, 10.2, 12],
    tags: ['pergola', 'timbertech', 'wooden', 'patio', 'outdoor-living'],
  },
  {
    id: 'outdoor-playhouse',
    name: 'Playhouse',
    category: 'outdoor',
    dimensions: [2.4, 2.1, 2.2],
    tags: ['backyard'],
  },
  {
    id: 'fence',
    name: 'Fence',
    category: 'outdoor',
    dimensions: [2, 1, 0.12],
    tags: ['boundary', 'timber'],
  },
  {
    id: 'high-fence',
    name: 'High Fence',
    category: 'outdoor',
    dimensions: [2, 1.8, 0.12],
    tags: ['boundary', 'timber'],
  },
  {
    id: 'hydrant',
    name: 'Hydrant',
    category: 'outdoor',
    dimensions: [0.45, 0.8, 0.45],
    tags: ['site'],
  },
  {
    id: 'microwave',
    name: 'Microwave',
    category: 'appliances',
    dimensions: [0.55, 0.32, 0.42],
    tags: ['kitchen'],
  },
  {
    id: 'toaster',
    name: 'Toaster',
    category: 'appliances',
    dimensions: [0.32, 0.22, 0.2],
    tags: ['kitchen'],
  },
  {
    id: 'stove',
    name: 'Stove',
    category: 'appliances',
    dimensions: [0.92, 0.85, 0.76],
    surfaceHeight: 0.85,
    tags: ['kitchen'],
  },
  {
    id: 'kitchen-fridge',
    name: 'Fridge',
    category: 'appliances',
    dimensions: [0.7, 1.92, 0.72],
    tags: ['kitchen'],
  },
  {
    id: 'freezer',
    name: 'Freezer',
    category: 'appliances',
    dimensions: [0.7, 1.6, 0.7],
    tags: ['kitchen'],
  },
  {
    id: 'washing-machine',
    name: 'Washer',
    category: 'appliances',
    dimensions: [0.65, 0.85, 0.65],
    tags: ['laundry'],
  },
  {
    id: 'air-conditioner',
    name: 'Air Conditioner',
    category: 'appliances',
    dimensions: [0.8, 0.3, 0.22],
    tags: ['hvac'],
  },
  {
    id: 'television',
    name: 'Television',
    category: 'appliances',
    dimensions: [1.62, 1.07, 0.38],
    tags: ['media'],
  },
  {
    id: 'coffee-machine',
    name: 'Coffee Machine',
    category: 'appliances',
    dimensions: [0.35, 0.45, 0.35],
    tags: ['kitchen'],
  },
  {
    id: 'ceiling-fan',
    name: 'Ceiling Fan',
    category: 'appliances',
    dimensions: [1.2, 0.25, 1.2],
    tags: ['hvac'],
  },
  {
    id: 'smoke-detector',
    name: 'Smoke Detector',
    category: 'appliances',
    dimensions: [0.16, 0.05, 0.16],
    tags: ['safety'],
  },
  {
    id: 'thermostat',
    name: 'Thermostat',
    category: 'appliances',
    dimensions: [0.14, 0.1, 0.04],
    tags: ['hvac'],
  },
]

const EXPORT_FORMATS: Array<{ format: ExportFormat; label: string }> = [
  { format: 'glb', label: 'GLB' },
  { format: 'stl', label: 'STL' },
  { format: 'obj', label: 'OBJ' },
]

const MODEL_IMPORT_ACCEPT = '.glb,.gltf,.stl,.obj'
const MAX_MODEL_IMPORT_SIZE = 250 * 1024 * 1024
const DEFAULT_SCENE_NAME = 'Default Studio'
const DEFAULT_SCENE_GRAPH: SceneGraph = {
  nodes: {
    site_default: {
      object: 'node',
      id: 'site_default',
      type: 'site',
      parentId: null,
      visible: true,
      metadata: {},
      polygon: {
        type: 'polygon',
        points: [
          [-25, -25],
          [25, -25],
          [25, 25],
          [-25, 25],
        ],
      },
      children: ['building_default'],
    },
    building_default: {
      object: 'node',
      id: 'building_default',
      type: 'building',
      parentId: 'site_default',
      visible: true,
      metadata: {},
      name: 'Default Building',
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      children: ['level_default'],
    },
    level_default: {
      object: 'node',
      id: 'level_default',
      type: 'level',
      parentId: 'building_default',
      visible: true,
      metadata: {},
      name: 'Ground Floor',
      level: 0,
      children: [],
    },
  },
  rootNodeIds: ['site_default'],
} as unknown as SceneGraph

async function createIfcVisualImportSceneGraph(
  ifcData: Uint8Array,
  sourceName: string,
  onProgress?: (message: string, percent: number) => void,
): Promise<SceneGraph> {
  const visual = await createIfcVisualImportWithRoofLayer(ifcData, sourceName, {
    onProgress: (message, percent) => onProgress?.(message, Math.round(percent * 0.92)),
  })
  if (!visual.body) {
    throw new Error('No renderable IFC body geometry was found.')
  }

  const siteId = generateId('site') as AnyNodeId
  const buildingId = generateId('building') as AnyNodeId
  const levelId = generateId('level') as AnyNodeId
  const scanId = generateId('scan') as AnyNodeId
  const roofScanId = visual.roof ? (generateId('scan') as AnyNodeId) : null
  const displayName = getImportDisplayName(sourceName)
  const assetUrl = await saveAsset(visual.body.file)
  const roofAssetUrl = visual.roof ? await saveAsset(visual.roof.file) : null
  onProgress?.('Saving IFC visual model...', 96)

  const summary: IfcVisualImportMetadata = {
    fileName: sourceName,
    fileSize: ifcData.byteLength,
    meshCount: visual.total.meshCount,
    mode: visual.roof ? 'roof-layered-visual' : 'single-visual',
    productCount: visual.total.productCount,
    skippedAuxiliaryCount: visual.total.skippedAuxiliaryCount,
    skippedInteriorCount: visual.total.skippedInteriorCount,
    triangleCount: visual.total.triangleCount,
    typeCounts: visual.total.typeCounts,
  }
  const levelChildren = roofScanId ? [scanId, roofScanId] : [scanId]

  const nodes: Record<AnyNodeId, AnyNode> = {
    [siteId]: {
      object: 'node',
      id: siteId,
      type: 'site',
      parentId: null,
      visible: true,
      metadata: {
        source: 'ifc-visual-pipeline',
        ifcVisualImport: summary,
      },
      polygon: {
        type: 'polygon',
        points: [
          [-25, -25],
          [25, -25],
          [25, 25],
          [-25, 25],
        ],
      },
      children: [buildingId],
    } as AnyNode,
    [buildingId]: {
      object: 'node',
      id: buildingId,
      type: 'building',
      parentId: siteId,
      visible: true,
      metadata: {
        source: 'ifc-visual-pipeline',
        ifcVisualImport: summary,
      },
      name: displayName,
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      children: [levelId],
    } as AnyNode,
    [levelId]: {
      object: 'node',
      id: levelId,
      type: 'level',
      parentId: buildingId,
      visible: true,
      metadata: {
        source: 'ifc-visual-pipeline',
        ifcVisualImport: summary,
      },
      name: 'IFC Visual Model',
      level: 0,
      children: levelChildren,
    } as AnyNode,
    [scanId]: ScanNode.parse({
      id: scanId,
      type: 'scan',
      name: `${displayName} visual model`,
      parentId: levelId,
      visible: true,
      url: assetUrl,
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      scale: 1,
      opacity: 100,
      metadata: {
        importedModel: {
          alignToPlane: false,
          centerPivot: false,
          fileName: visual.body.file.name,
          format: 'glb',
          size: visual.body.file.size,
          source: 'ifc-visual-pipeline',
        },
        ifcVisualImport: summary,
      },
    }) as AnyNode,
  }

  if (roofScanId && visual.roof && roofAssetUrl) {
    nodes[roofScanId] = ScanNode.parse({
      id: roofScanId,
      type: 'scan',
      name: `${displayName} roof`,
      parentId: levelId,
      visible: true,
      url: roofAssetUrl,
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      scale: 1,
      opacity: 100,
      metadata: {
        importedModel: {
          alignToPlane: false,
          centerPivot: false,
          fileName: visual.roof.file.name,
          format: 'glb',
          size: visual.roof.file.size,
          source: 'ifc-roof-layer-pipeline',
        },
        ifcProduct: {
          expressID: 0,
          ifcType: 'IFCROOF',
          triangleCount: visual.roof.triangleCount,
        },
      },
    }) as AnyNode
  }

  onProgress?.('IFC visual scene ready.', 100)

  return {
    nodes,
    rootNodeIds: [siteId],
  } as unknown as SceneGraph
}

function meta(node: { metadata?: unknown } | null | undefined): ConverterMetadata {
  return (node?.metadata ?? {}) as ConverterMetadata
}

function getIfcVisualImportSummary(graph: SceneGraph | null): IfcVisualImportMetadata | null {
  if (!graph) return null

  for (const node of Object.values(graph.nodes)) {
    const summary = (node.metadata as { ifcVisualImport?: unknown } | undefined)?.ifcVisualImport
    if (!summary || typeof summary !== 'object') continue
    return summary as IfcVisualImportMetadata
  }

  return null
}

function sceneStats(graph: SceneGraph | null) {
  if (!graph) return { nodes: 0, types: 0, typeCounts: {} as Record<string, number> }
  const typeCounts: Record<string, number> = {}
  for (const node of Object.values(graph.nodes)) {
    const type = (node as { type?: string }).type ?? 'unknown'
    typeCounts[type] = (typeCounts[type] ?? 0) + 1
  }
  return {
    nodes: Object.keys(graph.nodes).length,
    types: Object.keys(typeCounts).length,
    typeCounts,
  }
}

type HierarchyLayerId = 'structure' | 'furnish' | 'zones'

const HIERARCHY_LAYER_DEFS: Array<{ id: HierarchyLayerId; label: string; icon: LucideIcon }> = [
  { id: 'structure', label: 'Structure', icon: Box },
  { id: 'furnish', label: 'Furnish', icon: Package },
  { id: 'zones', label: 'Zones', icon: CircleDot },
]

const HIERARCHY_CONTAINER_TYPES = new Set(['site', 'building', 'level'])
const HIERARCHY_STRUCTURE_TYPES = new Set([
  'wall',
  'fence',
  'column',
  'slab',
  'ceiling',
  'roof',
  'roof-segment',
  'door',
  'window',
  'stair',
  'stair-segment',
  'elevator',
  'shelf',
  'skylight',
  'dormer',
  'box-vent',
  'ridge-vent',
  'chimney',
  'solar-panel',
])
const HIERARCHY_FURNISH_TYPES = new Set(['item', 'scan', 'guide', 'spawn'])
const HIERARCHY_IFC_STRUCTURE_TYPES = new Set([
  'IFCBEAM',
  'IFCBOXEDHALFSPACE',
  'IFCBUILDINGELEMENTPROXY',
  'IFCCHIMNEY',
  'IFCCOLUMN',
  'IFCCOVERING',
  'IFCCURTAINWALL',
  'IFCDOOR',
  'IFCFOOTING',
  'IFCMEMBER',
  'IFCPILE',
  'IFCPLATE',
  'IFCRAILING',
  'IFCRAMP',
  'IFCRAMPFLIGHT',
  'IFCROOF',
  'IFCSHADINGDEVICE',
  'IFCSITE',
  'IFCSLAB',
  'IFCSTAIR',
  'IFCSTAIRFLIGHT',
  'IFCWALL',
  'IFCWALLSTANDARDCASE',
  'IFCWINDOW',
])
const HIERARCHY_IFC_ZONE_TYPES = new Set(['IFCSPACE'])

function getHierarchyLayer(type: string): HierarchyLayerId | null {
  if (HIERARCHY_STRUCTURE_TYPES.has(type)) return 'structure'
  if (HIERARCHY_FURNISH_TYPES.has(type)) return 'furnish'
  if (type === 'zone') return 'zones'
  return null
}

function getIfcProductMetadata(node: AnyNode): IfcProductMetadata | null {
  const product = (node.metadata as { ifcProduct?: unknown } | undefined)?.ifcProduct
  if (!product || typeof product !== 'object') return null
  const ifcType = (product as { ifcType?: unknown }).ifcType
  const expressID = (product as { expressID?: unknown }).expressID
  if (typeof ifcType !== 'string' || typeof expressID !== 'number') return null
  return product as IfcProductMetadata
}

function isIfcVisualStructureNode(node: AnyNode): boolean {
  if (node.type !== 'scan' && node.type !== 'level') return false

  const metadata = node.metadata as
    | {
        ifcVisualImport?: unknown
        importedModel?: { source?: unknown }
        source?: unknown
      }
    | undefined
  if (metadata?.ifcVisualImport) return true
  if (metadata?.source === 'ifc-visual-pipeline') return true

  const importedSource = metadata?.importedModel?.source
  return (
    importedSource === 'ifc-visual-pipeline' ||
    importedSource === 'ifc-roof-layer-pipeline'
  )
}

function getHierarchyNodeLayer(node: AnyNode): HierarchyLayerId | null {
  const ifcType = getIfcProductMetadata(node)?.ifcType
  if (ifcType) {
    if (HIERARCHY_IFC_ZONE_TYPES.has(ifcType)) return 'zones'
    if (HIERARCHY_IFC_STRUCTURE_TYPES.has(ifcType)) return 'structure'
  }
  if (isIfcVisualStructureNode(node)) return 'structure'
  return getHierarchyLayer(node.type)
}

function getHierarchyBadge(node: AnyNode): string {
  if (isIfcVisualStructureNode(node)) return 'IFC'
  return getIfcProductMetadata(node)?.ifcType ?? node.type
}

function getHierarchyChildren(node: AnyNode | undefined): AnyNodeId[] {
  if (!(node && 'children' in node) || !Array.isArray(node.children)) return []
  return node.children
    .filter((childId): childId is string => typeof childId === 'string')
    .map((childId) => childId as AnyNodeId)
}

function hierarchyNodeMatchesLayer(
  nodes: Record<AnyNodeId, AnyNode>,
  node: AnyNode | undefined,
  layer: HierarchyLayerId,
): boolean {
  if (!node) return false
  if (getHierarchyNodeLayer(node) === layer) return true
  return getHierarchyChildren(node).some((childId) =>
    hierarchyNodeMatchesLayer(nodes, nodes[childId], layer),
  )
}

function getHierarchyLabel(node: AnyNode): string {
  if (node.name) return node.name
  if (node.type === 'site') return 'Site'
  if (node.type === 'building') return 'Building'
  if (node.type === 'level') {
    const level = (node as { level?: unknown }).level
    return typeof level === 'number' ? `Level ${level}` : 'Level'
  }
  return node.type
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function getHierarchyIcon(type: string): LucideIcon {
  if (type === 'site') return Home
  if (type === 'building') return Building2
  if (type === 'level') return Layers
  if (type === 'zone') return CircleDot
  if (type === 'item' || type === 'scan' || type === 'guide') return Package
  return Box
}

function getHierarchyNodeIcon(node: AnyNode): LucideIcon {
  const ifcType = getIfcProductMetadata(node)?.ifcType
  if (ifcType === 'IFCSPACE') return CircleDot
  if (ifcType) return Box
  return getHierarchyIcon(node.type)
}

function selectHierarchyNode(node: AnyNode, nodes: Record<AnyNodeId, AnyNode>) {
  const viewer = useViewer.getState()
  const editor = useEditor.getState()
  editor.setPendingImportPlacement(null)
  editor.setSelectedReferenceId(null)

  if (node.type === 'site') {
    viewer.setSelection({ buildingId: null, levelId: null, zoneId: null, selectedIds: [] })
    return
  }

  if (node.type === 'building') {
    viewer.setSelection({ buildingId: node.id as never, levelId: undefined, selectedIds: [] })
    return
  }

  if (node.type === 'level') {
    const parent = node.parentId ? nodes[node.parentId as AnyNodeId] : null
    viewer.setSelection({
      buildingId: parent?.type === 'building' ? (parent.id as never) : undefined,
      levelId: node.id as never,
      selectedIds: [],
    })
    return
  }

  if (node.type === 'zone') {
    viewer.setSelection({ zoneId: node.id as never, selectedIds: [] })
    return
  }

  viewer.setSelection({ selectedIds: [node.id], zoneId: null })
}

function downloadJson(graph: SceneGraph, filename: string) {
  const blob = new Blob([JSON.stringify(graph, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

function detectModelFormat(fileName: string): ModelFormat | null {
  const extension = fileName.split('.').pop()?.toLowerCase()
  if (extension === 'glb' || extension === 'gltf' || extension === 'stl' || extension === 'obj') {
    return extension
  }
  return null
}

function getImportDisplayName(fileName: string) {
  const trimmed = fileName.trim()
  const dotIndex = trimmed.lastIndexOf('.')
  return dotIndex > 0 ? trimmed.slice(0, dotIndex) : trimmed || 'Imported model'
}

function formatIfcTypeLabel(typeName: string) {
  return typeName
    .replace(/^IFC/, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function formatFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb.toFixed(1)} KB`
  return `${(kb / 1024).toFixed(1)} MB`
}

function getLocalPublicUrl(path: string) {
  if (typeof window === 'undefined') return path
  return `${window.location.origin}${path}`
}

function isAssetPlacementItem(item: LocalPlacementItem): item is LocalAssetPlacementItem {
  return item.placementKind == null || item.placementKind === 'asset'
}

function getPlacementThumbnailPath(item: LocalPlacementItem) {
  if (item.thumbnailPath) return item.thumbnailPath
  if (isAssetPlacementItem(item) && item.modelPath) return null
  return isAssetPlacementItem(item) ? `/items/${item.id}/thumbnail.webp` : null
}

function getPlacementModelPath(item: LocalPlacementItem) {
  return isAssetPlacementItem(item) ? (item.modelPath ?? `/items/${item.id}/model.glb`) : null
}

function getPlacementReadyMessage(item: LocalPlacementItem) {
  if (isAssetPlacementItem(item)) {
    return `${item.name} is ready. Move over the grid and click to place it.`
  }
  if (item.placementKind === 'wall' || item.placementKind === 'fence') {
    return `${item.name} is ready. Click a start point, move to set its length, then click the end point.`
  }
  return `${item.name} is ready. Click one corner, move to set the rectangle, then click the opposite corner.`
}

function createPlacementAsset(item: LocalAssetPlacementItem): AssetInput {
  const basePath = `/items/${item.id}`
  const modelPath = getPlacementModelPath(item) ?? `${basePath}/model.glb`
  const asset: AssetInput = {
    id: `local-${item.id}`,
    category: PLACEMENT_ASSET_CATEGORY[item.category],
    name: item.name,
    thumbnail: item.thumbnailPath ?? (item.modelPath ? '/icons/tree.png' : `${basePath}/thumbnail.webp`),
    src: getLocalPublicUrl(modelPath),
    dimensions: item.dimensions,
    offset: [0, 0, 0],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
    fitToDimensions: Boolean(item.modelPath),
    tags: [item.category, ...(item.tags ?? [])],
  }
  if (item.surfaceHeight != null) {
    asset.surface = { height: item.surfaceHeight }
  }
  return asset
}

function prepareEditorForImportPlacement() {
  const editor = useEditor.getState()
  const viewer = useViewer.getState()

  editor.setPendingImportPlacement(null)
  editor.setPhase('structure')
  editor.setMode('select')
  editor.setTool(null)
  viewer.setShowGrid(true)
  viewer.setSelection({ selectedIds: [], zoneId: null })
}

const QUARTER_TURN_RAD = Math.PI / 2

function isRotationTuple(value: unknown): value is [number, number, number] {
  return (
    Array.isArray(value) && value.length === 3 && value.every((part) => typeof part === 'number')
  )
}

function rotatePlanPoint([x, z]: PlanPoint, [centerX, centerZ]: PlanPoint): PlanPoint {
  const dx = x - centerX
  const dz = z - centerZ
  return [centerX - dz, centerZ + dx]
}

function getPlanCenter(points: PlanPoint[]): PlanPoint | null {
  if (points.length === 0) return null
  const sum = points.reduce(
    (total, point) => [total[0] + point[0], total[1] + point[1]] as PlanPoint,
    [0, 0] as PlanPoint,
  )
  return [sum[0] / points.length, sum[1] / points.length]
}

function getSelectedSceneNodeIds() {
  const ids = new Set<AnyNodeId>()
  for (const id of useViewer.getState().selection.selectedIds) {
    ids.add(id as AnyNodeId)
  }
  const selectedReferenceId = useEditor.getState().selectedReferenceId
  if (selectedReferenceId) ids.add(selectedReferenceId as AnyNodeId)
  return [...ids]
}

const MOVABLE_PARENT_NODE_TYPES = new Set([
  'building',
  'scan',
  'item',
  'column',
  'elevator',
  'roof',
  'stair',
])

type MoveSelectionTarget = {
  node: AnyNode
  selectAsReference: boolean
}

function hasPositionTuple(node: AnyNode | undefined): boolean {
  const position = (node as { position?: unknown } | undefined)?.position
  return (
    Array.isArray(position) &&
    position.length >= 3 &&
    position.every((part) => typeof part === 'number')
  )
}

function findMovableParentNode(
  nodes: Record<AnyNodeId, AnyNode>,
  nodeId: AnyNodeId | null | undefined,
): AnyNode | null {
  let currentId = nodeId
  while (currentId) {
    const node = nodes[currentId]
    if (!node) return null
    if (MOVABLE_PARENT_NODE_TYPES.has(node.type) && hasPositionTuple(node)) return node
    currentId = (node.parentId as AnyNodeId | null | undefined) ?? null
  }
  return null
}

function getNodeAncestors(
  nodes: Record<AnyNodeId, AnyNode>,
  nodeId: AnyNodeId,
): { buildingId: AnyNodeId | null; levelId: AnyNodeId | null } {
  let buildingId: AnyNodeId | null = null
  let levelId: AnyNodeId | null = null
  let current: AnyNode | undefined = nodes[nodeId]

  while (current) {
    if (current.type === 'building') buildingId = current.id as AnyNodeId
    if (current.type === 'level') levelId = current.id as AnyNodeId
    const parentId = current.parentId as AnyNodeId | null | undefined
    current = parentId ? nodes[parentId] : undefined
  }

  return { buildingId, levelId }
}

function getMoveSelectionTarget(
  nodes: Record<AnyNodeId, AnyNode>,
  selectedIds: readonly string[],
  selectedReferenceId: string | null,
): MoveSelectionTarget | null {
  if (selectedReferenceId) {
    const node = findMovableParentNode(nodes, selectedReferenceId as AnyNodeId)
    return node ? { node, selectAsReference: node.id === selectedReferenceId } : null
  }

  if (selectedIds.length !== 1) return null
  const node = findMovableParentNode(nodes, selectedIds[0] as AnyNodeId)
  return node ? { node, selectAsReference: false } : null
}

function startMoveSelectedSceneNode(target: MoveSelectionTarget) {
  const editor = useEditor.getState()
  const viewer = useViewer.getState()
  const nodes = useScene.getState().nodes as Record<AnyNodeId, AnyNode>
  const nodeId = target.node.id as AnyNodeId
  const { buildingId, levelId } = getNodeAncestors(nodes, nodeId)

  editor.setPendingImportPlacement(null)
  editor.setMode('select')
  editor.setTool(null)
  editor.setSelectedReferenceId(target.selectAsReference ? nodeId : null)
  viewer.setShowGrid(true)

  if (target.node.type === 'building') {
    viewer.setSelection({
      buildingId: nodeId as never,
      selectedIds: target.selectAsReference ? [] : [nodeId],
      zoneId: null,
    })
  } else if (buildingId || levelId) {
    viewer.setSelection({
      ...(buildingId ? { buildingId: buildingId as never } : {}),
      ...(levelId ? { levelId: levelId as never } : {}),
      selectedIds: target.selectAsReference ? [] : [nodeId],
      zoneId: null,
    })
  } else {
    viewer.setSelection({ selectedIds: target.selectAsReference ? [] : [nodeId], zoneId: null })
  }

  editor.setPendingImportPlacement({
    kind: 'move-existing',
    name: target.node.name ?? target.node.type,
    nodeId,
    selectAsReference: target.selectAsReference,
    space: target.node.type === 'building' ? 'world' : 'building',
    snapToGrid: true,
  })
}

function getQuarterTurnPatch(node: AnyNode): Partial<AnyNode> | null {
  if (node.type === 'wall' || node.type === 'fence') {
    const center: PlanPoint = [(node.start[0] + node.end[0]) / 2, (node.start[1] + node.end[1]) / 2]
    return {
      start: rotatePlanPoint(node.start, center),
      end: rotatePlanPoint(node.end, center),
    } as Partial<AnyNode>
  }

  if (node.type === 'slab' || node.type === 'ceiling') {
    const center = getPlanCenter(node.polygon)
    if (!center) return null
    return {
      polygon: node.polygon.map((point) => rotatePlanPoint(point, center)),
      holes: node.holes.map((hole) => hole.map((point) => rotatePlanPoint(point, center))),
    } as Partial<AnyNode>
  }

  if ('rotation' in node) {
    const rotation = node.rotation
    if (isRotationTuple(rotation)) {
      return {
        rotation: [rotation[0], rotation[1] + QUARTER_TURN_RAD, rotation[2]],
      } as Partial<AnyNode>
    }
    if (typeof rotation === 'number') {
      return { rotation: rotation + QUARTER_TURN_RAD } as Partial<AnyNode>
    }
  }

  return null
}

function rotateSelectedSceneNodes() {
  const scene = useScene.getState()
  const updates = getSelectedSceneNodeIds()
    .map((id) => {
      const node = scene.nodes[id]
      if (!node) return null
      const data = getQuarterTurnPatch(node)
      return data ? { id, data } : null
    })
    .filter((update): update is { id: AnyNodeId; data: Partial<AnyNode> } => update !== null)

  if (updates.length === 0) return false
  scene.updateNodes(updates)
  return true
}

function deleteSelectedSceneNodes() {
  const scene = useScene.getState()
  const ids = getSelectedSceneNodeIds().filter((id) => scene.nodes[id])
  if (ids.length === 0) return false

  scene.deleteNodes(ids)
  useViewer.getState().setSelection({ selectedIds: [], zoneId: null })
  useEditor.getState().setSelectedReferenceId(null)
  return true
}

function setSelectInteractionMode() {
  const editor = useEditor.getState()
  editor.setPendingImportPlacement(null)
  editor.setMode('select')
  editor.setTool(null)
}

function createAiMessageId(prefix: string) {
  const random =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2)
  return `${prefix}-${Date.now()}-${random}`
}

function getAiConversationHistory(messages: AiChatMessage[]) {
  return messages
    .filter((message) => message.variant !== 'error')
    .slice(-AI_HISTORY_LIMIT)
    .map((message) => ({ role: message.role, content: message.content }))
}

function getAiModelOptions(modelInfo: AiModelInfo | null): AiModelOption[] {
  const options = (modelInfo?.options ?? [])
    .filter((option) => AI_MODEL_PROVIDER_ORDER.includes(option.provider))
    .sort(
      (a, b) =>
        AI_MODEL_PROVIDER_ORDER.indexOf(a.provider) -
        AI_MODEL_PROVIDER_ORDER.indexOf(b.provider),
    )

  if (options.length > 0) return options
  if (modelInfo?.provider && AI_MODEL_PROVIDER_ORDER.includes(modelInfo.provider)) {
    return [
      {
        provider: modelInfo.provider,
        model: modelInfo.model,
        label: modelInfo.label,
        configured: modelInfo.configured,
        configurationError: modelInfo.configurationError,
      },
    ]
  }
  return []
}

function getDefaultAiProvider(modelInfo: AiModelInfo): AiProviderId | null {
  const options = getAiModelOptions(modelInfo)
  const currentProvider = options.find((option) => option.provider === modelInfo.provider)
  if (currentProvider) return currentProvider.provider
  return options.find((option) => option.configured)?.provider ?? options[0]?.provider ?? null
}

function SceneTaskbar({
  canEditSelection,
  canMoveSelection,
  selectActive,
  onDelete,
  onMove,
  onRotate,
  onSelect,
}: {
  canEditSelection: boolean
  canMoveSelection: boolean
  selectActive: boolean
  onDelete: () => void
  onMove: () => void
  onRotate: () => void
  onSelect: () => void
}) {
  const buttonBase =
    'inline-flex h-10 w-10 items-center justify-center rounded-xl text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-700 disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-transparent disabled:hover:text-slate-500'

  return (
    <div
      aria-label="Scene taskbar"
      className="absolute bottom-4 left-1/2 z-30 flex h-14 -translate-x-1/2 items-center gap-2 rounded-2xl border border-slate-200 bg-white/95 p-2 shadow-lg backdrop-blur-md"
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      onPointerUp={(event) => event.stopPropagation()}
      role="toolbar"
    >
      <button
        aria-label="Select"
        aria-pressed={selectActive}
        className={[
          buttonBase,
          selectActive ? 'bg-slate-100 text-slate-700 shadow-inner' : 'text-slate-500',
        ].join(' ')}
        onClick={onSelect}
        title="Select"
        type="button"
      >
        <MousePointer2 className="h-5 w-5" />
      </button>
      <button
        aria-label="Move selected parent"
        className={buttonBase}
        disabled={!canMoveSelection}
        onClick={onMove}
        title="Move selected parent"
        type="button"
      >
        <Move className="h-5 w-5" />
      </button>
      <button
        aria-label="Rotate 90 degrees"
        className={buttonBase}
        disabled={!canEditSelection}
        onClick={onRotate}
        title="Rotate 90 degrees"
        type="button"
      >
        <RotateCw className="h-5 w-5" />
      </button>
      <button
        aria-label="Delete"
        className={buttonBase}
        disabled={!canEditSelection}
        onClick={onDelete}
        title="Delete"
        type="button"
      >
        <Trash2 className="h-5 w-5" />
      </button>
    </div>
  )
}

function ToolRail({
  activeTool,
  isOpen,
  onChange,
}: {
  activeTool: ActiveTool
  isOpen: boolean
  onChange: (tool: ActiveTool) => void
}) {
  return (
    <nav
      aria-label="3D tool switcher"
      className="sticky top-3 hidden h-[calc(100vh-24px)] w-16 shrink-0 flex-col items-center gap-3 rounded-lg border border-slate-200 bg-white/85 p-2 shadow-sm backdrop-blur md:flex"
      data-ai-tool-rail
    >
      {TOOL_ITEMS.map((tool) => {
        const Icon = tool.icon
        const active = activeTool === tool.id && isOpen
        return (
          <button
            aria-label={tool.label}
            aria-pressed={active}
            className={[
              'flex h-12 w-12 flex-col items-center justify-center rounded-md border text-[10px] font-bold transition-colors',
              active
                ? 'border-blue-500 bg-blue-50 text-blue-700 shadow-sm'
                : 'border-transparent text-slate-500 hover:bg-slate-100 hover:text-slate-800',
            ].join(' ')}
            key={tool.id}
            onClick={() => onChange(tool.id)}
            title={tool.label}
            type="button"
          >
            <Icon className="h-4 w-4" />
            <span className="mt-0.5">{tool.short}</span>
          </button>
        )
      })}
    </nav>
  )
}

function MobileToolTabs({
  activeTool,
  onChange,
}: {
  activeTool: ActiveTool
  onChange: (tool: ActiveTool) => void
}) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-5 md:hidden">
      {TOOL_ITEMS.map((tool) => {
        const Icon = tool.icon
        const active = activeTool === tool.id
        return (
          <button
            aria-pressed={active}
            className={[
              'inline-flex h-10 items-center justify-center gap-2 rounded-md border px-3 font-semibold text-sm shadow-sm',
              active
                ? 'border-blue-500 bg-blue-50 text-blue-700'
                : 'border-slate-200 bg-white text-slate-600',
            ].join(' ')}
            key={tool.id}
            onClick={() => onChange(tool.id)}
            type="button"
          >
            <Icon className="h-4 w-4" />
            {tool.label}
          </button>
        )
      })}
    </div>
  )
}

function HierarchyPanel() {
  const nodes = useScene((state) => state.nodes as Record<AnyNodeId, AnyNode>)
  const rootNodeIds = useScene((state) => state.rootNodeIds as AnyNodeId[])
  const [activeLayer, setActiveLayer] = useState<HierarchyLayerId>('structure')

  const topLevelIds = useMemo(() => {
    if (rootNodeIds.length > 0) return rootNodeIds
    return Object.values(nodes)
      .filter((node) => !node.parentId)
      .map((node) => node.id as AnyNodeId)
  }, [nodes, rootNodeIds])

  const layerCounts = useMemo(() => {
    const counts: Record<HierarchyLayerId, number> = {
      structure: 0,
      furnish: 0,
      zones: 0,
    }
    for (const node of Object.values(nodes)) {
      const layer = getHierarchyNodeLayer(node)
      if (layer) counts[layer] += 1
    }
    return counts
  }, [nodes])

  const visibleRootIds = useMemo(
    () =>
      topLevelIds.filter((nodeId) => hierarchyNodeMatchesLayer(nodes, nodes[nodeId], activeLayer)),
    [activeLayer, nodes, topLevelIds],
  )
  const activeLayerDef = HIERARCHY_LAYER_DEFS.find((layer) => layer.id === activeLayer)
  const totalNodes = Object.keys(nodes).length

  return (
    <div className="flex min-h-0 flex-col gap-4" data-testid="ai-3d-hierarchy-panel">
      <div>
        <h1 className="font-bold text-2xl tracking-normal">Hierarchy</h1>
        <p className="mt-1 font-medium text-slate-500 text-sm">
          {totalNodes} nodes - {activeLayerDef?.label ?? 'Layer'}
        </p>
      </div>

      <div className="grid grid-cols-3 gap-1 rounded-lg bg-slate-100 p-1">
        {HIERARCHY_LAYER_DEFS.map((layer) => {
          const Icon = layer.icon
          const active = activeLayer === layer.id
          return (
            <button
              aria-pressed={active}
              className={[
                'flex min-h-16 flex-col items-center justify-center gap-1 rounded-md px-2 text-center font-semibold text-xs transition-colors',
                active
                  ? 'bg-white text-blue-700 shadow-sm'
                  : 'text-slate-500 hover:bg-white/70 hover:text-slate-800',
              ].join(' ')}
              key={layer.id}
              onClick={() => setActiveLayer(layer.id)}
              type="button"
            >
              <Icon className="h-4 w-4" />
              <span className="max-w-full truncate">{layer.label}</span>
              <span className="font-mono text-[10px] text-slate-400">{layerCounts[layer.id]}</span>
            </button>
          )
        })}
      </div>

      <div className="min-h-0 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
        {visibleRootIds.length > 0 ? (
          <div className="max-h-[calc(100vh-16rem)] overflow-y-auto p-2">
            {visibleRootIds.map((nodeId, index) => (
              <HierarchyTreeNode
                depth={0}
                key={nodeId}
                layer={activeLayer}
                nodeId={nodeId}
                siblingCount={visibleRootIds.length}
                siblingIndex={index}
              />
            ))}
          </div>
        ) : (
          <div className="p-6 text-center text-slate-400 text-sm">No scene nodes</div>
        )}
      </div>
    </div>
  )
}

function HierarchyTreeNode({
  depth,
  layer,
  nodeId,
  siblingCount,
  siblingIndex,
  visited,
}: {
  depth: number
  layer: HierarchyLayerId
  nodeId: AnyNodeId
  siblingCount: number
  siblingIndex: number
  visited?: Set<AnyNodeId>
}) {
  const node = useScene((state) => state.nodes[nodeId] as AnyNode | undefined)
  const nodes = useScene((state) => state.nodes as Record<AnyNodeId, AnyNode>)
  const updateNode = useScene((state) => state.updateNode)
  const selection = useViewer((state) => state.selection)
  const setHoveredId = useViewer((state) => state.setHoveredId)
  const selectedReferenceId = useEditor((state) => state.selectedReferenceId)
  const [expanded, setExpanded] = useState(depth < 3)

  const alreadyVisited = visited?.has(nodeId) ?? false
  const nextVisited = useMemo(() => {
    const next = new Set(visited)
    next.add(nodeId)
    return next
  }, [nodeId, visited])

  const childIds = useMemo(() => {
    if (!(node && !alreadyVisited)) return []
    return getHierarchyChildren(node).filter((childId) => {
      if (nextVisited.has(childId)) return false
      return hierarchyNodeMatchesLayer(nodes, nodes[childId], layer)
    })
  }, [alreadyVisited, layer, nextVisited, node, nodes])

  if (!node || alreadyVisited || !hierarchyNodeMatchesLayer(nodes, node, layer)) return null

  const currentNode = node
  const Icon = getHierarchyNodeIcon(currentNode)
  const label = getHierarchyLabel(currentNode)
  const badge = getHierarchyBadge(currentNode)
  const visible = currentNode.visible !== false
  const hasChildren = childIds.length > 0
  const nodeIdText = String(currentNode.id)
  const isSelected =
    selection.selectedIds.some((selectedId) => String(selectedId) === nodeIdText) ||
    String(selection.buildingId ?? '') === nodeIdText ||
    String(selection.levelId ?? '') === nodeIdText ||
    String(selection.zoneId ?? '') === nodeIdText ||
    selectedReferenceId === nodeIdText
  const isContainer = HIERARCHY_CONTAINER_TYPES.has(currentNode.type)

  function toggleVisibility(event: React.MouseEvent) {
    event.stopPropagation()
    const nextVisible = !visible
    updateNode(currentNode.id as AnyNodeId, { visible: nextVisible } as Partial<AnyNode>)
    const object = sceneRegistry.nodes.get(String(currentNode.id))
    if (object) object.visible = nextVisible
  }

  return (
    <div data-hierarchy-node-id={currentNode.id} data-layer={layer}>
      <div
        className={[
          'group flex min-w-0 items-center gap-1 rounded-md pr-1 transition-colors',
          isSelected
            ? 'bg-blue-50 text-blue-700'
            : visible
              ? 'text-slate-700 hover:bg-slate-50'
              : 'text-slate-400 hover:bg-slate-50',
        ].join(' ')}
        onMouseEnter={() => setHoveredId(currentNode.id as never)}
        onMouseLeave={() => setHoveredId(null)}
        style={{ paddingLeft: depth * 12 }}
      >
        <button
          aria-label={hasChildren ? (expanded ? 'Collapse' : 'Expand') : undefined}
          className="flex h-8 w-6 shrink-0 items-center justify-center rounded text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700 disabled:hover:bg-transparent disabled:hover:text-slate-400"
          disabled={!hasChildren}
          onClick={(event) => {
            event.stopPropagation()
            setExpanded((value) => !value)
          }}
          type="button"
        >
          {hasChildren && (
            <ChevronRight
              className={[
                'h-4 w-4 transition-transform',
                expanded ? 'rotate-90' : 'rotate-0',
              ].join(' ')}
            />
          )}
        </button>
        <button
          className="flex h-9 min-w-0 flex-1 items-center gap-2 text-left"
          onClick={() => selectHierarchyNode(currentNode, nodes)}
          onDoubleClick={() => {
            if (hasChildren) setExpanded((value) => !value)
          }}
          type="button"
        >
          <Icon
            className={[
              'h-4 w-4 shrink-0',
              isContainer ? 'text-blue-500' : visible ? 'text-slate-500' : 'text-slate-300',
            ].join(' ')}
          />
          <span
            className={[
              'min-w-0 flex-1 truncate font-semibold text-sm',
              visible ? '' : 'line-through decoration-slate-300',
            ].join(' ')}
            title={label}
          >
            {label}
          </span>
          {!isContainer && (
            <span className="max-w-20 shrink-0 truncate rounded bg-slate-100 px-1.5 py-0.5 font-semibold text-[10px] text-slate-400 uppercase">
              {badge}
            </span>
          )}
        </button>
        <button
          aria-label={visible ? `Hide ${label}` : `Show ${label}`}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-slate-400 opacity-80 transition-colors hover:bg-slate-100 hover:text-slate-700 group-hover:opacity-100"
          onClick={toggleVisibility}
          title={visible ? 'Hide' : 'Show'}
          type="button"
        >
          {visible ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
        </button>
      </div>

      {expanded && hasChildren && (
        <div
          className={[
            siblingIndex === siblingCount - 1 ? '' : 'border-slate-100 border-l',
            depth === 0 ? 'ml-3' : 'ml-2',
          ].join(' ')}
        >
          {childIds.map((childId, index) => (
            <HierarchyTreeNode
              depth={depth + 1}
              key={childId}
              layer={layer}
              nodeId={childId}
              siblingCount={childIds.length}
              siblingIndex={index}
              visited={nextVisited}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function AiPanel({
  graph,
  resetKey,
  onScene,
  setBusyOverlay,
}: {
  graph: SceneGraph | null
  resetKey: number
  onScene: (graph: SceneGraph, name: string) => void
  setBusyOverlay: (overlay: BusyOverlay) => void
}) {
  const [draft, setDraft] = useState('')
  const [messages, setMessages] = useState<AiChatMessage[]>([])
  const [conversationId, setConversationId] = useState<string | null>(null)
  const [status, setStatus] = useState<AiStatus>('idle')
  const [thinkingStartedAt, setThinkingStartedAt] = useState<number | null>(null)
  const [thinkingTextIndex, setThinkingTextIndex] = useState(0)
  const [modelInfo, setModelInfo] = useState<AiModelInfo | null>(null)
  const [modelInfoError, setModelInfoError] = useState<string | null>(null)
  const [selectedProvider, setSelectedProvider] = useState<AiProviderId | null>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (resetKey === 0) return
    setStatus('idle')
    setDraft('')
    setMessages([])
    setConversationId(null)
    setThinkingStartedAt(null)
    setThinkingTextIndex(0)
  }, [resetKey])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ block: 'end' })
  })

  useEffect(() => {
    if (status !== 'generating' || thinkingStartedAt == null) return

    const tick = () => {
      const elapsedMs = Date.now() - thinkingStartedAt
      setThinkingTextIndex(Math.floor(elapsedMs / 1600) % AI_THINKING_UPDATES.length)
    }

    tick()
    const timer = window.setInterval(tick, 400)
    return () => window.clearInterval(timer)
  }, [status, thinkingStartedAt])

  useEffect(() => {
    if (status !== 'generating') return
    const thinkingText = AI_THINKING_UPDATES[thinkingTextIndex] ?? AI_THINKING_UPDATES[0]
    setBusyOverlay({
      title: 'Thinking with AI',
      detail: thinkingText,
    })
  }, [setBusyOverlay, status, thinkingTextIndex])

  useEffect(() => {
    let cancelled = false

    async function loadModelInfo() {
      try {
        const response = await fetch('/api/ai/model-info', { cache: 'no-store' })
        const payload = (await response.json()) as AiModelInfo & { error?: string }
        if (!response.ok) throw new Error(payload.error ?? 'Could not load model info')
        if (cancelled) return
        setModelInfo(payload)
        setSelectedProvider((current) => {
          const options = getAiModelOptions(payload)
          if (current && options.some((option) => option.provider === current)) return current
          return getDefaultAiProvider(payload)
        })
        setModelInfoError(null)
      } catch (err) {
        if (cancelled) return
        setModelInfo(null)
        setModelInfoError(err instanceof Error ? err.message : 'Could not load model info')
      }
    }

    void loadModelInfo()
    return () => {
      cancelled = true
    }
  }, [])

  const modelOptions = useMemo(() => getAiModelOptions(modelInfo), [modelInfo])
  const selectedModelOption = useMemo(
    () =>
      modelOptions.find((option) => option.provider === selectedProvider) ??
      modelOptions[0] ??
      null,
    [modelOptions, selectedProvider],
  )
  const modelLabel =
    selectedModelOption?.label ?? modelInfo?.label ?? (modelInfoError ? 'Unavailable' : 'Checking...')
  const modelConfigurationError =
    selectedModelOption?.configurationError ?? modelInfo?.configurationError ?? modelInfoError
  const modelConfigured =
    selectedModelOption?.configured ?? (modelInfo ? modelInfo.configured : !modelInfoError)

  async function sendMessage(nextPrompt = draft) {
    const trimmed = nextPrompt.trim()
    if (!trimmed || status === 'generating' || !modelConfigured) return

    const userMessage: AiChatMessage = {
      id: createAiMessageId('user'),
      role: 'user',
      content: trimmed,
    }
    const history = getAiConversationHistory(messages)
    const nextConversationId = conversationId ?? createAiMessageId('conversation')
    if (!conversationId) setConversationId(nextConversationId)

    setStatus('generating')
    setDraft('')
    setThinkingStartedAt(Date.now())
    setThinkingTextIndex(0)
    setMessages((current) => [...current, userMessage])
    setBusyOverlay({ title: 'Thinking with AI', detail: AI_THINKING_UPDATES[0] })

    try {
      const response = await fetch('/api/ai/scene-agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: trimmed,
          graph: graph ?? undefined,
          conversationId: nextConversationId,
          history,
          aiProvider: selectedModelOption?.provider,
          aiModel: selectedModelOption?.model,
        }),
      })
      const payload = (await response.json()) as Ai3DResponse
      if (!response.ok) {
        throw new Error(payload.message ?? payload.error ?? 'Generation failed')
      }
      if (payload.graph) {
        onScene(payload.graph, payload.title ?? 'Generated Scene')
      }

      const stats = {
        steps: payload.steps ?? payload.actions?.length ?? 0,
        reads: payload.reads ?? 0,
        changes: payload.changes ?? 0,
      }
      const assistantMessage: AiChatMessage = {
        id: createAiMessageId('assistant'),
        role: 'assistant',
        content: payload.message || 'Done.',
        title: payload.title ?? undefined,
        stats,
      }
      setMessages((current) => [...current, assistantMessage])
      setStatus('ready')
    } catch (err) {
      const errorMessage: AiChatMessage = {
        id: createAiMessageId('assistant-error'),
        role: 'assistant',
        content: err instanceof Error ? err.message : 'Generation failed',
        variant: 'error',
      }
      setMessages((current) => [...current, errorMessage])
      setStatus('error')
    } finally {
      setThinkingStartedAt(null)
      setThinkingTextIndex(0)
      setBusyOverlay(null)
    }
  }

  const isGenerating = status === 'generating'
  const thinkingText = AI_THINKING_UPDATES[thinkingTextIndex] ?? AI_THINKING_UPDATES[0]
  const modelPicker = (
    <div className="flex min-w-0 items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2 text-[11px] leading-5 text-slate-400 shadow-sm">
      <span className="shrink-0 font-semibold uppercase">Model</span>
      <div className="flex min-w-0 flex-1 flex-col items-end gap-1">
        {modelOptions.length > 0 ? (
          <select
            aria-label="AI model"
            className={[
              'h-8 w-full max-w-60 min-w-0 rounded-md border bg-white px-2 font-semibold text-xs outline-none transition-colors',
              modelConfigurationError
                ? 'border-amber-300 text-amber-700 focus:border-amber-400 focus:ring-2 focus:ring-amber-400/20'
                : 'border-slate-200 text-slate-600 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20',
            ].join(' ')}
            disabled={isGenerating}
            onChange={(event) => setSelectedProvider(event.target.value as AiProviderId)}
            title={modelConfigurationError ?? modelLabel}
            value={selectedModelOption?.provider ?? ''}
          >
            {modelOptions.map((option) => (
              <option disabled={!option.configured} key={option.provider} value={option.provider}>
                {option.label}
              </option>
            ))}
          </select>
        ) : (
          <span
            className={[
              'min-w-0 truncate text-right font-mono',
              modelConfigurationError ? 'text-amber-600' : 'text-slate-500',
            ].join(' ')}
            title={modelConfigurationError ?? modelLabel}
          >
            {modelLabel}
          </span>
        )}
        {modelConfigurationError && (
          <span className="max-w-60 truncate text-right text-amber-600">
            {modelConfigurationError}
          </span>
        )}
      </div>
    </div>
  )

  return (
    <div className="flex min-h-0 flex-col gap-4">
      <div>
        <h1 className="font-bold text-2xl tracking-normal">Conversational AI</h1>
        <p className="mt-1 max-w-xl text-slate-600 text-sm leading-6">
          Ask, refine, and build the scene in context.
        </p>
      </div>

      {modelPicker}

      <div className="flex min-h-[420px] flex-col overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
        <div className="flex max-h-[46vh] min-h-72 flex-1 flex-col gap-3 overflow-y-auto p-4">
          {messages.length === 0 ? (
            <div className="flex flex-1 items-center justify-center p-6 text-center">
              <div className="max-w-56">
                <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-md bg-blue-50 text-blue-600">
                  <MessageSquare className="h-5 w-5" />
                </div>
                <p className="mt-3 font-semibold text-slate-800 text-sm">No messages yet</p>
              </div>
            </div>
          ) : (
            messages.map((chatMessage) => {
              const fromUser = chatMessage.role === 'user'
              return (
                <div
                  className={['flex', fromUser ? 'justify-end' : 'justify-start'].join(' ')}
                  key={chatMessage.id}
                >
                  <div
                    className={[
                      'max-w-[88%] rounded-lg px-3 py-2 text-sm shadow-sm',
                      fromUser
                        ? 'bg-blue-600 text-white'
                        : chatMessage.variant === 'error'
                          ? 'border border-red-200 bg-red-50 text-red-800'
                          : 'border border-slate-200 bg-slate-50 text-slate-700',
                    ].join(' ')}
                  >
                    {chatMessage.title && !fromUser && (
                      <p className="mb-1 font-semibold text-slate-900">{chatMessage.title}</p>
                    )}
                    <p className="whitespace-pre-wrap break-words leading-6">
                      {chatMessage.content}
                    </p>
                    {chatMessage.stats && !fromUser && (
                      <p className="mt-2 text-[11px] text-slate-400">
                        {chatMessage.stats.steps} steps - {chatMessage.stats.reads} reads -{' '}
                        {chatMessage.stats.changes} changes
                      </p>
                    )}
                  </div>
                </div>
              )
            })
          )}
          {isGenerating && (
            <div className="flex justify-start">
              <div className="min-w-52 max-w-[88%] rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-slate-700 text-sm shadow-sm">
                <div className="inline-flex items-center gap-2 text-slate-600">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Thinking
                </div>
                <p className="mt-1 min-h-5 text-slate-500 text-xs">{thinkingText}</p>
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        <form
          className="border-slate-200 border-t p-3"
          onSubmit={(event) => {
            event.preventDefault()
            void sendMessage()
          }}
        >
          <label className="sr-only" htmlFor="ai-chat-message">
            Message
          </label>
          <div className="flex items-end gap-2">
            <textarea
              className="max-h-32 min-h-11 flex-1 resize-none rounded-md border border-slate-300 bg-white px-3 py-2 text-slate-900 text-sm outline-none transition-colors placeholder:text-slate-400 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20"
              disabled={isGenerating || !modelConfigured}
              id="ai-chat-message"
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault()
                  void sendMessage()
                }
              }}
              placeholder="Ask Babel..."
              rows={1}
              value={draft}
            />
            <button
              aria-label="Send message"
              className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md bg-blue-600 text-white shadow-sm transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
              disabled={isGenerating || !draft.trim() || !modelConfigured}
              type="submit"
            >
              {isGenerating ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Send className="h-4 w-4" />
              )}
            </button>
          </div>
        </form>
      </div>

      <div>
        <p className="mb-2 font-semibold text-slate-400 text-xs uppercase tracking-wide">
          Starter templates
        </p>
        <div className="grid grid-cols-2 gap-2">
          {STARTER_TEMPLATES.map((template) => {
            const Icon = template.icon
            return (
              <button
                className={[
                  'group flex h-20 min-w-0 flex-col items-start justify-between rounded-lg border border-slate-200 bg-white p-3 text-left shadow-sm transition-colors disabled:opacity-50',
                  template.shellClass,
                ].join(' ')}
                disabled={isGenerating || !modelConfigured}
                key={template.id}
                onClick={() => void sendMessage(template.prompt)}
                title={template.prompt}
                type="button"
              >
                <span
                  className={[
                    'flex h-8 w-8 items-center justify-center rounded-md transition-transform group-hover:scale-105',
                    template.iconClass,
                  ].join(' ')}
                >
                  <Icon className="h-4 w-4" />
                </span>
                <span className="max-w-full truncate font-semibold text-slate-800 text-sm">
                  {template.title}
                </span>
              </button>
            )
          })}
        </div>
      </div>

      <div>
        <p className="mb-2 font-semibold text-slate-400 text-xs uppercase tracking-wide">
          Suggestions
        </p>
        <div className="grid grid-cols-2 gap-2">
          {EXAMPLES.map((example) => (
            <button
              className="h-9 min-w-0 truncate rounded-full border border-slate-200 bg-white px-3 text-center font-semibold text-slate-600 text-xs shadow-sm transition-colors hover:border-blue-300 hover:bg-blue-50 hover:text-blue-700 disabled:opacity-50"
              disabled={isGenerating || !modelConfigured}
              key={example}
              onClick={() => void sendMessage(example)}
              title={example}
              type="button"
            >
              {example}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

function ModelIoPanel({
  exportError,
  exportScene,
  exportingFormat,
  hasExportableContent,
  importedModel,
  importedModelReady,
  isPreparingModelImport,
  modelError,
  modelPlacementPending,
  onClearImportedModel,
  onExport,
  onImportFile,
}: {
  exportError: string | null
  exportScene: ExportSceneFn | null
  exportingFormat: ExportFormat | null
  hasExportableContent: boolean
  importedModel: ImportedModelAsset | null
  importedModelReady: boolean
  isPreparingModelImport: boolean
  modelError: string | null
  modelPlacementPending: boolean
  onClearImportedModel: () => void
  onExport: (format: ExportFormat) => void
  onImportFile: (file: File) => void | Promise<void>
}) {
  const [isDragging, setIsDragging] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const canExport = hasExportableContent && Boolean(exportScene) && exportingFormat === null

  const pickFile = useCallback(
    (file: File | undefined) => {
      if (!file || isPreparingModelImport) return
      void onImportFile(file)
      if (inputRef.current) inputRef.current.value = ''
    },
    [isPreparingModelImport, onImportFile],
  )

  const handleDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault()
      setIsDragging(false)
      pickFile(event.dataTransfer.files[0])
    },
    [pickFile],
  )

  return (
    <div className="flex min-h-0 flex-col gap-4">
      <div>
        <h1 className="font-bold text-2xl tracking-normal">3D File Import / Export</h1>
        <p className="mt-1 max-w-xl text-slate-600 text-sm leading-6">
          GLB, GLTF, STL, and OBJ assets for the shared 3D scene.
        </p>
      </div>

      <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
        <p className="mb-3 font-semibold text-slate-400 text-xs uppercase tracking-wide">Export</p>
        <div className="grid gap-2">
          {EXPORT_FORMATS.map(({ format, label }) => {
            const isExporting = exportingFormat === format
            return (
              <button
                className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-md border border-slate-300 bg-white px-3 font-semibold text-slate-700 text-sm shadow-sm transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                disabled={!canExport}
                key={format}
                onClick={() => onExport(format)}
                type="button"
              >
                {isExporting ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Download className="h-4 w-4" />
                )}
                Export {label}
              </button>
            )
          })}
        </div>
        {exportError && <p className="mt-3 text-red-600 text-xs">{exportError}</p>}
        {!hasExportableContent && (
          <p className="mt-3 text-slate-400 text-xs">
            Load an AI scene, IFC conversion, or imported model first.
          </p>
        )}
      </div>

      <div
        className={[
          'rounded-lg border-2 border-dashed p-4 text-center transition-all',
          isDragging
            ? 'scale-[1.01] border-blue-500 bg-blue-50'
            : 'border-slate-300 bg-white hover:border-slate-400',
        ].join(' ')}
        onDragLeave={(event) => {
          event.preventDefault()
          setIsDragging(false)
        }}
        onDragOver={(event) => {
          event.preventDefault()
          setIsDragging(true)
        }}
        onDrop={handleDrop}
      >
        <label className="inline-flex cursor-pointer items-center gap-2">
          <input
            accept={MODEL_IMPORT_ACCEPT}
            className="hidden"
            disabled={isPreparingModelImport}
            onChange={(event) => pickFile(event.target.files?.[0])}
            ref={inputRef}
            type="file"
          />
          <UploadCloud className="h-5 w-5 text-slate-400" />
          <span className="text-slate-600 text-sm">
            {isPreparingModelImport ? (
              'Preparing import...'
            ) : (
              <>
                Drop GLB, GLTF, STL, or OBJ here or{' '}
                <span className="font-medium text-blue-600">browse</span>
              </>
            )}
          </span>
        </label>
      </div>

      {modelError && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-red-700 text-sm">
          <span className="font-semibold">Error:</span> {modelError}
        </div>
      )}

      {importedModel && (
        <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="mb-1 font-semibold text-slate-400 text-xs uppercase tracking-wide">
                Imported model
              </p>
              <p className="truncate font-semibold text-slate-900 text-sm">{importedModel.name}</p>
              <p className="mt-1 text-slate-500 text-xs">
                {importedModel.format.toUpperCase()} - {formatFileSize(importedModel.size)}
              </p>
              <p className="mt-2 text-slate-400 text-xs">
                {modelPlacementPending
                  ? 'Ready to place on grid'
                  : importedModelReady
                    ? 'Placed in scene'
                    : 'Preparing placement'}
              </p>
            </div>
            <button
              className="rounded-md p-1 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
              onClick={onClearImportedModel}
              type="button"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function PlacementThumbnail({
  modelPath,
  thumbnailPath,
}: {
  modelPath: string | null
  thumbnailPath: string | null
}) {
  const previewRef = useRef<HTMLDivElement | null>(null)
  const [renderModelPreview, setRenderModelPreview] = useState(false)

  useEffect(() => {
    if (!modelPath) {
      setRenderModelPreview(false)
      return
    }

    const element = previewRef.current
    if (!element) return

    if (typeof IntersectionObserver === 'undefined') {
      setRenderModelPreview(true)
      return
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        setRenderModelPreview(Boolean(entry?.isIntersecting))
      },
      { rootMargin: '120px' },
    )

    observer.observe(element)
    return () => observer.disconnect()
  }, [modelPath])

  if (!(modelPath || thumbnailPath)) {
    return (
      <div className="flex h-16 w-16 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-500 transition-transform group-hover:scale-105">
        <Package className="h-8 w-8" />
      </div>
    )
  }

  return (
    <div
      className="relative h-full w-full overflow-hidden bg-[radial-gradient(circle_at_50%_35%,#ffffff_0%,#f8fafc_52%,#e5ebf3_100%)]"
      ref={previewRef}
    >
      {thumbnailPath && !modelPath && (
        <img
          alt=""
          className="absolute inset-0 h-full w-full object-contain p-2 transition-transform group-hover:scale-105"
          draggable={false}
          src={thumbnailPath}
        />
      )}
      {modelPath && !renderModelPreview && (
        <div className="absolute inset-0 flex items-center justify-center text-slate-400">
          <Package className="h-8 w-8" />
        </div>
      )}
      {modelPath && renderModelPreview && (
        <div className="pointer-events-none absolute inset-0 transition-transform group-hover:scale-105">
          <Canvas
            camera={{ fov: 32, near: 0.1, far: 100, position: [2.6, 1.8, 3.4] }}
            dpr={[1, 1.5]}
            frameloop="demand"
            gl={{ alpha: false, antialias: true, powerPreference: 'low-power' }}
          >
            <color args={['#f8fafc']} attach="background" />
            <PlacementPreviewCamera />
            <ambientLight intensity={1.6} />
            <directionalLight intensity={2.4} position={[3, 5, 4]} />
            <directionalLight intensity={0.8} position={[-3, 2, -2]} />
            <Suspense fallback={null}>
              <PlacementThumbnailModel modelPath={modelPath} />
            </Suspense>
          </Canvas>
        </div>
      )}
    </div>
  )
}

function PlacementPreviewCamera() {
  const camera = useThree((state) => state.camera)
  const invalidate = useThree((state) => state.invalidate)

  useEffect(() => {
    camera.position.set(2.8, 2.1, 4.2)
    camera.lookAt(0, 0, 0)
    camera.updateProjectionMatrix()
    invalidate()
  }, [camera, invalidate])

  return null
}

function PlacementThumbnailModel({ modelPath }: { modelPath: string }) {
  const { scene } = useGLTFKTX2(modelPath) as { scene: Object3D }
  const preview = useMemo(() => {
    const object = scene.clone(true)
    const box = new Box3().setFromObject(object)
    const size = new Vector3()
    const center = new Vector3()
    box.getSize(size)
    box.getCenter(center)

    const maxSide = Math.max(size.x, size.y, size.z, 0.001)
    const scale = 2.15 / maxSide
    return {
      object,
      position: [-center.x * scale, -center.y * scale, -center.z * scale] as [
        number,
        number,
        number,
      ],
      scale,
    }
  }, [scene])

  return (
    <group rotation={[0, -0.35, 0]}>
      <primitive object={preview.object} position={preview.position} scale={preview.scale} />
    </group>
  )
}

function PlacementPanel({
  activeItemId,
  error,
  placementPending,
  onPlace,
}: {
  activeItemId: string | null
  error: string | null
  placementPending: boolean
  onPlace: (item: LocalPlacementItem) => void
}) {
  const [activeCategory, setActiveCategory] = useState<PlacementCategoryId>('interior')
  const [query, setQuery] = useState('')

  const filteredItems = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase()
    return LOCAL_PLACEMENT_ITEMS.filter((item) => {
      if (item.category !== activeCategory) return false
      if (!normalizedQuery) return true
      return (
        item.name.toLowerCase().includes(normalizedQuery) ||
        item.id.includes(normalizedQuery) ||
        item.tags?.some((tag) => tag.includes(normalizedQuery))
      )
    })
  }, [activeCategory, query])

  const activeItem = activeItemId
    ? LOCAL_PLACEMENT_ITEMS.find((item) => item.id === activeItemId)
    : null

  return (
    <div className="flex min-h-0 flex-col gap-4">
      <div>
        <h1 className="font-bold text-2xl tracking-normal">Placement System</h1>
        <p className="mt-1 max-w-xl text-slate-600 text-sm leading-6">
          Select an asset or build segment, then click the grid to place it in the 3D scene.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-1 rounded-lg bg-slate-100 p-1 sm:grid-cols-4">
        {PLACEMENT_CATEGORIES.map((category) => {
          const active = activeCategory === category.id
          return (
            <button
              aria-pressed={active}
              className={[
                'h-9 rounded-md px-2 font-semibold text-xs transition-colors',
                active
                  ? 'bg-white text-orange-600 shadow-sm'
                  : 'text-slate-500 hover:bg-white/70 hover:text-slate-800',
              ].join(' ')}
              key={category.id}
              onClick={() => setActiveCategory(category.id)}
              type="button"
            >
              {category.label}
            </button>
          )
        })}
      </div>

      <div className="relative">
        <Search className="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-slate-400" />
        <input
          className="h-10 w-full rounded-md border border-slate-300 bg-white pr-3 pl-9 text-sm outline-none transition-colors placeholder:text-slate-400 focus:border-orange-400 focus:ring-2 focus:ring-orange-400/20"
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search assets..."
          type="text"
          value={query}
        />
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-red-700 text-sm">
          <span className="font-semibold">Error:</span> {error}
        </div>
      )}

      {placementPending && activeItem && (
        <div className="rounded-lg border border-orange-200 bg-orange-50 p-3 text-orange-800 text-sm">
          {getPlacementReadyMessage(activeItem)}
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {filteredItems.map((item) => {
          const active = activeItemId === item.id
          const thumbnailPath = getPlacementThumbnailPath(item)
          const modelPath = getPlacementModelPath(item)
          return (
            <button
              aria-pressed={active}
              className={[
                'group flex min-h-36 flex-col rounded-lg border bg-white p-2 text-left shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md',
                active
                  ? 'border-orange-300 ring-2 ring-orange-200'
                  : 'border-slate-200 hover:border-orange-200',
              ].join(' ')}
              key={item.id}
              onClick={() => onPlace(item)}
              type="button"
            >
              <div className="flex aspect-square w-full items-center justify-center overflow-hidden rounded-md bg-slate-50">
                <PlacementThumbnail modelPath={modelPath} thumbnailPath={thumbnailPath} />
              </div>
              <span
                className={[
                  'mt-2 max-h-10 min-h-9 overflow-hidden break-words font-semibold text-sm leading-tight',
                  active ? 'text-orange-600' : 'text-slate-800',
                ].join(' ')}
              >
                {item.name}
              </span>
            </button>
          )
        })}
      </div>

      {filteredItems.length === 0 && (
        <div className="rounded-lg border border-slate-200 bg-white p-6 text-center text-slate-400 text-sm">
          No assets match that search.
        </div>
      )}
    </div>
  )
}

function IfcPanel({
  placementPending,
  resetKey,
  selectedNodeId,
  onPlacementReady,
  setBusyOverlay,
  setSelectedNodeId,
}: {
  placementPending: boolean
  resetKey: number
  selectedNodeId: string | null
  onPlacementReady: (graph: SceneGraph, name: string) => void
  setBusyOverlay: (overlay: BusyOverlay) => void
  setSelectedNodeId: (nodeId: string | null) => void
}) {
  const [convertedGraph, setConvertedGraph] = useState<SceneGraph | null>(null)
  const [status, setStatus] = useState<IfcStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const [fileName, setFileName] = useState('')
  const [ifcData, setIfcData] = useState<Uint8Array | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [conversionProgress, setConversionProgress] = useState(0)
  const [conversionMessage, setConversionMessage] = useState('')

  const visualSummary = useMemo(() => getIfcVisualImportSummary(convertedGraph), [convertedGraph])

  const typeCounts = useMemo(() => {
    if (visualSummary) return visualSummary.typeCounts
    if (!convertedGraph) return {}
    const counts: Record<string, number> = {}
    for (const node of Object.values(convertedGraph.nodes)) {
      counts[node.type] = (counts[node.type] ?? 0) + 1
    }
    return counts
  }, [convertedGraph, visualSummary])

  const searchResults = useMemo(() => {
    if (!convertedGraph || !searchQuery.trim()) return []
    const q = searchQuery.toLowerCase()
    const results: { id: string; name: string; type: string; match: string }[] = []
    for (const node of Object.values(convertedGraph.nodes)) {
      if (['site', 'building', 'level'].includes(node.type)) continue
      const m = meta(node)
      let match: string | null = null
      if (node.name?.toLowerCase().includes(q)) match = `Name: ${node.name}`
      else if (node.type.includes(q)) match = `Type: ${node.type}`
      else if (m.ifcType?.toLowerCase().includes(q)) match = `IFC: ${m.ifcType}`
      else if (m.typeName?.toLowerCase().includes(q)) match = `Type: ${m.typeName}`
      else if (m.material?.toLowerCase().includes(q)) match = `Material: ${m.material}`
      else if (m.globalId?.toLowerCase().includes(q)) match = `ID: ${m.globalId}`
      else if (m.properties) {
        for (const [psetName, props] of Object.entries(m.properties)) {
          for (const [key, value] of Object.entries(props)) {
            if (key.toLowerCase().includes(q) || String(value).toLowerCase().includes(q)) {
              match = `${psetName}: ${key} = ${value}`
              break
            }
          }
          if (match) break
        }
      }
      if (match) {
        results.push({ id: node.id, name: node.name ?? node.id, type: node.type, match })
        if (results.length >= 50) break
      }
    }
    return results
  }, [convertedGraph, searchQuery])

  const loadAndConvert = useCallback(
    async (data: Uint8Array, name: string) => {
      setFileName(name)
      setStatus('converting')
      setSearchQuery('')
      setSelectedNodeId(null)
      setConversionProgress(0)
      setConversionMessage('Starting conversion...')
      setBusyOverlay({ title: 'Converting IFC', detail: 'Starting conversion...', progress: 0 })

      try {
        const nextGraph = await createIfcVisualImportSceneGraph(data, name, (message, percent) => {
          setConversionMessage(message)
          const mappedPercent = Math.round(percent)
          setConversionProgress(mappedPercent)
          setBusyOverlay({ title: 'Converting IFC', detail: message, progress: mappedPercent })
        })

        setConvertedGraph(nextGraph)
        onPlacementReady(nextGraph, name)
        setStatus('ready')
        setConversionProgress(100)
        setConversionMessage('Conversion complete')
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Conversion failed')
        setStatus('error')
        setConversionProgress(0)
      } finally {
        setBusyOverlay(null)
      }
    },
    [onPlacementReady, setBusyOverlay, setSelectedNodeId],
  )

  useEffect(() => {
    if (resetKey === 0) return
    setConvertedGraph(null)
    setStatus('idle')
    setError(null)
    setFileName('')
    setIfcData(null)
    setSearchQuery('')
    setSearchOpen(false)
    setConversionProgress(0)
    setConversionMessage('')
  }, [resetKey])

  const handleFile = useCallback(
    async (file: File) => {
      setStatus('loading')
      setError(null)

      const params = new URLSearchParams(window.location.search)
      if (params.has('file')) {
        params.delete('file')
        const qs = params.toString()
        const newUrl = `${window.location.pathname}${qs ? `?${qs}` : ''}${window.location.hash}`
        window.history.replaceState(null, '', newUrl)
      }

      try {
        const arrayBuffer = await file.arrayBuffer()
        const uint8Array = new Uint8Array(arrayBuffer)
        setIfcData(uint8Array)
        await loadAndConvert(uint8Array, file.name)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load file')
        setStatus('error')
        setBusyOverlay(null)
      }
    },
    [loadAndConvert, setBusyOverlay],
  )

  const handleDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault()
      setIsDragging(false)
      const file = event.dataTransfer.files[0]
      if (file?.name.toLowerCase().endsWith('.ifc')) {
        void handleFile(file)
      } else {
        setError('Please drop a valid IFC file')
      }
    },
    [handleFile],
  )

  const handleFileInput = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (file) void handleFile(file)
  }

  function downloadIfc() {
    if (!ifcData) return
    const blob = new Blob([ifcData as any], { type: 'application/octet-stream' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = fileName
    a.click()
    URL.revokeObjectURL(url)
  }

  function downloadSceneGraphJson() {
    if (!convertedGraph) return
    downloadJson(convertedGraph, `${fileName.replace('.ifc', '')}_scene-graph.json`)
  }

  const selectedNode = selectedNodeId
    ? (convertedGraph?.nodes as Record<string, Record<string, any>> | undefined)?.[selectedNodeId]
    : null

  return (
    <div className="flex min-h-0 flex-col gap-4">
      <div>
        <h1 className="font-bold text-2xl tracking-normal">IFC Converter</h1>
        <p className="mt-1 max-w-xl text-slate-600 text-sm leading-6">
          Upload an IFC building model to convert and inspect it in the shared 3D scene.
        </p>
      </div>

      <div
        className={[
          'rounded-lg border-2 border-dashed p-4 text-center transition-all',
          isDragging
            ? 'scale-[1.01] border-blue-500 bg-blue-50'
            : 'border-slate-300 bg-white hover:border-slate-400',
        ].join(' ')}
        onDragLeave={(event) => {
          event.preventDefault()
          setIsDragging(false)
        }}
        onDragOver={(event) => {
          event.preventDefault()
          setIsDragging(true)
        }}
        onDrop={handleDrop}
      >
        <label className="inline-flex cursor-pointer items-center gap-2">
          <input accept=".ifc" className="hidden" onChange={handleFileInput} type="file" />
          <UploadCloud className="h-5 w-5 text-slate-400" />
          <span className="text-slate-600 text-sm">
            Drop an IFC file here or <span className="font-medium text-blue-600">browse</span>
          </span>
        </label>
      </div>

      {status === 'converting' && (
        <div className="rounded-lg border border-blue-200 bg-white p-4 shadow-sm">
          <div className="flex items-center justify-between text-xs">
            <span className="truncate text-slate-500">{conversionMessage}</span>
            <span className="font-semibold text-blue-600">{conversionProgress}%</span>
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-200">
            <div
              className="h-full rounded-full bg-blue-600 transition-all duration-300"
              style={{ width: `${conversionProgress}%` }}
            />
          </div>
        </div>
      )}

      {status === 'error' && error && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-red-700 text-sm">
          <span className="font-semibold">Error:</span> {error}
        </div>
      )}

      {placementPending && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-amber-800 text-sm">
          IFC is ready. Move over the grid and click to place it in the scene.
        </div>
      )}

      {convertedGraph && (
        <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
          <p className="mb-3 font-semibold text-slate-400 text-xs uppercase tracking-wide">
            {visualSummary ? 'Visual model' : 'Semantic data'}
          </p>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="truncate font-semibold text-slate-900 text-sm">{fileName}</p>
              <p className="text-slate-400 text-xs">
                {visualSummary
                  ? visualSummary.meshCount != null
                    ? `${visualSummary.productCount} products - ${visualSummary.meshCount} meshes`
                    : `${visualSummary.productCount} products - ${Object.keys(visualSummary.typeCounts).length} IFC types`
                  : `${Object.keys(convertedGraph.nodes).length} nodes - ${
                      Object.keys(typeCounts).length
                    } types`}
              </p>
              {visualSummary && (
                <p className="text-slate-400 text-xs">
                  {visualSummary.triangleCount.toLocaleString()} triangles
                  {visualSummary.skippedInteriorCount != null
                    ? ` - skipped ${visualSummary.skippedInteriorCount.toLocaleString()} interiors`
                    : ''}
                </p>
              )}
            </div>
            <div className="flex gap-2">
              <button
                className="inline-flex h-8 items-center gap-1.5 rounded-md border border-slate-300 bg-white px-2.5 font-semibold text-slate-700 text-xs hover:bg-slate-50 disabled:opacity-50"
                disabled={!ifcData}
                onClick={downloadIfc}
                type="button"
              >
                <Download className="h-3.5 w-3.5" />
                IFC
              </button>
              <button
                className="inline-flex h-8 items-center gap-1.5 rounded-md bg-blue-600 px-2.5 font-semibold text-white text-xs hover:bg-blue-700"
                onClick={downloadSceneGraphJson}
                type="button"
              >
                <Download className="h-3.5 w-3.5" />
                JSON
              </button>
            </div>
          </div>

          <div className="mt-3 flex flex-wrap gap-1.5">
            {Object.entries(typeCounts)
              .slice(0, 10)
              .map(([type, count]) => (
                <span
                  className="rounded-md bg-slate-100 px-2 py-1 font-semibold text-slate-600 text-xs"
                  key={type}
                >
                  {count} {type}
                </span>
              ))}
          </div>
        </div>
      )}

      {convertedGraph && !visualSummary && (
        <div>
          <p className="mb-2 font-semibold text-slate-400 text-xs uppercase tracking-wide">
            Search elements
          </p>
          <div className="relative">
            <Search className="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              className="w-full rounded-md border border-slate-300 bg-white py-2 pr-9 pl-9 text-sm outline-none transition-colors focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20"
              onBlur={() => setTimeout(() => setSearchOpen(false), 200)}
              onChange={(event) => {
                setSearchQuery(event.target.value)
                setSearchOpen(true)
              }}
              onFocus={() => setSearchOpen(true)}
              placeholder="Search converted elements..."
              type="text"
              value={searchQuery}
            />
            {searchQuery && (
              <button
                className="absolute top-1/2 right-3 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                onClick={() => {
                  setSearchQuery('')
                  setSearchOpen(false)
                }}
                type="button"
              >
                <X className="h-4 w-4" />
              </button>
            )}
            {searchOpen && searchQuery.trim() && (
              <div className="absolute z-20 mt-1 max-h-64 w-full overflow-y-auto rounded-lg border border-slate-200 bg-white shadow-lg">
                {searchResults.length === 0 ? (
                  <div className="px-3 py-4 text-center text-slate-400 text-sm">No results</div>
                ) : (
                  searchResults.map((result) => (
                    <button
                      className={[
                        'w-full border-slate-100 border-b px-3 py-2 text-left last:border-0 hover:bg-blue-50',
                        selectedNodeId === result.id ? 'bg-blue-50' : '',
                      ].join(' ')}
                      key={result.id}
                      onClick={() => {
                        setSelectedNodeId(result.id)
                        setSearchOpen(false)
                      }}
                      type="button"
                    >
                      <div className="flex items-center gap-2">
                        <span className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-slate-500 text-xs">
                          {result.type}
                        </span>
                        <span className="truncate text-slate-900 text-sm">{result.name}</span>
                      </div>
                      <p className="mt-0.5 truncate text-slate-400 text-xs">{result.match}</p>
                    </button>
                  ))
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {selectedNode && (
        <IfcInspector
          graph={convertedGraph}
          node={selectedNode as Record<string, any>}
          onClose={() => setSelectedNodeId(null)}
        />
      )}
    </div>
  )
}

function IfcInspector({
  graph,
  node,
  onClose,
}: {
  graph: SceneGraph | null
  node: Record<string, any>
  onClose: () => void
}) {
  const nodeMeta = meta(node)
  const Row = ({ k, v }: { k: string; v: string }) => (
    <div className="flex justify-between gap-2 text-xs">
      <span className="shrink-0 text-slate-500">{k}</span>
      <span className="truncate text-right font-mono text-slate-900" title={v}>
        {v}
      </span>
    </div>
  )

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-center justify-between">
        <h3 className="truncate font-semibold text-slate-900 text-sm">{node.name ?? node.type}</h3>
        <button
          className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
          onClick={onClose}
          type="button"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="mt-3 space-y-1 border-slate-100 border-b pb-3">
        <Row k="Type" v={String(node.type)} />
        {nodeMeta.typeName && <Row k="Type Name" v={nodeMeta.typeName} />}
        {nodeMeta.ifcType && <Row k="IFC Type" v={nodeMeta.ifcType} />}
        {nodeMeta.globalId && <Row k="Global ID" v={nodeMeta.globalId} />}
        {nodeMeta.expressID != null && <Row k="Express ID" v={String(nodeMeta.expressID)} />}
        {nodeMeta.levelId && (
          <Row
            k="Level"
            v={
              (graph?.nodes as Record<string, { name?: string }> | undefined)?.[nodeMeta.levelId]
                ?.name ?? nodeMeta.levelId
            }
          />
        )}
      </div>

      {(node.start ||
        node.thickness != null ||
        node.height != null ||
        node.width != null ||
        node.elevation != null ||
        node.polygon) && (
        <div className="space-y-1 border-slate-100 border-b py-3">
          <p className="font-semibold text-slate-500 text-xs uppercase tracking-wide">Geometry</p>
          {node.start && (
            <Row k="Start" v={`[${node.start.map((v: number) => v.toFixed(2)).join(', ')}]`} />
          )}
          {node.end && (
            <Row k="End" v={`[${node.end.map((v: number) => v.toFixed(2)).join(', ')}]`} />
          )}
          {node.thickness != null && <Row k="Thickness" v={`${node.thickness.toFixed(3)} m`} />}
          {node.height != null && <Row k="Height" v={`${node.height.toFixed(3)} m`} />}
          {node.width != null && <Row k="Width" v={`${node.width.toFixed(3)} m`} />}
          {node.position != null && node.type !== 'wall' && (
            <Row
              k="Position"
              v={`[${node.position.map((v: number) => v.toFixed(2)).join(', ')}]`}
            />
          )}
          {node.elevation != null && <Row k="Elevation" v={`${node.elevation.toFixed(3)} m`} />}
          {node.sillHeight != null && <Row k="Sill Height" v={`${node.sillHeight.toFixed(3)} m`} />}
          {node.polygon && <Row k="Polygon" v={`${node.polygon.length} points`} />}
        </div>
      )}

      {(nodeMeta.material || nodeMeta.materialLayers) && (
        <div className="space-y-1 border-slate-100 border-b py-3">
          <p className="font-semibold text-slate-500 text-xs uppercase tracking-wide">Material</p>
          {nodeMeta.material && <Row k="Name" v={nodeMeta.material} />}
          {nodeMeta.materialLayers?.map((layer, index) => (
            <Row
              key={`${layer.name}-${index}`}
              k={layer.name}
              v={layer.thickness != null ? `${(layer.thickness * 1000).toFixed(0)} mm` : '-'}
            />
          ))}
        </div>
      )}

      {nodeMeta.properties &&
        Object.entries(nodeMeta.properties).map(([psetName, props]) => (
          <div className="space-y-1 border-slate-100 border-b py-3 last:border-b-0" key={psetName}>
            <p className="font-semibold text-slate-500 text-xs uppercase tracking-wide">
              {psetName}
            </p>
            {Object.entries(props).map(([key, value]) => (
              <Row key={key} k={key} v={String(value)} />
            ))}
          </div>
        ))}
    </div>
  )
}

export function Ai3DGenerativePage({ initialTool = 'ai' }: { initialTool?: ActiveTool }) {
  const [activeTool, setActiveTool] = useState<ActiveTool>(initialTool)
  const [isToolPanelOpen, setIsToolPanelOpen] = useState(false)
  const [graph, setGraph] = useState<SceneGraph | null>(DEFAULT_SCENE_GRAPH)
  const [sceneName, setSceneName] = useState<string | null>(DEFAULT_SCENE_NAME)
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [busyOverlay, setBusyOverlay] = useState<BusyOverlay>(null)
  const [resetKey, setResetKey] = useState(0)
  const [exportingFormat, setExportingFormat] = useState<ExportFormat | null>(null)
  const [exportError, setExportError] = useState<string | null>(null)
  const [importedModel, setImportedModel] = useState<ImportedModelAsset | null>(null)
  const [importedModelReady, setImportedModelReady] = useState(false)
  const [isPreparingModelImport, setIsPreparingModelImport] = useState(false)
  const [modelError, setModelError] = useState<string | null>(null)
  const [placementError, setPlacementError] = useState<string | null>(null)
  const [selectedPlacementItemId, setSelectedPlacementItemId] = useState<string | null>(null)
  const [hasMounted, setHasMounted] = useState(false)
  const pendingImportPlacement = useEditor((state) => state.pendingImportPlacement)
  const selectedReferenceId = useEditor((state) => state.selectedReferenceId)
  const exportScene = useViewer((state) => state.exportScene)
  const selectedSceneNodeIds = useViewer((state) => state.selection.selectedIds)
  const selectedZoneId = useViewer((state) => state.selection.zoneId)
  const sceneNodes = useScene((state) => state.nodes)
  const toolPanelRef = useRef<HTMLElement>(null)
  const previousLayerSelectionKeyRef = useRef('')

  const stats = useMemo(() => sceneStats(graph), [graph])
  const hasExportableContent = Boolean(graph || importedModelReady)
  const panelExportScene = hasMounted ? exportScene : null
  const modelPlacementPending = pendingImportPlacement?.kind === 'model'
  const ifcPlacementPending = pendingImportPlacement?.kind === 'ifc-scene'
  const catalogPlacementPending =
    pendingImportPlacement?.kind === 'catalog-item' ||
    pendingImportPlacement?.kind === 'catalog-build'
  const hasEditableSelection =
    hasMounted && (selectedSceneNodeIds.length > 0 || Boolean(selectedReferenceId))
  const layerSelectionKey = useMemo(
    () =>
      [
        ...selectedSceneNodeIds.map((id) => String(id)),
        selectedReferenceId ?? '',
        selectedZoneId ?? '',
        selectedNodeId ?? '',
      ]
        .filter(Boolean)
        .join('|'),
    [selectedNodeId, selectedReferenceId, selectedSceneNodeIds, selectedZoneId],
  )
  const moveSelectionTarget = useMemo(
    () =>
      hasMounted
        ? getMoveSelectionTarget(
            sceneNodes as Record<AnyNodeId, AnyNode>,
            selectedSceneNodeIds,
            selectedReferenceId,
          )
        : null,
    [hasMounted, sceneNodes, selectedSceneNodeIds, selectedReferenceId],
  )
  const canMoveSelection = Boolean(moveSelectionTarget) && !pendingImportPlacement
  const toolPanelWidthClass =
    activeTool === 'placement'
      ? 'md:w-[min(520px,calc(100vw-7rem))]'
      : activeTool === 'hierarchy'
        ? 'md:w-[min(430px,calc(100vw-7rem))]'
        : 'md:w-[min(380px,calc(100vw-7rem))]'

  useEffect(() => {
    setHasMounted(true)
  }, [])

  const updateScene = useCallback((nextGraph: SceneGraph, name: string) => {
    useEditor.getState().setPendingImportPlacement(null)
    setGraph(nextGraph)
    setSceneName(name)
    setSelectedNodeId(null)
    setPlacementError(null)
  }, [])

  const prepareIfcPlacement = useCallback((nextGraph: SceneGraph, name: string) => {
    const result = validateBuildJson(nextGraph)
    if (!(result.ok && result.parsed)) {
      throw new Error(result.errors[0]?.message ?? 'IFC conversion produced an invalid scene.')
    }

    prepareEditorForImportPlacement()
    setSelectedNodeId(null)
    useViewer.getState().setShowScans(true)
    useEditor.getState().setPendingImportPlacement({
      kind: 'ifc-scene',
      name: getImportDisplayName(name),
      nodes: result.parsed.nodes as Record<AnyNodeId, AnyNode>,
      rootNodeIds: result.parsed.rootNodeIds as AnyNodeId[],
      snapToGrid: true,
    })
  }, [])

  const handleSceneGraphChange = useCallback((nextGraph: SceneGraph) => {
    setGraph(nextGraph)
  }, [])

  function reset() {
    useEditor.getState().setPendingImportPlacement(null)
    setGraph(DEFAULT_SCENE_GRAPH)
    setSceneName(DEFAULT_SCENE_NAME)
    setSelectedNodeId(null)
    setBusyOverlay(null)
    setExportError(null)
    setExportingFormat(null)
    setImportedModel(null)
    setImportedModelReady(false)
    setIsPreparingModelImport(false)
    setModelError(null)
    setPlacementError(null)
    setSelectedPlacementItemId(null)
    setResetKey((value) => value + 1)
  }

  function downloadCurrentJson() {
    if (!graph) return
    const name = sceneName?.replace(/\.(ifc|json)$/i, '') || '3d-scene'
    downloadJson(graph, `${name}.json`)
  }

  const handleSelectTask = useCallback(() => {
    setSelectInteractionMode()
    setSelectedPlacementItemId(null)
    setPlacementError(null)
  }, [])

  const handleRotateSelection = useCallback(() => {
    rotateSelectedSceneNodes()
  }, [])

  const handleMoveSelection = useCallback(() => {
    const target = getMoveSelectionTarget(
      useScene.getState().nodes as Record<AnyNodeId, AnyNode>,
      useViewer.getState().selection.selectedIds,
      useEditor.getState().selectedReferenceId,
    )
    if (!target) return
    startMoveSelectedSceneNode(target)
    setSelectedPlacementItemId(null)
    setPlacementError(null)
  }, [])

  const handleDeleteSelection = useCallback(() => {
    if (!deleteSelectedSceneNodes()) return
    setSelectedNodeId(null)
    setSelectedPlacementItemId(null)
  }, [])

  async function exportCurrentScene(format: ExportFormat) {
    if (!hasExportableContent || !exportScene || exportingFormat) return
    setExportingFormat(format)
    setExportError(null)
    try {
      await exportScene(format)
    } catch (err) {
      setExportError(
        err instanceof Error ? err.message : `Failed to export ${format.toUpperCase()}`,
      )
    } finally {
      setExportingFormat(null)
    }
  }

  const importModelFile = useCallback(async (file: File) => {
    const format = detectModelFormat(file.name)
    if (!format) {
      setModelError('Please choose a GLB, GLTF, STL, or OBJ file')
      return
    }

    if (file.size > MAX_MODEL_IMPORT_SIZE) {
      setModelError(
        `File is too large (${(file.size / 1024 / 1024).toFixed(0)} MB). Maximum size is 250 MB.`,
      )
      return
    }

    setIsPreparingModelImport(true)
    setImportedModelReady(false)
    setModelError(null)
    setExportError(null)
    setBusyOverlay({ title: 'Preparing 3D import', detail: file.name })

    try {
      prepareEditorForImportPlacement()
      selectDefaultBuildingAndLevel()

      const levelId = useViewer.getState().selection.levelId
      if (!levelId) {
        throw new Error('No active level found for model import.')
      }

      const assetUrl = await saveAsset(file)
      const name = getImportDisplayName(file.name)
      setImportedModel({
        name: file.name,
        url: assetUrl,
        format,
        size: file.size,
      })
      useViewer.getState().setShowScans(true)
      useEditor.getState().setPendingImportPlacement({
        kind: 'model',
        name,
        url: assetUrl,
        format,
        levelId,
        snapToGrid: true,
      })
    } catch (err) {
      setModelError(err instanceof Error ? err.message : 'Could not prepare that import.')
    } finally {
      setIsPreparingModelImport(false)
      setBusyOverlay(null)
    }
  }, [])

  const clearImportedModel = useCallback(() => {
    if (useEditor.getState().pendingImportPlacement?.kind === 'model') {
      useEditor.getState().setPendingImportPlacement(null)
    }
    setImportedModel(null)
    setImportedModelReady(false)
    setModelError(null)
  }, [])

  const prepareCatalogItemPlacement = useCallback((item: LocalPlacementItem) => {
    try {
      prepareEditorForImportPlacement()
      selectDefaultBuildingAndLevel()

      const levelId = useViewer.getState().selection.levelId
      if (!levelId) {
        throw new Error('No active level found for item placement.')
      }

      useViewer.getState().setShowGrid(true)
      if (isAssetPlacementItem(item)) {
        useEditor.getState().setPhase('furnish')
        useEditor.getState().setPendingImportPlacement({
          kind: 'catalog-item',
          name: item.name,
          asset: createPlacementAsset(item),
          levelId,
          snapToGrid: true,
        })
      } else {
        useEditor.getState().setPendingImportPlacement({
          kind: 'catalog-build',
          name: item.name,
          buildKind: item.placementKind,
          levelId,
          height: item.dimensions[1],
          thickness: item.dimensions[2],
          snapToGrid: true,
        })
      }
      setSelectedPlacementItemId(item.id)
      setPlacementError(null)
      setExportError(null)
    } catch (err) {
      useEditor.getState().setPendingImportPlacement(null)
      setPlacementError(err instanceof Error ? err.message : 'Could not prepare that item.')
    }
  }, [])

  useEffect(() => {
    if (!(importedModel && graph) || modelPlacementPending || isPreparingModelImport) return

    const hasPlacedScan = Object.values(graph.nodes).some((node) => {
      const scan = node as { type?: unknown; url?: unknown }
      return scan.type === 'scan' && scan.url === importedModel.url
    })

    if (hasPlacedScan) {
      setImportedModelReady(true)
      setModelError(null)
    }
  }, [graph, importedModel, isPreparingModelImport, modelPlacementPending])

  const handleToolChange = useCallback(
    (tool: ActiveTool) => {
      if (tool === activeTool) {
        setIsToolPanelOpen((open) => !open)
        return
      }
      setActiveTool(tool)
      setIsToolPanelOpen(true)
    },
    [activeTool],
  )

  useEffect(() => {
    const previousKey = previousLayerSelectionKeyRef.current
    previousLayerSelectionKeyRef.current = layerSelectionKey

    if (!hasMounted || pendingImportPlacement) return

    if (!layerSelectionKey) {
      if (previousKey && activeTool === 'hierarchy') {
        setIsToolPanelOpen(false)
      }
      return
    }

    if (layerSelectionKey === previousKey) return

    setActiveTool('hierarchy')
    setIsToolPanelOpen(true)
  }, [activeTool, hasMounted, layerSelectionKey, pendingImportPlacement])

  useEffect(() => {
    if (!isToolPanelOpen) return

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (toolPanelRef.current?.contains(target)) return
      if (target instanceof Element && target.closest('[data-ai-tool-rail]')) return
      setIsToolPanelOpen(false)
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsToolPanelOpen(false)
    }

    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [isToolPanelOpen])

  if (!hasMounted) {
    return (
      <main className="min-h-screen bg-[#eef3fb] text-slate-950">
        <div className="mx-auto flex min-h-screen w-full max-w-[1880px] items-center justify-center px-3 py-3">
          <div className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white/90 px-4 py-3 text-sm text-slate-600 shadow-sm">
            <Loader2 className="h-4 w-4 animate-spin text-blue-600" />
            Loading
          </div>
        </div>
      </main>
    )
  }

  return (
    <main className="min-h-screen bg-[#eef3fb] text-slate-950">
      <div className="mx-auto flex min-h-screen w-full max-w-[1880px] gap-3 px-3 py-3">
        {hasMounted && (
          <ToolRail activeTool={activeTool} isOpen={isToolPanelOpen} onChange={handleToolChange} />
        )}

        <div className="flex min-h-0 flex-1 flex-col gap-3">
          {hasMounted && <MobileToolTabs activeTool={activeTool} onChange={setActiveTool} />}

          <section className="relative min-h-0 flex-1">
            <aside
              className={[
                'mb-5 min-h-0 overflow-y-auto rounded-lg border border-slate-200 bg-white/95 p-4 shadow-sm backdrop-blur-xl md:absolute md:top-0 md:bottom-0 md:left-0 md:z-30 md:mb-0 md:shadow-2xl',
                toolPanelWidthClass,
                isToolPanelOpen ? 'md:block' : 'md:hidden',
              ].join(' ')}
              ref={toolPanelRef}
            >
              <button
                aria-label="Close menu"
                className="absolute top-3 right-3 hidden rounded-md p-1.5 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700 md:inline-flex"
                onClick={() => setIsToolPanelOpen(false)}
                type="button"
              >
                <X className="h-4 w-4" />
              </button>
              <div className={activeTool === 'hierarchy' ? 'block' : 'hidden'}>
                <HierarchyPanel />
              </div>
              <div className={activeTool === 'ai' ? 'block' : 'hidden'}>
                <AiPanel
                  graph={graph}
                  onScene={updateScene}
                  resetKey={resetKey}
                  setBusyOverlay={setBusyOverlay}
                />
              </div>
              <div className={activeTool === 'ifc' ? 'block' : 'hidden'}>
                <IfcPanel
                  onPlacementReady={prepareIfcPlacement}
                  placementPending={ifcPlacementPending}
                  resetKey={resetKey}
                  selectedNodeId={selectedNodeId}
                  setBusyOverlay={setBusyOverlay}
                  setSelectedNodeId={setSelectedNodeId}
                />
              </div>
              <div className={activeTool === 'placement' ? 'block' : 'hidden'}>
                <PlacementPanel
                  activeItemId={selectedPlacementItemId}
                  error={placementError}
                  onPlace={prepareCatalogItemPlacement}
                  placementPending={catalogPlacementPending}
                />
              </div>
              <div className={activeTool === 'model' ? 'block' : 'hidden'}>
                <ModelIoPanel
                  exportError={exportError}
                  exportScene={panelExportScene}
                  exportingFormat={exportingFormat}
                  hasExportableContent={hasExportableContent}
                  importedModel={importedModel}
                  importedModelReady={importedModelReady}
                  isPreparingModelImport={isPreparingModelImport}
                  modelError={modelError}
                  modelPlacementPending={modelPlacementPending}
                  onClearImportedModel={clearImportedModel}
                  onExport={(format) => void exportCurrentScene(format)}
                  onImportFile={importModelFile}
                />
              </div>
            </aside>

            <section className="min-h-[620px] rounded-lg border border-slate-200 bg-white p-2 shadow-sm lg:h-[calc(100vh-24px)]">
              <div
                className="relative h-[76vh] min-h-[560px] overflow-hidden rounded-lg border border-slate-200 bg-slate-100 lg:h-full lg:min-h-0"
                data-testid="shared-3d-preview"
              >
                <div className="pointer-events-none absolute top-4 left-4 z-10 flex max-w-[calc(100%-8rem)] flex-col gap-2">
                  <div className="w-fit max-w-full rounded-lg border border-slate-200 bg-white/90 px-3 py-2 shadow-lg backdrop-blur-md">
                    <h2 className="truncate font-semibold text-slate-900 text-sm">
                      {sceneName ?? importedModel?.name ?? (graph ? 'Scene' : 'Scene Preview')}
                    </h2>
                    <p className="text-slate-500 text-xs">
                      {graph
                        ? `${stats.nodes} nodes - ${stats.types} types`
                        : importedModel
                          ? `${importedModel.format.toUpperCase()} - ${formatFileSize(importedModel.size)}`
                          : `${stats.nodes} nodes - ${stats.types} types`}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {Object.entries(stats.typeCounts)
                      .slice(0, 8)
                      .map(([type, count]) => (
                        <span
                          className="rounded-md bg-slate-950 px-2 py-1 font-semibold text-white text-xs shadow-sm"
                          key={type}
                        >
                          {count} {type}
                        </span>
                      ))}
                  </div>
                </div>

                <div className="absolute right-4 bottom-4 z-10 flex flex-wrap justify-end gap-2">
                  <button
                    className="inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-slate-200 bg-white/90 px-3 font-semibold text-slate-700 text-sm shadow-lg backdrop-blur-md transition-colors hover:bg-white disabled:opacity-50"
                    disabled={!graph}
                    onClick={downloadCurrentJson}
                    type="button"
                  >
                    <Download className="h-4 w-4" />
                    JSON
                  </button>
                  <button
                    className="inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-slate-200 bg-white/90 px-3 font-semibold text-slate-700 text-sm shadow-lg backdrop-blur-md transition-colors hover:bg-white"
                    onClick={reset}
                    type="button"
                  >
                    <RotateCcw className="h-4 w-4" />
                    Reset
                  </button>
                </div>

                {graph || importedModel ? (
                  <ScenePreview
                    onSceneGraphChange={handleSceneGraphChange}
                    onSelectNode={setSelectedNodeId}
                    sceneGraph={graph}
                  />
                ) : (
                  <div className="flex h-full items-center justify-center p-6 text-center">
                    <div className="max-w-sm">
                      <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-md bg-white text-blue-600 shadow-sm">
                        <Sparkles className="h-6 w-6" />
                      </div>
                      <p className="mt-4 font-semibold text-slate-800">No scene loaded yet</p>
                      <p className="mt-1 text-slate-500 text-sm">
                        Generate with AI, convert an IFC file, or import a 3D model.
                      </p>
                    </div>
                  </div>
                )}

                <SceneTaskbar
                  canEditSelection={hasEditableSelection && !pendingImportPlacement}
                  canMoveSelection={canMoveSelection}
                  onDelete={handleDeleteSelection}
                  onMove={handleMoveSelection}
                  onRotate={handleRotateSelection}
                  onSelect={handleSelectTask}
                  selectActive={!pendingImportPlacement}
                />

                {busyOverlay && (
                  <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-white/75 p-6 text-center backdrop-blur-sm">
                    <Loader2 className="h-8 w-8 animate-spin text-blue-600" />
                    <p className="font-semibold text-slate-900 text-sm">{busyOverlay.title}</p>
                    {busyOverlay.detail && (
                      <p className="max-w-sm truncate text-slate-500 text-xs">
                        {busyOverlay.detail}
                      </p>
                    )}
                    {busyOverlay.progress != null && (
                      <div className="w-56 max-w-full">
                        <div className="mb-1 flex justify-end text-blue-600 text-xs">
                          {busyOverlay.progress}%
                        </div>
                        <div className="h-1.5 overflow-hidden rounded-full bg-slate-200">
                          <div
                            className="h-full rounded-full bg-blue-600 transition-all duration-300"
                            style={{ width: `${busyOverlay.progress}%` }}
                          />
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </section>
          </section>
        </div>
      </div>
    </main>
  )
}
