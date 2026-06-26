'use client'

import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { useIsMobile } from '../../hooks/use-mobile'
import useEditor from '../../store/use-editor'

import { useSidebarStore } from '../ui/primitives/sidebar'
import { IconRail, type SidebarTab } from '../ui/sidebar/tab-bar'
import { EditorLayoutMobile } from './editor-layout-mobile'

const SIDEBAR_MIN_WIDTH = 300
const SIDEBAR_POPOUT_DEFAULT_WIDTH = 340
const SIDEBAR_POPOUT_MAX_WIDTH = 380

// ── Left column: icon rail with pop-out panel ────────────────────────────────

function LeftColumn({
  tabs,
  renderTabContent,
  sidebarOverlay,
}: {
  tabs: SidebarTab[]
  renderTabContent: (tabId: string) => ReactNode
  sidebarOverlay?: ReactNode
}) {
  const width = useSidebarStore((s) => s.width)
  const isCollapsed = useSidebarStore((s) => s.isCollapsed)
  const setIsCollapsed = useSidebarStore((s) => s.setIsCollapsed)
  const activePanel = useEditor((s) => s.activeSidebarPanel)
  const setActivePanel = useEditor((s) => s.setActiveSidebarPanel)

  const columnRef = useRef<HTMLDivElement>(null)
  const [hasInitializedPopout, setHasInitializedPopout] = useState(false)
  const isPopoutOpen = hasInitializedPopout && !isCollapsed
  const popoutWidth =
    width >= SIDEBAR_MIN_WIDTH
      ? Math.min(width, SIDEBAR_POPOUT_MAX_WIDTH)
      : SIDEBAR_POPOUT_DEFAULT_WIDTH

  useEffect(() => {
    setIsCollapsed(true)
    setHasInitializedPopout(true)
  }, [setIsCollapsed])

  // Ensure active panel is a valid tab
  useEffect(() => {
    if (tabs.length > 0 && !tabs.some((t) => t.id === activePanel)) {
      setActivePanel(tabs[0]!.id)
    }
  }, [tabs, activePanel, setActivePanel])

  // Leaving the items tab while furnishing should drop back to select mode
  useEffect(() => {
    if (activePanel === 'items') return
    const { phase, mode, setMode } = useEditor.getState()
    if (phase === 'furnish' && mode === 'build') {
      setMode('select')
    }
  }, [activePanel])

  // Rail click: open the pop-out for a tab, close it when re-clicking the
  // active tab, otherwise switch content while keeping the menu open.
  const handleRailClick = useCallback(
    (id: string) => {
      if (id === activePanel && !isCollapsed) {
        setIsCollapsed(true)
        return
      }
      if (id !== activePanel) {
        setActivePanel(id)
        setIsCollapsed(false)
        return
      }
      if (isCollapsed) {
        setActivePanel(id)
        setIsCollapsed(false)
        return
      }
    },
    [isCollapsed, activePanel, setIsCollapsed, setActivePanel],
  )

  useEffect(() => {
    if (!isPopoutOpen) return

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (columnRef.current?.contains(target)) return
      if (
        target instanceof Element &&
        target.closest(
          '[data-radix-popper-content-wrapper], [data-slot="dropdown-menu-content"], [data-slot="dropdown-menu-sub-content"], [role="dialog"], [role="menu"]',
        )
      ) {
        return
      }
      setIsCollapsed(true)
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsCollapsed(true)
    }

    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [isPopoutOpen, setIsCollapsed])

  return (
    <div
      className="relative z-40 flex h-full w-14 flex-shrink-0 bg-sidebar text-sidebar-foreground"
      ref={columnRef}
    >
      <IconRail
        activeTab={activePanel}
        collapsed={!isPopoutOpen}
        onIconClick={handleRailClick}
        tabs={tabs}
      />
      {isPopoutOpen && (
        <div
          className="absolute top-2 bottom-2 left-14 z-40 flex max-w-[calc(100vw-5rem)] flex-col overflow-hidden rounded-lg border border-border/70 bg-sidebar/95 text-sidebar-foreground shadow-2xl backdrop-blur-xl"
          style={{
            width: popoutWidth,
          }}
        >
          <div className="relative flex flex-1 flex-col overflow-hidden">
            {renderTabContent(activePanel)}
            {sidebarOverlay && <div className="absolute inset-0 z-50">{sidebarOverlay}</div>}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Right column: viewer area with toolbar ───────────────────────────────────

function RightColumn({
  toolbarLeft,
  toolbarRight,
  children,
  overlays,
}: {
  toolbarLeft?: ReactNode
  toolbarRight?: ReactNode
  children: ReactNode
  overlays?: ReactNode
}) {
  return (
    <div
      className="relative flex min-w-0 flex-1 flex-col overflow-hidden"
      style={{
        borderTopLeftRadius: 16,
        clipPath: 'inset(0 0 0 0 round 16px 0 0 0)',
        boxShadow: '-4px -2px 16px rgba(0, 0, 0, 0.08), -1px 0 4px rgba(0, 0, 0, 0.04)',
      }}
    >
      {/* Viewer toolbar */}
      {(toolbarLeft || toolbarRight) && (
        <div className="pointer-events-none absolute top-3 right-3 left-3 z-20 flex items-center justify-between gap-2">
          <div className="pointer-events-auto flex items-center gap-2">{toolbarLeft}</div>
          <div className="pointer-events-auto flex items-center gap-2">{toolbarRight}</div>
        </div>
      )}
      {/* Canvas area */}
      <div className="relative flex-1 overflow-hidden">{children}</div>
      {/* Overlays scoped to the viewer column */}
      {overlays && (
        <div
          className="pointer-events-none absolute inset-0 z-30"
          style={{ transform: 'translateZ(0)' }}
        >
          {overlays}
        </div>
      )}
    </div>
  )
}

// ── Main v2 layout ───────────────────────────────────────────────────────────

export interface EditorLayoutV2Props {
  navbarSlot?: ReactNode
  sidebarTabs?: SidebarTab[]
  renderTabContent: (tabId: string) => ReactNode
  sidebarOverlay?: ReactNode
  viewerToolbarLeft?: ReactNode
  viewerToolbarRight?: ReactNode
  viewerContent: ReactNode
  overlays?: ReactNode
}

export function EditorLayoutV2({
  navbarSlot,
  sidebarTabs = [],
  renderTabContent,
  sidebarOverlay,
  viewerToolbarLeft,
  viewerToolbarRight,
  viewerContent,
  overlays,
}: EditorLayoutV2Props) {
  const isCaptureMode = useEditor((s) => s.isCaptureMode)
  const isMobile = useIsMobile()

  if (isMobile) {
    return (
      <EditorLayoutMobile
        navbarSlot={navbarSlot}
        overlays={overlays}
        renderTabContent={renderTabContent}
        sidebarOverlay={sidebarOverlay}
        sidebarTabs={sidebarTabs}
        viewerContent={viewerContent}
        viewerToolbarLeft={viewerToolbarLeft}
        viewerToolbarRight={viewerToolbarRight}
      />
    )
  }

  return (
    <div className="dark flex h-full w-full flex-col bg-sidebar text-foreground">
      {/* Top navbar */}
      {navbarSlot}

      {/* Main content: left column + right column */}
      <div className="flex min-h-0 flex-1">
        {!isCaptureMode && sidebarTabs.length > 0 && (
          <LeftColumn
            renderTabContent={renderTabContent}
            sidebarOverlay={sidebarOverlay}
            tabs={sidebarTabs}
          />
        )}
        <RightColumn
          overlays={overlays}
          toolbarLeft={isCaptureMode ? undefined : viewerToolbarLeft}
          toolbarRight={isCaptureMode ? undefined : viewerToolbarRight}
        >
          {viewerContent}
        </RightColumn>
      </div>
    </div>
  )
}
