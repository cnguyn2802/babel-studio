import type { SceneGraph } from '@pascal-app/core/clone-scene-graph'
import {
  AnyNode,
  type AnyNodeId,
  type AnyNode as AnyNodeType,
  BuildingNode,
  CeilingNode,
  DoorNode,
  FenceNode,
  ItemNode,
  LevelNode,
  SiteNode,
  SlabNode,
  WallNode,
  WindowNode,
  ZoneNode,
} from '@pascal-app/core/schema'
import type { SceneMeta, SceneStore } from '@pascal-app/mcp/storage'
import { type NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { apiGraphSchema } from '@/lib/graph-schema'
import { getSceneStore } from '@/lib/scene-store-server'

const SUPPORTED_ACTIONS = [
  'get_scene',
  'apply_patch',
  'validate_scene',
  'save_scene',
  'create_room',
  'add_door',
  'add_window',
  'add_furniture',
  'create_deck',
  'create_pergola',
] as const

const OPENAI_STRUCTURED_ACTIONS = [
  'get_scene',
  'validate_scene',
  'save_scene',
  'create_room',
  'add_door',
  'add_window',
  'add_furniture',
  'create_deck',
  'create_pergola',
] as const

const actionSchema = z.object({
  tool: z.enum(SUPPORTED_ACTIONS),
  arguments: z.record(z.string(), z.unknown()).optional(),
})

const conversationMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().min(1).max(4000),
})

const planSchema = z.object({
  message: z.string().optional(),
  response: z.string().optional(),
  title: z.string().optional(),
  steps: z.number().int().nonnegative().optional(),
  reads: z.number().int().nonnegative().optional(),
  changes: z.number().int().nonnegative().optional(),
  actions: z.array(actionSchema).default([]),
})

const AI_PROVIDERS = ['auto', 'ollama', 'qwen', 'openai', 'abacus'] as const

const requestSchema = z.object({
  message: z.string().min(1).max(4000),
  sceneId: z.string().min(1).max(64).optional(),
  graph: apiGraphSchema.optional(),
  conversationId: z.string().max(200).optional(),
  history: z.array(conversationMessageSchema).max(24).optional(),
  aiProvider: z.enum(AI_PROVIDERS).optional(),
  aiModel: z.string().trim().min(1).max(200).optional(),
})

const DEFAULT_ABACUS_ENDPOINT = 'https://api.abacus.ai/api/executeAgent'
const DEFAULT_OPENAI_MODEL = 'gpt-5.5'
const DEFAULT_OPENAI_REASONING_EFFORT = 'medium'
const DEFAULT_OLLAMA_BASE_URL = 'http://localhost:11434'
const DEFAULT_OLLAMA_MODEL = 'llama3.2'
const DEFAULT_QWEN_BASE_URL = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1'
const DEFAULT_QWEN_MODEL = 'qwen3.7-max'

type AiProvider = (typeof AI_PROVIDERS)[number]
type ResolvedAiProvider = Exclude<AiProvider, 'auto'>
type OpenAIReasoningEffort = 'low' | 'medium' | 'high'

const AI_RUNTIME_PROVIDER_OPTIONS: ResolvedAiProvider[] = ['openai', 'qwen', 'ollama', 'abacus']

export type AiProviderRuntimeOption = {
  provider: ResolvedAiProvider
  model: string
  label: string
  configured: boolean
  configurationError: string | null
}

export type AiProviderRuntimeInfo = {
  requestedProvider: AiProvider | 'invalid'
  provider: ResolvedAiProvider | null
  model: string
  label: string
  configured: boolean
  configurationError: string | null
  options: AiProviderRuntimeOption[]
}

type AiProviderSelection = {
  provider?: AiProvider
  model?: string
}

type Ai3DGenerativeAction = z.infer<typeof actionSchema>
type Ai3DGenerativePlan = {
  message: string
  actions: Ai3DGenerativeAction[]
  title?: string
  steps?: number
  reads?: number
  changes?: number
}

type AiConversationMessage = z.infer<typeof conversationMessageSchema>

type Ai3DGenerativeRequest = {
  message: string
  scene: unknown
  sceneId?: string
  conversationId?: string
  history?: AiConversationMessage[]
}

type ActionResult = {
  tool: Ai3DGenerativeAction['tool']
  result: unknown
}

type ActiveSceneMeta = Pick<
  SceneMeta,
  'id' | 'name' | 'projectId' | 'ownerId' | 'thumbnailUrl' | 'version'
>

type CreatePatch = { op: 'create'; node: AnyNodeType; parentId?: AnyNodeId }
type UpdatePatch = { op: 'update'; id: AnyNodeId; data: Partial<AnyNodeType> }
type DeletePatch = { op: 'delete'; id: AnyNodeId; cascade?: boolean }
type Patch = CreatePatch | UpdatePatch | DeletePatch

type AiFurnitureAsset = {
  id: string
  category: string
  name: string
  dimensions: [number, number, number]
  keywords: string[]
  modelPath?: string
  thumbnailPath?: string
  offset?: [number, number, number]
  fitToDimensions?: boolean
  surfaceHeight?: number
}

type AiItemAssetPayload = {
  id: string
  category: string
  name: string
  thumbnail: string
  src: string
  dimensions: [number, number, number]
  tags: string[]
  offset: [number, number, number]
  rotation: [number, number, number]
  scale: [number, number, number]
  fitToDimensions?: boolean
  surface?: { height: number }
}

type RoomLayoutType =
  | 'living'
  | 'bedroom'
  | 'kitchen'
  | 'dining'
  | 'studio'
  | 'office'
  | 'garden'
  | 'house'

type RoomLayoutFurnitureSlot = {
  assetId: string
  x: number
  y?: number
  z: number
  rotationY?: number
}

type RoomLayoutDefinition = {
  type: RoomLayoutType
  name: string
  roomType: string
  width: number
  depth: number
  furniture: RoomLayoutFurnitureSlot[]
}

type RoomLayoutActionOptions = {
  name?: string
  roomType?: string
  width?: number
  depth?: number
  requestedAssetIds?: string[]
  includeDefaultFurniture?: boolean
}

const AI_FURNITURE_ASSETS: AiFurnitureAsset[] = [
  {
    id: 'sofa',
    category: 'furniture',
    name: 'Sofa',
    dimensions: [2.06, 0.74, 1.01],
    keywords: ['sofa', 'couch', 'seating'],
    offset: [-0.0023, 0.009, 0.0459],
  },
  {
    id: 'livingroom-chair',
    category: 'furniture',
    name: 'Livingroom Chair',
    dimensions: [1.1, 0.75, 1.07],
    keywords: ['armchair', 'chair', 'seat'],
    offset: [0, 0.0001, 0.0053],
  },
  {
    id: 'lounge-chair',
    category: 'furniture',
    name: 'Lounge Chair',
    dimensions: [0.68, 1.03, 1.26],
    keywords: ['lounge chair', 'accent chair', 'armchair'],
    offset: [0, 0.0034, 0.0894],
  },
  {
    id: 'dining-chair',
    category: 'furniture',
    name: 'Dining Chair',
    dimensions: [0.47, 0.87, 0.5],
    keywords: ['dining chair', 'chair', 'seat'],
  },
  {
    id: 'dining-table',
    category: 'furniture',
    name: 'Dining Table',
    dimensions: [2.16, 0.7, 0.95],
    keywords: ['dining table', 'table'],
    offset: [0, 0, -0.0077],
    surfaceHeight: 0.7,
  },
  {
    id: 'coffee-table',
    category: 'furniture',
    name: 'Coffee Table',
    dimensions: [1.72, 0.3, 1.04],
    keywords: ['coffee table', 'cocktail table', 'table'],
    offset: [0, 0, 0.0089],
    surfaceHeight: 0.3,
  },
  {
    id: 'office-table',
    category: 'furniture',
    name: 'Office Table',
    dimensions: [1.51, 0.76, 0.62],
    keywords: ['office table', 'desk', 'workstation'],
    offset: [-0.0001, 0, -0.0052],
    surfaceHeight: 0.75,
  },
  {
    id: 'office-chair',
    category: 'furniture',
    name: 'Office Chair',
    dimensions: [0.66, 1.16, 0.69],
    keywords: ['office chair', 'desk chair', 'task chair'],
  },
  {
    id: 'single-bed',
    category: 'furniture',
    name: 'Single Bed',
    dimensions: [1.08, 0.6, 2.14],
    keywords: ['single bed', 'bed'],
    offset: [-0.0024, 0, -0.013],
  },
  {
    id: 'double-bed',
    category: 'furniture',
    name: 'Double Bed',
    dimensions: [1.52, 0.71, 2],
    keywords: ['double bed', 'bed', 'queen bed'],
    offset: [0.0042, 0, -0.0277],
  },
  {
    id: 'bookshelf',
    category: 'furniture',
    name: 'Bookshelf',
    dimensions: [0.93, 1.99, 0.33],
    keywords: ['bookshelf', 'bookcase', 'shelf'],
  },
  {
    id: 'tv-stand',
    category: 'furniture',
    name: 'TV Stand',
    dimensions: [1.86, 0.35, 0.32],
    keywords: ['tv stand', 'media console', 'storage'],
    offset: [0, 0.2066, 0],
    surfaceHeight: 0.35,
  },
  {
    id: 'television',
    category: 'appliance',
    name: 'Television',
    dimensions: [1.62, 1.07, 0.38],
    keywords: ['television', 'tv', 'screen'],
  },
  {
    id: 'table-lamp',
    category: 'furniture',
    name: 'Table Lamp',
    dimensions: [0.29, 0.74, 0.67],
    keywords: ['table lamp', 'lamp', 'light'],
  },
  {
    id: 'floor-lamp',
    category: 'furniture',
    name: 'Floor Lamp',
    dimensions: [0.7, 1.86, 0.69],
    keywords: ['floor lamp', 'lamp', 'light'],
    offset: [0.0341, 0.0045, 0.0219],
  },
  {
    id: 'rectangular-carpet',
    category: 'furniture',
    name: 'Rectangular Carpet',
    dimensions: [2.78, 0.04, 1.81],
    keywords: ['carpet', 'rug', 'mat'],
  },
  {
    id: 'indoor-plant',
    category: 'furniture',
    name: 'Indoor Plant',
    dimensions: [0.69, 1.63, 0.83],
    keywords: ['plant', 'indoor plant', 'houseplant'],
    offset: [-0.0506, 0, 0.0664],
  },
  {
    id: 'kitchen-fridge',
    category: 'appliance',
    name: 'Kitchen Fridge',
    dimensions: [0.7, 1.92, 0.72],
    keywords: ['fridge', 'refrigerator', 'kitchen fridge'],
  },
  {
    id: 'kitchen-cabinet',
    category: 'furniture',
    name: 'Kitchen Cabinet',
    dimensions: [1.65, 1.09, 0.77],
    keywords: ['kitchen cabinet', 'cabinet'],
  },
  {
    id: 'stove',
    category: 'appliance',
    name: 'Stove',
    dimensions: [0.92, 0.85, 0.76],
    keywords: ['stove', 'oven', 'range'],
  },
  {
    id: 'bedside-table',
    category: 'furniture',
    name: 'Bedside Table',
    dimensions: [0.45, 0.48, 0.46],
    keywords: ['bedside table', 'nightstand', 'bedroom table'],
    offset: [0.0005, 0, -0.0062],
    surfaceHeight: 0.48,
  },
  {
    id: 'dresser',
    category: 'furniture',
    name: 'Dresser',
    dimensions: [1.23, 0.73, 0.61],
    keywords: ['dresser', 'chest', 'bedroom storage'],
    offset: [0, 0, -0.0066],
    surfaceHeight: 0.73,
  },
  {
    id: 'closet',
    category: 'furniture',
    name: 'Closet',
    dimensions: [1.95, 2.26, 0.6],
    keywords: ['closet', 'wardrobe', 'bedroom closet'],
    offset: [0, 0, -0.0141],
  },
  {
    id: 'kitchen-counter',
    category: 'furniture',
    name: 'Kitchen Counter',
    dimensions: [1.96, 0.73, 0.63],
    keywords: ['kitchen counter', 'counter', 'countertop', 'island'],
    offset: [0.0012, 0, -0.0004],
    surfaceHeight: 0.73,
  },
  {
    id: 'microwave',
    category: 'appliance',
    name: 'Microwave',
    dimensions: [0.52, 0.27, 0.41],
    keywords: ['microwave', 'microwave oven'],
    offset: [0, 0, -0.0225],
  },
  {
    id: 'coffee-machine',
    category: 'appliance',
    name: 'Coffee Machine',
    dimensions: [0.16, 0.24, 0.23],
    keywords: ['coffee machine', 'coffee maker', 'espresso'],
    offset: [0, 0, -0.2393],
  },
  {
    id: 'tree',
    category: 'outdoor',
    name: 'Tree',
    dimensions: [1.8, 3.2, 1.8],
    keywords: ['tree', 'garden tree', 'landscape tree'],
  },
  {
    id: 'fir-tree',
    category: 'outdoor',
    name: 'Fir Tree',
    dimensions: [1.8, 3.4, 1.8],
    keywords: ['fir tree', 'pine tree', 'evergreen tree'],
  },
  {
    id: 'palm',
    category: 'outdoor',
    name: 'Palm',
    dimensions: [1.8, 3.8, 1.8],
    keywords: ['palm', 'palm tree', 'tropical tree'],
  },
  {
    id: 'bush',
    category: 'outdoor',
    name: 'Bush',
    dimensions: [1.2, 0.8, 1.2],
    keywords: ['bush', 'shrub', 'garden bush'],
  },
  {
    id: 'hedge',
    category: 'outdoor',
    name: 'Hedge',
    dimensions: [2, 1, 0.6],
    keywords: ['hedge', 'garden hedge', 'plant border'],
  },
  {
    id: 'cactus',
    category: 'outdoor',
    name: 'Cactus',
    dimensions: [0.34, 0.39, 0.27],
    keywords: ['cactus', 'desert plant', 'succulent'],
  },
  {
    id: 'patio-umbrella',
    category: 'outdoor',
    name: 'Patio Umbrella',
    dimensions: [2.6, 2.4, 2.6],
    keywords: ['patio umbrella', 'umbrella', 'shade'],
  },
  {
    id: 'sunbed',
    category: 'outdoor',
    name: 'Sunbed',
    dimensions: [2, 0.5, 0.75],
    keywords: ['sunbed', 'lounger', 'outdoor lounge'],
  },
  {
    id: 'deck-082523',
    category: 'outdoor',
    name: 'Deck',
    dimensions: [14.4, 1.05, 9.6],
    keywords: ['deck', 'wood deck', 'outdoor deck', 'deck platform', 'patio deck'],
    modelPath: '/items/deck/deck_082523.glb',
    thumbnailPath: '/icons/floor.png',
    fitToDimensions: true,
    surfaceHeight: 0.16,
  },
  {
    id: 'deck-chair-hanged',
    category: 'outdoor',
    name: 'Hanging Deck Chair',
    dimensions: [1.4, 2.1, 1.4],
    keywords: ['hanging deck chair', 'deck chair', 'hanging chair', 'swing chair'],
    modelPath: '/items/deck/deck_chair_hanged_bbdw.glb',
    thumbnailPath: '/icons/item.png',
    fitToDimensions: true,
  },
  {
    id: 'deck-stairs-guardrails',
    category: 'outdoor',
    name: 'Deck with Stairs',
    dimensions: [16.5, 4.2, 11.4],
    keywords: [
      'deck with stairs',
      'deck stairs',
      'guardrails',
      'railing deck',
      'deck railing',
      'raised deck',
    ],
    modelPath: '/items/deck/deck_wit_sets_of_stairs_and_guardrails.glb',
    thumbnailPath: '/icons/stairs.png',
    fitToDimensions: true,
  },
  {
    id: 'ship-deck-balcony',
    category: 'outdoor',
    name: 'Ship Deck Balcony',
    dimensions: [13.5, 4.2, 7.2],
    keywords: ['ship deck balcony', 'deck balcony', 'balcony deck', 'railing balcony'],
    modelPath: '/items/deck/ship_deck_balcony.glb',
    thumbnailPath: '/icons/fence.png',
    fitToDimensions: true,
  },
  {
    id: 'pergola',
    category: 'outdoor',
    name: 'Pergola',
    dimensions: [11.4, 8.1, 9.6],
    keywords: ['pergola', 'outdoor pergola', 'patio pergola', 'shade structure'],
    modelPath: '/items/pergola/pergola.glb',
    thumbnailPath: '/icons/column.png',
    fitToDimensions: true,
  },
  {
    id: 'pergola-3',
    category: 'outdoor',
    name: 'Pergola 3',
    dimensions: [12, 8.4, 9.6],
    keywords: ['pergola 3', 'modern pergola', 'large pergola', 'pergola model 3'],
    modelPath: '/items/pergola/pergola_3.glb',
    thumbnailPath: '/icons/column.png',
    fitToDimensions: true,
  },
  {
    id: 'timber-pergola',
    category: 'outdoor',
    name: 'Timber Pergola',
    dimensions: [13.5, 8.4, 10.5],
    keywords: ['timber pergola', 'wood timber pergola', 'wooden shade structure'],
    modelPath: '/items/pergola/timber_pergola_3d_model.glb',
    thumbnailPath: '/icons/column.png',
    fitToDimensions: true,
  },
  {
    id: 'wooden-garden-pergola',
    category: 'outdoor',
    name: 'Garden Pergola',
    dimensions: [12.6, 8.1, 9.6],
    keywords: ['garden pergola', 'wooden garden pergola', 'backyard pergola'],
    modelPath: '/items/pergola/wooden_garden_pergola.glb',
    thumbnailPath: '/icons/tree.png',
    fitToDimensions: true,
  },
  {
    id: 'wooden-building-pergola',
    category: 'outdoor',
    name: 'TimberTech Pergola',
    dimensions: [15, 10.2, 12],
    keywords: [
      'timbertech pergola',
      'timbertech',
      'wooden pergola',
      'wood pergola',
      'building pergola',
      'wooden building pergola',
    ],
    modelPath: '/items/pergola/wooden_pergola_-_3d_building.glb',
    thumbnailPath: '/icons/column.png',
    fitToDimensions: true,
  },
  {
    id: 'outdoor-playhouse',
    category: 'outdoor',
    name: 'Playhouse',
    dimensions: [2.4, 2.1, 2.2],
    keywords: ['playhouse', 'outdoor playhouse', 'garden playhouse'],
  },
  {
    id: 'fence',
    category: 'outdoor',
    name: 'Fence',
    dimensions: [2, 1, 0.12],
    keywords: ['fence', 'garden fence', 'boundary fence'],
  },
  {
    id: 'high-fence',
    category: 'outdoor',
    name: 'High Fence',
    dimensions: [2, 1.8, 0.12],
    keywords: ['high fence', 'privacy fence', 'garden boundary'],
  },
]

