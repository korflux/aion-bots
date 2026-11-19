'use client';

// Cartões de rotina na conversa do bot (F12 passo 3, F13; design: Cartão de sistema → Rotina iniciada / concluída / falhou / perdida e Proposta de rotina;
// phase 10: Rotina criada pelo bot, Alteração de rotina aplicada e os avisos de recusa e edição). Duas formas (phase 18, A12 e A14, em `card-frame`): CARTÃO neutro
// para o que pede o dono (proposta, rotina criada ou alterada com Recusar e Editar, execução que falhou, atingiu o limite ou expirou) e LINHA discreta (`SystemLine`)
// para o que só informa (execução iniciada, concluída ou interrompida, perdida, confirmada, recusada, editada).
// - "Rotina <nome> ..." (`routine_run`): criado quando a execução COMEÇA e atualizado quando termina. Mostra o horário previsto e o real.
//   O resultado do bot NÃO está aqui (T20): é a mensagem do bot logo abaixo, e repeti-lo o mostrava duas vezes.
//   Os desfechos de cartão (falhou, atingiu o limite e expirou, `RUN_AS_CARD`) mostram a Faísca do bot de erro (pela função única `mascotStateOfRunStatus`),
//   sempre parada; a execução concluída, iniciada ou interrompida é linha, com o ícone e o link "Ver rotina", sem Faísca.
// - "Rotina <nome> confirmada" (`routine_confirmed`): registro de que o dono confirmou uma proposta ou alteração ANTIGA do bot. Existe sobretudo para o
//   bot (é por ele que o modelo sabe da confirmação); na tela é uma linha curta, sem ações.
// - "Rotina <nome> recusada" e "Rotina <nome> editada" (`routine_refused`, `routine_edited`, phase 10): os avisos equivalentes para o que o dono fez
//   num cartão de rotina aplicada pelo bot. Mesma forma do "confirmada": uma linha, sem ações; o detalhe (agenda e instrução finais) vai só ao modelo.
// - "Rotina <nome> perdida" (`routine_missed`): o horário passou com o serviço parado há mais de 60 minutos e a execução não rodou.
// - "Proposta de rotina" e "Alteração de rotina" (`routine_proposal`, `routine_change`) têm DOIS fluxos de vida, escolhidos pelo `status` do cartão
//   (ver `ROUTINE_CARD_STATUSES` em @aion/shared); os dois nunca se misturam num mesmo cartão:
//   - fluxo ANTIGO (`pending`, `confirmed`, `stale`; propostas gravadas antes da phase 10): nada acontece antes do "Confirmar" do dono. Continuam
//     aparecendo com Confirmar (e Editar, na proposta). O cartão mostra a INSTRUÇÃO que a rotina vai executar (R12): confirmar sem ver o texto seria às cegas.
//   - fluxo NOVO (`applied`, `refused`, `edited`, `superseded`; phase 10, SEC-03 substituída): a rotina ou a alteração JÁ valeu quando o cartão nasceu, e o
//     dono pode Recusar (o servidor desfaz) ou Editar (abre o editor ligado ao cartão). A ação do dono vem do servidor (`POST /api/routines/cards/<id>/refuse`
//     e o `PUT` da rotina com o `cardId` no corpo; o `?cartao=` é só o parâmetro da página do editor); o cartão só pede e mostra o resultado.
import {
  ERROR_CODES,
  ROUTINE_CATCH_UP_MS,
  ROUTINE_CHANGE_FIELD_LABELS,
  mascotStateOfRunStatus,
  type Bot,
  type ErrorCode,
  type RoutineCardStatus,
  type RoutineChangeCard,
  type RoutineChangeField,
  type RoutineConfirmedCard,
  type RoutineEditedCard,
  type RoutineMissedCard,
  type RoutineProposalCard,
  type RoutineRefusedCard,
  type RoutineRunCard,
} from '@aion/shared';
import { CalendarCheck, CalendarClock, CalendarCog, CalendarPlus, CalendarX } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useId, useRef, useState } from 'react';
import { toast } from 'sonner';
import { PROPOSAL_STORAGE_KEY } from '@/components/routines/routine-editor';
import { confirmRoutineChange, createRoutine, refuseRoutineCard } from '@/components/routines/routines-api';
import { ConfirmDialog } from '@/components/settings/confirm-dialog';
import { StatusBadge } from '@/components/settings/status-badge';
import { Button } from '@/components/ui/button';
import { ApiError, apiErrorMessage } from '@/lib/api-client';
import { cn } from '@/lib/cn';
import { formatDateTimeInZone } from '@/lib/format';
import { useSession } from '@/lib/session-context';
import { SystemCard, SystemLine, type CardTone } from './card-frame';

