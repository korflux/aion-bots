'use client';

// Corpo do painel da seção Bots (plugado em nav-config): a lista de bots, UMA linha por bot (phase 18, A25): a Faísca de 24 px na cor do bot, que conta o estado ao vivo pela
// pose (F10), e o nome; o texto do estado só aparece à vista quando o bot aguarda o dono ou está com erro, numa SEGUNDA linha menor abaixo do nome (que fica inteiro), e nos demais
// estados fica só para o leitor de tela e a linha segue única. A seção recolhível
// "Arquivados" fica no fim. O botão de novo bot fica no cabeçalho do painel (ação declarada em nav-config).
// Os dados vêm do store compartilhado (bots-store), então editar ou arquivar atualiza o painel na hora, e o `useLiveBots` o relê sozinho (5 s com algum
// bot em movimento, senão 15 s). O painel e os demais consumidores da lista compartilham o store, que tem uma
// releitura só, então nada é pedido em dobro.
// Não lido (phase 3, F4/A7): o bot com novidade mostra a bolinha (`UnreadDot`) à direita, também dentro de Arquivados; o bot aberto não a mostra.
import type { BotSummary } from '@aion/shared';
import { ChevronRight } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import { UNREAD_LABEL, UnreadDot } from '@/components/ui/unread-dot';
import { cn } from '@/lib/cn';
import { BotAvatar } from './bot-avatar';
import { liveStateLine } from './bot-display';
import { activeBots, archivedBots, botIsOpen, refreshBots, useLiveBots } from './bots-store';

/** Estados em que o texto de estado fica à vista: o bot pede o dono ou falhou. Nos outros a pose da Faísca basta (o texto segue para o leitor de tela). */
const ATTENTION_STATES: ReadonlySet<BotSummary['runState']> = new Set(['waiting', 'error']);

/**
 * Item da lista, de no mínimo 44 px: Faísca de 24 px, o nome (o completo fica no `title`) e, só quando o bot aguarda aprovação ou está com erro, o texto do estado numa segunda linha
 * menor e na cor do estado, abaixo do nome (decisão do dono em 15/11/2026: o estado ao lado truncava o nome no painel de 264 px; o nome só trunca se ele próprio não couber); nos demais
 * estados o texto vai em `sr-only`, então o leitor de tela o lê junto do nome (é conteúdo do link) e a linha segue única de 44 px. A Faísca é decorativa e só se mexe no bot que trabalha ou espera uma
 * aprovação (regra do próprio componente), para a lista respeitar o orçamento de movimento; a troca de estado não anima a linha. O nome vai em `--text` (a cor do bot só pinta a Faísca).
 * Com novidade não lida (e fora do bot aberto, que a presença marca lido), a bolinha fica por último, `shrink-0`, e o nome trunca antes dela; o `sr-only` põe "Novidades não lidas" no
 * nome acessível do link.
 */
function BotLink({ bot, current }: { bot: BotSummary; current: boolean }) {
  const line = liveStateLine(bot);
  const unread = bot.unread && !current;
  const attention = ATTENTION_STATES.has(bot.runState);
  return (
    <li>
      <Link
        href={`/bots/${bot.id}`}
        title={bot.name}
        aria-current={current ? 'page' : undefined}
        className={cn(
          'flex min-h-11 items-center gap-2 rounded-sm px-3 transition-colors hover:bg-surface-hover active:bg-selected',
          attention && 'py-1',
          current && 'bg-selected',
        )}
      >
        <BotAvatar owner={bot} size={24} state={bot.runState} className="shrink-0" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm/5 font-medium text-fg">{bot.name}</span>
          <span className={cn('font-medium', attention ? 'truncate text-xs/4' : 'sr-only', line.className)}>{line.text}</span>
        </span>
        {unread ? (
          <>
            <span className="sr-only">{UNREAD_LABEL}</span>
            <UnreadDot />
          </>
        ) : null}
      </Link>
    </li>
  );
}

/** Esqueleto de uma linha da lista carregando: círculo de 24 px e uma barra (o nome). */
function BotRowSkeleton() {
  return (
    <div className="flex h-11 items-center gap-2 px-3">
      <div className="size-6 shrink-0 animate-pulse rounded-full bg-surface" />
      <div className="h-3 w-2/3 animate-pulse rounded-sm bg-surface" />
    </div>
  );
}

/** Lista desktop com estado ao vivo e bots arquivados recolhíveis, alimentada pela releitura única do store. */
export function BotsPanel() {
  const { status, bots } = useLiveBots();
  const pathname = usePathname();
  const active = activeBots(bots);
  const archived = archivedBots(bots);

  // Arquivados começa recolhido, mas abre sozinho quando o bot aberto está arquivado (senão o item ativo sumiria).
  // `null` = seguir esse padrão; true/false = escolha explícita do dono.
  const [archivedChoice, setArchivedChoice] = useState<boolean | null>(null);
  const isCurrent = (bot: BotSummary) => botIsOpen(pathname, bot.id);
  const archivedOpen = archivedChoice ?? archived.some(isCurrent);

  if (status === 'idle' || (status === 'loading' && bots.length === 0)) {
    return (
      <div role="status" aria-busy="true" aria-label="Carregando bots" className="flex flex-col gap-0.5">
        {[0, 1, 2].map((row) => (
          <BotRowSkeleton key={row} />
        ))}
      </div>
    );
  }

  if (status === 'error' && bots.length === 0) {
    return (
      <div className="flex flex-col items-start gap-2 px-3 py-2">
        <p className="text-sm text-danger">Não foi possível carregar os bots.</p>
        <button
          type="button"
          onClick={() => void refreshBots()}
          className="rounded-sm text-sm font-medium text-fg underline underline-offset-4"
        >
          Tentar novamente
        </button>
      </div>
    );
  }

  if (bots.length === 0) return <p className="px-3 py-2 text-sm text-subtle">Nenhum bot ainda.</p>;

  return (
    <>
      {active.length > 0 ? (
        <ul aria-label="Bots" className="flex flex-col gap-0.5">
          {active.map((bot) => (
            <BotLink key={bot.id} bot={bot} current={isCurrent(bot)} />
          ))}
        </ul>
      ) : (
        <p className="px-3 py-2 text-sm text-subtle">Nenhum bot ativo.</p>
      )}

      {archived.length > 0 ? (
        <div className="mt-4">
          <button
            type="button"
            aria-expanded={archivedOpen}
            aria-controls="bots-arquivados"
            onClick={() => setArchivedChoice(!archivedOpen)}
            className="flex h-8 w-full items-center gap-1 rounded-sm px-3 text-xs font-medium uppercase tracking-wide text-subtle transition-colors hover:bg-surface-hover"
          >
            <ChevronRight className={cn('size-3.5 transition-transform', archivedOpen && 'rotate-90')} strokeWidth={1.5} aria-hidden />
            Arquivados
            <span className="ml-auto font-normal normal-case">{archived.length}</span>
          </button>
          <ul id="bots-arquivados" hidden={!archivedOpen} aria-label="Bots arquivados" className="mt-0.5 flex flex-col gap-0.5">
            {archived.map((bot) => (
              <BotLink key={bot.id} bot={bot} current={isCurrent(bot)} />
            ))}
          </ul>
        </div>
      ) : null}
    </>
  );
}
