import * as THREE from 'three'
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'
import * as WebIFC from 'web-ifc'

type IfcRecord = Record<string, unknown>

type FlatMesh = {
  geometries: {
    size: () => number
    get: (index: number) => PlacedGeometry
  }
  delete?: () => void
}

type PlacedGeometry = {
  color?: { x?: number; y?: number; z?: number; w?: number }
  flatTransformation: number[]
  geometryExpressID: number
}

type WebIfcGeometry = {
  GetVertexData: () => number
  GetVertexDataSize: () => number
  GetIndexData: () => number
  GetIndexDataSize: () => number
  delete?: () => void
}

export type IfcVisualImportResult = {
  file: File
  meshCount: number
  productCount: number
  skippedAuxiliaryCount: number
  skippedInteriorCount: number
  triangleCount: number
  typeCounts: Record<string, number>
}

export type IfcVisualImportLayersResult = {
  body: IfcVisualImportResult | null
  roof: IfcVisualImportResult | null
  total: Omit<IfcVisualImportResult, 'file'>
}

export type IfcVisualImportOptions = {
  onProgress?: (message: string, percent: number) => void
}

const IMPORTANT_TYPE_ORDER = [
  'IFCSITE',
  'IFCBUILDING',
  'IFCBUILDINGSTOREY',
  'IFCWALL',
  'IFCWALLSTANDARDCASE',
  'IFCSLAB',
  'IFCROOF',
  'IFCCOVERING',
  'IFCDOOR',
  'IFCWINDOW',
  'IFCSTAIR',
  'IFCSTAIRFLIGHT',
  'IFCCOLUMN',
  'IFCBEAM',
  'IFCMEMBER',
  'IFCPLATE',
  'IFCCURTAINWALL',
  'IFCRAILING',
]

const SKIPPED_AUXILIARY_IFC_TYPES = new Set([
  'IFCANNOTATION',
  'IFCBOXEDHALFSPACE',
  'IFCGEOGRAPHICELEMENT',
  'IFCGRID',
  'IFCHALFSPACESOLID',
  'IFCOPENINGELEMENT',
  'IFCPOLYGONALBOUNDEDHALFSPACE',
  'IFCSITE',
  'IFCSPACE',
  'IFCFEATUREELEMENT',
  'IFCFEATUREELEMENTSUBTRACTION',
  'IFCSURFACEFEATURE',
  'IFCVIRTUALELEMENT',
  'IFCVOIDINGFEATURE',
])

const AUXILIARY_NAME_KEYWORDS = [
  'ANNOTATION',
  'BOUNDARY',
  'CLIPPING',
  'GRID',
  'HALFSPACE',
  'REFERENCE',
  'SITE',
  'SPACE',
  'SURFACE',
  'TERRAIN',
  'TOPO',
]

const SKIPPED_INTERIOR_IFC_TYPES = new Set([
  'IFCAUDIOVISUALAPPLIANCE',
  'IFCCOMMUNICATIONSAPPLIANCE',
  'IFCELECTRICAPPLIANCE',
  'IFCEQUIPMENTELEMENT',
  'IFCFLOWTERMINAL',
  'IFCFURNISHINGELEMENT',
  'IFCFURNITURE',
  'IFCLIGHTFIXTURE',
  'IFCMOBILETELECOMMUNICATIONSAPPLIANCE',
  'IFCSANITARYTERMINAL',
  'IFCSYSTEMFURNITUREELEMENT',
  'IFCUNITARYEQUIPMENT',
])

const INTERIOR_NAME_KEYWORDS = [
  'APPLIANCE',
  'ARMCHAIR',
  'BED',
  'BENCH',
  'CABINET',
  'CHAIR',
  'COUCH',
  'DESK',
  'FURNISH',
  'LAMP',
  'LOCKER',
  'SEAT',
  'SHELF',
  'SOFA',
  'TABLE',
  'WARDROBE',
]