const AI_WINDOW_TYPES = [
  'fixed',
  'sliding',
  'casement',
  'awning',
  'hopper',
  'single-hung',
  'double-hung',
  'bay',
  'bow',
  'louvered',
] as const

const DEFAULT_AI_FURNITURE_ASSET = AI_FURNITURE_ASSETS[0] as AiFurnitureAsset

const ROOM_LAYOUT_DEFS: Record<RoomLayoutType, RoomLayoutDefinition> = {
  living: {
    type: 'living',
    name: 'Living room',
    roomType: 'living',
    width: 6,
    depth: 4,
    furniture: [
      { assetId: 'rectangular-carpet', x: 0, z: 0.45 },
      { assetId: 'sofa', x: 0, z: 1.25, rotationY: Math.PI },
      { assetId: 'coffee-table', x: 0, z: 0.35 },
      { assetId: 'livingroom-chair', x: -1.9, z: 0.25, rotationY: Math.PI / 2 },
      { assetId: 'tv-stand', x: 0, z: -1.55 },
      { assetId: 'television', x: 0, y: 0.35, z: -1.55 },
      { assetId: 'floor-lamp', x: 2.35, z: 1.25 },
      { assetId: 'indoor-plant', x: -2.35, z: -1.25 },
    ],
  },
  bedroom: {
    type: 'bedroom',
    name: 'Bed room',
    roomType: 'bedroom',
    width: 5,
    depth: 4,
    furniture: [
      { assetId: 'rectangular-carpet', x: 0, z: 0.45 },
      { assetId: 'double-bed', x: 0, z: 0.7 },
      { assetId: 'bedside-table', x: -1.15, z: 1.05 },
      { assetId: 'bedside-table', x: 1.15, z: 1.05 },
      { assetId: 'table-lamp', x: -1.15, y: 0.48, z: 1.05 },
      { assetId: 'dresser', x: -1.75, z: -1.25 },
      { assetId: 'closet', x: 1.55, z: -1.25 },
    ],
  },
  kitchen: {
    type: 'kitchen',
    name: 'Kitchen',
    roomType: 'kitchen',
    width: 5.5,
    depth: 4,
    furniture: [
      { assetId: 'kitchen-counter', x: -1.3, z: -1.15 },
      { assetId: 'kitchen-cabinet', x: 1, z: -1.05 },
      { assetId: 'kitchen-fridge', x: -2.15, z: 0.55 },
      { assetId: 'stove', x: 0.55, z: 0.65 },
      { assetId: 'microwave', x: 1.35, y: 0.73, z: -1.05 },
      { assetId: 'coffee-machine', x: -1.3, y: 0.73, z: -1.15 },
    ],
  },
  dining: {
    type: 'dining',
    name: 'Dining room',
    roomType: 'dining',
    width: 5,
    depth: 4,
    furniture: [
      { assetId: 'rectangular-carpet', x: 0, z: 0 },
      { assetId: 'dining-table', x: 0, z: 0 },
      { assetId: 'dining-chair', x: 0, z: -1.05 },
      { assetId: 'dining-chair', x: 0, z: 1.05, rotationY: Math.PI },
      { assetId: 'dining-chair', x: -1.35, z: 0, rotationY: -Math.PI / 2 },
      { assetId: 'dining-chair', x: 1.35, z: 0, rotationY: Math.PI / 2 },
      { assetId: 'indoor-plant', x: -2, z: 1.25 },
    ],
  },
  studio: {
    type: 'studio',
    name: 'Studio room',
    roomType: 'studio',
    width: 5.5,
    depth: 4.2,
    furniture: [
      { assetId: 'rectangular-carpet', x: 0.75, z: 0.25 },
      { assetId: 'double-bed', x: -1.45, z: 0.95 },
      { assetId: 'sofa', x: 1.35, z: 1.05, rotationY: Math.PI },
      { assetId: 'coffee-table', x: 1.35, z: 0.15 },
      { assetId: 'office-table', x: -1.55, z: -1.35 },
      { assetId: 'office-chair', x: -1.55, z: -0.75, rotationY: Math.PI },
      { assetId: 'tv-stand', x: 1.35, z: -1.45 },
      { assetId: 'television', x: 1.35, y: 0.35, z: -1.45 },
      { assetId: 'indoor-plant', x: 2.25, z: 1.3 },
    ],
  },
  office: {
    type: 'office',
    name: 'Office',
    roomType: 'office',
    width: 5,
    depth: 3.8,
    furniture: [
      { assetId: 'rectangular-carpet', x: 0, z: 0.1 },
      { assetId: 'office-table', x: 0, z: -1.05 },
      { assetId: 'office-chair', x: 0, z: -0.35, rotationY: Math.PI },
      { assetId: 'bookshelf', x: -1.9, z: 0.75, rotationY: Math.PI / 2 },
      { assetId: 'floor-lamp', x: 1.9, z: 0.95 },
      { assetId: 'indoor-plant', x: 1.85, z: -1.05 },
    ],
  },
  garden: {
    type: 'garden',
    name: 'Outdoor garden',
    roomType: 'garden',
    width: 8,
    depth: 6,
    furniture: [
      { assetId: 'hedge', x: -2.6, z: -2.45 },
      { assetId: 'hedge', x: 0, z: -2.45 },
      { assetId: 'hedge', x: 2.6, z: -2.45 },
      { assetId: 'tree', x: -3, z: 1.85 },
      { assetId: 'fir-tree', x: 2.9, z: 1.9 },
      { assetId: 'bush', x: -2.55, z: 0.2 },
      { assetId: 'bush', x: 2.45, z: -0.1 },
      { assetId: 'patio-umbrella', x: 0, z: 0.85 },
      { assetId: 'sunbed', x: 0.9, z: 0.15, rotationY: -Math.PI / 2 },
      { assetId: 'fence', x: -3.3, z: -1.25, rotationY: Math.PI / 2 },
      { assetId: 'fence', x: 3.3, z: -1.25, rotationY: Math.PI / 2 },
    ],
  },
  house: {
    type: 'house',
    name: 'Simple house shell',
    roomType: 'house',
    width: 8,
    depth: 6,
    furniture: [],
  },
}

const ROOM_LAYOUT_EXTRA_SLOTS: RoomLayoutFurnitureSlot[] = [
  { assetId: '', x: -2.15, z: 0.85, rotationY: Math.PI / 2 },
  { assetId: '', x: 2.15, z: 0.85, rotationY: -Math.PI / 2 },
  { assetId: '', x: -2.15, z: -0.85, rotationY: Math.PI / 2 },
  { assetId: '', x: 2.15, z: -0.85, rotationY: -Math.PI / 2 },
  { assetId: '', x: 0, z: -1.45 },
]

const OUTDOOR_LIVING_DEFAULT_WIDTH = 19.5
const OUTDOOR_LIVING_DEFAULT_DEPTH = 12.6
const OUTDOOR_LIVING_DEFAULT_ELEVATION = 0.16
const OUTDOOR_LIVING_PERGOLA_HEIGHT = 7.65
const TIMBERTECH_PERGOLA_DEFAULT_HEIGHT = 10.2
const TIMBERTECH_PERGOLA_SOURCE_BOUNDS = {
  width: 527.0860195159912,
  height: 771.7224049002895,
  depth: 527.0860211433023,
  minY: -37.11911955144969,
  floorY: 124.308,
}
const DECK_082523_SOURCE_FOOTPRINT = {
  width: 264,
  depth: 220.75,
  minY: 37.5,
  surfaceY: 117.5,
  centerX: 147.641,
  centerZ: -33.625,
  surfaceWidth: 264,
  surfaceDepth: 144,
  surfaceCenterX: 147.641,
  surfaceCenterZ: -72,
}
const DECK_STAIRS_SOURCE_FOOTPRINT = {
  width: 243.5,
  depth: 119,
  minY: 7.75,
  surfaceY: 64.938,
  centerX: 122.25,
  centerZ: -60.5,
  surfaceWidth: 165.5,
  surfaceDepth: 119,
  surfaceCenterX: 83.25,
  surfaceCenterZ: -60.5,
}

const OUTDOOR_LIVING_FURNITURE: RoomLayoutFurnitureSlot[] = [
  { assetId: 'coffee-table', x: 0, z: 0.15 },
  { assetId: 'sofa', x: 0, z: 1.1, rotationY: Math.PI },
  { assetId: 'lounge-chair', x: -1.8, z: 0.2, rotationY: Math.PI / 2 },
  { assetId: 'lounge-chair', x: 1.8, z: 0.2, rotationY: -Math.PI / 2 },
  { assetId: 'bush', x: -2.65, z: -1.45 },
  { assetId: 'indoor-plant', x: 2.65, z: 1.35 },
]

const DECK_ASSET_IDS = [
  'deck-082523',
  'deck-stairs-guardrails',
  'ship-deck-balcony',
  'deck-chair-hanged',
] as const

const PERGOLA_ASSET_IDS = [
  'pergola',
  'pergola-3',
  'timber-pergola',
  'wooden-garden-pergola',
  'wooden-building-pergola',
] as const

const WOOD_MATERIAL = {
  preset: 'wood' as const,
  properties: {
    color: '#b7793a',
    roughness: 0.78,
  },
}

