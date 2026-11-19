'use client';

// Tela da conversa (F6, F7; design "Conversa do bot" e "Chat geral", a mesma conversa): cabeçalho com a Faísca (a do bot no estado ao vivo ou, no Chat geral,
// a do Aion em `--faisca`), o nome e o selo de estado da execução, a lista de mensagens (`Thread`) e o composer. Com o bot arquivado, o composer dá lugar à faixa "Bot arquivado"
// (recebida como `footer`). Sem provedor, o composer fica desabilitado e uma faixa orienta a configurar (F3).
//
// Dono da conversa (`ConversationOwner`): um bot (marcador e nome coloridos, atalhos para artefatos, arquivos, memória e edição do bot) ou uma
// sessão do chat geral (a Faísca do Aion, o título e as ações que o chamador entrega, como o "Salvar"; se a sessão deixou de existir,
// o chamador entrega a tela de "expirou"). O restante é igual.
//
// Cabeçalho (phase 5, T6; spec F5, Suposição 6): a partir de 768 px é o de sempre (Faísca, nome, selo de execução e as ações como ícones). No celular a conversa não tem barra
// inferior: o cabeçalho começa com o "Voltar" para o pai fixo (`BackLink`: Início no bot, Chats na sessão), mostra o nome com uma SEGUNDA LINHA de estado (o selo da execução, ou o
// texto de estado do bot na lista) e reúne as ações num menu "Mais ações" (ícone mais texto). É o mesmo DOM nos dois tamanhos: o estado é um elemento só (muda de lugar por CSS), e as
// ações do desktop e o menu do celular se escondem por CSS no outro tamanho.
//
// O estado vive em `useConversation` (snapshot + SSE); esta tela só decide o que mostrar em cada estado: carregando, erro, vazio,
// na fila, trabalhando, sem provedor, arquivado.
//
// Painel do artefato (phase 14, passo 7; UI-04, A5 e A6): o doc ou a tabela que o dono abre pelo cartão da resposta aparece num painel ao lado da conversa (conversa com 56 rem ou mais)
// ou em tela cheia sobre ela (conversa estreita e celular). O artefato aberto vive na URL (`?artefato=<tipo>:<id>`, contrato em `artifacts/artifact-card.tsx`), então Voltar do navegador
// fecha o painel e o link abre direto; `useArtifactPanel` (`artifacts/artifact-panel.tsx`) lê o parâmetro, monta o painel e decide o endereço dos cartões, e esta tela o encaixa ao lado da coluna. A raiz é a container query `conversation` (o painel decide a largura
// pela da conversa, não pela da janela) e a conversa fica `invisible` sob o painel de tela cheia: sai do foco e da leitura sem perder a posição da rolagem.
//
// Versões (phase 4, F1 a F4): só a sessão do Chat geral entrega os comandos de versão à lista; o bot é linear (CONV-02). `?versao=outra` é o link de
// Atividades para uma execução fora do caminho ativo (Suposição 12): a sessão abre no caminho atual e um toast avisa que a atividade está em outra
// versão, em vez de procurar uma mensagem que a tela não mostra.
import { mascotStateOfRunStatus, type ActivityView, type Bot } from '@aion/shared';
import { Brain, EllipsisVertical, Paperclip, Shapes, SlidersHorizontal } from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { toast } from 'sonner';
import { useArtifactPanel } from '@/components/artifacts/artifact-panel';
import { BotAvatar } from '@/components/bots/bot-avatar';
import { liveStateLine, readableNameColor } from '@/components/bots/bot-display';
import { BotLoadError, BotLoading, BotNotFound } from '@/components/bots/bot-states';
import { useLiveBots } from '@/components/bots/bots-store';
import { NEW_SESSION_TITLE } from '@/components/chat/chat-state';
import { BackLink } from '@/components/shell/back-link';
import { Button } from '@/components/ui/button';
import { Menu, MenuContent, MenuItem, MenuTrigger } from '@/components/ui/menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/cn';
import { ObjectiveInvitation } from './objective';
import { Composer } from './composer';
import { ContextPanel } from './context-panel';
import { activeRunOf } from './conversation-state';
import { isWorking } from './timeline';
import { WorkingLine } from './working-line';
import { DEFAULT_MODEL_REASON, PROVIDER_REASON, SetupBanner } from './setup-banner';
import { Thread, type ThreadHandle, type VersionHandlers } from './thread';
import { useConversation } from './use-conversation';