export async function createIfcVisualImportGlb(
  data: Uint8Array,
  sourceName: string,
  options: IfcVisualImportOptions = {},
): Promise<IfcVisualImportResult> {
  const progress = (message: string, percent: number) => {
    options.onProgress?.(message, percent)
  }

  const ifcApi = new WebIFC.IfcAPI()
  ifcApi.SetWasmPath('/', true)

  progress('Initializing web-ifc visual pipeline...', 0)
  await ifcApi.Init()
  progress('Opening IFC model...', 5)
  const modelID = ifcApi.OpenModel(data)

  try {
    const group = new THREE.Group()
    group.name = sourceName
    const seen = new Set<number>()
    const typeCounts: Record<string, number> = {}
    let meshCount = 0
    let productCount = 0
    let skippedAuxiliaryCount = 0
    let skippedInteriorCount = 0
    let triangleCount = 0
    const types = getIfcEntityTypeEntries()

    for (const [typeIndex, [typeName, typeCode]] of types.entries()) {
      const ids = safeGetLineIDsWithType(ifcApi, modelID, typeCode)
      if (!ids) continue
      if (SKIPPED_AUXILIARY_IFC_TYPES.has(typeName)) {
        skippedAuxiliaryCount += ids.size()
        continue
      }
      if (SKIPPED_INTERIOR_IFC_TYPES.has(typeName)) {
        skippedInteriorCount += ids.size()
        continue
      }

      for (let i = 0; i < ids.size(); i++) {
        const expressID = ids.get(i)
        if (seen.has(expressID)) continue

        const line = safeGetLine(ifcApi, modelID, expressID)
        const resolvedTypeName = getIfcTypeName(ifcApi, line, typeName)
        if (!isIfcRootProduct(line)) {
          seen.add(expressID)
          continue
        }
        if (isAuxiliaryLikeProduct(resolvedTypeName, line)) {
          skippedAuxiliaryCount += 1
          seen.add(expressID)
          continue
        }
        if (isInteriorLikeProduct(resolvedTypeName, line)) {
          skippedInteriorCount += 1
          seen.add(expressID)
          continue
        }

        const flatMesh = safeGetFlatMesh(ifcApi, modelID, expressID)
        if (!flatMesh || flatMesh.geometries.size() === 0) {
          flatMesh?.delete?.()
          continue
        }

        seen.add(expressID)
        let meshesForProduct = 0
        let trianglesForProduct = 0

        for (let geometryIndex = 0; geometryIndex < flatMesh.geometries.size(); geometryIndex++) {
          const placed = flatMesh.geometries.get(geometryIndex)
          const mesh = createPlacedGeometryMesh(
            ifcApi,
            modelID,
            placed,
            line,
            resolvedTypeName,
            expressID,
            geometryIndex,
          )
          if (!mesh) continue

          const triangles = mesh.userData.triangleCount as number | undefined
          group.add(mesh)
          meshCount += 1
          meshesForProduct += 1
          trianglesForProduct += triangles ?? 0
          triangleCount += triangles ?? 0
        }

        flatMesh.delete?.()

        if (meshesForProduct > 0) {
          productCount += 1
          typeCounts[resolvedTypeName] = (typeCounts[resolvedTypeName] ?? 0) + 1
        }

        if (seen.size % 25 === 0) {
          progress(
            `Extracting IFC visual geometry: ${seen.size.toLocaleString()} products`,
            10 + Math.round((typeIndex / Math.max(types.length, 1)) * 78),
          )
          await nextFrame()
        }
      }
    }

    if (meshCount === 0) {
      throw new Error('No renderable IFC visual geometry was found.')
    }

    centerModelGroup(group)
    progress('Exporting IFC visual GLB...', 94)

    try {
      const file = await exportGroupToGlbFile(group, getVisualImportFileName(sourceName))
      progress('IFC visual model ready.', 100)
      return {
        file,
        meshCount,
        productCount,
        skippedAuxiliaryCount,
        skippedInteriorCount,
        triangleCount,
        typeCounts,
      }
    } finally {
      disposeGroup(group)
    }
  } finally {
    closeIfcModel(ifcApi, modelID)
  }
}

