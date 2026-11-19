'use client';

// Cartão de aprovação na conversa (F9; design "Cartão de sistema: Aprovação pendente / respondida"). Pendente: cartão neutro (phase 18, sem borda colorida; o tom `warning` pinta só o título), a
// ação legível e o app, os parâmetros resumidos, o tempo que falta e três respostas, todas com TEXTO (a ação é crítica e ambígua):
// "Permitir uma vez" (primário), "Negar" (secundário) e o menu com "Sempre permitir" e "Negar sempre" (estas gravam a regra no bot).
// No chat geral (sem `bot`) não há bot onde gravar a regra: o menu não existe, e o servidor também recusa a resposta permanente
// (a regra permanente do chat geral é a global, na tela Aprovações). Respondida, expirada ou cancelada: colapsa numa linha com o selo do estado.
// Conta do conector (phase 13, A9): quando a ação executa numa conta, o cartão a mostra ao lado da ação (`accountLabel`, nome do dono ou rótulo automático), pendente e respondido.
// Título do doc (decisão 23, A35, phase 14): a exclusão de doc mostra "Doc: <título>" ao lado da ação, pendente e respondido, vindo do impacto que o servidor gravou no cartão (`impact.kind` =
// `delete_doc`); o impacto de tabela segue com o nome da tabela e a contagem. O `kind` do impacto discrimina os dois, e o cartão sem impacto cai no cartão genérico (categoria e parâmetros).
// Faísca (F1 e F7 da phase 5): o cartão PENDENTE mostra a Faísca aguardando (na cor do bot ou, no chat geral, em `--faisca`), o único dos cartões que se
// mexe; o cartão respondido, expirado ou cancelado não mostra a Faísca.
//
// A resposta vai à API; o estado novo chega pelo SSE (o cartão da conversa é atualizado na mesma transação do servidor), mas o
// cartão já colapsa com a resposta da própria chamada, sem esperar o evento. Erros do contrato têm tratamento próprio:
// `APPROVAL_EXPIRED` mostra o cartão como expirado e `APPROVAL_NOT_PENDING` só avisa (o estado verdadeiro chega pelo SSE).
import {
  APPROVAL_STATUS_LABELS,
  DOC_ACTIONS,
  TABLE_ACTIONS,
  type ApprovalCard,
  type ApprovalDecision,
  type ApprovalOutcome,
  type ApprovalStatus,
  type Bot,
} from '@aion/shared';
import { ChevronDown, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { formatTimeLeft } from '@/components/approvals/approvals-state';
import { respondApproval } from '@/components/approvals/approvals-api';
import { notifyApprovalsChanged } from '@/components/approvals/pending-approvals';
import { StatusBadge, type BadgeTone } from '@/components/settings/status-badge';
import { Button } from '@/components/ui/button';
import { Menu, MenuContent, MenuItem, MenuTrigger } from '@/components/ui/menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { ApiError, apiErrorMessage } from '@/lib/api-client';
import { useNow } from '@/lib/use-now';
import { useSession } from '@/lib/session-context';
import { SystemCard } from './card-frame';

const STATUS_TONE: Record<Exclude<ApprovalStatus, 'pending'>, BadgeTone> = {
  approved: 'success',
  denied: 'danger',
  expired: 'warning',
  cancelled: 'neutral',
};

/** Complemento do selo quando a resposta gravou uma regra no bot ("sempre"). */
const DECISION_NOTE: Partial<Record<ApprovalDecision, string>> = { allow_always: 'sempre permitir', deny_always: 'negar sempre' };

/** Aviso dos parâmetros que o resumo deixou de fora: a ação executa com todos, então o dono precisa saber que existem. */
function omittedNotice({ count, names }: ApprovalCard['omitted']): string {
  const list = names.length > 0 ? `: ${names.join(', ')}${names.length < count ? '…' : ''}` : '';
  return `+${count} ${count === 1 ? 'parâmetro não exibido' : 'parâmetros não exibidos'}${list}`;
}

/**
 * Conta do conector em que a ação executa (phase 13, A9), ao lado da ação: o nome que o dono deu a ela ou o rótulo automático, já pronto no cartão (o servidor o grava, a tela
 * não o monta). É onde o dono decide, então é onde a conta precisa estar visível. Sem conta (cartão gravado antes da phase, ou categoria de tabelas), não há linha.
 */
function AccountNote({ label }: { label: ApprovalCard['accountLabel'] }) {
  if (label === undefined) return null;
  return <span className="text-xs text-muted [overflow-wrap:anywhere]">{`Conta: ${label}`}</span>;
}

/**
 * Título do doc que a exclusão apagaria (decisão 23, A35), ao lado da ação, pendente e respondido. O servidor o lê do banco depois da checagem de acesso e o grava no impacto do cartão; a tela só o
 * mostra, como texto (nunca interpretado como marcação), e nunca o deduz dos parâmetros. É onde o dono decide, então é onde precisa estar visível. Sem impacto de doc (cartão gravado antes da decisão,
 * ação de conector, tabelas), não há nada a mostrar.
 */
function DocNote({ impact }: { impact: ApprovalCard['impact'] }) {
  if (impact?.kind !== 'delete_doc') return null;
  return <span className="text-sm text-fg [overflow-wrap:anywhere]">{`Doc: ${impact.docTitle}`}</span>;
}

/** Parâmetros resumidos (nome e valor curtos, já truncados pelo servidor) e o aviso dos omitidos, em destaque. */
function Params({ params, omitted }: Pick<ApprovalCard, 'params' | 'omitted'>) {
  if (params.length === 0) return null;
  return (
    <>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[13px]/5">
        {params.map((param, index) => (
          <div key={`${index}-${param.name}`} className="contents">
            <dt className="font-mono text-subtle">{param.name}</dt>
            <dd className="font-mono text-muted [overflow-wrap:anywhere]">{param.value}</dd>
          </div>
        ))}
      </dl>
      {omitted.count > 0 ? <p className="mt-1 font-mono text-[13px]/5 text-warning [overflow-wrap:anywhere]">{omittedNotice(omitted)}</p> : null}
    </>
  );
}

/** `bot` é o dono da conversa (a cor da Faísca do cartão pendente; as respostas permanentes gravam a regra nele); nulo no chat geral, onde a Faísca é a do Aion. */
export function ApprovalCardView({ card, bot }: { card: ApprovalCard; bot: Bot | null }) {
  const tableAction = Object.values(TABLE_ACTIONS).find((action) => action.slug === card.action);
  // O impacto do cartão é da tabela ou do doc, e se discrimina por `kind` (decisão 23): `tableImpact` e `docImpact` são o mesmo `card.impact` visto por cada lado.
  const docImpact = card.impact?.kind === 'delete_doc' ? card.impact : undefined;
  const tableImpact = card.impact?.kind === 'delete_doc' ? undefined : card.impact;
  const allowPermanent = bot !== null;
  const { csrfToken } = useSession();
  const now = useNow(30_000);
  const [busy, setBusy] = useState(false);
  /** Resultado da própria resposta (ou expiração descoberta ao responder), antes de o evento do SSE chegar. */
  const [local, setLocal] = useState<ApprovalOutcome | null>(null);

  const status: ApprovalStatus = card.status !== 'pending' ? card.status : (local?.status ?? 'pending');
  const decision = card.status !== 'pending' ? card.decision : (local?.decision ?? null);

  async function respond(choice: ApprovalDecision) {
    if (busy) return;
    setBusy(true);
    try {
      const outcome = await respondApproval(card.approvalId, choice, csrfToken);
      setLocal(outcome);
      notifyApprovalsChanged();
    } catch (error) {
      if (error instanceof ApiError && error.code === 'APPROVAL_EXPIRED') {
        setLocal({ id: card.approvalId, status: 'expired', decision: null });
        toast.error(error.message, { duration: Infinity });
      } else if (error instanceof ApiError && error.code === 'APPROVAL_NOT_PENDING') {
        toast(error.message);
      } else {
        toast.error(apiErrorMessage(error), { duration: Infinity });
      }
      notifyApprovalsChanged();
    } finally {
      setBusy(false);
    }
  }

  if (status !== 'pending') {
    const note = decision ? DECISION_NOTE[decision] : undefined;
    return (
      <SystemCard icon={ShieldCheck} title="Aprovação">
        <p className="flex flex-wrap items-center gap-2">
          {/* O rótulo da ação já traz o app ("Send Email · Gmail"): acrescentar `card.appName` repetia o nome (E20). */}
          <span>{card.actionLabel}</span>
          <DocNote impact={card.impact} />
          <AccountNote label={card.accountLabel} />
          <StatusBadge tone={STATUS_TONE[status]}>{APPROVAL_STATUS_LABELS[status]}</StatusBadge>
          {note ? <span className="text-xs text-subtle">({note})</span> : null}
        </p>
        {tableImpact && <p className="mt-1 whitespace-pre-wrap break-words text-sm text-muted">{tableImpact.tableName} · {tableImpact.recordCount} registro(s) afetado(s){tableImpact.columnName ? ` · ${tableImpact.columnName}` : ''}</p>}
      </SystemCard>
    );
  }

  return (
    <SystemCard
      icon={ShieldCheck}
      title="Aprovação pendente"
      tone="warning"
      bot={bot}
      faiscaState="waiting"
      actions={
        <>
          <Button variant="primary" size="sm" disabled={busy} onClick={() => void respond('allow_once')}>
            Permitir uma vez
          </Button>
          <Button variant="secondary" size="sm" disabled={busy} onClick={() => void respond('deny')}>
            Negar
          </Button>
          {allowPermanent ? (
            <Menu>
              <Tooltip>
                <TooltipTrigger asChild>
                  <MenuTrigger asChild>
                    <Button variant="secondary" size="icon" aria-label="Mais opções de resposta" disabled={busy}>
                      <ChevronDown className="size-4" strokeWidth={1.5} aria-hidden />
                    </Button>
                  </MenuTrigger>
                </TooltipTrigger>
                <TooltipContent side="top">Mais opções de resposta</TooltipContent>
              </Tooltip>
              <MenuContent>
                <MenuItem onSelect={() => void respond('allow_always')}>Sempre permitir</MenuItem>
                <MenuItem onSelect={() => void respond('deny_always')}>Negar sempre</MenuItem>
              </MenuContent>
            </Menu>
          ) : null}
        </>
      }
    >
      {/* A ação e a conta lado a lado; no celular a conta desce para a linha de baixo. */}
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <p className="font-medium text-fg">{card.actionLabel}</p>
        <DocNote impact={card.impact} />
        <AccountNote label={card.accountLabel} />
      </div>
      {tableAction ? <><p className="mt-2 whitespace-pre-wrap break-words text-sm">Tabela: {tableImpact?.tableName ?? 'Tabela indisponível'}{tableImpact?.columnName ? ` · Coluna: ${tableImpact.columnName}` : ''}</p><p className="mt-1 text-sm">{tableImpact?.recordCount ?? 0} registro(s) afetado(s). Esta ação não pode ser desfeita.</p>{allowPermanent && <p className="mt-2 text-xs text-muted">Sempre permitir cria uma regra de {tableAction.label.toLocaleLowerCase('pt-BR')} para este bot, nas tabelas às quais ele tenha acesso. A regra do bot prevalece sobre a global. Não concede acesso a outras tabelas.</p>}</> : docImpact ? <><p className="mt-2 text-sm">Esta ação não pode ser desfeita.</p>{allowPermanent && <p className="mt-2 text-xs text-muted">Sempre permitir cria uma regra de {DOC_ACTIONS.delete.label.toLocaleLowerCase('pt-BR')} para este bot, nos docs aos quais ele tenha acesso. A regra do bot prevalece sobre a global. Não concede acesso a outros docs.</p>}</> : <><p className="font-mono text-[13px]/5 text-subtle [overflow-wrap:anywhere]">{card.action}</p><Params params={card.params} omitted={card.omitted} /></>}
      <p className="mt-2 text-xs text-subtle">Expira em {formatTimeLeft(card.expiresAt, now)}</p>
    </SystemCard>
  );
}
