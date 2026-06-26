'use client'

import { type ScanNode, useLiveTransforms, useRegistry } from '@pascal-app/core'
import { useAssetUrl, useGLTFKTX2, useNodeEvents, useViewer } from '@pascal-app/viewer'
import { Suspense, useMemo, useRef } from 'react'
import { Box3, type Group, type Material, type Mesh } from 'three'

type ImportedModelMetadata = {
  alignToPlane?: boolean
  centerPivot?: boolean
}

type MeshWithStoredRaycast = Mesh & {
  userData: Mesh['userData'] & {
    pascalOriginalRaycast?: Mesh['raycast']
  }
}

function getImportedModelMetadata(node: ScanNode): ImportedModelMetadata | null {
  const metadata = node.metadata
  if (!metadata || typeof metadata !== 'object' || !('importedModel' in metadata)) return null
  const importedModel = (metadata as { importedModel?: unknown }).importedModel
  return importedModel && typeof importedModel === 'object'
    ? (importedModel as ImportedModelMetadata)
    : null
}

export const ScanRenderer = ({ node }: { node: ScanNode }) => {
  const showScans = useViewer((s) => s.showScans)
  const ref = useRef<Group>(null!)
  useRegistry(node.id, 'scan', ref)
  const events = useNodeEvents(node, 'scan')
  const liveTransform = useLiveTransforms((state) => state.get(node.id))
  const importedModel = getImportedModelMetadata(node)
  const alignToPlane = importedModel?.alignToPlane === true
  const centerPivot = importedModel?.centerPivot === true
  const isImportedModel = importedModel != null

  const resolvedUrl = useAssetUrl(node.url)

  return (
    <group
      position={liveTransform?.position ?? node.position}
      ref={ref}
      rotation={
        liveTransform?.rotation !== undefined
          ? [node.rotation[0], liveTransform.rotation, node.rotation[2]]
          : node.rotation
      }
      scale={[node.scale, node.scale, node.scale]}
      visible={showScans && node.visible !== false}
      {...events}
    >
      {resolvedUrl && (
        <Suspense>
          <ScanModel
            alignToPlane={alignToPlane}
            centerPivot={centerPivot}
            isImportedModel={isImportedModel}
            opacity={node.opacity}
            url={resolvedUrl}
          />
        </Suspense>
      )}
    </group>
  )
}

const ScanModel = ({
  alignToPlane,
  centerPivot,
  isImportedModel,
  opacity,
  url,
}: {
  alignToPlane: boolean
  centerPivot: boolean
  isImportedModel: boolean
  opacity: number
  url: string
}) => {
  const gltf = useGLTFKTX2(url) as any
  const scene = gltf.scene

  useMemo(() => {
    const normalizedOpacity = opacity / 100
    const isTransparent = normalizedOpacity < 1

    scene.position.set(0, 0, 0)
    if (alignToPlane || centerPivot) {
      const bounds = new Box3().setFromObject(scene)
      if (!bounds.isEmpty()) {
        scene.position.set(
          centerPivot ? -(bounds.min.x + bounds.max.x) / 2 : 0,
          alignToPlane ? -bounds.min.y : 0,
          centerPivot ? -(bounds.min.z + bounds.max.z) / 2 : 0,
        )
      }
    }

    const updateMaterial = (material: Material) => {
      if (isTransparent) {
        material.transparent = true
        material.opacity = normalizedOpacity
        material.depthWrite = false
      } else {
        material.transparent = false
        material.opacity = 1
        material.depthWrite = true
      }
      material.needsUpdate = true
    }

    scene.traverse((child: any) => {
      if ((child as Mesh).isMesh) {
        const mesh = child as MeshWithStoredRaycast
        mesh.userData.pascalOriginalRaycast ??= mesh.raycast

        if (!isImportedModel) {
          // Keep legacy scan captures out of pointer selection; imported IFC/GLB
          // scans remain raycastable so the editor hierarchy can select them.
          mesh.raycast = () => {}
        } else {
          mesh.raycast = mesh.userData.pascalOriginalRaycast
        }

        // Exclude from bounding box calculations
        mesh.geometry.boundingBox = null
        mesh.geometry.boundingSphere = null
        mesh.frustumCulled = false

        if (Array.isArray(mesh.material)) {
          mesh.material.forEach((material) => {
            updateMaterial(material)
          })
        } else {
          updateMaterial(mesh.material)
        }
      }
    })
  }, [scene, opacity, alignToPlane, centerPivot, isImportedModel])

  return <primitive object={scene} />
}

export default ScanRenderer
