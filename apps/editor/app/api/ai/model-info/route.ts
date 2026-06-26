import { NextResponse } from 'next/server'
import { getAiProviderRuntimeInfo } from '../scene-agent/ai-3d-generative-tool'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export function GET() {
  return NextResponse.json(getAiProviderRuntimeInfo())
}
