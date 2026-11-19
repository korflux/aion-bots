'use client';

// Painel de subopções da seção ativa (264 px, redimensionável entre 220 e 360 px, recolhível pelo ícone no topo).
// Só o desktop tem o painel; o celular navega pela barra inferior e pelos cabeçalhos (phase 5 T6).
import { PanelLeftClose } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useRef, type KeyboardEvent, type PointerEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/cn';
import { backHrefFor } from './mobile-nav';
import type { NavSection } from './nav-config';

export const PANEL_DEFAULT_WIDTH = 264;
export const PANEL_MIN_WIDTH = 220;
export const PANEL_MAX_WIDTH = 360;
const KEYBOARD_STEP = 16;

const clampWidth = (width: number) => Math.min(PANEL_MAX_WIDTH, Math.max(PANEL_MIN_WIDTH, width));

/** Alça de redimensionamento: arrastar com o ponteiro ou usar as setas (Home/End vão aos limites). */
function ResizeHandle({ width, onResize }: { width: number; onResize: (width: number) => void }) {
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { startX: event.clientX, startWidth: width };
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current) onResize(clampWidth(drag.current.startWidth + event.clientX - drag.current.startX));
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const next: Record<string, number> = {
      ArrowLeft: width - KEYBOARD_STEP,
      ArrowRight: width + KEYBOARD_STEP,
      Home: PANEL_MIN_WIDTH,
      End: PANEL_MAX_WIDTH,
    };
    const target = next[event.key];
    if (target === undefined) return;
    event.preventDefault();
    onResize(clampWidth(target));
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Redimensionar painel"
      aria-valuemin={PANEL_MIN_WIDTH}
      aria-valuemax={PANEL_MAX_WIDTH}
      aria-valuenow={width}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={() => (drag.current = null)}
      onPointerCancel={() => (drag.current = null)}
      onKeyDown={onKeyDown}
      className="absolute inset-y-0 -right-1 z-10 w-2 cursor-col-resize touch-none hover:bg-line-strong/60 active:bg-line-strong"
    />
  );
}

interface SectionPanelProps {
  section: NavSection;
  width?: number;
  onCollapse?: () => void;
  onResize?: (width: number) => void;
}

/** Moldura desktop do conteúdo da seção: título, ações, lista e controles de largura e recolhimento. */
export function SectionPanel({ section, width = PANEL_DEFAULT_WIDTH, onCollapse, onResize }: SectionPanelProps) {
  const pathname = usePathname();
  const panel = section.panel;
  if (!panel) return null;
  const { action, Content } = panel;

  return (
    <aside
      aria-labelledby="painel-titulo"
      style={{ width }}
      className="relative flex max-w-full shrink-0 animate-[panel-in_200ms_var(--ease-out)] flex-col border-r border-line bg-panel"
    >
      <div className="flex h-[52px] shrink-0 items-center justify-between pl-4 pr-2">
        <p id="painel-titulo" className="text-sm font-medium text-fg">
          {panel.title}
        </p>
        <div className="flex items-center gap-0.5">
          {action ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button asChild variant="ghost" size="icon">
                  <Link href={action.href} aria-label={action.label}>
                    <action.icon className="size-4" strokeWidth={1.5} aria-hidden />
                  </Link>
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">{action.label}</TooltipContent>
            </Tooltip>
          ) : null}
          {onCollapse ? (
            <Button variant="ghost" size="icon" aria-label="Recolher painel" onClick={onCollapse}>
              <PanelLeftClose className="size-4" strokeWidth={1.5} aria-hidden />
            </Button>
          ) : null}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-4">
        {Content ? (
          <Content />
        ) : panel.links && panel.links.length > 0 ? (
          <ul className="flex flex-col gap-0.5">
            {panel.links.map((link) => {
              // Ativo na própria rota, nas filhas e na tela cujo pai fixo é este item (a lista de arquivos, aberta por Atividade e arquivos: `backHrefFor`).
              const isActive = pathname === link.href || pathname.startsWith(`${link.href}/`) || backHrefFor(pathname) === link.href;
              return (
                <li key={link.href}>
                  <Link
                    href={link.href}
                    aria-current={isActive ? 'page' : undefined}
                    className={cn(
                      'flex h-9 items-center rounded-sm px-3 text-sm text-muted transition-colors hover:bg-surface-hover hover:text-fg active:bg-selected',
                      isActive && 'bg-selected font-medium text-fg',
                    )}
                  >
                    {link.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>

      {onResize ? <ResizeHandle width={width} onResize={onResize} /> : null}
    </aside>
  );
}
