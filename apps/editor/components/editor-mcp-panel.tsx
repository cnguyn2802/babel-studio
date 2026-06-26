'use client'

import { applySceneGraphToEditor, type SceneGraph, useScene } from '@pascal-app/editor'
import { ArrowUp, Clock3, Plus } from 'lucide-react'
import { useMemo, useState } from 'react'

type EditorMcpPanelProps = {
  sceneId?: string
}

type ChatMessage = {
  id: string
  role: 'user' | 'assistant'
  text: string
  title?: string
  steps?: number
  reads?: number
  changes?: number
}

type SceneAgentResponse = {
  message: string
  title?: string
  steps?: number
  reads?: number
  changes?: number
  graph?: SceneGraph
}

export function EditorMcpPanel({ sceneId }: EditorMcpPanelProps) {
  const nodes = useScene((s) => s.nodes)
  const rootNodeIds = useScene((s) => s.rootNodeIds)
  const collections = useScene((s) => s.collections)
  const [input, setInput] = useState('')
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [isSending, setIsSending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const graph = useMemo<SceneGraph>(
    () => ({
      nodes,
      rootNodeIds,
      collections: collections ?? {},
    }),
    [nodes, rootNodeIds, collections],
  )

  async function sendMessage() {
    const message = input.trim()
    if (!message || isSending) return

    setInput('')
    setError(null)
    setIsSending(true)
    setMessages((current) => [...current, { id: crypto.randomUUID(), role: 'user', text: message }])

    try {
      const response = await fetch('/api/ai/scene-agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, sceneId, graph }),
      })
      const payload = (await response.json()) as Partial<SceneAgentResponse> & {
        error?: string
        details?: unknown
      }
      if (!response.ok) {
        throw new Error(formatAgentError(payload))
      }
      if (payload.graph) {
        applySceneGraphToEditor(payload.graph)
      }
      setMessages((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          text: payload.message ?? 'Done.',
          title: payload.title,
          steps: payload.steps,
          reads: payload.reads,
          changes: payload.changes,
        },
      ])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'AI request failed')
    } finally {
      setIsSending(false)
    }
  }

  return (
    <div className="flex h-full flex-col bg-[#141414] text-neutral-100">
      <div className="flex h-16 shrink-0 items-center gap-3 border-neutral-800 border-b px-5">
        <div className="pascal-loader-1 h-6 w-6 text-white" />
        <h2 className="truncate font-semibold text-lg">MCP Agent</h2>
      </div>

      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-6 py-6">
        {messages.length === 0 ? (
          <div className="rounded-lg bg-neutral-800/80 p-4 text-neutral-300 text-sm leading-6">
            Ask for a scene change, layout review, room, or opening. The agent returns scene
            operations and applies them to this editor session.
          </div>
        ) : (
          messages.map((message) => (
            <article key={message.id}>
              {message.role === 'user' ? (
                <div className="ml-auto max-w-[92%] rounded-lg bg-neutral-800 px-4 py-3 text-neutral-100 leading-7">
                  {message.text}
                </div>
              ) : (
                <div className="space-y-3">
                  {message.title && (
                    <div className="rounded-lg border border-blue-500/80 bg-blue-950/30 p-4 shadow-[0_0_0_8px_rgba(37,99,235,0.12)]">
                      <div className="flex items-center justify-between gap-3">
                        <div className="flex min-w-0 items-center gap-3">
                          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-cyan-950 text-cyan-200">
                            <Clock3 className="h-5 w-5" />
                          </div>
                          <div className="min-w-0">
                            <p className="truncate font-semibold">{message.title}</p>
                            <p className="text-neutral-400 text-sm">
                              {message.steps ?? 0} steps · {message.reads ?? 0} reads ·{' '}
                              {message.changes ?? 0} changes
                            </p>
                          </div>
                        </div>
                        {message.changes ? (
                          <span className="rounded-full border border-cyan-400/30 bg-cyan-950 px-3 py-1 font-semibold text-cyan-100 text-xs">
                            v1
                          </span>
                        ) : null}
                      </div>
                    </div>
                  )}
                  <p className="text-neutral-200 text-lg leading-8">{message.text}</p>
                </div>
              )}
            </article>
          ))
        )}
        {error && (
          <div className="rounded-lg border border-red-500/40 bg-red-950/30 p-3 text-red-100 text-sm">
            {error}
          </div>
        )}
      </div>

      <div className="shrink-0 border-neutral-800 border-t p-5">
        <div className="rounded-lg border border-neutral-700 bg-neutral-800 p-3 shadow-inner">
          <div className="mb-2 flex items-center gap-2 text-neutral-400 text-sm">
            <div className="pascal-loader-1 h-4 w-4 text-indigo-300" />
            Scene context
          </div>
          <textarea
            className="h-28 w-full resize-none bg-transparent text-neutral-100 outline-none placeholder:text-neutral-500"
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                void sendMessage()
              }
            }}
            placeholder="Ask anything..."
            value={input}
          />
          <div className="flex items-center justify-between">
            <button
              aria-label="Add attachment"
              className="flex h-8 w-8 items-center justify-center text-neutral-400 hover:text-neutral-100"
              type="button"
            >
              <Plus className="h-5 w-5" />
            </button>
            <button
              aria-label="Send message"
              className="flex h-10 w-10 items-center justify-center rounded-full bg-neutral-200 text-neutral-900 disabled:cursor-not-allowed disabled:opacity-40"
              disabled={isSending || input.trim().length === 0}
              onClick={() => void sendMessage()}
              type="button"
            >
              <ArrowUp className="h-5 w-5" />
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function formatAgentError(payload: {
  message?: string
  error?: string
  details?: unknown
}): string {
  if (typeof payload.details === 'string') return payload.details
  if (payload.message) return payload.message
  if (payload.error) return payload.error
  return 'AI request failed'
}
