'use client';

// A lista de mensagens da conversa (design: "Conversa do bot" e "Chat geral", que é a mesma conversa): mensagem do dono em bolha à
// direita (a ÚNICA bolha, UI-07) e resposta do bot em texto direto na coluna central, sem balão nem Faísca ao lado (phase 18), atividades de ferramenta
// agrupadas, cartões de sistema e as mensagens que ainda esperam a vez ("Na fila"). A resposta do bot aparece INTEIRA, de uma vez, quando
// a etapa do modelo termina (T19, decisão do dono): o texto em escrita fica escondido e a linha da Faísca acima do composer (`WorkingLine`, fora desta lista) cobre a espera.
// Sem bot (`bot` nulo, o chat geral) os cartões usam a borda neutra (`--border-strong` no lugar de `--bot`) e a conversa vazia pergunta "No que posso ajudar?".
//
// Faísca (phase 5, F1 e F7; ID-01 e ID-02): a conversa vazia mostra a Faísca de 112 px (96 px em tela estreita) com a entrada única e o olhar que segue o
// cursor; e os cartões recebem o bot inteiro para mostrarem a Faísca nos casos do design
// (ver `card-frame.tsx`). As respostas não têm Faísca ao lado (phase 18): a que trabalha é a da linha fixa `WorkingLine`. Na cor do bot ou, no Chat geral (sem bot), em `--faisca`:
// o `BotAvatar` (`owner` nulo) é o ponto único dessa escolha, e o Chat geral não tem marcador.
//
// Rolagem: o fim da conversa é seguido SÓ se o dono já estava no fim. Se ele subiu para ler e chega algo novo, aparece a pílula
// "Novas mensagens" em vez de puxar a tela.
//
// Histórico por rodadas (F4): a conversa abre com as últimas 10 rodadas e, ao chegar a menos de `LOAD_TOP_PX` do topo (ou se a conversa nem
// enche a tela), carrega as 10 anteriores sozinha; o botão da faixa do topo (`OlderZone`) é a alternativa para teclado e leitor de tela, e o
// link "ver na conversa" de um trecho da busca carrega páginas até a mensagem aparecer. Carregar não move a leitura nem acende a pílula: ao
// inserir mensagens acima, a rolagem é compensada pela altura que entrou (`useLayoutEffect` de `viewed`). A âncora de rolagem nativa
// (`overflow-anchor`) fica desligada de propósito: ela não existe em todos os navegadores (o do iPhone não a tem) e somaria à compensação.
//
// Barra de ações (phase 4, F6 e F7): cada mensagem do dono e a última bolha de texto de cada resposta levam a `MessageActions` logo abaixo, dentro
// de um `.message-group` (a área cujo hover ou foco revela a barra no desktop); a da última resposta fica sempre visível (`answerBarsOf`). O `id`
// `message-<id>` continua na bolha, não no grupo: o salto, o destaque e os testes medem a bolha sem a barra.
//
// Complemento (phase 4, F5): os pendentes da execução ativa aparecem como bolhas "Complemento · aguardando" com "Cancelar" no fim (depois do
// atividades em curso e antes da fila), e a mensagem já lida leva a legenda "complemento" acima da bolha do dono.
//
// Versões do Chat geral (phase 4, F1 a F4; só com `versions`, que o bot nunca recebe): cada rodada do caminho (`state.rounds`) dá à mensagem do dono
// o seletor "‹ k/n ›" e Editar (edição no lugar, `EditMessage`) e à resposta o seletor e o menu "Mais ações" (gerar outra resposta, retroceder até
// aqui). Retroceder pede confirmação no popup (`Modal`, botão primário: nada é apagado) e deixa no fim a linha "N rodadas retrocedidas · Restaurar".
// Com execução aberta ou complemento pendente os controles ficam bloqueados (`isBusy`). Trocar de versão anuncia "Versão k de n" numa região
// `polite` fora da lista (o seletor pode ter sido recriado) e devolve o foco ao seletor do mesmo grupo. A execução nova de uma versão já está no
// caminho: não aparece como "Na fila" (a mensagem dela já está na tela) e a linha da Faísca cobre a espera.
//
// Arquivos gerados pelo Python (phase 4, F10): os anexos das atividades `run_python` aparecem sob a resposta da execução, antes da barra de ações
// (`GeneratedFiles`; o lugar é decidido por `generatedFilesOf`).
//
// Artefatos da resposta (phase 14, passo 7; A4): sob a resposta, depois dos arquivos gerados e antes da barra de ações, uma LINHA por tabela ou doc que o bot criou ou alterou (phase 18, A13: ícone, tipo e título, sem moldura)
// (`ArtifactCards`; o lugar e o agrupamento por execução, tipo e id são de `artifactsOf`). A linha é um link para a conversa com `?artefato=`, que abre o painel (`ConversationView`
// monta o endereço, `artifactLinks` de `useArtifactPanel`, que também marca a linha do artefato aberto).
import type { Bot, CardView, ChooseVersionRequest, ComplementView, TextMessageView } from '@aion/shared';
import { ArrowDown, CalendarClock, CornerDownRight, LoaderCircle, RotateCcw } from 'lucide-react';
import { Fragment, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type Ref } from 'react';
import { toast } from 'sonner';
import { ArtifactCards, type ArtifactLinks } from '@/components/artifacts/artifact-card';
import { StatusBadge } from '@/components/settings/status-badge';
import { Button } from '@/components/ui/button';
import { Modal, ModalActions, ModalContent } from '@/components/ui/modal';
import { BotAvatar } from '@/components/bots/bot-avatar';
import { readableNameColor } from '@/components/bots/bot-display';
import { useGaze } from '@/components/mascot/use-gaze';
import { cn } from '@/lib/cn';
import { ActivityGroup } from './activity-block';
import { SystemCard } from './card-frame';
import { activeRunOf, compareIds, isBusy, queuedRunsOf, type ConversationState } from './conversation-state';
import { AttachmentList, GeneratedFiles } from './attachment-list';
import type { ConversationSource } from './conversation-api';
import { EditMessage } from './edit-message';
import { Markdown } from './markdown';
import { BLOCKED_HINT, MessageActions, type VersionSelector } from './message-actions';
import { OlderZone, type OlderPhase } from './older-zone';
import { SystemCardMessage } from './system-card';
import { answerBarsOf, artifactsOf, bareAnswerAnchorsOf, buildBlocks, generatedFilesOf, lastVisibleItem, workLinesOf } from './timeline';
import type { ActionResult, OlderResult } from './use-conversation';