export async function createIfcVisualImportWithRoofLayer(
  data: Uint8Array,
  sourceName: string,
  options: IfcVisualImportOptions = {},
): Promise<IfcVisualImportLayersResult> {
  const progress = (message: string, percent: number) => {
    options.onProgress?.(message, percent)
  }

  const ifcApi = new WebIFC.IfcAPI()
  ifcApi.SetWasmPath('/', true)

  progress('Initializing web-ifc visual pipeline...', 0)
  await ifcApi.Init()
  progress('Opening IFC model...', 5)
  const modelID = ifcApi.OpenModel(data)

  try {
    const bodyGroup = new THREE.Group()
    const roofGroup = new THREE.Group()
    bodyGroup.name = sourceName
    roofGroup.name = `${sourceName} roof`

    const roofProductIds = collectRoofLayerProductIds(ifcApi, modelID)
    const seen = new Set<number>()
    const bodyStats = createVisualImportStats()
    const roofStats = createVisualImportStats()
    const totalStats = createVisualImportStats()
    const types = getIfcEntityTypeEntries()

    for (const [typeIndex, [typeName, typeCode]] of types.entries()) {
      const ids = safeGetLineIDsWithType(ifcApi, modelID, typeCode)
      if (!ids) continue
      if (SKIPPED_AUXILIARY_IFC_TYPES.has(typeName)) {
        totalStats.skippedAuxiliaryCount += ids.size()
        continue
      }
      if (SKIPPED_INTERIOR_IFC_TYPES.has(typeName)) {
        totalStats.skippedInteriorCount += ids.size()
        continue
      }

      for (let i = 0; i < ids.size(); i++) {
        const expressID = ids.get(i)
        if (seen.has(expressID)) continue

        const line = safeGetLine(ifcApi, modelID, expressID)
        const resolvedTypeName = getIfcTypeName(ifcApi, line, typeName)
        if (!isIfcRootProduct(line)) {
          seen.add(expressID)
          continue
        }
        if (isAuxiliaryLikeProduct(resolvedTypeName, line)) {
          totalStats.skippedAuxiliaryCount += 1
          seen.add(expressID)
          continue
        }
        if (isInteriorLikeProduct(resolvedTypeName, line)) {
          totalStats.skippedInteriorCount += 1
          seen.add(expressID)
          continue
        }

        const flatMesh = safeGetFlatMesh(ifcApi, modelID, expressID)
        if (!flatMesh || flatMesh.geometries.size() === 0) {
          flatMesh?.delete?.()
          continue
        }

        seen.add(expressID)
        let meshesForProduct = 0
        let trianglesForProduct = 0
        const isRoofProduct = roofProductIds.has(expressID) || isRoofLikeProduct(resolvedTypeName, line)
        const targetGroup = isRoofProduct ? roofGroup : bodyGroup
        const targetStats = isRoofProduct ? roofStats : bodyStats

        for (let geometryIndex = 0; geometryIndex < flatMesh.geometries.size(); geometryIndex++) {
          const placed = flatMesh.geometries.get(geometryIndex)
          const mesh = createPlacedGeometryMesh(
            ifcApi,
            modelID,
            placed,
            line,
            resolvedTypeName,
            expressID,
            geometryIndex,
          )
          if (!mesh) continue

          const triangles = mesh.userData.triangleCount as number | undefined
          targetGroup.add(mesh)
          targetStats.meshCount += 1
          totalStats.meshCount += 1
          meshesForProduct += 1
          trianglesForProduct += triangles ?? 0
          targetStats.triangleCount += triangles ?? 0
          totalStats.triangleCount += triangles ?? 0
        }

        flatMesh.delete?.()

        if (meshesForProduct > 0) {
          targetStats.productCount += 1
          totalStats.productCount += 1
          targetStats.typeCounts[resolvedTypeName] =
            (targetStats.typeCounts[resolvedTypeName] ?? 0) + 1
          totalStats.typeCounts[resolvedTypeName] =
            (totalStats.typeCounts[resolvedTypeName] ?? 0) + 1
        }

        if (seen.size % 25 === 0) {
          progress(
            `Extracting IFC visual geometry: ${seen.size.toLocaleString()} products`,
            10 + Math.round((typeIndex / Math.max(types.length, 1)) * 78),
          )
          await nextFrame()
        }
      }
    }

    if (totalStats.meshCount === 0) {
      throw new Error('No renderable IFC visual geometry was found.')
    }

    bodyStats.skippedAuxiliaryCount = totalStats.skippedAuxiliaryCount
    bodyStats.skippedInteriorCount = totalStats.skippedInteriorCount
    roofStats.skippedAuxiliaryCount = totalStats.skippedAuxiliaryCount
    roofStats.skippedInteriorCount = totalStats.skippedInteriorCount
    centerModelLayerGroups([bodyGroup, roofGroup])
    progress('Exporting IFC visual GLBs...', 94)

    try {
      const body =
        bodyStats.meshCount > 0
          ? {
              ...(await exportVisualImportLayer(
                bodyGroup,
                getVisualImportFileName(sourceName),
                bodyStats,
              )),
            }
          : null
      const roof =
        roofStats.meshCount > 0
          ? {
              ...(await exportVisualImportLayer(
                roofGroup,
                getVisualLayerFileName(sourceName, 'roof'),
                roofStats,
              )),
            }
          : null
      progress('IFC visual model ready.', 100)
      return { body, roof, total: totalStats }
    } finally {
      disposeGroup(bodyGroup)
      disposeGroup(roofGroup)
    }
  } finally {
    closeIfcModel(ifcApi, modelID)
  }
}