/** Selo de estado do cabeçalho (neutro: o azul é só da Faísca, de links, do foco e da bolinha): "Trabalhando" com o ponto pulsante (desligado em reduced motion) ou "Aguardando aprovação". `className` posiciona o selo no cabeçalho. */
function RunBadge({ status, className }: { status: 'running' | 'waiting_approval'; className?: string }) {
  const running = status === 'running';
  return (
    <span
      role="status"
      className={cn('flex shrink-0 items-center gap-1.5 rounded-sm px-1.5 py-0.5 text-xs font-medium', running ? 'bg-surface-hover text-muted' : 'bg-warning-soft text-warning', className)}
    >
      {running ? <span aria-hidden className="size-1.5 animate-[pulse-dot_1.2s_linear_infinite] rounded-full bg-muted" /> : null}
      {running ? 'Trabalhando' : 'Aguardando aprovação'}
    </span>
  );
}

/**
 * Estado ao vivo do bot no cabeçalho: o MESMO `runState` da lista de bots, lido do store compartilhado, que se atualiza sozinho e na hora em que uma
 * execução muda de estado (`useConversation` pede a releitura a cada evento de execução), e o texto desse estado (`liveStateLine`, o mesmo da lista). Enquanto
 * a lista não chegou, vale o que o bot já diz de si (arquivado dorme, senão livre).
 */
function useBotHeaderState(bot: Bot) {
  const { bots } = useLiveBots();
  const item = bots.find((candidate) => candidate.id === bot.id);
  const archivedAt = item?.archivedAt ?? bot.archivedAt;
  const runState = item?.runState ?? (archivedAt !== null ? 'sleep' : 'idle');
  return { runState, line: liveStateLine({ runState, archivedAt }) };
}

/**
 * Faísca do cabeçalho de um bot (32 px, nível liso), no estado ao vivo (`useBotHeaderState`). Decorativa: o estado sempre é dito em texto (o selo de
 * execução ou `BotHeaderStateText`). Não fica parada (`still`): o cabeçalho é o foco da tela, então trabalhando e aguardando se mexem, e os demais estados
 * ficam quietos sozinhos (só `working` e `waiting` rodam laços).
 */
function BotHeaderAvatar({ bot }: { bot: Bot }) {
  const { runState } = useBotHeaderState(bot);
  return <BotAvatar owner={bot} size={32} state={runState} />;
}

/**
 * O estado do bot em texto, quando a execução não está ativa (concluído, erro, dormindo e livre; com a execução ativa o selo "Trabalhando" ou "Aguardando aprovação" já o diz):
 * a Faísca é decorativa e nunca é o único portador de um estado. No celular é a SEGUNDA LINHA do cabeçalho, visível, sob o nome e na cor do estado; a partir de 768 px é texto só
 * para leitor de tela (`sr-only`), como sempre foi. É estático, sem região ao vivo, de propósito: a releitura de 5 ou 15 s reaplica o mesmo texto e um `aria-live` o reanunciaria a cada
 * ciclo; quem navega pelo cabeçalho o lê. O texto é o da lista de bots.
 */
function BotHeaderStateText({ bot }: { bot: Bot }) {
  const { line } = useBotHeaderState(bot);
  return <p className={cn('whitespace-nowrap text-xs/4 md:sr-only', line.className)}>{line.text}</p>;
}

/** Toast do link de Atividades para uma execução fora do caminho ativo da sessão (spec Suposição 12). */
export const OFF_PATH_NOTICE = 'Esta atividade está em outra versão da conversa.';

/**
 * Atalhos do cabeçalho do bot (desktop) para artefatos, arquivos, memória e configurações, inclusive quando arquivado. No celular o mesmo conjunto vive em `BotMoreActions`. "Artefatos"
 * (phase 14, A3) é a área que lista tabelas e docs, no lugar do antigo "Tabelas do bot"; leva à lista de todos, onde o filtro por bot recorta os deste. Exportado só para a prova
 * (`artifact-list.test.tsx`) conferir o atalho sem montar a conversa inteira.
 */