/** Distância do fim, em px, até a qual o dono ainda "está no fim" (acompanha o streaming). */
const NEAR_BOTTOM_PX = 80;
/** Distância do topo, em px, abaixo da qual as rodadas anteriores são carregadas sozinhas (spec F4). */
const LOAD_TOP_PX = 200;
/** Páginas anteriores que o salto até uma mensagem antiga carrega, no máximo, antes de desistir (spec F4). */
const MAX_JUMP_PAGES = 100;
const HIGHLIGHT_MS = 2_000;

/**
 * Resumo do que está no fim da conversa: muda quando chega mensagem nova ou o texto da última cresce, mas não ao carregar antigas. Só
 * conta o que a tela mostra: o texto em escrita (escondido) cresce a cada pedaço e não pode acender a pílula "Novas mensagens".
 */
function tailSignature(state: ConversationState): string {
  const last = lastVisibleItem(state.items);
  const tail = last === undefined ? '' : `${last.id}:${last.status}:${last.kind === 'text' || last.kind === 'card' ? last.content.length : (last.result?.length ?? -1)}`;
  return `${tail}|${state.runs.map((run) => `${run.id}:${run.status}:${run.complements?.length ?? 0}`).join(',')}`;
}

/**
 * Controles de versão da mensagem do dono na sessão do Chat geral (phase 4, F1 e F4): o seletor, o estado de edição e o envio da versão nova.
 * Ausentes no bot e na mensagem lida como complemento (que não abre rodada própria).
 */
interface UserVersionControls {
  versions: VersionSelector | null;
  blocked: boolean;
  editing: boolean;
  setEditing: (editing: boolean) => void;
  /** Modelo efetivo da sessão (a visão dele decide as imagens da versão nova). */
  model: string | null;
  onSubmitEdit: (content: string, attachmentIds: string[]) => Promise<ActionResult>;
}

/**
 * Bolha do dono (caixas de anexo acima do texto) com a barra de ações à direita, abaixo dela; Copiar leva o texto como foi digitado. A mensagem lida
 * como complemento durante a execução (phase 4, F5) leva a legenda "complemento" acima, alinhada à direita (ícone decorativo). Na sessão do Chat
 * geral, Editar troca a bolha pela caixa de edição no lugar; ao fechá-la o foco volta ao botão Editar.
 */
function UserBubble({ message, highlighted, source, controls = null }: { message: TextMessageView; highlighted: boolean; source: ConversationSource; controls?: UserVersionControls | null }) {
  const editButton = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);
  const editing = controls?.editing ?? false;
  useEffect(() => {
    if (editing || !returnFocus.current) return;
    returnFocus.current = false;
    editButton.current?.focus();
  }, [editing]);
  if (controls && editing) {
    return (
      <EditMessage
        message={message}
        source={source}
        model={controls.model}
        onSubmit={controls.onSubmitEdit}
        onClose={() => {
          returnFocus.current = true;
          controls.setEditing(false);
        }}
      />
    );
  }
  return (
    <div className="message-group flex flex-col items-end">
      {message.complement ? (
        <p className="mb-1 flex items-center gap-1 text-xs text-muted">
          <CornerDownRight className="size-3.5" strokeWidth={1.5} aria-hidden />
          complemento
        </p>
      ) : null}
      <div
        id={`message-${message.id}`}
        className={cn(
          'max-w-[88%] whitespace-pre-wrap rounded-lg bg-surface grad-sheen px-4 py-2 text-[15px]/6 [overflow-wrap:anywhere] md:max-w-[80%]',
          highlighted && 'outline-2 outline-focus',
        )}
      >
        <AttachmentList files={message.attachments ?? []} source={source} />
        {message.content}
      </div>
      <MessageActions
        text={message.content}
        align="end"
        versions={controls?.versions}
        blocked={controls?.blocked}
        onEdit={controls ? () => controls.setEditing(true) : undefined}
        editRef={editButton}
      />
    </div>
  );
}