function createPlacedGeometryMesh(
  ifcApi: WebIFC.IfcAPI,
  modelID: number,
  placed: PlacedGeometry,
  line: IfcRecord | null,
  typeName: string,
  expressID: number,
  geometryIndex: number,
): THREE.Mesh | null {
  const transform = placed.flatTransformation
  if (!Array.isArray(transform) || transform.length < 16) return null

  let geometryData: WebIfcGeometry
  try {
    geometryData = ifcApi.GetGeometry(modelID, placed.geometryExpressID) as WebIfcGeometry
  } catch {
    return null
  }

  try {
    const placedGeometryLine = safeGetLine(ifcApi, modelID, placed.geometryExpressID)
    const placedGeometryTypeName = getIfcTypeName(ifcApi, placedGeometryLine, '')
    if (isAuxiliaryLikeProduct(placedGeometryTypeName, placedGeometryLine)) return null

    const vertexData = ifcApi.GetVertexArray(
      geometryData.GetVertexData(),
      geometryData.GetVertexDataSize(),
    )
    const indexData = ifcApi.GetIndexArray(
      geometryData.GetIndexData(),
      geometryData.GetIndexDataSize(),
    )

    if (vertexData.length < 6 || indexData.length < 3) return null

    const positions: number[] = []
    const normals: number[] = []

    for (let vertex = 0; vertex + 5 < vertexData.length; vertex += 6) {
      const x = vertexData[vertex] ?? 0
      const y = vertexData[vertex + 1] ?? 0
      const z = vertexData[vertex + 2] ?? 0
      const nx = vertexData[vertex + 3] ?? 0
      const ny = vertexData[vertex + 4] ?? 0
      const nz = vertexData[vertex + 5] ?? 1

      const [wx, wy, wz] = transformPoint(transform, x, y, z)
      positions.push(wx, wy, wz)

      const [wnx, wny, wnz] = transformDirection(transform, nx, ny, nz)
      const normalLength = Math.hypot(wnx, wny, wnz) || 1
      normals.push(wnx / normalLength, wny / normalLength, wnz / normalLength)
    }

    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
    geometry.setIndex(Array.from(indexData))
    geometry.computeBoundingSphere()

    const color = getPlacedColor(placed, typeName)
    const material = new THREE.MeshStandardMaterial({
      color: new THREE.Color(color.r, color.g, color.b),
      depthWrite: color.opacity >= 0.999,
      metalness: fallbackMetalness(typeName),
      opacity: color.opacity,
      roughness: fallbackRoughness(typeName),
      side: THREE.DoubleSide,
      transparent: color.opacity < 0.999,
    })

    const mesh = new THREE.Mesh(geometry, material)
    const name = stringValue(line?.Name) ?? `${typeName} ${expressID}`
    mesh.castShadow = color.opacity >= 0.999
    mesh.receiveShadow = true
    mesh.name = `${typeName}:${expressID}:${geometryIndex}`
    mesh.userData = {
      expressID,
      globalId: stringValue(line?.GlobalId) ?? undefined,
      ifcType: typeName,
      name,
      opacity: color.opacity,
      triangleCount: Math.floor(indexData.length / 3),
    }

    return mesh
  } finally {
    geometryData.delete?.()
  }
}

function createVisualImportStats(): Omit<IfcVisualImportResult, 'file'> {
  return {
    meshCount: 0,
    productCount: 0,
    skippedAuxiliaryCount: 0,
    skippedInteriorCount: 0,
    triangleCount: 0,
    typeCounts: {},
  }
}

async function exportVisualImportLayer(
  group: THREE.Group,
  fileName: string,
  stats: Omit<IfcVisualImportResult, 'file'>,
): Promise<IfcVisualImportResult> {
  return {
    file: await exportGroupToGlbFile(group, fileName),
    meshCount: stats.meshCount,
    productCount: stats.productCount,
    skippedAuxiliaryCount: stats.skippedAuxiliaryCount,
    skippedInteriorCount: stats.skippedInteriorCount,
    triangleCount: stats.triangleCount,
    typeCounts: { ...stats.typeCounts },
  }
}

