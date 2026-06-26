'use client'

import { useViewer } from '@pascal-app/viewer'
import { useThree } from '@react-three/fiber'
import { useEffect } from 'react'
import { Group, type Object3D } from 'three'
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'
import { OBJExporter } from 'three/examples/jsm/exporters/OBJExporter.js'
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js'

export function ExportManager({
  additionalRootNames,
}: {
  additionalRootNames?: readonly string[]
}) {
  const scene = useThree((state) => state.scene)
  const setExportScene = useViewer((state) => state.setExportScene)
  const additionalRootNamesKey = additionalRootNames?.join('\0') ?? ''

  useEffect(() => {
    const exportFn = async (format: 'glb' | 'stl' | 'obj' = 'glb') => {
      const extraRootNames = additionalRootNamesKey
        ? additionalRootNamesKey.split('\0').filter(Boolean)
        : []
      const sceneGroup = scene.getObjectByName('scene-renderer')
      const extraRoots = extraRootNames
        .map((name) => scene.getObjectByName(name))
        .filter((root): root is Object3D => Boolean(root))

      if (!sceneGroup && extraRoots.length === 0) {
        console.error('No exportable scene content found')
        return
      }

      const exportRoot =
        extraRoots.length === 0 && sceneGroup
          ? sceneGroup
          : createExportRoot(sceneGroup ? [sceneGroup, ...extraRoots] : extraRoots)

      const date = new Date().toISOString().split('T')[0]

      if (format === 'stl') {
        const exporter = new STLExporter()
        const result = exporter.parse(exportRoot, { binary: true })
        const blob = new Blob([result], { type: 'model/stl' })
        downloadBlob(blob, `model_${date}.stl`)
        return
      }

      if (format === 'obj') {
        const exporter = new OBJExporter()
        const result = exporter.parse(exportRoot)
        const blob = new Blob([result], { type: 'model/obj' })
        downloadBlob(blob, `model_${date}.obj`)
        return
      }

      // Default: GLB export (existing behavior)
      const exporter = new GLTFExporter()

      return new Promise<void>((resolve, reject) => {
        exporter.parse(
          exportRoot,
          (gltf) => {
            const blob = new Blob([gltf as ArrayBuffer], { type: 'model/gltf-binary' })
            downloadBlob(blob, `model_${date}.glb`)
            resolve()
          },
          (error) => {
            console.error('Export error:', error)
            reject(error)
          },
          { binary: true },
        )
      })
    }

    setExportScene(exportFn)

    return () => {
      setExportScene(null)
    }
  }, [scene, setExportScene, additionalRootNamesKey])

  return null
}

function createExportRoot(roots: Object3D[]) {
  const exportRoot = new Group()
  exportRoot.name = 'export-root'
  for (const root of roots) {
    exportRoot.add(root.clone(true))
  }
  return exportRoot
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}