/** Fuso do navegador: os horários do cartão são mostrados no fuso do dono (a rotina pode ter outro, mas o cartão é um aviso). */
const localZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone;

const RUN_TITLE: Record<RoutineRunCard['state'], string> = {
  running: 'iniciada',
  completed: 'concluída',
  failed: 'falhou',
  interrupted: 'interrompida',
  limit_reached: 'atingiu o limite',
  expired: 'expirou',
};

const RUN_TONE: Record<RoutineRunCard['state'], CardTone> = {
  running: 'bot',
  completed: 'bot',
  failed: 'danger',
  interrupted: 'warning',
  limit_reached: 'warning',
  expired: 'warning',
};

/** Estados da execução de rotina que continuam cartão (pedem a atenção do dono); os demais viram linha (phase 18). */
const RUN_AS_CARD: ReadonlySet<RoutineRunCard['state']> = new Set(['failed', 'limit_reached', 'expired']);

/**
 * Texto longo recolhido após 6 linhas (design), com "Mostrar mais" só quando há mais para mostrar. Mostra o texto exatamente como foi
 * escrito (quebras de linha preservadas, sem interpretar Markdown), que é o que a instrução de uma rotina proposta precisa: o dono deve
 * ver o que vai executar, e não uma versão formatada dele.
 */
