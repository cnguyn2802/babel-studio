# Babel Studio

AI-assisted 3D scene editor for room layouts, furniture placement, outdoor decks, and pergola planning.

Live app: https://babel-studio.vercel.app/ai-3d

## What It Does

- Generate furnished 3D rooms from prompts.
- Plan deterministic layouts for living rooms, studios, kitchens, bedrooms, offices, and gardens.
- Create outdoor living scenes with deck and pergola GLB assets.
- Choose AI providers at runtime, including OpenAI, Qwen, and Abacus when configured.
- Import and place 3D assets in the editor workspace.

## Tech Stack

- Next.js 16
- React 19
- Three.js and React Three Fiber
- Zustand
- Zod
- Turborepo
- Bun

## Repository Layout

```text
apps/
  editor/        Next.js editor app
packages/
  core/          Scene graph, schemas, stores, and pure logic
  viewer/        3D viewer and render systems
  editor/        Reusable editor UI and tools
  mcp/           Scene storage and MCP utilities
```

## Local Development

Install dependencies:

```bash
bun install
```

Create `.env.local` from `.env.example`, then configure the AI providers you want to use.

Run the editor:

```bash
cd apps/editor
bun run dev
```

Default local URL:

```text
http://localhost:3002/ai-3d
```

## Production Build

```bash
cd apps/editor
bun run build
```

## AI Configuration

Common environment variables:

```env
AI_PROVIDER=openai
OPENAI_API_KEY=
OPENAI_MODEL=gpt-5.5
OPENAI_REASONING_EFFORT=medium

QWEN_API_KEY=
QWEN_MODEL=qwen3.7-max
QWEN_BASE_URL=

ABACUS_AI_DEPLOYMENT_ID=
ABACUS_AI_DEPLOYMENT_TOKEN=
```

## Deploy

The current production deployment is hosted on Vercel:

```text
https://babel-studio.vercel.app
```

Production deploys can be pushed with:

```bash
npx vercel deploy --prod
```
