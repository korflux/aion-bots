'use client';

// Moldura do cartão de sistema e a linha discreta (phase 18, A12 a A15). Dois componentes no mesmo arquivo para os fluxos (`system-card.tsx`, `approval-card.tsx`,
// `routine-card.tsx`, `memory-card.tsx` e `objective.tsx`) usarem a MESMA forma sem se importarem em círculo:
//   - `SystemCard`: o CARTÃO neutro, só para o que pede uma decisão ou uma retomada do dono (aprovação, rotina criada ou alterada, falha, limite): bloco de largura total
//     em `--bg-surface` com uma borda fina neutra, sem borda lateral colorida e sem brilho; o tom (`warning`, `danger`) só pinta o título e o ícone da legenda.
//   - `SystemLine`: a LINHA, para o que só informa (memória, objetivo, rotina executada, avisos): ícone pequeno, texto e link ou ação inline, sem moldura nem fundo. O corpo
//     opcional (o diff da memória, o texto do objetivo) vai logo abaixo, recuado e menor. Ambos são `<section aria-label>`, então continuam uma região para leitor de tela.
//

// Todo ícone da legenda leva `data-icon` com o nome do componente do ícone (`ShieldCheck`, `CalendarClock`...), o gancho do E2E para saber qual ícone saiu sem depender da classe do
// desenho (A32); o mesmo vale para o `EmptyState` e para os giros de espera (`data-icon="LoaderCircle"`).
//
// Faísca (F1 e F7 da phase 5): os cartões de aprovação pendente, de falha, de limite e de rotina (a criada ou alterada e a execução que falhou) trocam o ícone de 14 px da legenda pela Faísca de 32 px
// no estado do cartão (`faiscaState`), na cor do bot ou, no Chat geral (`bot` nulo), em `--faisca`; os demais seguem com o ícone. A moldura é o ÚNICO
// lugar que decide o movimento dos cartões (orçamento de movimento: só o que pede a atenção do dono se mexe): só `waiting` anima (a aprovação pendente), qualquer
// outro estado fica parado, para o histórico da conversa não ter vários laços rodando durante a rolagem.
import type { Bot } from '@aion/shared';
import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { BotAvatar } from '@/components/bots/bot-avatar';
import type { FaiscaState } from '@/components/mascot/faisca-detail';
import { cn } from '@/lib/cn';

export type CardTone = 'bot' | 'warning' | 'danger';

/** Cor do título do cartão por tom: neutro por padrão; só aviso e erro ganham cor, no texto e no ícone (nunca em borda ou fundo). */
const TONE_TEXT: Record<CardTone, string> = {
  bot: 'text-muted',
  warning: 'text-warning',
  danger: 'text-danger',
};

/**
 * Contêiner do cartão. `actions` fica à direita do corpo (no mobile, abaixo, com a Faísca ainda à esquerda do corpo). Com `faiscaState` a Faísca de 32 px
 * ocupa o lugar do ícone da legenda; o título e o texto do cartão continuam sendo quem diz o estado (a Faísca é decorativa).
 */
export function SystemCard({
  icon: Icon,
  title,
  tone = 'bot',
  actions,
  bot = null,
  faiscaState,
  children,
}: {
  icon: LucideIcon;
  title: string;
  tone?: CardTone;
  actions?: ReactNode;
  /** O bot dono da conversa (a cor da Faísca); nulo no Chat geral, onde a Faísca é a do Aion. */
  bot?: Bot | null;
  /** Estado da Faísca do cartão. Sem ele o cartão mostra o ícone da legenda. */
  faiscaState?: FaiscaState;
  children: ReactNode;
}) {
  const showFaisca = faiscaState !== undefined;
  return (
    <section
      aria-label={title}
      className={cn(
        'flex w-full flex-wrap items-start gap-x-4 gap-y-2 rounded-md border border-line bg-surface px-3 py-2.5',
        'animate-[card-in_150ms_var(--ease-out)]',
      )}
    >
      {/* Largura-base de 16 rem: se o corpo (com a Faísca) e as ações não cabem lado a lado (mobile), as ações descem para a linha de baixo. */}
      <div className="flex min-w-0 flex-[1_1_16rem] items-start gap-3">
        {showFaisca ? <BotAvatar owner={bot} size={32} state={faiscaState} still={faiscaState !== 'waiting'} /> : null}
        <div className="min-w-0 flex-1">
          <p className={cn('mb-1 flex items-center gap-1.5 text-xs font-medium', TONE_TEXT[tone])}>
            {showFaisca ? null : <Icon className="size-3.5 shrink-0" strokeWidth={1.5} data-icon={Icon.displayName} aria-hidden />}
            {title}
          </p>
          <div className="text-sm text-fg [overflow-wrap:anywhere]">{children}</div>
        </div>
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </section>
  );
}

/**
 * A linha discreta de um aviso informativo. `actions` (Desfazer, Ver rotina) ficam na mesma linha do título; `children` é o detalhe, recuado sob o ícone. Sem animação de
 * entrada nem fundo: o aviso não compete com a resposta. O tom pinta só o texto, como no cartão.
 */
export function SystemLine({
  icon: Icon,
  title,
  tone = 'bot',
  actions,
  children,
}: {
  icon: LucideIcon;
  title: string;
  tone?: CardTone;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <section aria-label={title} className="w-full text-sm text-muted">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <p className={cn('flex min-w-0 items-center gap-2 text-sm', TONE_TEXT[tone])}>
          <Icon className="size-4 shrink-0" strokeWidth={1.5} data-icon={Icon.displayName} aria-hidden />
          <span className="[overflow-wrap:anywhere]">{title}</span>
        </p>
        {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      </div>
      {children ? <div className="mt-1 pl-6 text-xs text-muted [overflow-wrap:anywhere]">{children}</div> : null}
    </section>
  );
}