export async function handleAi3DGenerativeToolRequest(request: NextRequest) {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json(
      { error: 'invalid_request', details: 'body must be JSON' },
      { status: 400 },
    )
  }

  const parsed = requestSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid_request', details: parsed.error.issues },
      { status: 400 },
    )
  }

  const providerSelection: AiProviderSelection = {
    provider: parsed.data.aiProvider,
    model: parsed.data.aiModel,
  }
  const providerConfigError = getProviderConfigurationError(process.env, providerSelection.provider)
  if (providerConfigError) {
    return NextResponse.json(
      {
        error: 'ai_not_configured',
        details: providerConfigError,
      },
      { status: 501 },
    )
  }

  try {
    const store = await getSceneStore()
    const source = await loadSourceGraph(store, parsed.data.sceneId, parsed.data.graph)
    const session = new GraphSession(source.graph, source.meta)
    const agentRequest = {
      message: parsed.data.message,
      sceneId: parsed.data.sceneId,
      conversationId: parsed.data.conversationId,
      history: parsed.data.history ?? [],
      scene: session.exportSceneGraph(),
    }
    const promptTemplateActions = promptTemplateActionsForPrompt(parsed.data.message)
    const plan = promptTemplateActions
      ? {
          message: 'Loaded a deterministic room layout.',
          title: 'Deterministic Layout',
          steps: promptTemplateActions.length,
          reads: 0,
          changes: promptTemplateActions.length,
          actions: promptTemplateActions,
        }
      : await safeCallAiProvider(agentRequest, providerSelection)
    const plannedActions =
      promptTemplateActions ?? fallbackActionsForPrompt(parsed.data.message, plan.actions)
    const plannerRewroteActions = plannedActions !== plan.actions

    const actionResults: ActionResult[] = []
    for (const action of plannedActions) {
      actionResults.push(
        await executeAction(action, session, store, source.meta?.name ?? 'Pascal scene'),
      )
    }

    const changed = actionResults.some(
      (r) =>
        r.tool === 'apply_patch' ||
        r.tool === 'create_room' ||
        r.tool === 'add_door' ||
        r.tool === 'add_window' ||
        r.tool === 'add_furniture' ||
        r.tool === 'create_deck' ||
        r.tool === 'create_pergola',
    )
    const saved = actionResults.some((r) => r.tool === 'save_scene')
    if (source.meta && changed && !saved) {
      actionResults.push(await persistActiveScene(session, store, source.meta.name))
    }

    const graph = session.exportSceneGraph()
    const inferredChanges = countChangedActions(actionResults)
    const runtimeInfo = getAiProviderRuntimeInfo(process.env, providerSelection)
    return NextResponse.json({
      message: summarizeCompletedGeneration(actionResults) ?? plan.message ?? 'Done.',
      title: plan.title?.trim() ? plan.title : summarizeActions(actionResults),
      steps: plannerRewroteActions ? actionResults.length : (plan.steps ?? actionResults.length),
      reads:
        plan.reads ??
        actionResults.filter((r) => r.tool === 'get_scene' || r.tool === 'validate_scene').length,
      changes: Math.max(plan.changes ?? 0, inferredChanges),
      actions: actionResults,
      graph,
      aiProvider: runtimeInfo.provider,
      aiModel: runtimeInfo.model,
      sceneId: source.meta?.id ?? parsed.data.sceneId,
      conversationId: parsed.data.conversationId,
      version: session.getActiveScene()?.version ?? source.meta?.version ?? null,
    })
  } catch (error) {
    return NextResponse.json(
      {
        error: 'scene_agent_failed',
        message: error instanceof Error ? error.message : String(error),
      },
      { status: 502 },
    )
  }
}

async function callAiProvider(
  request: Ai3DGenerativeRequest,
  selection: AiProviderSelection = {},
): Promise<Ai3DGenerativePlan> {
  const provider = resolveAiProvider(process.env, selection.provider)
  if (provider === 'ollama') {
    return callOllama(request, process.env, selection.model)
  }
  if (provider === 'qwen') {
    return callQwen(request, process.env, selection.model)
  }
  if (provider === 'openai') {
    return callOpenAI(request, process.env, selection.model)
  }
  return callAbacus(request)
}

async function safeCallAiProvider(
  request: Ai3DGenerativeRequest,
  selection: AiProviderSelection = {},
): Promise<Ai3DGenerativePlan> {
  try {
    return await callAiProvider(request, selection)
  } catch (error) {
    const fallbackActions = fallbackActionsForPrompt(request.message, [])
    if (fallbackActions.length === 0) throw error
    return {
      message: '',
      title: 'Generated Scene',
      steps: fallbackActions.length,
      reads: 0,
      changes: fallbackActions.length,
      actions: fallbackActions,
    }
  }
}

function isOpenAIConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.OPENAI_API_KEY)
}

function getQwenApiKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.QWEN_API_KEY || env.DASHSCOPE_API_KEY
}

function isQwenConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(getQwenApiKey(env))
}

function isAbacusConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.ABACUS_AI_DEPLOYMENT_ID && env.ABACUS_AI_DEPLOYMENT_TOKEN)
}

function isOllamaConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    env.AI_PROVIDER?.trim().toLowerCase() === 'ollama' ||
    Boolean(env.OLLAMA_BASE_URL || env.OLLAMA_MODEL)
  )
}

function getRequestedAiProvider(
  env: NodeJS.ProcessEnv = process.env,
  providerOverride?: AiProvider | null,
): AiProvider | null {
  if (providerOverride) return providerOverride
  const value = env.AI_PROVIDER?.trim().toLowerCase()
  if (!value) return 'auto'
  return AI_PROVIDERS.includes(value as AiProvider) ? (value as AiProvider) : null
}

function resolveAiProvider(
  env: NodeJS.ProcessEnv = process.env,
  providerOverride?: AiProvider | null,
): ResolvedAiProvider {
  const requested = getRequestedAiProvider(env, providerOverride)
  if (
    requested === 'ollama' ||
    requested === 'qwen' ||
    requested === 'openai' ||
    requested === 'abacus'
  ) {
    return requested
  }
  if (isOllamaConfigured(env)) return 'ollama'
  if (isQwenConfigured(env)) return 'qwen'
  if (isOpenAIConfigured(env)) return 'openai'
  return 'abacus'
}

function normalizeModelOverride(modelOverride?: string | null): string | null {
  const trimmed = modelOverride?.trim()
  return trimmed ? trimmed : null
}

function getOpenAIModel(
  env: NodeJS.ProcessEnv = process.env,
  modelOverride?: string | null,
): string {
  const override = normalizeModelOverride(modelOverride)
  if (override) return override
  return env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL
}

function getOpenAIReasoningEffort(
  env: NodeJS.ProcessEnv = process.env,
): OpenAIReasoningEffort {
  const value = env.OPENAI_REASONING_EFFORT?.trim().toLowerCase()
  if (value === 'low' || value === 'medium' || value === 'high') return value
  return DEFAULT_OPENAI_REASONING_EFFORT
}

function getQwenModel(
  env: NodeJS.ProcessEnv = process.env,
  modelOverride?: string | null,
): string {
  const override = normalizeModelOverride(modelOverride)
  if (override) return override
  return env.QWEN_MODEL || DEFAULT_QWEN_MODEL
}

function getOllamaModel(
  env: NodeJS.ProcessEnv = process.env,
  modelOverride?: string | null,
): string {
  const override = normalizeModelOverride(modelOverride)
  if (override) return override
  return env.OLLAMA_MODEL || DEFAULT_OLLAMA_MODEL
}

function getOllamaApiBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const baseUrl = (env.OLLAMA_BASE_URL || DEFAULT_OLLAMA_BASE_URL).replace(/\/+$/, '')
  return baseUrl.endsWith('/api') ? baseUrl : `${baseUrl}/api`
}

function getAiProviderModel(
  provider: ResolvedAiProvider,
  env: NodeJS.ProcessEnv,
  modelOverride?: string | null,
): string {
  if (provider === 'ollama') return getOllamaModel(env, modelOverride)
  if (provider === 'qwen') return getQwenModel(env, modelOverride)
  if (provider === 'openai') return getOpenAIModel(env, modelOverride)
  return 'deployment agent'
}

function getAiProviderDisplayName(provider: ResolvedAiProvider): string {
  if (provider === 'ollama') return 'Llama (Ollama)'
  if (provider === 'qwen') return 'Qwen'
  if (provider === 'openai') return 'OpenAI'
  return 'Abacus AI'
}

export function getAiProviderRuntimeInfo(
  env: NodeJS.ProcessEnv = process.env,
  selection: AiProviderSelection = {},
): AiProviderRuntimeInfo {
  const requestedProvider = getRequestedAiProvider(env, selection.provider)
  const configurationError = getProviderConfigurationError(env, selection.provider)
  const provider = requestedProvider ? resolveAiProvider(env, selection.provider) : null
  const model = provider ? getAiProviderModel(provider, env, selection.model) : 'unknown'
  const label = provider ? `${getAiProviderDisplayName(provider)} - ${model}` : 'Invalid provider'

  return {
    requestedProvider: requestedProvider ?? 'invalid',
    provider,
    model,
    label,
    configured: configurationError === null,
    configurationError,
    options: getAiProviderRuntimeOptions(env),
  }
}

function getAiProviderRuntimeOptions(
  env: NodeJS.ProcessEnv = process.env,
): AiProviderRuntimeOption[] {
  return AI_RUNTIME_PROVIDER_OPTIONS.map((provider) => {
    const configurationError = getProviderConfigurationError(env, provider)
    const model = getAiProviderModel(provider, env)
    return {
      provider,
      model,
      label: `${getAiProviderDisplayName(provider)} - ${model}`,
      configured: configurationError === null,
      configurationError,
    }
  })
}

function getProviderConfigurationError(
  env: NodeJS.ProcessEnv = process.env,
  providerOverride?: AiProvider | null,
): string | null {
  const requested = getRequestedAiProvider(env, providerOverride)
  if (!requested) {
    return 'AI_PROVIDER must be one of: auto, ollama, qwen, openai, abacus.'
  }

  if (requested === 'ollama') {
    return isOllamaConfigured(env)
      ? null
      : 'Set OLLAMA_BASE_URL or OLLAMA_MODEL, or set AI_PROVIDER=auto.'
  }

  if (requested === 'qwen') {
    return isQwenConfigured(env)
      ? null
      : 'Set QWEN_API_KEY or DASHSCOPE_API_KEY, or set AI_PROVIDER=auto.'
  }

  if (requested === 'openai') {
    return isOpenAIConfigured(env) ? null : 'Set OPENAI_API_KEY, or set AI_PROVIDER=auto.'
  }

  if (requested === 'abacus') {
    return isAbacusConfigured(env)
      ? null
      : 'Set ABACUS_AI_DEPLOYMENT_ID and ABACUS_AI_DEPLOYMENT_TOKEN.'
  }

  if (
    isOllamaConfigured(env) ||
    isQwenConfigured(env) ||
    isOpenAIConfigured(env) ||
    isAbacusConfigured(env)
  ) {
    return null
  }
  return 'Set AI_PROVIDER=ollama, set OLLAMA_MODEL, set QWEN_API_KEY, set OPENAI_API_KEY, or set ABACUS_AI_DEPLOYMENT_ID and ABACUS_AI_DEPLOYMENT_TOKEN.'
}

function openAIPlanResponseFormat() {
  const argumentProperties = {
    name: { type: ['string', 'null'] },
    roomType: { type: ['string', 'null'] },
    width: { type: ['number', 'null'] },
    depth: { type: ['number', 'null'] },
    wallId: { type: ['string', 'null'] },
    t: { type: ['number', 'null'] },
    height: { type: ['number', 'null'] },
    sillHeight: { type: ['number', 'null'] },
    windowType: { enum: [...AI_WINDOW_TYPES, null] },
    assetId: { type: ['string', 'null'] },
    item: { type: ['string', 'null'] },
    x: { type: ['number', 'null'] },
    y: { type: ['number', 'null'] },
    z: { type: ['number', 'null'] },
    rotationY: { type: ['number', 'null'] },
    elevation: { type: ['number', 'null'] },
    includeRailing: { type: ['boolean', 'null'] },
  }

  return {
    type: 'json_schema',
    name: 'ai_3d_generative_plan',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['message', 'title', 'steps', 'reads', 'changes', 'actions'],
      properties: {
        message: { type: 'string' },
        title: { type: 'string' },
        steps: { type: 'integer', minimum: 0 },
        reads: { type: 'integer', minimum: 0 },
        changes: { type: 'integer', minimum: 0 },
        actions: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['tool', 'arguments'],
            properties: {
              tool: { type: 'string', enum: [...OPENAI_STRUCTURED_ACTIONS] },
              arguments: {
                type: 'object',
                additionalProperties: false,
                required: Object.keys(argumentProperties),
                properties: argumentProperties,
              },
            },
          },
        },
      },
    },
  }
}

async function callOpenAI(
  request: Ai3DGenerativeRequest,
  env: NodeJS.ProcessEnv = process.env,
  modelOverride?: string | null,
): Promise<Ai3DGenerativePlan> {
  const apiKey = env.OPENAI_API_KEY
  if (!apiKey) throw new Error('openai_not_configured: set OPENAI_API_KEY')

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: getOpenAIModel(env, modelOverride),
      input: [
        {
          role: 'system',
          content: [
            {
              type: 'input_text',
              text: ai3DGenerativeSystemPrompt({ supportedActions: OPENAI_STRUCTURED_ACTIONS }),
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: JSON.stringify({
                message: request.message,
                history: request.history ?? [],
                sceneId: request.sceneId,
                conversationId: request.conversationId,
                scene: request.scene,
              }),
            },
          ],
        },
      ],
      reasoning: { effort: getOpenAIReasoningEffort(env) },
      text: { format: openAIPlanResponseFormat() },
    }),
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`openai_request_failed: ${response.status}${text ? ` ${text}` : ''}`)
  }

  const payload = await response.json()
  return normalizePlan(parseJson(extractResponseText(payload)), 'openai_response_invalid')
}