export function BotHeaderActions({ botId }: { botId: string }) {
  return (
    <div className="flex items-center gap-3 max-md:hidden">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button asChild variant="ghost" size="icon">
            <Link href="/artefatos" aria-label="Artefatos">
              <Shapes className="size-4" strokeWidth={1.5} aria-hidden />
            </Link>
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">Artefatos</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button asChild variant="ghost" size="icon">
            <Link href={`/bots/${botId}/arquivos`} aria-label="Arquivos do bot">
              <Paperclip className="size-4" strokeWidth={1.5} aria-hidden />
            </Link>
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">Arquivos do bot</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button asChild variant="ghost" size="icon">
            <Link href={`/bots/${botId}/memoria`} aria-label="Memória do bot">
              <Brain className="size-4" strokeWidth={1.5} aria-hidden />
            </Link>
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">Memória do bot</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button asChild variant="ghost" size="icon">
            <Link href={`/bots/${botId}/editar`} aria-label="Configurações do bot">
              <SlidersHorizontal className="size-4" strokeWidth={1.5} aria-hidden />
            </Link>
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">Configurações do bot</TooltipContent>
      </Tooltip>
    </div>
  );
}

/**
 * Menu "Mais ações" do cabeçalho no celular (só abaixo de 768 px): gatilho de ícone com nome acessível e alvo de 40 px, itens com ícone e texto (menu do kit). `children` são os
 * `MenuItem` da conversa: os do bot (`BotMoreActions`) ou os da sessão (entregues pelo chamador).
 */
function MoreActionsMenu({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Menu>
      <MenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={label} className="shrink-0 md:hidden">
          <EllipsisVertical className="size-[18px]" strokeWidth={1.5} aria-hidden />
        </Button>
      </MenuTrigger>
      <MenuContent>{children}</MenuContent>
    </Menu>
  );
}

/**
 * "Mais ações do bot" (celular): Artefatos, Arquivos, Memória e Editar bot, as mesmas portas dos ícones do desktop. O rótulo é "Editar bot" (não "Configurações", que colidiria com as
 * Configurações do app). Vale também com o bot arquivado, como os ícones.
 */
function BotMoreActions({ botId }: { botId: string }) {
  return (
    <MoreActionsMenu label="Mais ações do bot">
      <MenuItem asChild><Link href="/artefatos"><Shapes className="size-4" strokeWidth={1.5} aria-hidden />Artefatos</Link></MenuItem>
      <MenuItem asChild>
        <Link href={`/bots/${botId}/arquivos`}>
          <Paperclip className="size-4" strokeWidth={1.5} aria-hidden />
          Arquivos
        </Link>
      </MenuItem>
      <MenuItem asChild>
        <Link href={`/bots/${botId}/memoria`}>
          <Brain className="size-4" strokeWidth={1.5} aria-hidden />
          Memória
        </Link>
      </MenuItem>
      <MenuItem asChild>
        <Link href={`/bots/${botId}/editar`}>
          <SlidersHorizontal className="size-4" strokeWidth={1.5} aria-hidden />
          Editar bot
        </Link>
      </MenuItem>
    </MoreActionsMenu>
  );
}

/**
 * De quem é a conversa mostrada: um bot, ou uma sessão do chat geral (com o título, as ações do cabeçalho e a tela de sessão expirada). `actions` são as ações do desktop (botões
 * no cabeçalho) e `menuActions` as mesmas no menu "Mais ações" do celular (`MenuItem`s; `null` quando ainda não há o que oferecer, e o menu não aparece).
 */
export type ConversationOwner =
  | { kind: 'bot'; bot: Bot }
  | { kind: 'session'; sessionId: string; title: string | null; actions: ReactNode; menuActions: ReactNode; expired: ReactNode };

/**
 * Raiz da conversa (phase 14, passo 7): a container query `conversation` (de que o painel do artefato depende para decidir ao lado x tela cheia), a coluna da conversa (`column`: o
 * fundo do bot e, com o painel de tela cheia aberto, `invisible`) e, ao lado dela, o `panel` do artefato.
 */
function ConversationFrame({ column, panel, children }: { column: { className: string; style?: CSSProperties }; panel: ReactNode; children: ReactNode }) {
  return (
    <div className="@container/conversation relative flex h-full min-h-0">
      <div className={column.className} style={column.style}>
        {children}
      </div>
      {panel}
    </div>
  );
}

