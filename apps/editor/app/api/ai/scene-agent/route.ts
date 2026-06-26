import type { NextRequest } from 'next/server'
import { handleAi3DGenerativeToolRequest } from './ai-3d-generative-tool'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function POST(request: NextRequest) {
  return handleAi3DGenerativeToolRequest(request)
}