async function callQwen(
  request: Ai3DGenerativeRequest,
  env: NodeJS.ProcessEnv = process.env,
  modelOverride?: string | null,
): Promise<Ai3DGenerativePlan> {
  const apiKey = getQwenApiKey(env)
  if (!apiKey) throw new Error('qwen_not_configured: set QWEN_API_KEY or DASHSCOPE_API_KEY')

  const baseUrl = (env.QWEN_BASE_URL || DEFAULT_QWEN_BASE_URL).replace(/\/+$/, '')
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: getQwenModel(env, modelOverride),
      messages: [
        {
          role: 'system',
          content: ai3DGenerativeSystemPrompt(),
        },
        {
          role: 'user',
          content: JSON.stringify({
            message: request.message,
            history: request.history ?? [],
            sceneId: request.sceneId,
            conversationId: request.conversationId,
            scene: request.scene,
          }),
        },
      ],
      response_format: { type: 'json_object' },
    }),
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`qwen_request_failed: ${response.status}${text ? ` ${text}` : ''}`)
  }

  const payload = await response.json()
  return normalizePlan(parseJson(extractChatCompletionText(payload)), 'qwen_response_invalid')
}

async function callOllama(
  request: Ai3DGenerativeRequest,
  env: NodeJS.ProcessEnv = process.env,
  modelOverride?: string | null,
): Promise<Ai3DGenerativePlan> {
  const response = await fetch(`${getOllamaApiBaseUrl(env)}/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: getOllamaModel(env, modelOverride),
      messages: [
        {
          role: 'system',
          content: ai3DGenerativeSystemPrompt(),
        },
        {
          role: 'user',
          content: JSON.stringify({
            message: request.message,
            history: request.history ?? [],
            sceneId: request.sceneId,
            conversationId: request.conversationId,
            scene: request.scene,
          }),
        },
      ],
      stream: false,
      format: 'json',
      options: {
        temperature: 0.1,
      },
    }),
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`ollama_request_failed: ${response.status}${text ? ` ${text}` : ''}`)
  }

  const payload = await response.json()
  return normalizePlan(parseJson(extractOllamaChatText(payload)), 'ollama_response_invalid')
}

async function callAbacus(
  request: Ai3DGenerativeRequest,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Ai3DGenerativePlan> {
  const deploymentId = env.ABACUS_AI_DEPLOYMENT_ID
  const deploymentToken = env.ABACUS_AI_DEPLOYMENT_TOKEN

  if (!(deploymentId && deploymentToken)) {
    throw new Error(
      'abacus_not_configured: set ABACUS_AI_DEPLOYMENT_ID and ABACUS_AI_DEPLOYMENT_TOKEN',
    )
  }

  const agentInput = {
    message: request.message,
    history: request.history ?? [],
    sceneId: request.sceneId,
    conversationId: request.conversationId,
    scene: request.scene,
    instructions: ai3DGenerativeSystemPrompt(),
  }

  const response = await fetch(
    `${DEFAULT_ABACUS_ENDPOINT}?deploymentToken=${encodeURIComponent(deploymentToken)}&deploymentId=${encodeURIComponent(deploymentId)}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        arguments: JSON.stringify([]),
        keywordArguments: JSON.stringify({ input: agentInput }),
      }),
    },
  )

  if (!response.ok) {
    throw new Error(`abacus_request_failed: ${response.status}`)
  }

  const payload = await response.json()
  const rawResult = unwrapProviderResult(payload)
  return normalizePlan(parseJsonLike(rawResult), 'abacus_response_invalid')
}

function ai3DGenerativeSystemPrompt({
  supportedActions = SUPPORTED_ACTIONS,
}: {
  supportedActions?: readonly string[]
} = {}): string {
  const allowApplyPatch = supportedActions.includes('apply_patch')
  return [
    'You are Pascal AI, a 3D generative scene tool for an interior/building editor.',
    'Return JSON only. Do not use markdown.',
    'Each request includes the current user message, recent conversation history, and the current scene graph. Use the history to resolve follow-up requests and references like "that room", "make it bigger", or "add another one".',
    'If the user asks a question or requests an explanation instead of a scene change, answer in message and return actions: [].',
    `Supported actions: ${supportedActions.join(', ')}.`,
    'Use create_room when the user asks to generate a new room, house shell, studio, or empty building space. Its arguments are { "name"?: string, "roomType"?: string, "width"?: number, "depth"?: number }. Use values in meters.',
    'For furnished room requests such as living room, bedroom, kitchen, dining room, studio, or office, return create_room followed by multiple add_furniture actions with explicit x/z positions. Do not stop after create_room unless the user asks for an empty room or shell.',
    'For a living room, prefer sofa, coffee-table, livingroom-chair, tv-stand, television, rectangular-carpet, floor-lamp, and indoor-plant. For a studio, combine a bed, seating, table/desk, rug, and storage or plants.',
    'For outdoor garden requests, use create_room with roomType "garden" followed by add_furniture actions using outdoor assets such as tree, fir-tree, bush, hedge, patio-umbrella, sunbed, fence, high-fence, palm, cactus, or outdoor-playhouse.',
    'For outdoor living, deck, patio, terrace, or pergola requests, use create_deck and create_pergola instead of apply_patch. These actions place local GLB assets from /items/deck and /items/pergola and auto-fit them to meters. create_deck arguments are { "name"?: string, "assetId"?: string, "item"?: string, "width"?: number, "depth"?: number, "x"?: number, "z"?: number, "elevation"?: number, "includeRailing"?: boolean }. Useful deck assetIds: deck-082523, deck-stairs-guardrails, ship-deck-balcony. create_pergola arguments are { "name"?: string, "assetId"?: string, "item"?: string, "width"?: number, "depth"?: number, "x"?: number, "z"?: number, "height"?: number, "rotationY"?: number }. Prefer pergola-3 for generic outdoor living deck + pergola combos. Useful pergola assetIds: pergola-3, pergola, timber-pergola, wooden-garden-pergola, wooden-building-pergola.',
    'Use add_door for simple requests to add a door. Its arguments are { "wallId"?: string, "t"?: number, "width"?: number, "height"?: number }. If the user does not specify a wall, omit wallId and the app will choose a reasonable wall.',
    'Use add_window for simple requests to add a window. Its arguments are { "wallId"?: string, "t"?: number, "width"?: number, "height"?: number, "sillHeight"?: number, "windowType"?: string }. If the user does not specify a wall, omit wallId and the app will choose a reasonable wall.',
    `Use add_furniture for requests to place furniture or local 3D assets. Its arguments are { "assetId"?: string, "item"?: string, "x"?: number, "y"?: number, "z"?: number, "rotationY"?: number }. Useful local asset ids include: ${AI_FURNITURE_ASSETS.map((asset) => asset.id).join(', ')}.`,
    allowApplyPatch
      ? 'Use apply_patch for other scene mutations. Prefer small, valid patches grounded in the provided scene graph.'
      : 'If the request cannot be expressed with the supported actions and existing schemas, explain the missing capability in message and return actions: [].',
    'Do not ask clarifying questions for normal generation requests. Choose reasonable dimensions and defaults, then mutate the scene.',
    'Respond with exactly this shape:',
    `{"message": string, "title"?: string, "steps"?: number, "reads"?: number, "changes"?: number, "actions": [{"tool": ${supportedActions.map((tool) => JSON.stringify(tool)).join(' | ')}, "arguments"?: object}]}`,
    'If you cannot confidently mutate the scene, return actions: [] and explain what is missing in message.',
  ].join('\n')
}

function normalizePlan(value: unknown, errorPrefix: string): Ai3DGenerativePlan {
  const parsed = planSchema.safeParse(value)
  if (!parsed.success) {
    throw new Error(`${errorPrefix}: ${parsed.error.message}`)
  }
  return {
    message: parsed.data.message ?? parsed.data.response ?? '',
    actions: parsed.data.actions,
    title: parsed.data.title,
    steps: parsed.data.steps,
    reads: parsed.data.reads,
    changes: parsed.data.changes,
  }
}

function extractResponseText(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return ''
  const obj = payload as Record<string, unknown>
  if (typeof obj.output_text === 'string') return obj.output_text
  const output = obj.output
  if (!Array.isArray(output)) return ''
  const texts: string[] = []
  for (const item of output) {
    if (!item || typeof item !== 'object') continue
    const content = (item as Record<string, unknown>).content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (!block || typeof block !== 'object') continue
      const text = (block as Record<string, unknown>).text
      if (typeof text === 'string') texts.push(text)
    }
  }
  return texts.join('\n').trim()
}

function extractChatCompletionText(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return ''
  const choices = (payload as Record<string, unknown>).choices
  if (!Array.isArray(choices)) return ''

  const texts: string[] = []
  for (const choice of choices) {
    if (!choice || typeof choice !== 'object') continue
    const message = (choice as Record<string, unknown>).message
    if (!message || typeof message !== 'object') continue
    const content = (message as Record<string, unknown>).content
    if (typeof content === 'string') {
      texts.push(content)
      continue
    }
    if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== 'object') continue
        const text = (block as Record<string, unknown>).text
        if (typeof text === 'string') texts.push(text)
      }
    }
  }

  return texts.join('\n').trim()
}

function extractOllamaChatText(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return ''
  const obj = payload as Record<string, unknown>
  const message = obj.message
  if (message && typeof message === 'object') {
    const content = (message as Record<string, unknown>).content
    if (typeof content === 'string') return content.trim()
  }
  return typeof obj.response === 'string' ? obj.response.trim() : ''
}

function unwrapProviderResult(payload: unknown): unknown {
  if (!payload || typeof payload !== 'object') return payload
  const obj = payload as Record<string, unknown>
  return obj.result ?? obj.output ?? obj.response ?? payload
}

function parseJsonLike(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {}
  const parsedObject = parseFirstJsonObject(value)
  if (parsedObject !== null) return parsedObject
  return { message: value, actions: [] }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {}
  const parsedObject = parseFirstJsonObject(text)
  if (parsedObject !== null) return parsedObject
  throw new Error('response did not contain JSON')
}

function parseFirstJsonObject(text: string): unknown | null {
  let start = -1
  let depth = 0
  let inString = false
  let escaped = false

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]
    if (start === -1) {
      if (char === '{') {
        start = i
        depth = 1
      }
      continue
    }

    if (inString) {
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }

    if (char === '"') {
      inString = true
    } else if (char === '{') {
      depth += 1
    } else if (char === '}') {
      depth -= 1
      if (depth === 0) {
        return JSON.parse(text.slice(start, i + 1))
      }
    }
  }

  return null
}

function fallbackActionsForPrompt(
  message: string,
  actions: Ai3DGenerativeAction[],
): Ai3DGenerativeAction[] {
  const promptTemplateActions = promptTemplateActionsForPrompt(message)
  if (promptTemplateActions) return promptTemplateActions
  const deterministicLayoutActions = deterministicRoomLayoutActionsForPrompt(message, actions)
  if (deterministicLayoutActions) return deterministicLayoutActions
  if (actions.length > 0) return actions
  if (shouldAutoAddDoor(message) && shouldAutoAddWindow(message)) {
    return [
      { tool: 'add_door', arguments: { t: 0.35 } },
      { tool: 'add_window', arguments: { t: 0.72 } },
    ]
  }
  if (shouldAutoAddWindow(message)) return [{ tool: 'add_window', arguments: { t: 0.5 } }]
  if (shouldAutoAddDoor(message)) return [{ tool: 'add_door', arguments: { t: 0.5 } }]
  if (shouldAutoCreateRoom(message)) {
    const furniture = inferFurnitureAssetQuery(message)
    const roomAction: Ai3DGenerativeAction = {
      tool: 'create_room',
      arguments: {
        name: /\bliving\b/i.test(message) ? 'Living room' : 'AI Room',
        roomType: /\bliving\b/i.test(message) ? 'living' : 'room',
        width: /\bsmall\b/i.test(message) ? 4 : 6,
        depth: /\bsmall\b/i.test(message) ? 3 : 4,
      },
    }
    if (furniture) {
      return [roomAction, { tool: 'add_furniture', arguments: { item: furniture } }]
    }
    return [roomAction]
  }
  if (shouldAutoAddFurniture(message)) {
    return [
      {
        tool: 'add_furniture',
        arguments: { item: inferFurnitureAssetQuery(message) ?? 'sofa' },
      },
    ]
  }
  return actions
}

function promptTemplateActionsForPrompt(message: string): Ai3DGenerativeAction[] | null {
  return (
    starterTemplateActionsForPrompt(message) ??
    outdoorLivingTemplateActionsForPrompt(message) ??
    suggestionTemplateActionsForPrompt(message) ??
    deterministicRoomLayoutActionsForPrompt(message, [])
  )
}

function starterTemplateActionsForPrompt(message: string): Ai3DGenerativeAction[] | null {
  const normalized = normalizeAssetQuery(message)
  if (!normalized.includes('starter template')) return null

  if (normalized.includes('living room')) {
    return createRoomLayoutActions(ROOM_LAYOUT_DEFS.living)
  }

  if (normalized.includes('bed room') || normalized.includes('bedroom')) {
    return createRoomLayoutActions(ROOM_LAYOUT_DEFS.bedroom)
  }

  if (normalized.includes('kitchen')) {
    return createRoomLayoutActions(ROOM_LAYOUT_DEFS.kitchen)
  }

  if (normalized.includes('dining room')) {
    return createRoomLayoutActions(ROOM_LAYOUT_DEFS.dining)
  }

  return null
}