function collectRoofLayerProductIds(ifcApi: WebIFC.IfcAPI, modelID: number): Set<number> {
  const roofIds = new Set<number>()
  const aggregateChildren = collectAggregateChildrenByParent(ifcApi, modelID)

  for (const [typeName, typeCode] of getIfcEntityTypeEntries()) {
    const ids = safeGetLineIDsWithType(ifcApi, modelID, typeCode)
    if (!ids) continue

    for (let i = 0; i < ids.size(); i++) {
      const expressID = ids.get(i)
      const line = safeGetLine(ifcApi, modelID, expressID)
      const resolvedTypeName = getIfcTypeName(ifcApi, line, typeName)
      if (isRoofLikeProduct(resolvedTypeName, line)) roofIds.add(expressID)
    }
  }

  const stack = [...roofIds]
  const seen = new Set<number>()
  while (stack.length > 0) {
    const expressID = stack.pop()
    if (expressID == null || seen.has(expressID)) continue
    seen.add(expressID)

    for (const childId of aggregateChildren.get(expressID) ?? []) {
      if (!roofIds.has(childId)) roofIds.add(childId)
      stack.push(childId)
    }
  }

  return roofIds
}

function collectAggregateChildrenByParent(
  ifcApi: WebIFC.IfcAPI,
  modelID: number,
): Map<number, number[]> {
  const relationType = (WebIFC as Record<string, unknown>).IFCRELAGGREGATES
  const childrenByParent = new Map<number, number[]>()
  if (typeof relationType !== 'number') return childrenByParent

  const relationIds = safeGetLineIDsWithType(ifcApi, modelID, relationType)
  if (!relationIds) return childrenByParent

  for (let i = 0; i < relationIds.size(); i++) {
    const relation = safeGetLine(ifcApi, modelID, relationIds.get(i))
    if (!relation) continue

    const parentId = refId(relation.RelatingObject)
    const related = Array.isArray(relation.RelatedObjects) ? relation.RelatedObjects : []
    if (parentId == null || related.length === 0) continue

    const children = childrenByParent.get(parentId) ?? []
    for (const childRef of related) {
      const childId = refId(childRef)
      if (childId != null) children.push(childId)
    }
    childrenByParent.set(parentId, children)
  }

  return childrenByParent
}

function isRoofLikeProduct(typeName: string, line: IfcRecord | null): boolean {
  if (typeName === 'IFCROOF') return true
  if (!line) return false

  const text = getIfcLabelText(line)
  if (text.includes('ROOF') || text.includes('DACH')) return true

  const predefined = stringValue(line.PredefinedType)?.toUpperCase() ?? ''
  return predefined === 'ROOF'
}

function getIfcEntityTypeEntries(): [string, number][] {
  const entries = Object.entries(WebIFC as Record<string, unknown>)
    .filter(([name, value]) => /^IFC[A-Z0-9]+$/.test(name) && typeof value === 'number')
    .filter(([name]) => !name.endsWith('TYPE'))
    .map(([name, value]) => [name, value as number] as [string, number])

  const byCode = new Map<number, string>()
  for (const [name, code] of entries) {
    if (!byCode.has(code)) byCode.set(code, name)
  }

  const ordered = Array.from(byCode.entries()).map(
    ([code, name]) => [name, code] as [string, number],
  )
  return ordered.sort((a, b) => {
    const ai = IMPORTANT_TYPE_ORDER.indexOf(a[0])
    const bi = IMPORTANT_TYPE_ORDER.indexOf(b[0])
    if (ai !== -1 || bi !== -1) return (ai === -1 ? 9999 : ai) - (bi === -1 ? 9999 : bi)
    return a[0].localeCompare(b[0])
  })
}

function safeGetLineIDsWithType(ifcApi: WebIFC.IfcAPI, modelID: number, typeCode: number) {
  try {
    return ifcApi.GetLineIDsWithType(modelID, typeCode)
  } catch {
    return null
  }
}

function safeGetFlatMesh(ifcApi: WebIFC.IfcAPI, modelID: number, expressID: number): FlatMesh | null {
  try {
    return ifcApi.GetFlatMesh(modelID, expressID) as FlatMesh
  } catch {
    return null
  }
}