/** Apresenta a conversa compartilhada e mantém identidade, estado e atalhos do bot legíveis durante a execução. */
export function ConversationView({ owner, footer, onSent }: { owner: ConversationOwner; footer: ReactNode | null; onSent?: () => void }) {
  const bot = owner.kind === 'bot' ? owner.bot : null;
  const session = owner.kind === 'session' ? owner : null;
  const { load, retry, send, stop, stopRequested, retryFailed, setModel, setContext, loadOlder, cancelComplement, takeDraft, edit, regenerate, rewind, restore, choose } =
    useConversation(owner.kind, owner.kind === 'bot' ? owner.bot.id : owner.sessionId);
  const isSession = session !== null;
  const versions = useMemo<VersionHandlers | null>(() => (isSession ? { edit, regenerate, rewind, restore, choose } : null), [isSession, edit, regenerate, rewind, restore, choose]);
  const thread = useRef<ThreadHandle>(null);
  const [objectiveSent, setObjectiveSent] = useState(false);
  // `?mensagem=<id>` abre a conversa já apontando para aquela mensagem (histórico da rotina, Atividades, push). Só aceita o formato de id.
  const searchParams = useSearchParams();
  const focusParam = searchParams.get('mensagem');
  const focusMessageId = focusParam !== null && /^\d{1,18}$/.test(focusParam) ? focusParam : null;
  // `?versao=outra` (Atividades, execução fora do caminho ativo): avisa uma vez por sessão aberta, quando a conversa já está na tela.
  const offPath = isSession && searchParams.get('versao') === 'outra';
  const ready = load.status === 'ready';
  const warnedOffPath = useRef(false);
  useEffect(() => {
    if (!offPath || !ready || warnedOffPath.current) return;
    warnedOffPath.current = true;
    toast(OFF_PATH_NOTICE);
  }, [offPath, ready]);

  // Painel do artefato (phase 14, passo 7): o `?artefato=` da URL decide o que está aberto; o hook entrega o painel, o endereço dos cartões e o que fazer ao clicar neles.
  const artifactPanel = useArtifactPanel();
  const active = load.status === 'ready' ? activeRunOf(load.state) : null;
  // Título da sessão quando a lista ainda não o traz: conversa vazia é o "Novo chat" (rascunho); com mensagens, o nome neutro da seção. Assim uma
  // sessão que a lista não conhece (além das 200 mais recentes, ou criada em outra aba) nunca se passa por chat novo.
  // O que impede de conversar, na ordem em que se resolve: sem provedor não há modelo para escolher; no Chat geral o modelo padrão é obrigatório
  // (T23), então uma sessão sem modelo (nem padrão, nem preferência própria) fica bloqueada até o dono defini-lo em Configurações.
  const blocker =
    load.status !== 'ready' ? null : !load.state.providerConfigured ? 'provider' : session !== null && load.state.model.model === null ? 'default-model' : null;
  const sessionTitle = session ? (session.title ?? (load.status === 'ready' && load.state.items.length === 0 ? NEW_SESSION_TITLE : 'Chat geral')) : undefined;

  // A sessão já foi apagada (retenção de 7 dias) ou nunca existiu: a tela de "expirou" substitui a conversa inteira.
  if (session && load.status === 'not-found') return session.expired;

  return (
    // Fundo da conversa (phase 5, T8): a de um bot leva só o fundo opaco liso de `bot-glow` (UI-06: sem brilho na cor dele, que fica no avatar e no nome); a do Chat geral fica
    // transparente e mostra o fundo liso da página.
    <ConversationFrame
      column={{ className: cn('flex h-full min-h-0 min-w-0 flex-1 flex-col', bot && 'bot-glow', artifactPanel.open && '@max-4xl/conversation:invisible'), style: bot ? ({ '--bot': bot.color } as CSSProperties) : undefined }}
      panel={artifactPanel.element}
    >
      <header className="flex min-h-[52px] shrink-0 items-center gap-2 px-4 max-md:py-1.5 md:h-[52px] md:gap-3 md:px-6">
        <BackLink />
        {bot ? (
          <BotHeaderAvatar bot={bot} />
        ) : (
          // O Chat geral não tem estado de bot na lista: a Faísca do Aion segue a execução ativa da própria sessão (e o selo ao lado a diz em texto).
          <BotAvatar owner={null} size={32} state={active ? mascotStateOfRunStatus(active.status) : 'idle'} />
        )}
        {/* Nome e estado: no celular o estado é a segunda linha (sob o nome); a partir de 768 px o selo de execução fica à direita do nome, na mesma linha. */}
        <div className="min-w-0 flex-1 md:flex md:items-center md:gap-3">
          {bot ? (
            <h1 style={{ color: readableNameColor(bot.color) }} className="truncate text-sm font-medium md:min-w-0 md:flex-1" title={bot.name}>
              {bot.name}
            </h1>
          ) : (
            <h1 className="truncate text-sm font-medium text-fg md:min-w-0 md:flex-1" title={sessionTitle}>
              {sessionTitle}
            </h1>
          )}
          {active ? (
            <RunBadge status={active.status === 'waiting_approval' ? 'waiting_approval' : 'running'} className="mt-0.5 w-fit md:mt-0" />
          ) : bot ? (
            <BotHeaderStateText bot={bot} />
          ) : null}
        </div>
        {bot ? (
          <>
            <BotHeaderActions botId={bot.id} />
            <BotMoreActions botId={bot.id} />
          </>
        ) : session ? (
          <>
            <div className="flex shrink-0 items-center max-md:hidden">{session.actions}</div>
            {session.menuActions ? <MoreActionsMenu label="Mais ações do chat">{session.menuActions}</MoreActionsMenu> : null}
          </>
        ) : null}
      </header>

      {load.status === 'loading' ? <BotLoading label="Carregando conversa" /> : null}
      {load.status === 'not-found' ? <BotNotFound /> : null}
      {load.status === 'error' ? <BotLoadError message={load.message} onRetry={retry} /> : null}

      {load.status === 'ready' ? (
        <>
          {bot && load.state.objective ? <ObjectiveInvitation botId={bot.id} objective={load.state.objective} archived={bot.archivedAt !== null} sent={objectiveSent} /> : null}
          <Thread source={{ kind: owner.kind, id: owner.kind === 'bot' ? owner.bot.id : owner.sessionId }} ref={thread} bot={bot} state={load.state} onRetry={(runId, limitMessageId) => void retryFailed(runId, limitMessageId)} onCancelComplement={cancelComplement} loadOlder={loadOlder} focusMessageId={focusMessageId} versions={versions} artifactLinks={artifactPanel.links} />
          {/* Linha fixa da Faísca (ID-04): fora da lista, acima do composer, só enquanto a conversa trabalha. */}
          {isWorking(load.state) ? (
            <WorkingLine
              bot={bot}
              activities={load.state.items.filter((item): item is ActivityView => item.kind === 'activity' && item.runId !== null && item.runId === active?.id)}
              runStatus={active?.status}
            />
          ) : null}
          {footer ?? (
            <>
              {blocker === 'provider' ? <SetupBanner text={PROVIDER_REASON} href="/configuracoes/conexoes" action="Abrir Conexões" /> : null}
              {blocker === 'default-model' ? <SetupBanner text={DEFAULT_MODEL_REASON} href="/configuracoes/preferencias" action="Abrir Preferências" /> : null}
              <Composer
                contextPanel={<ContextPanel state={load.state.context ?? null} source={{ kind: owner.kind, id: owner.kind === 'bot' ? owner.bot.id : owner.sessionId }} onState={setContext} />}
                source={{ kind: owner.kind, id: owner.kind === 'bot' ? owner.bot.id : owner.sessionId }}
                disabled={blocker !== null}
                disabledReason={blocker === 'default-model' ? DEFAULT_MODEL_REASON : PROVIDER_REASON}
                model={load.state.model}
                onModelChange={(model, effort) => void setModel(model, effort)}
                running={active !== null}
                stopping={stopRequested}
                onSend={async (content, attachmentIds) => {
                  const result = await send(content, attachmentIds);
                  if (result.ok) { setObjectiveSent(true); onSent?.(); }
                  return result;
                }}
                onStop={() => void stop()}
                draft={load.state.draft}
                onTakeDraft={takeDraft}
                onSent={() => thread.current?.scrollToBottom()}
              />
            </>
          )}
        </>
      ) : null}
    </ConversationFrame>
  );
}