/**
 * Linha "N rodadas retrocedidas · Restaurar" (phase 4, F3; design "Linha rodadas retrocedidas"): último item da conversa depois de retroceder,
 * com linhas de 1 px dos dois lados que encolhem até zero em tela estreita. Bloqueada com execução aberta (mesma dica e toast da barra).
 */
function RewoundLine({ rounds, blocked, onRestore }: { rounds: number; blocked: boolean; onRestore: () => Promise<void> }) {
  const [restoring, setRestoring] = useState(false);
  return (
    <div className="flex animate-[card-in_150ms_var(--ease-out)] items-center gap-3 py-2" data-rewound="">
      <span aria-hidden className="h-px min-w-0 flex-1 bg-line" />
      <p className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-sm text-muted">
        <span>{rounds === 1 ? '1 rodada retrocedida' : `${rounds} rodadas retrocedidas`}</span>
        <Button
          variant="ghost"
          size="sm"
          aria-disabled={blocked || undefined}
          disabled={restoring}
          className={blocked ? 'opacity-50' : undefined}
          title={blocked ? BLOCKED_HINT : undefined}
          onClick={() => {
            if (blocked) {
              toast(BLOCKED_HINT);
              return;
            }
            setRestoring(true);
            void onRestore().finally(() => setRestoring(false));
          }}
        >
          {restoring ? <LoaderCircle data-icon="LoaderCircle" className="size-4 animate-spin motion-reduce:animate-none" strokeWidth={1.5} aria-hidden /> : <RotateCcw className="size-4" strokeWidth={1.5} aria-hidden />}
          Restaurar
        </Button>
      </p>
      <span aria-hidden className="h-px min-w-0 flex-1 bg-line" />
    </div>
  );
}

/** Texto do popup Retroceder (spec F3), no singular com uma rodada. */
const rewindDescription = (rounds: number): string =>
  `${rounds === 1 ? '1 rodada sai do contexto e continua recuperável' : `${rounds} rodadas saem do contexto e continuam recuperáveis`} pelas versões. Ações já executadas, como envios pelo Composio, não são desfeitas.`;

/**
 * Complemento ainda não lido (phase 4, F5; design "Complemento aguardando"): a mesma estrutura da bolha "Na fila", com o selo "Complemento ·
 * aguardando" e "Cancelar" (que devolve o texto e os anexos como rascunho). O selo e o botão quebram para baixo da bolha em tela estreita.
 */
function PendingComplement({ complement, source, onCancel }: { complement: ComplementView; source: ConversationSource; onCancel: (id: string) => Promise<void> }) {
  const [cancelling, setCancelling] = useState(false);
  return (
    <div className="ml-auto flex max-w-[88%] animate-[card-in_150ms_var(--ease-out)] flex-col items-end gap-1 md:max-w-[80%]" data-complement="pending">
      <div className="whitespace-pre-wrap rounded-lg bg-surface grad-sheen px-4 py-2 text-[15px]/6 [overflow-wrap:anywhere]"><AttachmentList files={complement.attachments} source={source} />{complement.content}</div>
      <div className="flex flex-wrap items-center justify-end gap-2">
        <StatusBadge tone="neutral">Complemento · aguardando</StatusBadge>
        <Button
          variant="ghost"
          size="sm"
          disabled={cancelling}
          onClick={() => {
            setCancelling(true);
            void onCancel(complement.id).finally(() => setCancelling(false));
          }}
        >
          {cancelling ? <LoaderCircle data-icon="LoaderCircle" className="size-4 animate-spin motion-reduce:animate-none" strokeWidth={1.5} aria-hidden /> : null}
          Cancelar
        </Button>
      </div>
    </div>
  );
}

/**
 * Faísca da conversa vazia (do bot, ou do Aion no Chat geral): 112 px (96 px abaixo de 768 px, por CSS, para o HTML não depender da largura da tela), a entrada
 * única e o olhar que segue o cursor (`useGaze`, desligado com movimento reduzido e em toque; sem cursor a Faísca ociosa olha à frente). O vetor sai do centro da
 * própria Faísca, por isso o `ref` está no invólucro dela e não na coluna toda. Decorativa: a pergunta logo abaixo é o texto da tela. É um componente à parte
 * para o hook existir só na conversa vazia.
 */
function EmptyFaisca({ bot }: { bot: Bot | null }) {
  const faiscaRef = useRef<HTMLDivElement>(null);
  const gaze = useGaze(faiscaRef);
  return (
    // Halo da Faísca de destaque (`faisca-halo`, `--grad-hero`) a 200 % do invólucro, e não os 260 % das telas de erro: a coluna rola por dentro e um halo maior desceria alguns
    // pixels abaixo do título, criando uma rolagem na conversa vazia. O `!` vence a largura da regra do halo (fora de @layer), como no Início.
    <div ref={faiscaRef} className="faisca-halo w-fit [&::before]:w-[200%]!">
      <BotAvatar owner={bot} size={112} state="idle" enter gaze={gaze} className="max-md:size-24" />
    </div>
  );
}