function outdoorLivingTemplateActionsForPrompt(message: string): Ai3DGenerativeAction[] | null {
  const normalized = normalizeAssetQuery(message)
  const isGenerationRequest = /\b(add|create|place|generate|build|design|make)\b/i.test(message)
  const wantsPatioSurface =
    (normalized.includes('patio') && !normalized.includes('patio umbrella')) ||
    normalized.includes('terrace')
  const wantsDeck =
    normalized.includes('deck') ||
    wantsPatioSurface ||
    normalized.includes('outdoor living')
  const wantsPergola = normalized.includes('pergola')
  const wantsOutdoorLiving = normalized.includes('outdoor living')

  if (!isGenerationRequest || !(wantsDeck || wantsPergola)) return null

  const width = normalized.includes('small') ? 15.6 : OUTDOOR_LIVING_DEFAULT_WIDTH
  const depth = normalized.includes('small') ? 10.8 : OUTDOOR_LIVING_DEFAULT_DEPTH
  const shouldFurnish =
    wantsOutdoorLiving ||
    (wantsDeck && wantsPergola) ||
    normalized.includes('lounge') ||
    normalized.includes('seating')
  const deckAssetId = inferDeckAssetId(message)
  const pergolaAssetId = inferPergolaAssetId(message)

  if (wantsDeck && wantsPergola) {
    return createOutdoorLivingActions(message, {
      width,
      depth,
      includeDefaultFurniture: shouldFurnish,
      deckAssetId,
      pergolaAssetId,
    })
  }

  if (wantsOutdoorLiving) {
    return createOutdoorLivingActions(message, {
      width,
      depth,
      includeDefaultFurniture: true,
      deckAssetId,
      pergolaAssetId,
    })
  }

  if (wantsDeck) {
    return [
      {
        tool: 'create_deck',
        arguments: {
          name: 'Outdoor living deck',
          width,
          depth,
          elevation: OUTDOOR_LIVING_DEFAULT_ELEVATION,
          includeRailing: true,
          assetId: deckAssetId,
        },
      },
    ]
  }

  return [
    {
      tool: 'create_pergola',
      arguments: {
        name: 'Outdoor pergola',
        width: Math.min(width, 5),
        depth: Math.min(depth, 3.4),
        height: OUTDOOR_LIVING_PERGOLA_HEIGHT,
        assetId: pergolaAssetId,
      },
    },
  ]
}

function createOutdoorLivingActions(
  message: string,
  options: {
    width?: number
    depth?: number
    includeDefaultFurniture?: boolean
    deckAssetId?: string
    pergolaAssetId?: string
  } = {},
): Ai3DGenerativeAction[] {
  const width = options.width ?? OUTDOOR_LIVING_DEFAULT_WIDTH
  const depth = options.depth ?? OUTDOOR_LIVING_DEFAULT_DEPTH
  const deckAssetId = options.deckAssetId ?? inferDeckAssetId(message)
  const pergolaAssetId = options.pergolaAssetId ?? inferPergolaAssetId(message)
  const isTimberTechPergola = pergolaAssetId === 'wooden-building-pergola'
  const layoutAnchor = getOutdoorLivingLayoutAnchor(deckAssetId, width, depth)
  const furniture = selectOutdoorLivingFurniture(message, options.includeDefaultFurniture ?? true)

  return [
    {
      tool: 'create_deck',
      arguments: {
        name: 'Outdoor living deck',
        width,
        depth,
        elevation: OUTDOOR_LIVING_DEFAULT_ELEVATION,
        includeRailing: false,
        assetId: deckAssetId,
      },
    },
    {
      tool: 'create_pergola',
      arguments: {
        name: 'Outdoor living pergola',
        width: Math.max(3.2, width - (isTimberTechPergola ? 0.4 : 1.3)),
        depth: Math.max(2.6, depth - (isTimberTechPergola ? 0.25 : 1)),
        x: layoutAnchor.x,
        z: layoutAnchor.z,
        height: isTimberTechPergola
          ? TIMBERTECH_PERGOLA_DEFAULT_HEIGHT
          : OUTDOOR_LIVING_PERGOLA_HEIGHT,
        assetId: pergolaAssetId,
      },
    },
    ...furniture.map((item) => {
      const args: Record<string, unknown> = {
        assetId: item.assetId,
        x: roundMeters(layoutAnchor.x + item.x),
        z: roundMeters(layoutAnchor.z + item.z),
      }
      if (typeof item.y === 'number') args.y = item.y
      if (typeof item.rotationY === 'number') args.rotationY = item.rotationY
      return { tool: 'add_furniture' as const, arguments: args }
    }),
  ]
}

function selectOutdoorLivingFurniture(
  message: string,
  includeDefaultFurniture: boolean,
): RoomLayoutFurnitureSlot[] {
  const slots = includeDefaultFurniture ? [...OUTDOOR_LIVING_FURNITURE] : []
  const existingAssetIds = new Set(slots.map((slot) => slot.assetId))
  const requestedAssetIds = collectRequestedFurnitureAssetIds(message, [])

  for (const assetId of requestedAssetIds) {
    if (
      isOutdoorLivingStructureAssetId(assetId) ||
      existingAssetIds.has(assetId) ||
      !AI_FURNITURE_ASSETS.some((asset) => asset.id === assetId)
    ) {
      continue
    }
    const extraSlot = ROOM_LAYOUT_EXTRA_SLOTS[slots.length % ROOM_LAYOUT_EXTRA_SLOTS.length] ?? {
      assetId: '',
      x: 0,
      z: 0,
    }
    slots.push({ ...extraSlot, assetId })
    existingAssetIds.add(assetId)
  }

  return slots
}

function inferDeckAssetId(message: string): string {
  const normalized = normalizeAssetQuery(message)
  const requested = findFurnitureAsset(message)
  if (requested && (DECK_ASSET_IDS as readonly string[]).includes(requested.id)) {
    return requested.id
  }
  if (normalized.includes('balcony') || normalized.includes('ship deck')) return 'ship-deck-balcony'
  if (
    normalized.includes('stairs') ||
    normalized.includes('stair') ||
    normalized.includes('guardrail') ||
    normalized.includes('railing') ||
    normalized.includes('raised')
  ) {
    return 'deck-stairs-guardrails'
  }
  return 'deck-082523'
}

function inferPergolaAssetId(message: string): string {
  const normalized = normalizeAssetQuery(message)
  if (normalized.includes('timbertech')) return 'wooden-building-pergola'
  if (normalized.includes('timber')) return 'timber-pergola'
  if (normalized.includes('garden') || normalized.includes('backyard')) {
    return 'wooden-garden-pergola'
  }
  if (normalized.includes('wooden') || normalized.includes('wood pergola')) {
    return 'wooden-building-pergola'
  }
  if (
    normalized.includes('pergola 3') ||
    normalized.includes('modern pergola') ||
    normalized.includes('outdoor living') ||
    normalized.includes('deck') ||
    normalized.includes('patio') ||
    normalized.includes('terrace')
  ) {
    return 'pergola-3'
  }
  const requested = findFurnitureAsset(message)
  if (
    requested &&
    requested.id !== 'pergola' &&
    (PERGOLA_ASSET_IDS as readonly string[]).includes(requested.id)
  ) {
    return requested.id
  }
  return 'pergola-3'
}

function isOutdoorLivingStructureAssetId(assetId: string): boolean {
  return (
    (DECK_ASSET_IDS as readonly string[]).includes(assetId) ||
    (PERGOLA_ASSET_IDS as readonly string[]).includes(assetId)
  )
}

function suggestionTemplateActionsForPrompt(message: string): Ai3DGenerativeAction[] | null {
  const normalized = normalizeAssetQuery(message)

  if (
    /\b(add|create|place)\b/i.test(message) &&
    normalized.includes('door') &&
    normalized.includes('window')
  ) {
    return [
      { tool: 'add_door', arguments: { t: 0.35 } },
      { tool: 'add_window', arguments: { t: 0.72 } },
    ]
  }

  if (normalized.includes('compact living room')) {
    return createRoomLayoutActions(ROOM_LAYOUT_DEFS.living, {
      name: 'Compact living room',
      width: 5.5,
    })
  }

  if (normalized.includes('small studio room')) {
    return createRoomLayoutActions(ROOM_LAYOUT_DEFS.studio, {
      name: 'Small studio room',
      width: 5.5,
      depth: 4.2,
    })
  }

  if (
    normalized.includes('outdoor garden') ||
    normalized.includes('garden layout') ||
    normalized.includes('garden')
  ) {
    return createRoomLayoutActions(ROOM_LAYOUT_DEFS.garden, {
      requestedAssetIds: collectRequestedFurnitureAssetIds(message, []),
    })
  }

  if (normalized.includes('simple house shell')) {
    return createRoomLayoutActions(ROOM_LAYOUT_DEFS.house)
  }

  return null
}

function deterministicRoomLayoutActionsForPrompt(
  message: string,
  actions: Ai3DGenerativeAction[],
): Ai3DGenerativeAction[] | null {
  const layoutType = inferRoomLayoutType(message, actions)
  if (!layoutType) return null
  if (!shouldUseRoomLayoutPlanner(message, actions, layoutType)) return null

  const layout = ROOM_LAYOUT_DEFS[layoutType]
  const roomActionArgs = readFirstCreateRoomArgs(actions)
  return createRoomLayoutActions(layout, {
    name: roomActionArgs.name ?? layout.name,
    roomType: roomActionArgs.roomType ?? layout.roomType,
    width: roomActionArgs.width ?? layout.width,
    depth: roomActionArgs.depth ?? layout.depth,
    requestedAssetIds: collectRequestedFurnitureAssetIds(message, actions),
    includeDefaultFurniture:
      !(isUnfurnishedRoomRequest(message) || isOnlyRequestedFurnitureRequest(message)),
  })
}

function createRoomLayoutActions(
  layout: RoomLayoutDefinition,
  options: RoomLayoutActionOptions = {},
): Ai3DGenerativeAction[] {
  const furniture = selectRoomLayoutFurniture(layout, options)
  return [
    {
      tool: 'create_room',
      arguments: {
        name: options.name ?? layout.name,
        roomType: options.roomType ?? layout.roomType,
        width: options.width ?? layout.width,
        depth: options.depth ?? layout.depth,
      },
    },
    ...furniture.map((item) => {
      const args: Record<string, unknown> = {
        assetId: item.assetId,
        x: item.x,
        z: item.z,
      }
      if (typeof item.y === 'number') args.y = item.y
      if (typeof item.rotationY === 'number') args.rotationY = item.rotationY
      return { tool: 'add_furniture' as const, arguments: args }
    }),
  ]
}

function selectRoomLayoutFurniture(
  layout: RoomLayoutDefinition,
  options: RoomLayoutActionOptions,
): RoomLayoutFurnitureSlot[] {
  const slots = options.includeDefaultFurniture === false ? [] : [...layout.furniture]
  const existingAssetIds = new Set(slots.map((slot) => slot.assetId))
  const requestedAssetIds = options.requestedAssetIds ?? []

  for (const assetId of requestedAssetIds) {
    if (
      isOutdoorLivingStructureAssetId(assetId) ||
      existingAssetIds.has(assetId) ||
      !AI_FURNITURE_ASSETS.some((asset) => asset.id === assetId)
    ) {
      continue
    }
    const layoutSlot = layout.furniture.find((slot) => slot.assetId === assetId)
    const extraSlot = layoutSlot ??
      ROOM_LAYOUT_EXTRA_SLOTS[slots.length % ROOM_LAYOUT_EXTRA_SLOTS.length] ?? {
        assetId: '',
        x: 0,
        z: 0,
      }
    slots.push({ ...extraSlot, assetId })
    existingAssetIds.add(assetId)
  }

  return slots
}

function inferRoomLayoutType(
  message: string,
  actions: Ai3DGenerativeAction[],
): RoomLayoutType | null {
  const roomActionArgs = readFirstCreateRoomArgs(actions)
  const normalized = normalizeAssetQuery(
    [message, roomActionArgs.name, roomActionArgs.roomType].filter(Boolean).join(' '),
  )

  if (normalized.includes('living room') || /\bliving\b/.test(normalized)) return 'living'
  if (normalized.includes('bed room') || normalized.includes('bedroom')) return 'bedroom'
  if (normalized.includes('kitchen')) return 'kitchen'
  if (normalized.includes('dining room') || /\bdining\b/.test(normalized)) return 'dining'
  if (normalized.includes('studio')) return 'studio'
  if (normalized.includes('office') || normalized.includes('workspace')) return 'office'
  if (
    normalized.includes('outdoor garden') ||
    normalized.includes('garden') ||
    normalized.includes('landscape') ||
    normalized.includes('backyard') ||
    normalized.includes('yard')
  ) {
    return 'garden'
  }
  if (normalized.includes('house')) return 'house'
  return null
}

function shouldUseRoomLayoutPlanner(
  message: string,
  actions: Ai3DGenerativeAction[],
  layoutType: RoomLayoutType,
): boolean {
  if (layoutType === 'house') return normalizeAssetQuery(message).includes('house shell')
  if (layoutType === 'garden') {
    return /\b(create|generate|build|design|make)\b/i.test(message)
  }
  if (actions.some((action) => action.tool === 'create_room')) return true
  if (actions.some((action) => action.tool === 'add_furniture') && shouldAutoCreateRoom(message)) {
    return true
  }
  return (
    /\b(create|generate|build|design)\b/i.test(message) &&
    /\b(room|studio|office|kitchen|bedroom|living|dining|garden|backyard|yard)\b/i.test(message)
  )
}

function isUnfurnishedRoomRequest(message: string): boolean {
  const normalized = normalizeAssetQuery(message)
  return (
    normalized.includes('empty') ||
    normalized.includes('unfurnished') ||
    normalized.includes('no furniture') ||
    normalized.includes('without furniture') ||
    normalized.includes('shell')
  )
}

function isOnlyRequestedFurnitureRequest(message: string): boolean {
  const normalized = normalizeAssetQuery(message)
  return /\b(only|just)\b/.test(normalized)
}

function readFirstCreateRoomArgs(actions: Ai3DGenerativeAction[]) {
  const action = actions.find((item) => item.tool === 'create_room')
  const args = action?.arguments ?? {}
  return {
    name: readStringArg(args, ['name']),
    roomType: readStringArg(args, ['roomType', 'type', 'kind']),
    width: readPositiveNumberArg(args, 'width'),
    depth: readPositiveNumberArg(args, 'depth'),
  }
}