function safeGetLine(ifcApi: WebIFC.IfcAPI, modelID: number, expressID: number): IfcRecord | null {
  if (!Number.isFinite(expressID) || expressID <= 0) return null

  try {
    const line = ifcApi.GetLine(modelID, expressID)
    return isRecord(line) ? line : null
  } catch {
    return null
  }
}

function getIfcTypeName(ifcApi: WebIFC.IfcAPI, line: IfcRecord | null, fallback: string): string {
  const typeCode = numberValue(line?.type)
  const getNameFromTypeCode = (ifcApi as { GetNameFromTypeCode?: (typeCode: number) => string })
    .GetNameFromTypeCode

  if (typeCode != null && typeof getNameFromTypeCode === 'function') {
    try {
      const typeName = getNameFromTypeCode.call(ifcApi, typeCode)
      if (typeName) return typeName.replace(/[^a-z0-9]/gi, '').toUpperCase()
    } catch {
      return fallback
    }
  }

  return fallback
}

function isAuxiliaryLikeProduct(typeName: string, line: IfcRecord | null): boolean {
  if (SKIPPED_AUXILIARY_IFC_TYPES.has(typeName)) return true
  if (!line) return false

  const text = getIfcLabelText(line)
  if (!text) return false

  if (typeName === 'IFCBUILDINGELEMENTPROXY' || typeName === 'IFCPROXY') {
    return AUXILIARY_NAME_KEYWORDS.some((keyword) => text.includes(keyword))
  }

  return false
}

function isIfcRootProduct(line: IfcRecord | null): boolean {
  return Boolean(stringValue(line?.GlobalId))
}

function isInteriorLikeProduct(typeName: string, line: IfcRecord | null): boolean {
  if (SKIPPED_INTERIOR_IFC_TYPES.has(typeName)) return true
  if (!line) return false

  const text = getIfcLabelText(line)
  return INTERIOR_NAME_KEYWORDS.some((keyword) => text.includes(keyword))
}

function getIfcLabelText(line: IfcRecord): string {
  return [
    stringValue(line.Name),
    stringValue(line.ObjectType),
    stringValue(line.PredefinedType),
    stringValue(line.Tag),
  ]
    .filter(Boolean)
    .join(' ')
    .toUpperCase()
}

function getPlacedColor(placed: PlacedGeometry, typeName: string) {
  const color = placed.color
  if (
    color &&
    Number.isFinite(color.x) &&
    Number.isFinite(color.y) &&
    Number.isFinite(color.z)
  ) {
    return {
      b: clamp01(color.z ?? 0.7),
      g: clamp01(color.y ?? 0.7),
      opacity: clamp01(color.w ?? 1),
      r: clamp01(color.x ?? 0.7),
    }
  }

  return fallbackColor(typeName)
}

function fallbackColor(typeName: string) {
  if (typeName.includes('ROOF')) return { r: 0.86, g: 0.34, b: 0.06, opacity: 1 }
  if (typeName.includes('WINDOW') || typeName.includes('PLATE') || typeName.includes('CURTAIN')) {
    return { r: 0.72, g: 0.86, b: 0.92, opacity: 0.48 }
  }
  if (typeName.includes('DOOR')) return { r: 0.72, g: 0.48, b: 0.25, opacity: 1 }
  if (typeName.includes('SITE')) return { r: 0.18, g: 0.52, b: 0.16, opacity: 1 }
  if (typeName.includes('FURN')) return { r: 0.68, g: 0.56, b: 0.42, opacity: 1 }
  return { r: 0.72, g: 0.72, b: 0.68, opacity: 1 }
}

function fallbackRoughness(typeName: string): number {
  if (typeName.includes('WINDOW') || typeName.includes('PLATE') || typeName.includes('CURTAIN')) {
    return 0.08
  }
  if (typeName.includes('DOOR') || typeName.includes('FURN')) return 0.45
  return 0.62
}

function fallbackMetalness(typeName: string): number {
  if (typeName.includes('WINDOW') || typeName.includes('PLATE') || typeName.includes('CURTAIN')) {
    return 0.02
  }
  return 0
}

