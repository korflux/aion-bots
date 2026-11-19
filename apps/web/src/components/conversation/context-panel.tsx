'use client';

// Indicador de contexto do composer para bot, Chat geral e abertura (Início) (phase 8; ação única "Compactar agora" desde a phase 9, F6).
//
// Só a bola de ocupação fica visível, à esquerda do seletor de modelo; o clique abre um dropdown compacto com o essencial: percentual de uso da janela, avisos,
// o estado de uma compactação em andamento e a única ação do painel, o botão textual "Compactar agora" (resume a conversa antiga com o modelo e consome tokens;
// o texto é obrigatório porque a ação custa dinheiro e não é universalmente reconhecível). A elisão manual saiu: não há mais ação sem custo nem rótulo "Comprimir:".
// Somente o servidor mede e decide elegibilidade; números ausentes aparecem como indisponíveis, nunca como zero. A ocupação é sempre a razão que a medição do servidor
// entrega (tokens medidos ÷ orçamento de entrada): trocar a janela é resolvido lá (phase 9, T11), que devolve a mesma medição sobre o orçamento da janela vigente e sem
// "Desatualizado" quando a janela foi a única mudança. O painel nunca recalcula orçamento nem decide o que é desatualizado; "Desatualizado" é conteúdo ou configuração nova.
import { contextFailureMessage, type ContextState } from '@aion/shared';
import { LoaderCircle, X } from 'lucide-react';
import { useRef, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { apiErrorMessage } from '@/lib/api-client';
import { cn } from '@/lib/cn';
import { useSession } from '@/lib/session-context';
import { cancelContextMaintenance, fetchContextState, maintainContext, type ConversationSource } from './conversation-api';

/** Percentual do orçamento de entrada; valor ausente nunca vira zero. */
const percentOf = (value: number | null | undefined, budget: number | null | undefined): string | null => value == null || !budget ? null : `${Math.round((value / budget) * 100)}%`;

/** Indicador circular de ocupação (decorativo: o nome acessível fica no botão). */
function OccupancyRing({ ratio }: { ratio: number | null }) {
  return <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true" className="shrink-0 -rotate-90">
    <circle cx="10" cy="10" r="7" fill="none" className="stroke-line" strokeWidth="2.5" />
    {ratio !== null ? <circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" pathLength="100" strokeDasharray={`${Math.min(100, Math.max(0, ratio * 100))} 100`} /> : null}
  </svg>;
}

/**
 * Ação do painel com dica (o botão vai em `children`). A dica fica num invólucro focável porque botão desabilitado não recebe ponteiro nem foco, e o motivo de
 * estar indisponível também precisa aparecer; habilitado, o invólucro sai da ordem de tabulação e o foco vai direto ao botão.
 */
function HintedAction({ hint, disabled, children }: { hint: string; disabled: boolean; children: ReactNode }) {
  return <Tooltip><TooltipTrigger asChild><span tabIndex={disabled ? 0 : -1} className="inline-flex rounded-md outline-offset-2">{children}</span></TooltipTrigger><TooltipContent side="top" className="max-w-56 whitespace-normal">{hint}</TooltipContent></Tooltip>;
}

/** Dica do botão habilitado: diz o que a ação faz e que ela custa tokens, sem prometer redução (o resumo pode sair maior que a origem). */
const COMPACT_HINT = 'Resume a conversa antiga com o modelo (consome tokens); os originais continuam consultáveis.';

/**
 * O que o painel diz sobre o estado do servidor, sem DOM (fonte única da linha de status e do aviso automático; testável sem renderizar o dropdown).
 *  - `compacting`: há uma compactação em curso, seja a fase do servidor (resumo, ou índice de último recurso, inclusive numa compactação automática) ou uma
 *    operação ainda na fila ou em execução. É o ÚNICO rótulo de andamento: "Compactando…".
 *  - `status`: o andamento ou o desfecho da última operação manual. Uma operação antiga de elisão (modo extinto) sai pelo mesmo desfecho genérico, sem erro.
 *  - `autoNote`: aviso discreto da compactação AUTOMÁTICA do último pedido (sem mensagem, cartão nem notificação), só com `summary` e `index`. O servidor só os acende
 *    para compactação automática feita para aquele pedido (a medição de um "Compactar agora" chega zerada, e um resumo antigo não conta); `compaction.elision` é
 *    campo morto do contrato (sempre falso) e não é lido.
 */
export function describeContextState(state: ContextState | null): { compacting: boolean; status: string; autoNote: string } {
  const measurement = state?.measurement;
  const operation = state?.operation;
  const result = operation?.result;
  // changed indica representação salva; um resumo pode custar tokens sem liberar espaço na janela.
  const summaryWithoutReduction = operation?.mode === 'summarize' && result?.changed && result.beforeInputTokens !== null && result.afterInputTokens !== null && result.afterInputTokens >= result.beforeInputTokens;
  const active = operation?.status === 'queued' || operation?.status === 'running';
  const compacting = state?.phase === 'reducing' || state?.phase === 'summarizing' || active;
  const before = percentOf(result?.beforeInputTokens, measurement?.inputBudget);
  const after = percentOf(result?.afterInputTokens, measurement?.inputBudget);
  const status = compacting ? 'Compactando…' : operation?.status === 'cancelled' ? 'Compactação cancelada.' : operation?.status === 'failed' ? contextFailureMessage(operation.errorCode, operation.mode) : operation?.status === 'unknown' ? 'Resultado incerto: confira antes de repetir.' : operation?.status === 'completed' ? summaryWithoutReduction ? 'Resumo salvo, sem redução de espaço.' : result?.changed ? (before && after ? `Compactado: ${before} → ${after} da janela.` : 'Contexto compactado.') : 'Nada a compactar.' : '';
  const compaction = measurement?.compaction;
  const autoNote = compaction && (compaction.summary || compaction.index)
    ? `Contexto compactado automaticamente: ${[compaction.summary && 'conversa antiga resumida', compaction.index && 'trecho mais antigo em índice'].filter(Boolean).join(', ')}.` : '';
  return { compacting, status, autoNote };
}

export interface ContextPanelProps {
  /** A abertura não sugere consumo nem manutenção de uma conversa inexistente: mostra só o estado "ainda não calculado". */
  mode?: 'conversation' | 'opening';
  state: ContextState | null;
  source?: ConversationSource;
  onState?: (state: ContextState) => void;
}

/** Bola + dropdown sobre o Popover do kit: abrir apenas lê metadados; a ação paga exige clique deliberado. */
export function ContextPanel({ state, source, onState, mode = 'conversation' }: ContextPanelProps) {
  const opening = mode === 'opening';
  const { csrfToken } = useSession();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Bloqueia dois cliques antes mesmo de o React atualizar o botão; a idempotência definitiva fica no servidor.
  const locked = useRef(false);
  const measurement = state?.measurement;
  // Razão da medição como o servidor a entrega (orçamento já na janela vigente, ver o cabeçalho); com `stale` ela é a da última medição, anunciada como "Desatualizado".
  const ratio = measurement && measurement.inputBudget > 0 ? measurement.inputTokens / measurement.inputBudget : null;
  const percent = measurement?.stale ? 'Desatualizado' : ratio !== null ? `≈ ${Math.round(ratio * 100)}%` : measurement ? 'Sem espaço para entrada' : 'Ainda não calculado';
  const operation = state?.operation;
  const active = operation?.status === 'queued' || operation?.status === 'running';
  const { compacting, status, autoNote } = describeContextState(state);
  const label = autoNote ? `${percent} · compactado` : percent;
  // Elegibilidade decidida só pelo servidor: `summarizeEnabled` já inclui o que impede qualquer manutenção (arquivado, ocupado, aprovação pendente), o perfil validado,
  // a chave do provedor e ter histórico a cobrir. `enabled`/`reason` valem para estados antigos sem esses campos.
  const eligible = state?.eligibility.summarizeEnabled ?? state?.eligibility.enabled;
  const disabled = pending || active || !source || !eligible;
  const reason = !source ? 'Envie uma mensagem para começar a conversa.' : !state ? 'Estado de contexto indisponível.' : state.eligibility.summarizeReason ?? state.eligibility.reason ?? (active ? 'Compactação em andamento.' : null);
  const tone = measurement?.excessTokens ? 'text-danger' : ratio !== null && ratio >= 0.85 ? 'text-warning' : ratio !== null && ratio >= 0.6 ? 'text-fg' : 'text-muted';

  /** Releitura é somente GET, sem medição paga; falha mantém o último snapshot disponível. */
  async function readState() {
    if (opening || !source) return;
    try { onState?.(await fetchContextState(source)); }
    catch (failure) { setError(apiErrorMessage(failure)); }
  }

  /** Uma intenção gera um UUID novo; falha/rede nunca repete automaticamente uma chamada de resultado incerto. */
  async function act(action: 'summarize' | 'cancel') {
    if (!source || !state || locked.current || (action === 'cancel' && !operation)) return;
    locked.current = true;
    setPending(true);
    setError(null);
    try {
      const next = action === 'cancel'
        ? await cancelContextMaintenance(source, operation!.requestId, csrfToken)
        : await maintainContext(source, { mode: action, expectedRevision: state.revision, requestId: crypto.randomUUID() }, csrfToken);
      onState?.(next);
    } catch (failure) {
      setError(apiErrorMessage(failure));
      await readState();
    } finally { locked.current = false; setPending(false); }
  }

  /** O gatilho não cria sessão no Início; a conversa existente só relê seu estado ao abrir. */
  function changeOpen(next: boolean) {
    setOpen(next);
    if (next) { setError(null); void readState(); }
  }

  return <Popover open={open} onOpenChange={changeOpen}>
    <Tooltip>
      <TooltipTrigger asChild>
        <PopoverTrigger asChild>
          <Button variant="ghost" size="icon" aria-label={`Contexto: ${label}`} aria-expanded={open} className={cn('shrink-0', tone)}>
            {compacting ? <LoaderCircle data-icon="LoaderCircle" className="size-4 animate-spin motion-reduce:animate-none" aria-hidden /> : <OccupancyRing ratio={ratio} />}
          </Button>
        </PopoverTrigger>
      </TooltipTrigger>
      <TooltipContent side="top">Contexto: {label}</TooltipContent>
    </Tooltip>
    {/* Foco inicial no próprio dropdown: focar o 1º controle abria a dica dele e o Escape fechava a dica em vez do dropdown. */}
    <PopoverContent side="top" align="start" collisionPadding={16} aria-label="Contexto" tabIndex={-1} onOpenAutoFocus={(event) => { event.preventDefault(); (event.currentTarget as HTMLElement).focus(); }} className="w-72 max-w-[calc(100vw-2rem)] p-3 text-sm text-fg outline-none">
      <div className="flex items-center justify-between gap-2"><p className="font-medium">Contexto</p>{ratio === null || measurement?.stale ? <p className={cn('text-xs', tone)}>{percent}</p> : null}</div>
      {/* Só o percentual de uso da janela (mesma razão da bola: entrada estimada ÷ orçamento de entrada); números absolutos confundiam: o orçamento de entrada é menor que a janela escolhida (reserva de saída e margem). */}
      {ratio !== null ? <div className="mt-1 flex items-center gap-2">
        <div role="meter" aria-label="Uso da janela" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, Math.round(ratio * 100))} aria-valuetext={`${Math.round(ratio * 100)}% da janela em uso`} className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-line">
          <div className={cn('h-full rounded-full bg-current', tone)} style={{ width: `${Math.min(100, Math.max(0, ratio * 100))}%` }} />
        </div>
        <span className={cn('shrink-0 text-xs tabular-nums', tone)}>{Math.round(ratio * 100)}% da janela</span>
      </div> : null}
      {measurement?.stale ? <p className="mt-1 text-xs text-warning">Desatualizado desde a última medição.</p> : null}
      {!opening ? <>
        <div className="mt-3 flex items-center gap-2 border-t border-line pt-3">
          <HintedAction hint={disabled && reason ? reason : COMPACT_HINT} disabled={disabled}>
            <Button variant="secondary" size="sm" disabled={disabled} onClick={() => void act('summarize')}>Compactar agora</Button>
          </HintedAction>
          {active && operation.cancelable ? <HintedAction hint="Cancelar a compactação em andamento." disabled={pending}>
            <Button variant="secondary" size="icon" aria-label="Cancelar compactação" disabled={pending} onClick={() => void act('cancel')}><X className="size-4" aria-hidden /></Button>
          </HintedAction> : null}
        </div>
        <p role="status" aria-live="polite" className="mt-2 min-h-4 text-xs text-muted">{status}</p>
        {autoNote ? <p className="mt-1 text-xs text-muted">{autoNote}</p> : null}
        {error ?<p role="alert" className="mt-1 text-xs text-danger">{error}</p> : null}
      </> : null}
    </PopoverContent>
  </Popover>;
}