function collectRequestedFurnitureAssetIds(
  message: string,
  actions: Ai3DGenerativeAction[],
): string[] {
  const requested = new Set<string>()
  const normalized = normalizeAssetQuery(message)

  for (const asset of AI_FURNITURE_ASSETS) {
    const terms = [
      asset.id,
      asset.name,
      ...asset.keywords.filter((keyword) => {
        const term = normalizeAssetQuery(keyword)
        return term === 'tv' || term.includes(' ')
      }),
    ].map(normalizeAssetQuery)
    if (terms.some((term) => term && normalized.includes(term))) requested.add(asset.id)
  }

  for (const action of actions) {
    if (action.tool !== 'add_furniture') continue
    const requestedAsset = readStringArg(action.arguments ?? {}, [
      'assetId',
      'item',
      'kind',
      'query',
      'name',
      'asset',
    ])
    const asset = requestedAsset ? findFurnitureAsset(requestedAsset) : null
    if (asset) requested.add(asset.id)
  }

  return [...requested]
}

function shouldAutoAddWindow(message: string): boolean {
  return /\b(add|create|place)\b/i.test(message) && /\bwindow\b/i.test(message)
}

function shouldAutoAddDoor(message: string): boolean {
  return /\b(add|create|place)\b/i.test(message) && /\bdoor\b/i.test(message)
}

function shouldAutoAddFurniture(message: string): boolean {
  return (
    /\b(add|create|place|put)\b/i.test(message) &&
    (/\b(furniture|furnish|item|asset|object)\b/i.test(message) ||
      inferFurnitureAssetQuery(message) !== null)
  )
}

function shouldAutoCreateRoom(message: string): boolean {
  return (
    /\b(create|generate|make|build)\b/i.test(message) &&
    /\b(room|house|studio|space|garden|backyard|yard)\b/i.test(message)
  )
}

function isOpenOutdoorRoomType(roomType: string): boolean {
  const normalized = normalizeAssetQuery(roomType)
  return (
    normalized.includes('garden') ||
    normalized.includes('backyard') ||
    normalized.includes('yard') ||
    normalized.includes('landscape') ||
    normalized.includes('outdoor')
  )
}

function inferFurnitureAssetQuery(message: string): string | null {
  return findFurnitureAsset(message)?.id ?? null
}

function findFurnitureAsset(query: string): AiFurnitureAsset | null {
  const normalized = normalizeAssetQuery(query)
  if (!normalized) return null

  const candidates = AI_FURNITURE_ASSETS.flatMap((asset) =>
    [asset.id, asset.name, ...asset.keywords].map((term) => ({
      asset,
      term: normalizeAssetQuery(term),
    })),
  )
    .filter(({ term }) => term.length > 0)
    .sort((a, b) => b.term.length - a.term.length)

  for (const { asset, term } of candidates) {
    if (normalized === term || normalized.includes(term)) return asset
  }
  return null
}