function transformPoint(matrix: number[], x: number, y: number, z: number): [number, number, number] {
  return [
    (matrix[0] ?? 0) * x + (matrix[4] ?? 0) * y + (matrix[8] ?? 0) * z + (matrix[12] ?? 0),
    (matrix[1] ?? 0) * x + (matrix[5] ?? 0) * y + (matrix[9] ?? 0) * z + (matrix[13] ?? 0),
    (matrix[2] ?? 0) * x + (matrix[6] ?? 0) * y + (matrix[10] ?? 0) * z + (matrix[14] ?? 0),
  ]
}

function transformDirection(
  matrix: number[],
  x: number,
  y: number,
  z: number,
): [number, number, number] {
  return [
    (matrix[0] ?? 0) * x + (matrix[4] ?? 0) * y + (matrix[8] ?? 0) * z,
    (matrix[1] ?? 0) * x + (matrix[5] ?? 0) * y + (matrix[9] ?? 0) * z,
    (matrix[2] ?? 0) * x + (matrix[6] ?? 0) * y + (matrix[10] ?? 0) * z,
  ]
}

function centerModelGroup(group: THREE.Group) {
  group.updateMatrixWorld(true)
  const box = new THREE.Box3().setFromObject(group)
  if (box.isEmpty()) return

  const center = box.getCenter(new THREE.Vector3())
  group.position.set(group.position.x - center.x, group.position.y - box.min.y, group.position.z - center.z)
  group.userData.ifcOriginalCenter = center.toArray()
  group.userData.ifcGroundOffset = box.min.y
}

function centerModelLayerGroups(groups: THREE.Group[]) {
  const box = new THREE.Box3()

  for (const group of groups) {
    if (group.children.length === 0) continue
    group.updateMatrixWorld(true)
    box.union(new THREE.Box3().setFromObject(group))
  }

  if (box.isEmpty()) return

  const center = box.getCenter(new THREE.Vector3())
  for (const group of groups) {
    group.position.set(
      group.position.x - center.x,
      group.position.y - box.min.y,
      group.position.z - center.z,
    )
    group.userData.ifcOriginalCenter = center.toArray()
    group.userData.ifcGroundOffset = box.min.y
  }
}

function exportGroupToGlbFile(group: THREE.Group, fileName: string): Promise<File> {
  const exporter = new GLTFExporter()

  return new Promise((resolve, reject) => {
    exporter.parse(
      group,
      (gltf) => {
        const blob = new Blob([gltf as ArrayBuffer], { type: 'model/gltf-binary' })
        resolve(new File([blob], fileName, { type: 'model/gltf-binary' }))
      },
      (error) => reject(error),
      { binary: true },
    )
  })
}

function getVisualImportFileName(sourceName: string): string {
  const base =
    sourceName
      .replace(/\.[^.]+$/, '')
      .replace(/[^a-z0-9_-]+/gi, '-')
      .replace(/^-+|-+$/g, '') || 'ifc'
  return `${base}-visual.glb`
}

function getVisualLayerFileName(sourceName: string, layer: string): string {
  const base =
    sourceName
      .replace(/\.[^.]+$/, '')
      .replace(/[^a-z0-9_-]+/gi, '-')
      .replace(/^-+|-+$/g, '') || 'ifc'
  return `${base}-${layer}.glb`
}

function disposeGroup(group: THREE.Group) {
  group.traverse((object) => {
    const mesh = object as THREE.Mesh
    if (!mesh.isMesh) return
    mesh.geometry.dispose()
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    for (const material of materials) material.dispose()
  })
  group.clear()
}

function closeIfcModel(ifcApi: WebIFC.IfcAPI, modelID: number) {
  const disposable = ifcApi as unknown as {
    CloseModel?: (modelID: number) => void
    Dispose?: () => void
  }
  try {
    disposable.CloseModel?.(modelID)
  } finally {
    disposable.Dispose?.()
  }
}

function nextFrame(): Promise<void> {
  if (typeof requestAnimationFrame !== 'function') return Promise.resolve()
  return new Promise((resolve) => requestAnimationFrame(() => resolve()))
}

function stringValue(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (isRecord(value) && typeof value.value === 'string') return value.value
  return null
}

function numberValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (isRecord(value)) return numberValue(value.value)
  return null
}

function refId(value: unknown): number | null {
  if (!isRecord(value)) return null
  const raw = value.value
  return typeof raw === 'number' && raw > 0 ? raw : null
}

function isRecord(value: unknown): value is IfcRecord {
  return Boolean(value) && typeof value === 'object'
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}