function CollapsibleText({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const regionId = useId();
  const long = text.split('\n').length > 6 || text.length > 420;
  return (
    <div className="mt-2">
      <div id={regionId} className={cn(!open && long && 'line-clamp-6 overflow-hidden')}>
        <p className="whitespace-pre-wrap text-muted [overflow-wrap:anywhere]">{text}</p>
      </div>
      {long ? (
        <button type="button" aria-expanded={open} aria-controls={regionId} onClick={() => setOpen((value) => !value)} className="mt-1 text-xs font-medium text-muted underline underline-offset-4 hover:text-fg">
          {open ? 'Mostrar menos' : 'Mostrar mais'}
        </button>
      ) : null}
    </div>
  );
}

/**
 * Cartão "Rotina <nome> ..." de uma execução. `bot` é o dono da conversa (a cor da Faísca; rotina só existe em conversa de bot). O estado do cartão
 * (`running`, `completed`, ...) é um `RunStatus`, então a Faísca vem da função única da phase, sem tabela própria; só `done` e `error` mostram a Faísca.
 */
export function RoutineRunCardView({ card, bot }: { card: RoutineRunCard; bot: Bot | null }) {
  const outcome = mascotStateOfRunStatus(card.state);
  const zone = localZone();
  const failure = card.failureCode !== null && card.failureCode in ERROR_CODES ? ERROR_CODES[card.failureCode as ErrorCode].message : null;
  const title = `Rotina “${card.routineName}” ${RUN_TITLE[card.state]}`;
  const link = card.routineId ? (
    <Button asChild variant="ghost" size="sm">
      <Link href={`/rotinas/${card.routineId}`}>Ver rotina</Link>
    </Button>
  ) : null;
  const times = (
    <p className="text-muted">
      {card.manual ? 'Executada agora a pedido seu' : `Previsto para ${formatDateTimeInZone(card.scheduledFor, zone)}`}
      {' · '}iniciou {formatDateTimeInZone(card.startedAt, zone)}
      {card.finishedAt ? ` · terminou ${formatDateTimeInZone(card.finishedAt, zone)}` : ''}
    </p>
  );
  // Phase 18 (A12 e A14): a execução que deu certo (ou ainda corre, ou foi interrompida) é só uma linha com o link da rotina; falha, limite e expiração seguem cartão, com a Faísca de erro.
  if (!RUN_AS_CARD.has(card.state)) {
    return (
      <SystemLine icon={CalendarClock} title={title} tone={RUN_TONE[card.state]} actions={link}>
        {times}
      </SystemLine>
    );
  }
  return (
    <SystemCard icon={CalendarClock} title={title} tone={RUN_TONE[card.state]} bot={bot} faiscaState={outcome === 'done' || outcome === 'error' ? outcome : undefined} actions={link}>
      {times}
      {card.state === 'failed' ? <p className="mt-1 text-danger">{failure ?? 'A execução falhou.'}</p> : null}
      {card.state === 'expired' ? <p className="mt-1 text-warning">O pedido de aprovação expirou sem resposta e a execução foi encerrada.</p> : null}
    </SystemCard>
  );
}

export function RoutineMissedCardView({ card }: { card: RoutineMissedCard }) {
  const minutes = Math.round(ROUTINE_CATCH_UP_MS / 60_000);
  return (
    <SystemLine icon={CalendarX} title={`Rotina “${card.routineName}” perdida`} tone="warning">
      <p>
        O horário previsto ({formatDateTimeInZone(card.scheduledFor, localZone())}) passou com o serviço parado há mais de {minutes} minutos, então a execução não rodou.
      </p>
    </SystemLine>
  );
}

/** Títulos do aviso de confirmação por ação, iguais em tom aos do cartão de alteração. */
const CONFIRMED_TITLE: Record<RoutineConfirmedCard['action'], string> = {
  create: 'criada',
  update: 'alterada',
  pause: 'pausada',
  resume: 'retomada',
  delete: 'excluída',
};

export function RoutineConfirmedCardView({ card }: { card: RoutineConfirmedCard }) {
  return (
    <SystemLine icon={CalendarCheck} title={`Rotina “${card.routineName}” ${CONFIRMED_TITLE[card.action]}`}>
      <p>Você confirmou a proposta do bot.</p>
    </SystemLine>
  );
}

/**
 * Aviso "Rotina <nome> recusada" (phase 10): o dono recusou, num cartão, o que o bot aplicou. É um registro de uma linha, sem ações (o cartão da rotina é
 * quem mostra o estado "Recusada"); existe para o bot saber da recusa, e o texto que ele lê é o `content` gravado pelo servidor, não este.
 */
export function RoutineRefusedCardView({ card }: { card: RoutineRefusedCard }) {
  return (
    <SystemLine icon={CalendarX} title={`Rotina “${card.routineName}” recusada`}>
      <p>{card.action === 'create' ? 'Você recusou a rotina criada pelo bot.' : 'Você recusou a alteração do bot.'}</p>
    </SystemLine>
  );
}

/** Aviso "Rotina <nome> editada" (phase 10): o dono editou, pelo cartão, a rotina do bot. Mesma forma do aviso de recusa; agenda e instrução finais vão só ao modelo. */
export function RoutineEditedCardView({ card }: { card: RoutineEditedCard }) {
  return (
    <SystemLine icon={CalendarCheck} title={`Rotina “${card.routineName}” editada`}>
      <p>Você editou a rotina.</p>
    </SystemLine>
  );
}

// ---------------------------------------------------------------------------------------------
// Rotina aplicada pelo bot: estados e ações do dono (phase 10, fluxo novo dos cartões de proposta e de alteração)
// ---------------------------------------------------------------------------------------------

/** Os estados do fluxo novo de `ROUTINE_CARD_STATUSES`: o bot já aplicou (`applied`) e o dono recusou, editou ou perdeu a chance (`superseded`). */
type AppliedStatus = Extract<RoutineCardStatus, 'applied' | 'refused' | 'edited' | 'superseded'>;

/** O cartão é do fluxo novo (aplicado pelo bot) ou ainda do antigo, que aguarda o Confirmar do dono? É por aqui que a tela escolhe o desenho. */
function isAppliedFlow(status: RoutineCardStatus): status is AppliedStatus {
  return status === 'applied' || status === 'refused' || status === 'edited' || status === 'superseded';
}

/** Rótulo do estado "mudou depois": a rotina saiu do estado em que o cartão a deixou, então Recusar e Editar não valem mais (A15). */
const SUPERSEDED_LABEL = 'A rotina mudou depois desta proposta';

interface AppliedActionsProps {
  /** Id da mensagem do cartão: o que o servidor usa para desfazer ou ligar a edição. */
  cardId: string;
  /** Estado gravado no cartão (o que o servidor sabe). */
  status: AppliedStatus;
  /** A rotina que o cartão aponta; nulo quando ela não existe (excluída pelo bot, recusada ou apagada depois): sem "Editar" nem "Ver rotina". */
  routineId: string | null;
  /** Rótulo do estado em vigor: "Ativa" (rotina criada) ou "Aplicada" (alteração). */
  activeLabel: string;
  /** Falso na exclusão: a rotina nem existe mais, então não há o que editar (só recusar e restaurar). */
  canEdit: boolean;
  /** Texto do modal de "Recusar": o que acontece ao confirmar. */
  undo: { title: string; description: string; confirmLabel: string };
}

/**
 * Selo de estado e ações do dono num cartão de rotina aplicada pelo bot (design: Ativa ou aplicada com Editar e Recusar; Recusada; Editada pelo dono com
 * "Ver rotina"; mudou depois). Compartilhado pelo cartão "Rotina criada pelo bot" e pelo de alteração, que só diferem no texto do modal e na exclusão.
 *
 * - Recusar abre o modal de confirmação (a ação não tem volta pelo cartão). Confirmar chama `refuse` e a resposta troca o estado aqui mesmo, antes de o
 *   evento do SSE trazer o do servidor. Recusar de novo um cartão já recusado é idempotente (200, o mesmo resultado, sem aviso novo). `ROUTINE_CHANGED` (409)
 *   vem de um cartão já editado ou marcado como "mudou depois", ou de a rotina ter mudado depois do cartão (o servidor confere o estado atual): a tela mostra a
 *   mensagem da API e passa o cartão a "mudou depois"; o servidor decide e o texto do erro vem do envelope, sem cópia local.
 * - Editar leva ao editor da rotina existente (`/rotinas/<id>?cartao=<cardId>`), que liga a gravação ao cartão e volta à conversa.
 * - O estado local só vale enquanto o servidor ainda diz `applied`: quando o SSE trouxer outro estado, é o do servidor que vale.
 * - Foco (teclado e leitor de tela): recusar com sucesso ou com `ROUTINE_CHANGED` tira os botões da tela, e o foco que estava neles cairia no `body`. Ele vai
 *   para o contêiner de estado do próprio cartão (`stateBox`, `tabIndex={-1}`), que não sai do DOM; só nesses dois casos, nunca quando o estado muda por
 *   evento de outro aparelho (a tela não rouba o foco de quem está em outro lugar). Cancelar o modal volta ao "Recusar" que o abriu.
 */
function AppliedCardActions({ cardId, status, routineId, activeLabel, canEdit, undo }: AppliedActionsProps) {
  const { csrfToken } = useSession();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [local, setLocal] = useState<'refused' | 'superseded' | null>(null);
  const refuseButton = useRef<HTMLButtonElement>(null);
  const stateBox = useRef<HTMLDivElement>(null);
  const shown: AppliedStatus = status === 'applied' && local !== null ? local : status;

  async function refuse() {
    if (busy) return;
    setBusy(true);
    try {
      await refuseRoutineCard(cardId, csrfToken);
      setLocal('refused');
      setOpen(false);
      toast('Rotina recusada');
    } catch (error) {
      setOpen(false);
      if (error instanceof ApiError && error.code === 'ROUTINE_CHANGED') setLocal('superseded');
      toast.error(apiErrorMessage(error), { duration: Infinity });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {/* A moldura do cartão não deixa as ações encolherem (`shrink-0`), então o selo longo "mudou depois" e "Ver rotina" estouravam a tela de 320 px. Em tela
          estreita este contêiner quebra linha e é limitado à largura útil do cartão (a viewport menos 3 rem: 1,5 rem do `px-3` da coluna da conversa e 1,5 rem do `px-3` do cartão neutro).
          ponytail: o limite assume o `px-3` da coluna da conversa e do cartão em telas estreitas, rever se mudarem. */}
      <div ref={stateBox} role="group" aria-label="Estado da rotina" tabIndex={-1} className="flex flex-wrap items-center gap-2 outline-none max-md:max-w-[calc(100vw-3rem)]">
        {shown === 'applied' ? (
          <>
            <StatusBadge tone="success">{activeLabel}</StatusBadge>
            {canEdit && routineId !== null ? (
              <Button variant="secondary" size="sm" disabled={busy} onClick={() => router.push(`/rotinas/${routineId}?cartao=${cardId}`)}>
                Editar
              </Button>
            ) : null}
            <Button ref={refuseButton} variant="danger" size="sm" disabled={busy} onClick={() => setOpen(true)}>
              Recusar
            </Button>
          </>
        ) : shown === 'refused' ? (
          <StatusBadge tone="neutral">Recusada</StatusBadge>
        ) : (
          <>
            <StatusBadge tone={shown === 'edited' ? 'neutral' : 'warning'}>{shown === 'edited' ? 'Editada pelo dono' : SUPERSEDED_LABEL}</StatusBadge>
            {routineId !== null ? (
              <Button asChild variant="ghost" size="sm">
                <Link href={`/rotinas/${routineId}`}>Ver rotina</Link>
              </Button>
            ) : null}
          </>
        )}
      </div>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={undo.title}
        description={undo.description}
        confirmLabel={undo.confirmLabel}
        pending={busy}
        onConfirm={() => void refuse()}
        onCloseAutoFocus={(event) => {
          // O modal é controlado e não tem gatilho, então o Radix não devolveria o foco: cancelar volta ao "Recusar" que o abriu. Recusar (com sucesso ou com
          // ROUTINE_CHANGED) tira o botão da tela na mesma renderização que fecha o modal, então o foco vai para o contêiner de estado, que fica.
          event.preventDefault();
          (refuseButton.current ?? stateBox.current)?.focus();
        }}
      />
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Rotina proposta pelo bot: "Rotina criada pelo bot" (fluxo novo) e "Proposta de rotina" (fluxo antigo)
// ---------------------------------------------------------------------------------------------

/**
 * Corpo comum dos dois cartões de proposta: nome, agenda legível e fuso, instrução (recolhível) e, enquanto valem, as próximas execuções. A rotina recusada,
 * editada ou que mudou depois não tem mais as datas do cartão (elas descreveriam uma agenda que não é a de hoje), então só o estado em vigor as mostra.
 */
function ProposalDetails({ card, instructionLabel, showNextRuns }: { card: RoutineProposalCard; instructionLabel: string; showNextRuns: boolean }) {
  const { proposal } = card;
  return (
    <>
      <p className="font-medium">{proposal.name}</p>
      <p className="text-muted">
        {card.summary} · {proposal.timezone}
      </p>
      <p className="mt-2 text-xs font-medium text-subtle">{instructionLabel}</p>
      <CollapsibleText text={proposal.instruction} />
      {showNextRuns && card.nextRuns.length > 0 ? (
        <ol aria-label="Próximas execuções" className="mt-2 flex flex-col gap-0.5 text-xs tabular-nums text-muted">
          {card.nextRuns.map((iso) => (
            <li key={iso}><time dateTime={iso}>{formatDateTimeInZone(iso, proposal.timezone)}</time></li>
          ))}
        </ol>
      ) : null}
    </>
  );
}

/**
 * Cartão da rotina proposta pelo bot: escolhe o desenho pelo estado. Fluxo novo (a rotina já foi criada e roda): "Rotina criada pelo bot". Fluxo antigo
 * (proposta gravada antes da phase 10, ainda pendente ou já confirmada): "Proposta de rotina" com Confirmar.
 */
export function RoutineProposalCardView({ card, cardId, botId }: { card: RoutineProposalCard; cardId: string; botId: string }) {
  const status = card.status;
  return isAppliedFlow(status) ? <RoutineCreatedCardView card={card} cardId={cardId} status={status} /> : <PendingProposalCardView card={card} cardId={cardId} botId={botId} />;
}

/**
 * "Rotina criada pelo bot" (phase 10): `propose_routine` já criou a rotina ativa, que roda na agenda sem clique do dono. O cartão mostra o que foi criado
 * (a instrução inclusive: o que a rotina executa sozinha, com o poder do bot, precisa estar à vista) e deixa Recusar (exclui) e Editar. Nada a confirmar.
 */
function RoutineCreatedCardView({ card, cardId, status }: { card: RoutineProposalCard; cardId: string; status: AppliedStatus }) {
  return (
    <SystemCard
      icon={CalendarPlus}
      title="Rotina criada pelo bot"
      actions={
        <AppliedCardActions
          cardId={cardId}
          status={status}
          routineId={card.routineId}
          activeLabel="Ativa"
          canEdit
          undo={{
            title: `Recusar a rotina “${card.proposal.name}”?`,
            description: 'Ela será excluída. Execuções que já aconteceram continuam no histórico. O bot vai saber da recusa.',
            confirmLabel: 'Recusar',
          }}
        />
      }
    >
      <ProposalDetails card={card} instructionLabel="Instrução que a rotina executa" showNextRuns={status === 'applied'} />
    </SystemCard>
  );
}

/**
 * "Proposta de rotina" do fluxo ANTIGO: o bot propôs, o dono confirma aqui (cria a rotina) ou abre o editor preenchido com "Editar". Nada é agendado antes
 * da confirmação. Como a ferramenta de propor era isenta de aprovação (SEC-03 antiga), a confirmação era o único controle: por isso a instrução vai à vista (R12).
 */
function PendingProposalCardView({ card, cardId, botId }: { card: RoutineProposalCard; cardId: string; botId: string }) {
  const { csrfToken } = useSession();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  /** Confirmada pela resposta desta chamada, antes de o evento do SSE chegar. */
  const [createdHere, setCreatedHere] = useState<string | null>(null);
  const routineId = card.routineId ?? createdHere;
  const confirmed = card.status === 'confirmed' || createdHere !== null;
  const { proposal } = card;

  async function confirm() {
    if (busy) return;
    setBusy(true);
    try {
      const routine = await createRoutine({ ...proposal, botId, proposalMessageId: cardId }, csrfToken);
      setCreatedHere(routine.id);
      toast('Rotina criada');
    } catch (error) {
      const reason = error instanceof ApiError ? error.fields?.[0]?.reason : undefined;
      toast.error(reason ?? apiErrorMessage(error), { duration: Infinity });
    } finally {
      setBusy(false);
    }
  }

  function edit() {
    // A proposta vai para o editor pelo sessionStorage só nesta passagem; sem storage, o editor abre vazio no bot certo.
    try {
      window.sessionStorage.setItem(PROPOSAL_STORAGE_KEY, JSON.stringify({ messageId: cardId, proposal }));
    } catch {
      // Storage bloqueado: segue sem preenchimento.
    }
    router.push(`/rotinas/nova?proposta=${cardId}&bot=${botId}`);
  }

  return (
    <SystemCard
      icon={CalendarPlus}
      title="Proposta de rotina"
      actions={
        confirmed ? (
          <>
            <StatusBadge tone="success">Confirmada</StatusBadge>
            {routineId ? (
              <Button asChild variant="ghost" size="sm">
                <Link href={`/rotinas/${routineId}`}>Ver rotina</Link>
              </Button>
            ) : null}
          </>
        ) : (
          <>
            <Button variant="primary" size="sm" disabled={busy} onClick={() => void confirm()}>
              Confirmar
            </Button>
            <Button variant="secondary" size="sm" disabled={busy} onClick={edit}>
              Editar
            </Button>
          </>
        )
      }
    >
      {/* R12: a instrução é o que a rotina vai executar sozinha, com o poder do bot; confirmar sem vê-la seria aprovar às cegas (SEC-03 antiga). */}
      <ProposalDetails card={card} instructionLabel="Instrução que a rotina vai executar" showNextRuns />
    </SystemCard>
  );
}

// ---------------------------------------------------------------------------------------------
// Alteração de rotina: "... alterada pelo bot" (fluxo novo) e "Alterar a rotina" (fluxo antigo; T21)
// ---------------------------------------------------------------------------------------------

type ChangeAction = RoutineChangeCard['change']['action'];

/** Títulos do cartão de alteração PENDENTE (fluxo antigo): a ação que o dono ainda vai confirmar. */
const CHANGE_TITLE: Record<ChangeAction, string> = {
  update: 'Alterar a rotina',
  pause: 'Pausar a rotina',
  resume: 'Retomar a rotina',
  delete: 'Excluir a rotina',
};

/** Títulos do cartão de alteração JÁ APLICADA (fluxo novo): "Rotina “X” alterada pelo bot", e o mesmo para pausada, retomada e excluída. Espelha `bots/preview.ts`. */
const APPLIED_CHANGE_TITLE: Record<ChangeAction, string> = {
  update: 'alterada',
  pause: 'pausada',
  resume: 'retomada',
  delete: 'excluída',
};

/** Efeito de pausar, retomar ou excluir, no tempo do fluxo: no antigo é o que vai acontecer ao confirmar; no novo, o que o bot já fez. */
type ChangeEffects = Record<Exclude<ChangeAction, 'update'>, string>;

const CHANGE_EFFECT: ChangeEffects = {
  pause: 'A rotina deixa de rodar e as execuções que ainda não começaram saem da fila, até ser retomada.',
  resume: 'A rotina volta a rodar a partir do próximo horário previsto.',
  delete: 'A rotina e o histórico dela são apagados. Isso não pode ser desfeito.',
};

const APPLIED_CHANGE_EFFECT: ChangeEffects = {
  pause: 'A rotina foi pausada: deixou de rodar e as execuções que ainda não começaram saíram da fila, até ser retomada.',
  resume: 'A rotina foi retomada: volta a rodar a partir do próximo horário previsto.',
  delete: 'A rotina e o histórico dela foram apagados pelo bot.',
};

const CHANGE_DONE: Record<ChangeAction, string> = {
  update: 'Rotina alterada',
  pause: 'Rotina pausada',
  resume: 'Rotina retomada',
  delete: 'Rotina excluída',
};

/** Valor curto de um campo (não a instrução) como aparece em "antes → depois": datas locais sem o "T", e "sem ..." quando não há valor. */
function shortValue(field: Exclude<RoutineChangeField, 'instruction'>, snapshot: Extract<RoutineChangeCard['change'], { action: 'update' }>['before']): string {
  switch (field) {
    case 'name':
      return snapshot.name;
    case 'schedule':
      return snapshot.summary;
    case 'timezone':
      return snapshot.timezone;
    case 'startsAt':
      return snapshot.startsAt === null ? 'sem início' : snapshot.startsAt.replace('T', ' ');
    case 'endsAt':
      return snapshot.endsAt === null ? 'sem fim' : snapshot.endsAt.replace('T', ' ');
    case 'maxRuns':
      return snapshot.maxRuns === null ? 'sem limite' : String(snapshot.maxRuns);
  }
}

/**
 * Corpo comum dos dois cartões de alteração: o antes e o depois dos campos que mudam (com a prévia das próximas execuções quando a agenda muda), ou o
 * efeito de pausar, retomar ou excluir. `effects` traz o texto no tempo certo do fluxo; `showNextRuns` esconde as datas quando o cartão já não descreve a
 * agenda de hoje (recusada, editada ou que mudou depois).
 */
function ChangeDetails({ change, effects, showNextRuns }: { change: RoutineChangeCard['change']; effects: ChangeEffects; showNextRuns: boolean }) {
  if (change.action !== 'update') return <p className="text-muted">{effects[change.action]}</p>;
  return (
    <div className="flex flex-col gap-2">
      {change.changed.map((field) =>
        field === 'instruction' ? (
          <div key={field}>
            <p className="text-xs font-medium text-subtle">{ROUTINE_CHANGE_FIELD_LABELS[field]}: antes</p>
            <CollapsibleText text={change.before.instruction} />
            <p className="mt-2 text-xs font-medium text-subtle">{ROUTINE_CHANGE_FIELD_LABELS[field]}: depois</p>
            <CollapsibleText text={change.after.instruction} />
          </div>
        ) : (
          <p key={field}>
            <span className="text-xs font-medium text-subtle">{ROUTINE_CHANGE_FIELD_LABELS[field]}: </span>
            <span className="text-muted">{shortValue(field, change.before)}</span>
            <span aria-hidden> → </span>
            <span className="sr-only"> para </span>
            <span className="font-medium">{shortValue(field, change.after)}</span>
          </p>
        ),
      )}
      {showNextRuns && change.nextRuns.length > 0 && change.changed.some((field) => field === 'schedule' || field === 'timezone' || field === 'startsAt' || field === 'endsAt') ? (
        <ol aria-label="Próximas execuções" className="flex flex-col gap-0.5 text-xs tabular-nums text-muted">
          {change.nextRuns.map((iso) => (
            <li key={iso}>{formatDateTimeInZone(iso, change.after.timezone)}</li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}

/**
 * Cartão de alteração de rotina: escolhe o desenho pelo estado. Fluxo novo (o bot já aplicou): "Rotina “X” alterada, pausada, retomada ou excluída pelo
 * bot", com Recusar e Editar. Fluxo antigo (proposta gravada antes da phase 10): "Alterar, Pausar, Retomar ou Excluir a rotina", com Confirmar.
 */
export function RoutineChangeCardView({ card, cardId }: { card: RoutineChangeCard; cardId: string }) {
  const status = card.status;
  return isAppliedFlow(status) ? <AppliedChangeCardView card={card} cardId={cardId} status={status} /> : <PendingChangeCardView card={card} cardId={cardId} />;
}

/**
 * "Rotina “X” alterada pelo bot" (e pausada, retomada, excluída; phase 10): o bot já aplicou a alteração e o cartão guarda o estado anterior no servidor. Recusar
 * volta a rotina ao que era (a exclusão recusada traz a rotina de volta com a mesma configuração e o mesmo histórico, daí "Recusar e restaurar"); Editar abre o editor
 * (não existe na exclusão, porque a rotina não está lá).
 */
function AppliedChangeCardView({ card, cardId, status }: { card: RoutineChangeCard; cardId: string; status: AppliedStatus }) {
  const { change } = card;
  const deleted = change.action === 'delete';
  return (
    <SystemCard
      icon={deleted ? CalendarX : CalendarCog}
      title={`Rotina “${card.routineName}” ${APPLIED_CHANGE_TITLE[change.action]} pelo bot`}
      actions={
        <AppliedCardActions
          cardId={cardId}
          status={status}
          routineId={card.routineId}
          activeLabel="Aplicada"
          canEdit={!deleted}
          undo={
            deleted
              ? {
                  title: `Recusar a exclusão da rotina “${card.routineName}”?`,
                  description: 'A rotina volta com a mesma configuração e o mesmo histórico.',
                  confirmLabel: 'Recusar e restaurar',
                }
              : {
                  title: `Recusar a alteração da rotina “${card.routineName}”?`,
                  description: 'A rotina volta a ser como era antes desta alteração.',
                  confirmLabel: 'Recusar',
                }
          }
        />
      }
    >
      <ChangeDetails change={change} effects={APPLIED_CHANGE_EFFECT} showNextRuns={status === 'applied'} />
    </SystemCard>
  );
}

/**
 * Cartão "Alterar/Pausar/Retomar/Excluir a rotina" do fluxo ANTIGO (T21): mostra o antes e o depois dos campos que mudam (ou o efeito da ação) e o botão que
 * confirma. Confirmar chama a API com o id do cartão: o servidor aplica o que gravou nele. Estados: pendente (botão), confirmada (selo e
 * link para a rotina, menos na exclusão) e desatualizada (selo e aviso: a rotina mudou, nada foi aplicado).
 */
function PendingChangeCardView({ card, cardId }: { card: RoutineChangeCard; cardId: string }) {
  const { csrfToken } = useSession();
  const [busy, setBusy] = useState(false);
  /** Confirmada pela resposta desta chamada, antes de o evento do SSE chegar. */
  const [confirmedHere, setConfirmedHere] = useState(false);
  const confirmed = card.status === 'confirmed' || confirmedHere;
  const stale = card.status === 'stale' && !confirmedHere;
  const { change } = card;

  async function confirm() {
    if (busy) return;
    setBusy(true);
    try {
      await confirmRoutineChange(cardId, csrfToken);
      setConfirmedHere(true);
      toast(CHANGE_DONE[change.action]);
    } catch (error) {
      const reason = error instanceof ApiError ? error.fields?.[0]?.reason : undefined;
      toast.error(reason ?? apiErrorMessage(error), { duration: Infinity });
    } finally {
      setBusy(false);
    }
  }

  return (
    <SystemCard
      icon={CalendarCog}
      title={`${CHANGE_TITLE[change.action]} “${card.routineName}”`}
      actions={
        confirmed ? (
          <>
            <StatusBadge tone="success">Confirmada</StatusBadge>
            {card.routineId && change.action !== 'delete' ? (
              <Button asChild variant="ghost" size="sm">
                <Link href={`/rotinas/${card.routineId}`}>Ver rotina</Link>
              </Button>
            ) : null}
          </>
        ) : stale ? (
          <StatusBadge tone="warning">Desatualizada</StatusBadge>
        ) : (
          <Button variant={change.action === 'delete' ? 'danger' : 'primary'} size="sm" disabled={busy} onClick={() => void confirm()}>
            {change.action === 'delete' ? 'Excluir' : 'Confirmar'}
          </Button>
        )
      }
    >
      <ChangeDetails change={change} effects={CHANGE_EFFECT} showNextRuns />
      {/* Estado do fluxo antigo: a proposta ficou para trás e nada foi aplicado (no fluxo novo, "mudou depois" é o selo do cartão). */}
      {stale ? <p className="mt-2 text-warning">A rotina mudou depois desta proposta, então nada foi aplicado. Peça ao bot para propor de novo.</p> : null}
    </SystemCard>
  );
}