/** O que quem renderiza a lista pode pedir a ela. */
export interface ThreadHandle {
  /** Vai ao fim e volta a acompanhar o streaming (usado logo depois de o dono enviar uma mensagem). */
  scrollToBottom(): void;
}

/**
 * Comandos de versão da sessão do Chat geral (phase 4, F1 a F4), vindos de `useConversation`. O bot não os recebe (CONV-02): sem eles a lista não
 * mostra seletor, Editar, menu nem a linha "Restaurar".
 */
export interface VersionHandlers {
  edit: (messageId: string, content: string, attachmentIds: string[]) => Promise<ActionResult>;
  regenerate: (runId: string) => Promise<void>;
  rewind: (runId: string) => Promise<boolean>;
  restore: () => Promise<void>;
  choose: (target: ChooseVersionRequest) => Promise<boolean>;
}

export interface ThreadProps {
  /** Origem autenticada usada pelos links de conteúdo, igual à origem do snapshot. */
  source: ConversationSource;
  /** O bot dono da conversa; nulo na sessão do chat geral. */
  bot: Bot | null;
  state: ConversationState;
  onRetry: (runId: string, limitMessageId?: string) => void;
  /** "Cancelar" de um complemento pendente (phase 4, F5): devolve-o como rascunho. */
  onCancelComplement: (complementId: string) => Promise<void>;
  /** Carrega as rodadas anteriores às que a tela tem; quando resolve, a lista já está no DOM (ver `useConversation`). */
  loadOlder: () => Promise<OlderResult>;
  /** Mensagem a mostrar ao abrir a conversa (link "Ver na conversa" do histórico de uma rotina): rola até ela e a destaca. */
  focusMessageId?: string | null;
  /** Só na sessão do Chat geral: editar, gerar, retroceder, restaurar e trocar versões. */
  versions?: VersionHandlers | null;
  /** Como os cartões de artefato abrem o painel (phase 14, passo 7): o endereço, o artefato aberto e o clique. */
  artifactLinks: ArtifactLinks;
  ref?: Ref<ThreadHandle>;
}

/** Posição de uma versão no grupo (1..total) e o seletor que troca para a vizinha do mesmo grupo; nulo com uma versão só. */
function selectorOf(ids: readonly string[], current: string | null, group: string, onPick: (id: string, direction: -1 | 1) => void): VersionSelector | null {
  const index = current === null ? -1 : ids.indexOf(current);
  if (ids.length < 2 || index === -1) return null;
  return {
    position: index + 1,
    total: ids.length,
    group,
    onStep: (direction) => {
      const next = ids[index + direction];
      if (next !== undefined) onPick(next, direction);
    },
  };
}