function normalizeAssetQuery(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

function readStringArg(args: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = args[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

function readNumberArg(args: Record<string, unknown>, key: string): number | null {
  const value = args[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function readBooleanArg(args: Record<string, unknown>, key: string): boolean | null {
  const value = args[key]
  return typeof value === 'boolean' ? value : null
}

function readPositiveNumberArg(args: Record<string, unknown>, key: string): number | null {
  const value = readNumberArg(args, key)
  return value !== null && value > 0 ? value : null
}

function readArrayNumber(value: unknown, index: number): number | null {
  if (!Array.isArray(value)) return null
  const item = value[index]
  return typeof item === 'number' && Number.isFinite(item) ? item : null
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function roundMeters(value: number): number {
  return Math.round(value * 1000) / 1000
}

function getDeckSupportSource(deckAsset: AiFurnitureAsset) {
  if (deckAsset.id === 'deck-082523') return DECK_082523_SOURCE_FOOTPRINT
  if (deckAsset.id === 'deck-stairs-guardrails') return DECK_STAIRS_SOURCE_FOOTPRINT
  return null
}

function getOutdoorLivingLayoutAnchor(
  deckAssetId: string,
  width: number,
  depth: number,
): { x: number; z: number } {
  const deckAsset = getAiFurnitureAssetById(deckAssetId)
  if (!deckAsset) return { x: 0, z: 0 }
  const support = computeDeckSupportPlane(
    deckAsset,
    width,
    depth,
    0,
    0,
    OUTDOOR_LIVING_DEFAULT_ELEVATION,
  )
  return { x: support.centerX, z: support.centerZ }
}

function computeDeckSupportPlane(
  deckAsset: AiFurnitureAsset,
  width: number,
  depth: number,
  x: number,
  z: number,
  fallbackSurfaceY: number,
) {
  const source = getDeckSupportSource(deckAsset)
  if (!source) {
    return {
      centerX: x,
      centerZ: z,
      width,
      depth,
      surfaceY: fallbackSurfaceY,
    }
  }

  const footprintScale = Math.max(
    width / source.width,
    depth / source.depth,
  )
  const surfaceOffsetX = (source.surfaceCenterX - source.centerX) * footprintScale
  const surfaceOffsetZ =
    (source.surfaceCenterZ - source.centerZ) * footprintScale

  return {
    centerX: roundMeters(x + surfaceOffsetX),
    centerZ: roundMeters(z + surfaceOffsetZ),
    width: roundMeters(source.surfaceWidth * footprintScale),
    depth: roundMeters(source.surfaceDepth * footprintScale),
    surfaceY: roundMeters((source.surfaceY - source.minY) * footprintScale),
  }
}

function getPergolaSupportMargin(pergolaAsset: AiFurnitureAsset): number {
  return pergolaAsset.id === 'wooden-building-pergola' ? 0.25 : 0.8
}

function getPergolaDefaultHeight(pergolaAsset: AiFurnitureAsset): number {
  return pergolaAsset.id === 'wooden-building-pergola'
    ? TIMBERTECH_PERGOLA_DEFAULT_HEIGHT
    : OUTDOOR_LIVING_PERGOLA_HEIGHT
}

function getPergolaSupportYOffset(
  pergolaAsset: AiFurnitureAsset,
  width: number,
  height: number,
  depth: number,
): number {
  if (pergolaAsset.id !== 'wooden-building-pergola') return 0

  const source = TIMBERTECH_PERGOLA_SOURCE_BOUNDS
  const fitScale = Math.min(width / source.width, height / source.height, depth / source.depth)
  return roundMeters((source.floorY - source.minY) * fitScale)
}

function getAiFurnitureAssetById(id: string): AiFurnitureAsset | null {
  return AI_FURNITURE_ASSETS.find((asset) => asset.id === id) ?? null
}

function createItemAssetPayload(
  asset: AiFurnitureAsset,
  dimensions: [number, number, number] = asset.dimensions,
): AiItemAssetPayload {
  const basePath = `/items/${asset.id}`
  const payload: AiItemAssetPayload = {
    id: asset.id,
    category: asset.category,
    name: asset.name,
    thumbnail: asset.thumbnailPath ?? (asset.modelPath ? '/icons/item.png' : `${basePath}/thumbnail.webp`),
    src: asset.modelPath ?? `${basePath}/model.glb`,
    dimensions,
    tags: asset.keywords,
    offset: asset.offset ?? [0, 0, 0],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
    fitToDimensions: asset.fitToDimensions ?? Boolean(asset.modelPath),
  }
  if (typeof asset.surfaceHeight === 'number') {
    payload.surface = { height: asset.surfaceHeight }
  }
  return payload
}

async function loadSourceGraph(
  store: SceneStore,
  sceneId: string | undefined,
  graph: z.infer<typeof apiGraphSchema> | undefined,
) {
  if (sceneId) {
    const scene = await store.load(sceneId)
    if (!scene) throw new Error(`scene_not_found: ${sceneId}`)
    return {
      graph: graph ? (graph as SceneGraph) : scene.graph,
      meta: {
        id: scene.id,
        name: scene.name,
        projectId: scene.projectId,
        ownerId: scene.ownerId,
        thumbnailUrl: scene.thumbnailUrl,
        version: scene.version,
      },
    }
  }
  if (graph) return { graph: graph as SceneGraph, meta: null }
  return { graph: createDefaultSceneGraph(), meta: null }
}

async function executeAction(
  action: Ai3DGenerativeAction,
  session: GraphSession,
  store: SceneStore,
  fallbackSceneName: string,
): Promise<ActionResult> {
  switch (action.tool) {
    case 'get_scene':
      return { tool: action.tool, result: session.exportSceneGraph() }
    case 'validate_scene':
      return { tool: action.tool, result: session.validateScene() }
    case 'apply_patch': {
      const patches = Array.isArray(action.arguments?.patches) ? action.arguments.patches : []
      const result = session.applyPatch(patches as Patch[])
      return { tool: action.tool, result }
    }
    case 'create_room': {
      const result = session.createRoom(action.arguments ?? {})
      return { tool: action.tool, result }
    }
    case 'add_door': {
      const result = session.addDoor(action.arguments ?? {})
      return { tool: action.tool, result }
    }
    case 'add_window': {
      const result = session.addWindow(action.arguments ?? {})
      return { tool: action.tool, result }
    }
    case 'add_furniture': {
      const result = session.addFurniture(action.arguments ?? {})
      return { tool: action.tool, result }
    }
    case 'create_deck': {
      const result = session.createDeck(action.arguments ?? {})
      return { tool: action.tool, result }
    }
    case 'create_pergola': {
      const result = session.createPergola(action.arguments ?? {})
      return { tool: action.tool, result }
    }
    case 'save_scene': {
      const name =
        typeof action.arguments?.name === 'string' ? action.arguments.name : fallbackSceneName
      return persistActiveScene(session, store, name)
    }
  }
}

async function persistActiveScene(
  session: GraphSession,
  store: SceneStore,
  fallbackSceneName: string,
): Promise<ActionResult> {
  const active = session.getActiveScene()
  if (!active) {
    return { tool: 'save_scene', result: { skipped: true, reason: 'no_saved_scene' } }
  }
  const graph = session.exportSceneGraph()
  const meta = await store.save({
    id: active.id,
    name: fallbackSceneName,
    projectId: active.projectId,
    ownerId: active.ownerId,
    thumbnailUrl: active.thumbnailUrl,
    graph,
    expectedVersion: active.version,
    saveMode: 'draft',
    publish: false,
    operation: 'ai_3d_generative_tool',
  })
  session.setActiveScene(meta)
  await store.appendSceneEvent?.({
    sceneId: meta.id,
    version: meta.version,
    kind: 'ai_3d_generative_tool',
    graph,
  })
  return { tool: 'save_scene', result: meta }
}

function summarizeActions(results: ActionResult[]): string {
  const changes = countChangedActions(results)
  if (changes === 0) return 'Reviewed the scene'
  return `Reviewed the scene and applied ${changes} ${changes === 1 ? 'change' : 'changes'}`
}

function countChangedActions(results: ActionResult[]): number {
  const directChanges = results.filter(
    (r) =>
      r.tool === 'apply_patch' ||
      r.tool === 'save_scene' ||
      r.tool === 'create_room' ||
      r.tool === 'add_door' ||
      r.tool === 'add_window' ||
      r.tool === 'add_furniture' ||
      r.tool === 'create_deck' ||
      r.tool === 'create_pergola',
  ).length
  const embeddedRoomChanges = results.filter(actionCreatedRoomAsPrerequisite).length
  return directChanges + embeddedRoomChanges
}

function summarizeCompletedGeneration(results: ActionResult[]): string | null {
  const createdRoom =
    results.some((r) => r.tool === 'create_room') || results.some(actionCreatedRoomAsPrerequisite)
  const createdOutdoorArea = results.some(actionCreatedOutdoorArea)
  const createdDeck = results.some((r) => r.tool === 'create_deck')
  const createdPergola = results.some((r) => r.tool === 'create_pergola')
  const addedDoor = results.some((r) => r.tool === 'add_door')
  const addedWindow = results.some((r) => r.tool === 'add_window')
  const furnitureResults = results.filter((r) => r.tool === 'add_furniture')
  const furnitureResult = furnitureResults[0]?.result
  const furnitureName =
    furnitureResult && typeof furnitureResult === 'object'
      ? (furnitureResult as { assetName?: unknown }).assetName
      : null
  const addedFurniture = typeof furnitureName === 'string' ? furnitureName : null
  if (createdDeck && createdPergola && furnitureResults.length > 1) {
    return `Generated an outdoor living deck with a GLB pergola and placed ${furnitureResults.length} local assets.`
  }
  if (createdDeck && createdPergola) {
    return 'Generated an outdoor living deck with local deck and pergola GLB assets.'
  }
  if (createdDeck) {
    return 'Generated an outdoor living deck from the local GLB asset library.'
  }
  if (createdPergola) {
    return 'Generated an outdoor pergola from the local GLB asset library.'
  }
  if (createdOutdoorArea && furnitureResults.length > 1) {
    return `Generated an outdoor garden and placed ${furnitureResults.length} local assets.`
  }
  if (createdOutdoorArea && addedFurniture) {
    return `Generated an outdoor garden and placed ${addedFurniture}.`
  }
  if (createdOutdoorArea) {
    return 'Generated an open outdoor garden area.'
  }
  if (createdRoom && furnitureResults.length > 1) {
    return `Generated a room shell and placed ${furnitureResults.length} local assets.`
  }
  if (createdRoom && addedDoor && addedWindow) {
    return 'Generated a room shell, then added a door and window to reasonable walls.'
  }
  if (createdRoom && addedDoor) {
    return 'Generated a room shell and added a door to a reasonable wall.'
  }
  if (createdRoom && addedWindow) {
    return 'Generated a room shell and added a window to a reasonable wall.'
  }
  if (createdRoom && addedFurniture) {
    return `Generated a room shell and placed ${addedFurniture}.`
  }
  if (createdRoom) {
    return 'Generated a room shell with a slab, ceiling, and perimeter walls.'
  }
  if (addedDoor) {
    return 'Added a door to a reasonable wall in the scene.'
  }
  if (addedWindow) {
    return 'Added a window to a reasonable wall in the scene.'
  }
  if (addedFurniture) {
    return `Placed ${addedFurniture} from the local item library.`
  }
  return null
}

function actionCreatedRoomAsPrerequisite(result: ActionResult): boolean {
  if (
    !['add_door', 'add_window', 'add_furniture'].includes(result.tool) ||
    !result.result ||
    typeof result.result !== 'object'
  ) {
    return false
  }
  return Boolean((result.result as { createdRoom?: unknown }).createdRoom)
}

function actionCreatedOutdoorArea(result: ActionResult): boolean {
  if (result.tool !== 'create_room' || !result.result || typeof result.result !== 'object') {
    return false
  }
  return Boolean((result.result as { openOutdoorArea?: unknown }).openOutdoorArea)
}

class GraphSession {
  private graph: SceneGraph
  private activeScene: ActiveSceneMeta | null

  constructor(graph: SceneGraph, activeScene: ActiveSceneMeta | null) {
    this.graph = cloneGraph(graph)
    this.activeScene = activeScene
  }

  getActiveScene(): ActiveSceneMeta | null {
    return this.activeScene
  }

  setActiveScene(meta: ActiveSceneMeta): void {
    this.activeScene = {
      id: meta.id,
      name: meta.name,
      projectId: meta.projectId,
      ownerId: meta.ownerId,
      thumbnailUrl: meta.thumbnailUrl,
      version: meta.version,
    }
  }

  exportSceneGraph(): SceneGraph {
    return cloneGraph(this.graph)
  }

  validateScene() {
    const errors: { nodeId: string; path: string; message: string }[] = []
    for (const [nodeId, node] of Object.entries(this.graph.nodes)) {
      const parsed = AnyNode.safeParse(node)
      if (!parsed.success) {
        for (const issue of parsed.error.issues) {
          errors.push({
            nodeId,
            path: issue.path.map(String).join('.'),
            message: issue.message,
          })
        }
      }
    }
    for (const rootId of this.graph.rootNodeIds) {
      if (!this.graph.nodes[rootId]) {
        errors.push({ nodeId: rootId, path: 'rootNodeIds', message: 'root node not found' })
      }
    }
    return { valid: errors.length === 0, errors }
  }

  applyPatch(patches: Patch[]) {
    const createdIds: AnyNodeId[] = []
    const deletedIds: AnyNodeId[] = []
    for (const patch of patches) {
      if (patch.op === 'create') {
        const parsed = AnyNode.safeParse(patch.node)
        if (!parsed.success) {
          throw new Error(`invalid create node: ${parsed.error.message}`)
        }
        if (patch.parentId && !this.graph.nodes[patch.parentId]) {
          throw new Error(`create parentId not found: ${patch.parentId}`)
        }
        this.graph.nodes[parsed.data.id] = {
          ...parsed.data,
          parentId: patch.parentId ?? parsed.data.parentId ?? null,
        } as AnyNodeType
        if (patch.parentId) {
          appendChildId(this.graph.nodes[patch.parentId], parsed.data.id)
        } else if (!this.graph.rootNodeIds.includes(parsed.data.id)) {
          this.graph.rootNodeIds.push(parsed.data.id)
        }
        createdIds.push(parsed.data.id)
      } else if (patch.op === 'update') {
        const existing = this.graph.nodes[patch.id]
        if (!existing) throw new Error(`update id not found: ${patch.id}`)
        const next = { ...existing, ...patch.data, id: existing.id, type: existing.type }
        const parsed = AnyNode.safeParse(next)
        if (!parsed.success) {
          throw new Error(`invalid update node: ${parsed.error.message}`)
        }
        this.graph.nodes[patch.id] = parsed.data
      } else if (patch.op === 'delete') {
        if (!this.graph.nodes[patch.id]) throw new Error(`delete id not found: ${patch.id}`)
        const ids = collectDescendants(this.graph, patch.id)
        if (ids.length > 1 && patch.cascade === false) {
          throw new Error(`delete ${patch.id} has descendants; pass cascade: true`)
        }
        for (const id of ids) {
          delete this.graph.nodes[id]
          deletedIds.push(id)
        }
        this.graph.rootNodeIds = this.graph.rootNodeIds.filter((id) => !ids.includes(id))
        for (const node of Object.values(this.graph.nodes)) {
          removeChildIds(node, ids)
        }
      }
    }
    return { appliedOps: patches.length, createdIds, deletedIds }
  }

  createRoom(args: Record<string, unknown>) {
    const levelId = this.firstLevelId()
    if (!levelId) throw new Error('create_room requires a level')
    const width = typeof args.width === 'number' && args.width > 0 ? args.width : 6
    const depth = typeof args.depth === 'number' && args.depth > 0 ? args.depth : 4
    const name = typeof args.name === 'string' && args.name.trim() ? args.name.trim() : 'AI Room'
    const roomType =
      typeof args.roomType === 'string' && args.roomType.trim() ? args.roomType.trim() : 'room'
    const halfW = width / 2
    const halfD = depth / 2
    const polygon: [number, number][] = [
      [-halfW, -halfD],
      [halfW, -halfD],
      [halfW, halfD],
      [-halfW, halfD],
    ]
    const openOutdoorArea = isOpenOutdoorRoomType(roomType)
    const zone = ZoneNode.parse({
      name,
      polygon,
      color: openOutdoorArea
        ? '#16a34a'
        : roomType.toLowerCase().includes('living')
          ? '#22c55e'
          : '#60a5fa',
      metadata: { aiTool: 'create_room', roomType },
    })
    const slab = SlabNode.parse({ polygon, metadata: { aiTool: 'create_room', roomType } })
    if (openOutdoorArea) {
      this.applyPatch([
        { op: 'create', node: zone, parentId: levelId },
        { op: 'create', node: slab, parentId: levelId },
      ])

      return {
        zoneId: zone.id,
        slabId: slab.id,
        ceilingId: null,
        wallIds: [],
        width,
        depth,
        areaSqMeters: Math.round(width * depth * 100) / 100,
        openOutdoorArea: true,
      }
    }

    const ceiling = CeilingNode.parse({ polygon, metadata: { aiTool: 'create_room', roomType } })
    const walls = polygon.map((start, index) =>
      WallNode.parse({
        name: `${name} wall ${index + 1}`,
        start,
        end: polygon[(index + 1) % polygon.length],
        metadata: { aiTool: 'create_room', roomType, edgeIndex: index },
      }),
    )

    this.applyPatch([
      { op: 'create', node: zone, parentId: levelId },
      { op: 'create', node: slab, parentId: levelId },
      { op: 'create', node: ceiling, parentId: levelId },
      ...walls.map((wall) => ({ op: 'create' as const, node: wall, parentId: levelId })),
    ])

    return {
      zoneId: zone.id,
      slabId: slab.id,
      ceilingId: ceiling.id,
      wallIds: walls.map((wall) => wall.id),
      width,
      depth,
      areaSqMeters: Math.round(width * depth * 100) / 100,
    }
  }

  createDeck(args: Record<string, unknown>) {
    const levelId = this.firstLevelId()
    if (!levelId) throw new Error('create_deck requires a level')

    const width = clampNumber(
      readPositiveNumberArg(args, 'width') ?? OUTDOOR_LIVING_DEFAULT_WIDTH,
      2.4,
      48,
    )
    const depth = clampNumber(
      readPositiveNumberArg(args, 'depth') ?? OUTDOOR_LIVING_DEFAULT_DEPTH,
      2,
      36,
    )
    const elevation = clampNumber(
      readPositiveNumberArg(args, 'elevation') ?? OUTDOOR_LIVING_DEFAULT_ELEVATION,
      0.04,
      0.6,
    )
    const x = readNumberArg(args, 'x') ?? 0
    const z = readNumberArg(args, 'z') ?? 0
    const name =
      typeof args.name === 'string' && args.name.trim()
        ? args.name.trim()
        : 'Outdoor living deck'
    const includeRailing = readBooleanArg(args, 'includeRailing') ?? true
    const deckAsset = this.resolveDeckAsset(args)
    const deckDimensions: [number, number, number] = [width, deckAsset.dimensions[1], depth]
    const halfW = width / 2
    const halfD = depth / 2
    const polygon: [number, number][] = [
      [x - halfW, z - halfD],
      [x + halfW, z - halfD],
      [x + halfW, z + halfD],
      [x - halfW, z + halfD],
    ]

    const deckSupport = computeDeckSupportPlane(deckAsset, width, depth, x, z, elevation)
    const zone = ZoneNode.parse({
      name,
      polygon,
      color: '#92400e',
      metadata: {
        aiTool: 'create_deck',
        roomType: 'outdoor-living',
        outdoorLiving: true,
        surfaceY: deckSupport.surfaceY,
      },
    })
    const deckAssetPayload = createItemAssetPayload(deckAsset, deckDimensions)
    deckAssetPayload.surface = { height: deckSupport.surfaceY }
    const deckItem = ItemNode.parse({
      name,
      parentId: levelId,
      position: [x, 0, z],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
      asset: deckAssetPayload,
      metadata: {
        aiTool: 'create_deck',
        roomType: 'deck',
        outdoorLiving: true,
        assetId: deckAsset.id,
        width,
        depth,
        surfaceY: deckSupport.surfaceY,
        supportCenterX: deckSupport.centerX,
        supportCenterZ: deckSupport.centerZ,
        supportWidth: deckSupport.width,
        supportDepth: deckSupport.depth,
      },
    })

    const addProceduralRailings = includeRailing && deckAsset.id === 'deck-082523'
    const railingSpecs = addProceduralRailings
      ? [
          {
            name: `${name} back railing`,
            start: [x - halfW, z + halfD] as [number, number],
            end: [x + halfW, z + halfD] as [number, number],
          },
          {
            name: `${name} left railing`,
            start: [x - halfW, z - halfD] as [number, number],
            end: [x - halfW, z + halfD] as [number, number],
          },
          {
            name: `${name} right railing`,
            start: [x + halfW, z + halfD] as [number, number],
            end: [x + halfW, z - halfD] as [number, number],
          },
        ]
      : []
    const railings = railingSpecs.map((spec) =>
      FenceNode.parse({
        name: spec.name,
        start: spec.start,
        end: spec.end,
        height: 0.95,
        thickness: 0.08,
        baseHeight: 0.12,
        postSpacing: 1.35,
        postSize: 0.1,
        topRailHeight: 0.07,
        groundClearance: elevation,
        baseStyle: 'floating',
        showInfill: false,
        color: '#8b5a2b',
        style: 'rail',
        material: WOOD_MATERIAL,
        metadata: { aiTool: 'create_deck', roomType: 'deck-railing', outdoorLiving: true },
      }),
    )

    this.applyPatch([
      { op: 'create', node: zone, parentId: levelId },
      { op: 'create', node: deckItem, parentId: levelId },
      ...railings.map((railing) => ({ op: 'create' as const, node: railing, parentId: levelId })),
    ])

    return {
      zoneId: zone.id,
      deckItemId: deckItem.id,
      assetId: deckAsset.id,
      assetName: deckAsset.name,
      source: deckItem.asset.src,
      railingIds: railings.map((railing) => railing.id),
      width,
      depth,
      elevation,
      surfaceY: deckSupport.surfaceY,
      supportCenter: [deckSupport.centerX, deckSupport.centerZ],
      supportWidth: deckSupport.width,
      supportDepth: deckSupport.depth,
      areaSqMeters: Math.round(width * depth * 100) / 100,
      openOutdoorArea: true,
      outdoorLiving: true,
      glbAsset: true,
    }
  }

  createPergola(args: Record<string, unknown>) {
    const levelId = this.firstLevelId()
    if (!levelId) throw new Error('create_pergola requires a level')

    const x = readNumberArg(args, 'x') ?? 0
    const z = readNumberArg(args, 'z') ?? 0
    const support = this.findOutdoorLivingDeckSupportAt(x, z)
    const pergolaAsset = this.resolvePergolaAsset(args)
    const supportMargin = getPergolaSupportMargin(pergolaAsset)
    const maxSupportedWidth = support ? Math.max(1.8, support.width - supportMargin) : 36
    const maxSupportedDepth = support ? Math.max(1.6, support.depth - supportMargin) : 30
    const width = roundMeters(
      clampNumber(
        readPositiveNumberArg(args, 'width') ?? Math.min(15.6, maxSupportedWidth),
        1.8,
        maxSupportedWidth,
      ),
    )
    const depth = roundMeters(
      clampNumber(
        readPositiveNumberArg(args, 'depth') ?? Math.min(9.6, maxSupportedDepth),
        1.6,
        maxSupportedDepth,
      ),
    )
    const height = clampNumber(
      readPositiveNumberArg(args, 'height') ?? getPergolaDefaultHeight(pergolaAsset),
      1.8,
      12,
    )
    const supportYOffset = support
      ? getPergolaSupportYOffset(pergolaAsset, width, height, depth)
      : 0
    const y = readNumberArg(args, 'y') ?? (support ? support.surfaceY - supportYOffset : 0)
    const rotationY = readNumberArg(args, 'rotationY') ?? 0
    const name =
      typeof args.name === 'string' && args.name.trim() ? args.name.trim() : 'Outdoor pergola'
    const pergolaDimensions: [number, number, number] = [width, height, depth]
    const metadata: Record<string, unknown> = {
      aiTool: 'create_pergola',
      roomType: 'pergola',
      outdoorLiving: true,
      assetId: pergolaAsset.id,
      supportYOffset,
    }
    if (support) {
      metadata.supportedByDeckId = support.deckItemId
      metadata.supportSurfaceY = support.surfaceY
    }

    const pergola = ItemNode.parse({
      name,
      parentId: levelId,
      position: [x, y, z],
      rotation: [0, rotationY, 0],
      scale: [1, 1, 1],
      asset: createItemAssetPayload(pergolaAsset, pergolaDimensions),
      metadata,
    })

    this.applyPatch([{ op: 'create', node: pergola, parentId: levelId }])

    return {
      pergolaId: pergola.id,
      levelId,
      assetId: pergolaAsset.id,
      assetName: pergolaAsset.name,
      source: pergola.asset.src,
      width,
      depth,
      height,
      position: [x, y, z],
      rotationY,
      supportedByDeckId: support?.deckItemId ?? null,
      supportWidth: support?.width ?? null,
      supportDepth: support?.depth ?? null,
      supportSurfaceY: support?.surfaceY ?? null,
      supportYOffset,
      outdoorLiving: true,
      glbAsset: true,
    }
  }

  addDoor(args: Record<string, unknown>) {
    let wallId = typeof args.wallId === 'string' ? (args.wallId as AnyNodeId) : this.firstWallId()
    let createdRoom: ReturnType<GraphSession['createRoom']> | null = null
    if (!wallId) {
      createdRoom = this.createRoom({
        name: 'AI Room',
        roomType: 'room',
        width: 4,
        depth: 3,
      })
      wallId = createdRoom.wallIds[0] ?? null
    }
    if (!wallId) throw new Error('add_door requires a wallId because no wall exists in the scene')
    const wall = this.graph.nodes[wallId]
    if (!wall || wall.type !== 'wall') throw new Error(`wall not found: ${wallId}`)

    const width = typeof args.width === 'number' && args.width > 0 ? args.width : 0.9
    const height = typeof args.height === 'number' && args.height > 0 ? args.height : 2.1
    const t = typeof args.t === 'number' ? Math.max(0, Math.min(1, args.t)) : 0.5
    const length = wallLength(wall)
    if (length < width) throw new Error(`wall ${wallId} is too short for a ${width}m door`)

    const localX = wallLocalXFromT(wall, t, width)
    const door = DoorNode.parse({
      wallId,
      parentId: wallId,
      position: [localX, height / 2, 0],
      width,
      height,
      metadata: { aiTool: 'add_door' },
    })
    this.applyPatch([{ op: 'create', node: door, parentId: wallId }])
    return {
      doorId: door.id,
      wallId,
      localX,
      t,
      width,
      height,
      coordinateSystem: 'wall-local-meters',
      createdRoom,
    }
  }

  addWindow(args: Record<string, unknown>) {
    let wallId = typeof args.wallId === 'string' ? (args.wallId as AnyNodeId) : this.firstWallId()
    let createdRoom: ReturnType<GraphSession['createRoom']> | null = null
    if (!wallId) {
      createdRoom = this.createRoom({
        name: 'AI Room',
        roomType: 'room',
        width: 4,
        depth: 3,
      })
      wallId = createdRoom.wallIds[0] ?? null
    }
    if (!wallId) throw new Error('add_window requires a wallId because no wall exists in the scene')
    const wall = this.graph.nodes[wallId]
    if (!wall || wall.type !== 'wall') throw new Error(`wall not found: ${wallId}`)

    const length = wallLength(wall)
    if (length <= 0.4) throw new Error(`wall ${wallId} is too short for a window`)
    const desiredWidth = readNumberArg(args, 'width') ?? 1.2
    const width = clampNumber(desiredWidth, 0.3, Math.max(0.3, length - 0.1))
    const height = clampNumber(readNumberArg(args, 'height') ?? 1.2, 0.3, 2.5)
    const sillHeight = clampNumber(readNumberArg(args, 'sillHeight') ?? 0.9, 0.1, 2.2)
    const t = clampNumber(readNumberArg(args, 't') ?? 0.5, 0, 1)
    const requestedWindowType = readStringArg(args, ['windowType', 'type'])
    const windowType = AI_WINDOW_TYPES.includes(
      requestedWindowType as (typeof AI_WINDOW_TYPES)[number],
    )
      ? (requestedWindowType as (typeof AI_WINDOW_TYPES)[number])
      : 'fixed'

    const localX = wallLocalXFromT(wall, t, width)
    const window = WindowNode.parse({
      wallId,
      parentId: wallId,
      position: [localX, sillHeight + height / 2, 0],
      width,
      height,
      windowType,
      metadata: { aiTool: 'add_window', sillHeight },
    })
    this.applyPatch([{ op: 'create', node: window, parentId: wallId }])
    return {
      windowId: window.id,
      wallId,
      localX,
      t,
      width,
      height,
      sillHeight,
      windowType,
      coordinateSystem: 'wall-local-meters',
      createdRoom,
    }
  }

  addFurniture(args: Record<string, unknown>) {
    const levelId = this.firstLevelId()
    if (!levelId) throw new Error('add_furniture requires a level')

    const asset = this.resolveFurnitureAsset(args)
    const position = this.nextFurniturePosition(args, asset)
    const rotationY = readNumberArg(args, 'rotationY') ?? readArrayNumber(args.rotation, 1) ?? 0
    const itemAsset = createItemAssetPayload(asset)
    const deckSupport = this.findOutdoorLivingDeckSupportAt(position[0], position[2])

    const item = ItemNode.parse({
      name: asset.name,
      parentId: levelId,
      position,
      rotation: [0, rotationY, 0],
      scale: [1, 1, 1],
      asset: itemAsset,
      metadata: {
        aiTool: 'add_furniture',
        assetId: asset.id,
        ...(deckSupport ? { supportedByDeckId: deckSupport.deckItemId } : {}),
      },
    })
    this.applyPatch([{ op: 'create', node: item, parentId: levelId }])
    return {
      itemId: item.id,
      levelId,
      assetId: asset.id,
      assetName: asset.name,
      source: itemAsset.src,
      position,
      rotationY,
      coordinateSystem: 'level-local-meters',
    }
  }

  private firstWallId(): AnyNodeId | null {
    const wall = Object.values(this.graph.nodes).find((node) => node.type === 'wall')
    return (wall?.id as AnyNodeId | undefined) ?? null
  }

  private firstLevelId(): AnyNodeId | null {
    const level = Object.values(this.graph.nodes).find((node) => node.type === 'level')
    return (level?.id as AnyNodeId | undefined) ?? null
  }

  private resolveDeckAsset(args: Record<string, unknown>): AiFurnitureAsset {
    const requested = readStringArg(args, [
      'assetId',
      'item',
      'kind',
      'query',
      'name',
      'asset',
      'style',
      'variant',
    ])
    if (requested) {
      const asset = findFurnitureAsset(requested)
      if (asset && (DECK_ASSET_IDS as readonly string[]).includes(asset.id)) return asset
    }
    const fallbackId = requested ? inferDeckAssetId(requested) : 'deck-082523'
    const fallback = getAiFurnitureAssetById(fallbackId) ?? getAiFurnitureAssetById('deck-082523')
    if (!fallback) throw new Error('deck assets are not configured')
    return fallback
  }

  private resolvePergolaAsset(args: Record<string, unknown>): AiFurnitureAsset {
    const requested = readStringArg(args, [
      'assetId',
      'item',
      'kind',
      'query',
      'name',
      'asset',
      'style',
      'variant',
    ])
    if (requested) {
      const asset = findFurnitureAsset(requested)
      if (
        asset &&
        asset.id !== 'pergola' &&
        (PERGOLA_ASSET_IDS as readonly string[]).includes(asset.id)
      ) {
        return asset
      }
    }
    const fallbackId = requested ? inferPergolaAssetId(requested) : 'pergola-3'
    const fallback = getAiFurnitureAssetById(fallbackId) ?? getAiFurnitureAssetById('pergola-3')
    if (!fallback) throw new Error('pergola assets are not configured')
    return fallback
  }

  private resolveFurnitureAsset(args: Record<string, unknown>): AiFurnitureAsset {
    const requested = readStringArg(args, ['assetId', 'item', 'kind', 'query', 'name', 'asset'])
    if (requested) {
      const asset = findFurnitureAsset(requested)
      if (asset) return asset
    }
    return DEFAULT_AI_FURNITURE_ASSET
  }

  private nextFurniturePosition(
    args: Record<string, unknown>,
    asset: AiFurnitureAsset,
  ): [number, number, number] {
    const requestedX = readArrayNumber(args.position, 0) ?? readNumberArg(args, 'x')
    const requestedY = readArrayNumber(args.position, 1) ?? readNumberArg(args, 'y')
    const requestedZ = readArrayNumber(args.position, 2) ?? readNumberArg(args, 'z')
    if (requestedX !== null || requestedY !== null || requestedZ !== null) {
      const x = requestedX ?? 0
      const z = requestedZ ?? 0
      const y = requestedY ?? this.findOutdoorLivingDeckSupportAt(x, z)?.surfaceY ?? 0
      return [roundMeters(x), roundMeters(y), roundMeters(z)]
    }

    const itemCount = Object.values(this.graph.nodes).filter((node) => node.type === 'item').length
    const spacing = Math.max(1.2, Math.max(asset.dimensions[0], asset.dimensions[2]) + 0.5)
    const grid: Array<[number, number]> = [
      [0, 0],
      [spacing, 0],
      [-spacing, 0],
      [0, spacing],
      [0, -spacing],
      [spacing, spacing],
      [-spacing, spacing],
      [spacing, -spacing],
      [-spacing, -spacing],
    ]
    const [x, z] = grid[itemCount % grid.length] ?? [0, 0]
    const layer = Math.floor(itemCount / grid.length)
    const stackedZ = z + layer * spacing * 2
    const y = this.findOutdoorLivingDeckSupportAt(x, stackedZ)?.surfaceY ?? 0
    return [roundMeters(x), roundMeters(y), roundMeters(stackedZ)]
  }

  private findOutdoorLivingDeckSupportAt(
    x: number,
    z: number,
  ): { deckItemId: AnyNodeId; surfaceY: number; width: number; depth: number } | null {
    let best: { deckItemId: AnyNodeId; surfaceY: number; width: number; depth: number } | null =
      null
    for (const node of Object.values(this.graph.nodes)) {
      if (node.type !== 'item') continue
      const metadata =
        node.metadata && typeof node.metadata === 'object'
          ? (node.metadata as Record<string, unknown>)
          : {}
      if (metadata.aiTool !== 'create_deck') continue

      const [deckX, deckY, deckZ] = node.position
      const supportCenterX =
        typeof metadata.supportCenterX === 'number' && Number.isFinite(metadata.supportCenterX)
          ? metadata.supportCenterX
          : deckX
      const supportCenterZ =
        typeof metadata.supportCenterZ === 'number' && Number.isFinite(metadata.supportCenterZ)
          ? metadata.supportCenterZ
          : deckZ
      const width =
        typeof metadata.supportWidth === 'number' && Number.isFinite(metadata.supportWidth)
          ? metadata.supportWidth
          : typeof metadata.width === 'number' && Number.isFinite(metadata.width)
            ? metadata.width
          : node.asset.dimensions[0]
      const depth =
        typeof metadata.supportDepth === 'number' && Number.isFinite(metadata.supportDepth)
          ? metadata.supportDepth
          : typeof metadata.depth === 'number' && Number.isFinite(metadata.depth)
            ? metadata.depth
          : node.asset.dimensions[2]
      if (Math.abs(x - supportCenterX) > width / 2 || Math.abs(z - supportCenterZ) > depth / 2) {
        continue
      }

      const surfaceY =
        typeof metadata.surfaceY === 'number' && Number.isFinite(metadata.surfaceY)
          ? metadata.surfaceY
          : deckY + (node.asset.surface?.height ?? 0)
      if (!best || surfaceY > best.surfaceY) {
        best = { deckItemId: node.id as AnyNodeId, surfaceY, width, depth }
      }
    }
    return best
  }
}

function createDefaultSceneGraph(): SceneGraph {
  const building = BuildingNode.parse({ name: 'AI Building' })
  const level = LevelNode.parse({ name: 'Level 0', level: 0, parentId: building.id })
  const site = SiteNode.parse({ name: 'AI Site', children: [building.id] })
  const linkedBuilding = {
    ...building,
    parentId: site.id,
    children: [level.id],
  }
  return {
    nodes: {
      [site.id]: site,
      [building.id]: linkedBuilding,
      [level.id]: level,
    } as SceneGraph['nodes'],
    rootNodeIds: [site.id],
    collections: {},
  }
}

function cloneGraph(graph: SceneGraph): SceneGraph {
  return JSON.parse(JSON.stringify(graph)) as SceneGraph
}

function appendChildId(parent: AnyNodeType | undefined, childId: AnyNodeId): void {
  if (!parent || !('children' in parent) || !Array.isArray(parent.children)) return
  if (!(parent.children as unknown[]).includes(childId)) {
    ;(parent.children as unknown[]).push(childId)
  }
}

function removeChildIds(node: AnyNodeType, ids: AnyNodeId[]): void {
  if (!('children' in node) || !Array.isArray(node.children)) return
  node.children = (node.children as unknown[]).filter((child) => {
    if (typeof child === 'string') return !ids.includes(child as AnyNodeId)
    if (child && typeof child === 'object' && 'id' in child) {
      return !ids.includes((child as { id: AnyNodeId }).id)
    }
    return true
  }) as never
}

function collectDescendants(graph: SceneGraph, id: AnyNodeId): AnyNodeId[] {
  const out: AnyNodeId[] = [id]
  const node = graph.nodes[id]
  if (!node || !('children' in node) || !Array.isArray(node.children)) return out
  for (const child of node.children as unknown[]) {
    const childId =
      typeof child === 'string'
        ? (child as AnyNodeId)
        : child && typeof child === 'object' && 'id' in child
          ? ((child as { id: string }).id as AnyNodeId)
          : null
    if (childId && graph.nodes[childId]) out.push(...collectDescendants(graph, childId))
  }
  return out
}

function wallLength(wall: Pick<Extract<AnyNodeType, { type: 'wall' }>, 'start' | 'end'>): number {
  const dx = wall.end[0] - wall.start[0]
  const dz = wall.end[1] - wall.start[1]
  return Math.sqrt(dx * dx + dz * dz)
}

function wallLocalXFromT(
  wall: Pick<Extract<AnyNodeType, { type: 'wall' }>, 'start' | 'end'>,
  t: number,
  width: number,
): number {
  const length = wallLength(wall)
  return Math.max(width / 2, Math.min(t * length, length - width / 2))
}
