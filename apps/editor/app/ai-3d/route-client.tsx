'use client'

import { Loader2 } from 'lucide-react'
import dynamic from 'next/dynamic'

function Ai3DRouteShell() {
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

const Ai3DGenerativePage = dynamic(
  () => import('./tool-page').then((mod) => mod.Ai3DGenerativePage),
  {
    ssr: false,
    loading: Ai3DRouteShell,
  },
)

export function Ai3DRouteClient() {
  return <Ai3DGenerativePage />
}