export function Thread({ bot, state, onRetry, onCancelComplement, loadOlder, focusMessageId = null, versions = null, artifactLinks, ref, source }: ThreadProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const stuck = useRef(true);
  const [showPill, setShowPill] = useState(false);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  // Barra de ações no celular (phase 18, A16): só a última resposta a mostra; nas outras ela aparece ao tocar na resposta (uma por vez, `tappedBar` é a chave do bloco).
  // No desktop nada disso vale (a barra segue o hover e o foco). O toque num link, botão ou na própria barra não alterna.
  const [tappedBar, setTappedBar] = useState<string | null>(null);
  const toggleBar = (key: string) => (event: MouseEvent<HTMLElement>) => {
    if ((event.target as HTMLElement).closest('[data-message-actions], a, button')) return;
    setTappedBar((current) => (current === key ? null : key));
  };
  const [olderPhase, setOlderPhase] = useState<OlderPhase>('idle');
  /** Carga em curso: rolagem, botão e salto que pedem durante ela esperam a mesma, em vez de buscar a mesma página duas vezes. */
  const olderInFlight = useRef<Promise<OlderResult> | null>(null);
  /** A lista como ficou no último commit (primeira mensagem, se há mais para trás e altura da rolagem): base da compensação e do salto. */
  const viewed = useRef({ firstId: null as string | null, hasMore: false, height: 0 });

  const blocks = useMemo(() => buildBlocks(state.items), [state.items]);
  const answerBars = useMemo(() => answerBarsOf(blocks), [blocks]);
  // Linhas de trabalho (phase 18): uma por execução, no primeiro bloco de atividades dela; o bloco seguinte da mesma execução vale `null` e não desenha linha.
  const workLines = useMemo(() => workLinesOf(blocks, state.items), [blocks, state.items]);
  // Arquivos gerados pelo Python (phase 4, F10): sob a última bolha de texto da execução, ou sob as atividades dela quando não há texto.
  const generated = useMemo(() => generatedFilesOf(blocks), [blocks]);
  // Cartões de artefato (phase 14, A4): um por tabela ou doc criado ou alterado na resposta, no mesmo lugar dos arquivos gerados.
  const artifacts = useMemo(() => artifactsOf(blocks), [blocks]);
  /** Os cartões de artefato que ficam sob o bloco `key` (nada, se a resposta dele não criou nem alterou artefato). */
  const artifactCardsOf = (key: string) => {
    const refs = artifacts.get(key);
    return refs ? <ArtifactCards artifacts={refs} links={artifactLinks} /> : null;
  };
  const active = activeRunOf(state);
  const signature = tailSignature(state);

  // Versões (só na sessão do Chat geral): a rodada de cada mensagem e de cada resposta do caminho, com a posição dela.
  const rounds = useMemo(() => (versions ? (state.rounds ?? []) : []), [versions, state.rounds]);
  const byMessage = useMemo(() => new Map(rounds.map((round, index) => [round.messageId, { round, index }])), [rounds]);
  const byRun = useMemo(() => new Map(rounds.flatMap((round, index) => (round.runId === null ? [] : [[round.runId, { round, index }] as const]))), [rounds]);
  // Resposta sem texto ganha a barra só depois de terminar: durante a execução (uma aprovação pendente, por exemplo) ela ainda não é uma versão pronta.
  const bareAnchors = useMemo(() => bareAnswerAnchorsOf(blocks, new Set([...byRun.keys()].filter((runId) => !state.runs.some((run) => run.id === runId)))), [blocks, byRun, state.runs]);
  const blocked = isBusy(state);
  // A execução de uma versão nova (edição, outra resposta) já está no caminho com a mensagem na tela: não vira bolha "Na fila".
  const queued = queuedRunsOf(state).filter((run) => !byRun.has(run.id));
  /** Mensagem do dono em edição (uma por vez). */
  const [editingId, setEditingId] = useState<string | null>(null);
  /** Popup Retroceder: aberto, a resposta e quantas rodadas saem (guardados enquanto o popup fecha, para o texto não mudar na saída). */
  const [rewindOpen, setRewindOpen] = useState(false);
  const [rewindTarget, setRewindTarget] = useState<{ runId: string; rounds: number } | null>(null);
  const [rewinding, setRewinding] = useState(false);
  // ponytail: a troca de versão substitui o estado pelo snapshot novo e, se o dono não estava no fim, a pílula "Novas mensagens" pode acender
  // sem novidade real; separar releitura de caminho de mensagem nova em `tailSignature` se isso incomodar no uso.
  /**
   * Última troca de versão: o anúncio "Versão k de n" e o seletor que recebe o foco. Gravada depois de o snapshot novo ser aplicado (a troca devolve
   * o caminho na resposta), então o efeito abaixo já encontra a lista nova na tela.
   */
  const [picked, setPicked] = useState<{ group: string; step: 'prev' | 'next'; announcement: string } | null>(null);

  /** Troca de versão pelo seletor: anuncia a posição nova e devolve o foco ao mesmo lado do seletor (ou ao outro, se este virou ponta). */
  const pickVersion = useCallback(
    async (target: ChooseVersionRequest, ids: readonly string[], id: string, group: string, direction: -1 | 1) => {
      if (!versions || !(await versions.choose(target))) return;
      setPicked({ group, step: direction === -1 ? 'prev' : 'next', announcement: `Versão ${ids.indexOf(id) + 1} de ${ids.length}` });
    },
    [versions],
  );
  useEffect(() => {
    if (picked === null) return;
    const selector = document.querySelector(`[data-version-group="${picked.group}"]`);
    const wanted = selector?.querySelector<HTMLButtonElement>(`[data-version-step="${picked.step}"]`);
    const other = selector?.querySelector<HTMLButtonElement>(`[data-version-step="${picked.step === 'prev' ? 'next' : 'prev'}"]`);
    (wanted && !wanted.disabled ? wanted : other)?.focus();
  }, [picked]);

  /** Controles da resposta `runId` do caminho (Chat geral): o seletor das versões dela, o menu "Mais ações" e o bloqueio. */
  const answerControls = (runId: string | null) => {
    const found = runId === null ? undefined : byRun.get(runId);
    if (!found || !versions) return {};
    const { round, index } = found;
    const answer = round.runId as string;
    const after = rounds.length - index - 1;
    const group = `run-${round.runVersions[0]}`;
    return {
      blocked,
      versions: selectorOf(round.runVersions, answer, group, (id, direction) => void pickVersion({ runId: id }, round.runVersions, id, group, direction)),
      more: {
        onRegenerate: () => void versions.regenerate(answer),
        onRewind:
          after > 0
            ? () => {
                setRewindTarget({ runId: answer, rounds: after });
                setRewindOpen(true);
              }
            : null,
      },
    };
  };

  /** Confirma o retrocesso: o popup fecha com sucesso ou falha (a falha vira toast em `useConversation`). */
  async function confirmRewind() {
    if (!versions || rewindTarget === null) return;
    setRewinding(true);
    await versions.rewind(rewindTarget.runId);
    setRewinding(false);
    setRewindOpen(false);
  }

  const scrollToBottom = useCallback(() => {
    const element = scrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
    stuck.current = true;
    setShowPill(false);
  }, []);

  // O que chegou no fim: acompanha se o dono estava no fim; senão, avisa pela pílula. A primeira carga sempre vai ao fim.
  const seen = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (seen.current === null || stuck.current) scrollToBottom();
    else if (seen.current !== signature) setShowPill(true);
    seen.current = signature;
  }, [signature, scrollToBottom]);

  // Quem enviou a mensagem pede para ir ao fim (mesmo que estivesse lendo mais acima): marca "no fim" e o efeito acima rola
  // quando a bolha nova for desenhada.
  useImperativeHandle(ref, () => ({ scrollToBottom }), [scrollToBottom]);

  /**
   * Carrega as rodadas anteriores e reflete na faixa do topo (carregando, de volta ao normal ou erro). Quem pede durante uma carga em curso
   * recebe a mesma promessa. Só uma falha deixa a faixa em "erro" (a rolagem para de tentar sozinha até "Tentar novamente").
   */
  const loadPrevious = useCallback((): Promise<OlderResult> => {
    if (olderInFlight.current !== null) return olderInFlight.current;
    setOlderPhase('loading');
    const request = loadOlder().then((result) => {
      olderInFlight.current = null;
      setOlderPhase(result.ok ? 'idle' : 'error');
      return result;
    });
    olderInFlight.current = request;
    return request;
  }, [loadOlder]);

  // Carga automática: com o topo a menos de LOAD_TOP_PX, há mais para trás e nada em curso nem em erro. O efeito abaixo cobre quando a
  // conversa não enche a tela (não há rolagem para disparar o evento) e quando uma página nova ainda deixou o topo por perto.
  const hasMore = state.hasMore;
  const loadIfNearTop = useCallback(() => {
    const element = scrollRef.current;
    if (element !== null && hasMore && olderPhase === 'idle' && element.scrollTop < LOAD_TOP_PX) void loadPrevious();
  }, [hasMore, olderPhase, loadPrevious]);
  useEffect(() => {
    loadIfNearTop();
  }, [loadIfNearTop, state.items]);

  function handleScroll() {
    const element = scrollRef.current;
    if (!element) return;
    stuck.current = element.scrollHeight - element.scrollTop - element.clientHeight < NEAR_BOTTOM_PX;
    if (stuck.current) setShowPill(false);
    loadIfNearTop();
  }

  // Carregar mensagens antigas insere linhas ACIMA do que o dono lê: sem compensar, a tela saltaria para o começo da página nova. O que entrou
  // acima é a diferença de altura da lista entre este commit e o anterior (`viewed`, atualizado em todo commit, para outras mudanças de altura,
  // como a linha da Faísca, não entrarem na conta).
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const firstId = state.items[0]?.id ?? null;
    const before = viewed.current;
    if (before.firstId !== null && firstId !== null && compareIds(firstId, before.firstId) < 0) element.scrollTop += element.scrollHeight - before.height;
    viewed.current = { firstId, hasMore, height: element.scrollHeight };
  });

  /**
   * "ver na conversa": carrega páginas anteriores (até MAX_JUMP_PAGES) até a mensagem aparecer, rola até ela e a destaca por 2 s. Para antes
   * quando ela não está mais para trás: os ids crescem com o tempo, então se a mais antiga carregada já não é mais nova que o alvo e ele não
   * está na tela, ele não existe nesta conversa; sem mais páginas ou com a falha de uma carga, também desiste (e avisa).
   */
  const jumpTo = useCallback(
    async (messageId: string) => {
      const target = () => document.getElementById(`message-${messageId}`);
      for (let pages = 0; target() === null; pages += 1) {
        const { firstId, hasMore: older } = viewed.current;
        if (!older || firstId === null || compareIds(firstId, messageId) <= 0 || pages >= MAX_JUMP_PAGES) {
          toast.error('Mensagem não encontrada');
          return;
        }
        const result = await loadPrevious();
        if (!result.ok) {
          toast.error(result.message, { duration: Infinity });
          return;
        }
      }
      target()?.scrollIntoView({ block: 'center' });
      stuck.current = false;
      setHighlightId(messageId);
    },
    [loadPrevious],
  );

  // Abrir a conversa já apontando para uma mensagem (histórico da rotina, e depois Atividades): vai até ela uma vez por pedido.
  const jumpedTo = useRef<string | null>(null);
  useEffect(() => {
    if (focusMessageId === null || jumpedTo.current === focusMessageId) return;
    jumpedTo.current = focusMessageId;
    void jumpTo(focusMessageId);
  }, [focusMessageId, jumpTo]);
  useEffect(() => {
    if (highlightId === null) return;
    const timer = setTimeout(() => setHighlightId(null), HIGHLIGHT_MS);
    return () => clearTimeout(timer);
  }, [highlightId]);

  // "Tentar novamente" só aparece na falha que é o ÚLTIMO item da conversa e com o bot livre: depois de uma repetição (ou de
  // qualquer mensagem nova) a falha antiga deixa de ser candidata, como a API também recusa.
  const lastBlock = blocks.at(-1);
  const retryableId = lastBlock?.type === 'card' && (lastBlock.message.card.type === 'run_failed' || lastBlock.message.card.type === 'run_limit' && lastBlock.message.card.limit === 'tokens' && !lastBlock.message.card.continuation?.automatic) && state.runs.length === 0 ? lastBlock.key : null;

  const empty = state.items.length === 0 && state.runs.length === 0;

  // Rolagem única da conversa: o log (`.thread-scroll`) é o ÚNICO contêiner que rola. Ele é `relative` para ser o bloco de referência dos elementos
  // absolutos das mensagens (os `sr-only` das ações, por exemplo); sem isso eles se ancoravam no `.thread-pane`, escapavam do recorte do log e esticavam
  // o <main> do shell, que ganhava uma segunda barra de rolagem sem função. O botão "Novas mensagens" fica no `.thread-pane`, fora do log, e não rola junto.
  return (
    <div className="thread-pane relative min-h-0 flex-1" style={{ '--bot': bot ? bot.color : 'var(--border-strong)' } as React.CSSProperties}>
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        role="log"
        aria-label="Conversa"
        aria-live="off"
        tabIndex={0}
        className="thread-scroll relative h-full overflow-y-auto overscroll-contain px-3 [overflow-anchor:none] md:px-6"
      >
        {empty ? (
          <div className="flex h-full flex-col items-center justify-center gap-4 pb-8 text-center">
            <EmptyFaisca bot={bot} />
            <h2 className="max-w-[760px] text-[28px]/9 font-semibold text-fg [overflow-wrap:anywhere]">
              {bot ? (
                <>
                  O que o <span style={{ color: readableNameColor(bot.color) }}>{bot.name}</span> faz agora?
                </>
              ) : (
                'No que posso ajudar?'
              )}
            </h2>
          </div>
        ) : (
          <div className="mx-auto flex w-full max-w-[760px] flex-col gap-4 pb-8 pt-4">
            <OlderZone
              hasMore={state.hasMore}
              phase={olderPhase}
              onLoad={() => {
                // O botão some enquanto carrega: o foco vai para a lista (que rola com as setas), em vez de se perder no documento.
                scrollRef.current?.focus({ preventScroll: true });
                void loadPrevious();
              }}
            />

            {blocks.map((block) => {
              switch (block.type) {
                case 'user': {
                  // A chave da rodada (a primeira versão do grupo) mantém a bolha montada ao trocar de versão ou editar, e o foco não se perde.
                  const found = versions ? byMessage.get(block.key) : undefined;
                  const group = found ? `msg-${found.round.messageVersions[0]}` : null;
                  return (
                    <UserBubble
                      source={source}
                      key={group ?? block.key}
                      message={block.message}
                      highlighted={highlightId === block.key}
                      controls={
                        found && versions && group
                          ? {
                              blocked,
                              model: state.model.model,
                              editing: editingId === block.key,
                              setEditing: (open) => setEditingId(open ? block.key : null),
                              onSubmitEdit: (content, attachmentIds) => versions.edit(block.key, content, attachmentIds),
                              versions: selectorOf(found.round.messageVersions, found.round.messageId, group, (id, direction) =>
                                void pickVersion({ messageId: id }, found.round.messageVersions, id, group, direction),
                              ),
                            }
                          : null
                      }
                    />
                  );
                }
                case 'assistant':
                  return (
                    // Resposta do bot (UI-07): texto direto na coluna central, sem balão, sem borda e sem a Faísca ao lado; só a mensagem do dono é balão.
                    <div key={block.key} className="message-group" onClick={toggleBar(block.key)}>
                      <div id={`message-${block.key}`} className={cn('w-full max-w-full rounded-md', highlightId === block.key && 'outline-2 outline-focus')}>
                        <Markdown>{block.message.content}</Markdown>
                        {block.message.incomplete ? <p className="mt-2 text-sm text-muted">Resposta incompleta: limite de saída atingido.</p> : null}
                      </div>
                      <GeneratedFiles files={generated.get(block.key) ?? []} source={source} />
                      {artifactCardsOf(block.key)}
                      {answerBars.withBar.has(block.key) ? (
                        <MessageActions
                          text={block.message.content}
                          align="start"
                          model={block.message.model}
                          pinned={answerBars.pinned === block.key}
                          open={tappedBar === block.key}
                          {...answerControls(block.message.runId)}
                        />
                        ) : null}
                    </div>
                  );
                case 'activities': {
                  const workLine = workLines.get(block.key);
                  const group = workLine ? <ActivityGroup line={workLine} bot={bot} live={active !== null && block.activities[0]?.runId === active.id} onJump={(id) => void jumpTo(id)} /> : null;
                  return (
                    <Fragment key={block.key}>
                      {bareAnchors.has(block.key) ? (
                        // Resposta só de atividades numa rodada da sessão: a barra (seletor e menu) fica logo abaixo delas.
                        <div className="message-group" onClick={toggleBar(block.key)}>
                          {group}
                          <GeneratedFiles files={generated.get(block.key) ?? []} source={source} />
                          {artifactCardsOf(block.key)}
                          <MessageActions align="start" pinned={lastBlock?.key === block.key} open={tappedBar === block.key} {...answerControls(bareAnchors.get(block.key) ?? null)} />
                        </div>
                      ) : (
                        <>
                          {group}
                          <GeneratedFiles files={generated.get(block.key) ?? []} source={source} />
                          {artifactCardsOf(block.key)}
                        </>
                      )}
                    </Fragment>
                  );
                }
                case 'card': {
                  const cardBody = (
                    <SystemCardMessage
                      message={block.message as CardView}
                      bot={bot}
                      objectiveVersion={state.objective?.version}
                      onRetry={block.key === retryableId && block.message.runId !== null ? () => onRetry(block.message.runId as string, block.message.card.type === 'run_limit' ? block.message.id : undefined) : undefined}
                    />
                  );
                  const cardClass = cn('rounded-md', highlightId === block.key && 'outline-2 outline-focus');
                  // Resposta sem texto (falha, parada) de uma rodada da sessão: a barra abaixo do cartão mantém o seletor e o menu ao alcance.
                  return bareAnchors.has(block.key) ? (
                    <div key={block.key} className="message-group" onClick={toggleBar(block.key)}>
                      <div id={`message-${block.key}`} className={cardClass}>
                        {cardBody}
                      </div>
                      <MessageActions align="start" pinned={lastBlock?.key === block.key} open={tappedBar === block.key} {...answerControls(bareAnchors.get(block.key) ?? null)} />
                    </div>
                  ) : (
                    <div key={block.key} id={`message-${block.key}`} className={cardClass}>
                      {cardBody}
                    </div>
                  );
                }
              }
            })}

            {/* Complementos ainda não lidos: depois das atividades em curso, antes da fila. A linha da Faísca ("Trabalhando…") não está na lista: fica fixa acima do composer (`WorkingLine`). */}
            {(active?.complements ?? []).map((complement) => (
              <PendingComplement key={`complement-${complement.id}`} complement={complement} source={source} onCancel={onCancelComplement} />
            ))}

            {queued.map((run, index) =>
              run.routineName !== null ? (
                // Execução de rotina esperando a vez: não é uma mensagem do dono, então aparece como cartão e não como bolha.
                <SystemCard key={run.id} icon={CalendarClock} title={`Rotina “${run.routineName}”`} actions={<StatusBadge tone="neutral">Na fila</StatusBadge>}>
                  <p className="text-muted">Aguardando a vez do bot.</p>
                </SystemCard>
              ) : (
                <div key={run.id} className="ml-auto flex max-w-[88%] flex-col items-end gap-1 md:max-w-[80%]">
                  <div className="whitespace-pre-wrap rounded-lg bg-surface grad-sheen px-4 py-2 text-[15px]/6 [overflow-wrap:anywhere]"><AttachmentList files={run.attachments ?? []} source={source} />{run.input}</div>
                  {active !== null || index > 0 ? <StatusBadge tone="neutral">Na fila</StatusBadge> : null}
                </div>
              ),
            )}

            {/* Depois de retroceder (F3): some quando uma mensagem nova entra na fila, porque ela vira versão e o seletor cumpre o papel. */}
            {versions && state.rewound && state.runs.length === 0 ? <RewoundLine rounds={state.rewound.rounds} blocked={blocked} onRestore={versions.restore} /> : null}
          </div>
        )}
      </div>

      {/* Fora da lista (que não anuncia sozinha): a posição nova depois de trocar de versão, já que o seletor pode ter sido recriado. */}
      {versions ? (
        <p role="status" className="sr-only">
          {picked?.announcement}
        </p>
      ) : null}

      {versions ? (
        <Modal open={rewindOpen} onOpenChange={(open) => (rewinding ? undefined : setRewindOpen(open))}>
          <ModalContent title="Retroceder até esta resposta?" description={rewindDescription(rewindTarget?.rounds ?? 1)}>
            <ModalActions className="max-md:flex-col">
              <Button variant="secondary" disabled={rewinding} onClick={() => setRewindOpen(false)}>
                Cancelar
              </Button>
              <Button variant="primary" disabled={rewinding} onClick={() => void confirmRewind()}>
                {rewinding ? <LoaderCircle data-icon="LoaderCircle" className="size-4 animate-spin motion-reduce:animate-none" strokeWidth={1.5} aria-hidden /> : null}
                Retroceder
              </Button>
            </ModalActions>
          </ModalContent>
        </Modal>
      ) : null}

      {showPill ? (
        <button
          type="button"
          onClick={scrollToBottom}
          className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-line-strong bg-surface grad-sheen px-3 py-1.5 text-sm font-medium text-fg shadow-float"
        >
          Novas mensagens
          <ArrowDown className="size-4" strokeWidth={1.5} aria-hidden />
        </button>
      ) : null}
    </div>
  );
}
