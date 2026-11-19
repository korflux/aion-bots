'use client';

// Painel da seção Chat geral (plugado em nav-config), na lista de UMA linha da phase 18 (A22 a A24): "Novo chat" no topo como linha de texto com ícone, as seções "Salvos" e
// "Recentes" e, em cada sessão, só o título e a bolinha de não lido. O aviso da retenção ("Apagados 7 dias após a última mensagem") é UM, fixo sob "Recentes" quando há sessão
// não salva; o ícone de relógio só aparece na linha a que falta 1 dia ou menos (`showsExpiryClock`) e leva a data exata do apagamento (hover, foco e toque, e o nome acessível do botão).
// Os dados vêm do store compartilhado (chat-store), então criar, salvar ou mandar a primeira mensagem atualiza o painel na hora.
// Não lido (phase 3, F4/A7): a sessão com novidade mostra a bolinha à direita do título e o título em `text-fg font-medium`; a sessão aberta não a mostra.
// O painel assina a releitura periódica da lista (`useLiveChatSessions`), que traz a leitura feita em outro aparelho.
// A lista em si (`SessionsList`: carregando, erro, vazio e as seções) é uma peça só, usada pelo painel e pela página `/chats` (phase 5, T6 e T10), que a alimenta com a lista
// completa (`ChatSessionsList`) ou com a vista "Salvos" (`use-saved-sessions.ts`): as duas telas mostram as sessões do mesmo jeito. "Novo chat" é só do painel (a página tem o "+" no celular).
import { Clock, Plus, SquarePen } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { UNREAD_LABEL, UnreadDot } from '@/components/ui/unread-dot';
import { cn } from '@/lib/cn';
import { browserTimeZone, formatDateTimeInZone } from '@/lib/format';
import { useNow } from '@/lib/use-now';
import type { ChatSession } from '@aion/shared';
import { refreshChatSessions, sessionIsOpen, useLiveChatSessions, type ChatSessionsState } from './chat-store';
import { RETENTION_NOTICE, sectionsOf, sessionTitle, showsExpiryClock } from './chat-state';
import { useNewSession } from './use-new-session';

/** Botão de ícone do cabeçalho do painel: abre o chat novo (o rascunho vazio, se já houver um) sem criar sessões à toa. */
export function NewSessionAction() {
  const { open, busy } = useNewSession();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Novo chat" disabled={busy} onClick={() => void open()}>
          <Plus className="size-4" strokeWidth={1.5} aria-hidden />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">Novo chat</TooltipContent>
    </Tooltip>
  );
}

/**
 * O relógio da linha (A24): um botão ao lado do link, não dentro dele (controle dentro de link é interativo aninhado). O nome acessível já diz a data exata do apagamento; o tooltip a
 * mostra no hover e no foco, e o clique a abre (o toque não dispara hover).
 */
function ExpiryClock({ expiresAt }: { expiresAt: string }) {
  const [open, setOpen] = useState(false);
  const label = `Apaga em ${formatDateTimeInZone(expiresAt, browserTimeZone() ?? 'UTC')}`;
  return (
    <Tooltip open={open} onOpenChange={setOpen}>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          // O clique abre a dica (o toque não tem hover); `preventDefault` impede o gatilho do Radix de fechá-la no mesmo clique. Tocar fora ou Esc a fecham.
          onClick={(event) => {
            event.preventDefault();
            setOpen(true);
          }}
          // O mouse que sai do ícone fecha a dica (o toque não: ele a mantém até o próximo toque, e `pointerleave` dispara ao soltar o dedo).
          onPointerLeave={(event) => event.pointerType === 'mouse' && setOpen(false)}
          className="flex size-8 shrink-0 items-center justify-center rounded-sm text-muted hover:text-fg"
        >
          <Clock className="size-3.5" strokeWidth={1.5} aria-hidden />
        </button>
      </TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}

/** Item da lista (uma linha): título truncado (o completo fica no `title`), a bolinha de não lido, o relógio quando falta 1 dia ou menos e o destaque da sessão aberta. */
function SessionLink({ session, current, now }: { session: ChatSession; current: boolean; now: number }) {
  const title = sessionTitle(session);
  const unread = session.unread && !current;
  return (
    <li className="flex items-center">
      <Link
        href={`/chat/${session.id}`}
        title={title}
        aria-current={current ? 'page' : undefined}
        className={cn(
          'flex min-w-0 flex-1 items-center gap-2 rounded-sm px-3 py-2 text-sm text-muted transition-colors hover:bg-surface-hover hover:text-fg active:bg-selected',
          current && 'bg-selected font-medium text-fg',
        )}
      >
        <span className={cn('min-w-0 flex-1 truncate', unread && 'font-medium text-fg')}>{title}</span>
        {unread ? (
          <>
            <span className="sr-only">{UNREAD_LABEL}</span>
            <UnreadDot />
          </>
        ) : null}
      </Link>
      {showsExpiryClock(session, now) && session.expiresAt !== null ? <ExpiryClock expiresAt={session.expiresAt} /> : null}
    </li>
  );
}

/** "Novo chat" no topo do painel: uma linha de texto com ícone, que abre o rascunho vazio (ou cria um) sem acumular sessões à toa. */
function NewChatRow() {
  const { open, busy } = useNewSession();
  return (
    <button
      type="button"
      disabled={busy}
      onClick={() => void open()}
      className="mb-1 flex h-9 w-full items-center gap-2 rounded-sm px-3 text-sm text-fg transition-colors hover:bg-surface-hover active:bg-selected disabled:opacity-50"
    >
      <SquarePen className="size-4 shrink-0" strokeWidth={1.5} aria-hidden />
      Novo chat
    </button>
  );
}

export interface SessionsListProps {
  /** O estado da leitura da lista (o mesmo `ChatSessionsState` do store e da vista Salvos). */
  status: ChatSessionsState['status'];
  sessions: readonly ChatSession[];
  /** O que a lista diz quando está vazia (cada vista tem a sua frase). */
  emptyMessage: string;
  /** "Tentar novamente" da leitura que falhou sem nada para mostrar. */
  onRetry: () => void;
}

/**
 * A lista de sessões com os quatro estados: carregando (esqueleto), erro sem nada para mostrar (com "Tentar novamente"), vazia (`emptyMessage`) e as linhas. Uma leitura que falha
 * com uma lista já à vista mantém a lista (o erro só aparece quando não há o que mostrar).
 */
export function SessionsList({ status, sessions, emptyMessage, onRetry }: SessionsListProps) {
  const pathname = usePathname();
  // Um minuto basta: o texto muda de dia em dia, e o relógio só garante que um painel deixado aberto não envelheça.
  const now = useNow(60_000);

  if (status === 'idle' || (status === 'loading' && sessions.length === 0)) {
    return (
      <div role="status" aria-busy="true" aria-label="Carregando sessões" className="flex flex-col gap-1.5 px-1 pt-1">
        {[0, 1, 2].map((row) => (
          <div key={row} className="h-[52px] animate-pulse rounded-sm bg-surface" />
        ))}
      </div>
    );
  }

  if (status === 'error' && sessions.length === 0) {
    return (
      <div className="flex flex-col items-start gap-2 px-3 py-2">
        <p className="text-sm text-danger">Não foi possível carregar as sessões.</p>
        <button type="button" onClick={onRetry} className="rounded-sm text-sm font-medium text-fg underline underline-offset-4">
          Tentar novamente
        </button>
      </div>
    );
  }

  if (sessions.length === 0) return <p className="px-3 py-2 text-sm text-subtle">{emptyMessage}</p>;

  // Uma lista só ("Sessões"), com as seções como itens de título: o nome da lista e a contagem de links seguem os mesmos para quem a lê.
  const { saved, recent } = sectionsOf(sessions);
  const heading = (text: string, id: string) => (
    <li key={id} className="px-3 pb-1 pt-3 first:pt-1">
      <h3 id={id} className="text-xs font-medium text-subtle">{text}</h3>
    </li>
  );
  return (
    <ul aria-label="Sessões" className="flex flex-col gap-0.5">
      {saved.length > 0 ? heading('Salvos', 'chat-secao-salvos') : null}
      {saved.map((session) => (
        <SessionLink key={session.id} session={session} current={sessionIsOpen(pathname, session.id)} now={now} />
      ))}
      {recent.length > 0 ? heading('Recentes', 'chat-secao-recentes') : null}
      {recent.length > 0 ? <li className="px-3 pb-1 text-xs text-muted">{RETENTION_NOTICE}</li> : null}
      {recent.map((session) => (
        <SessionLink key={session.id} session={session} current={sessionIsOpen(pathname, session.id)} now={now} />
      ))}
    </ul>
  );
}

/** A lista completa das sessões (o store compartilhado, com a releitura periódica): a do painel e a da vista "Todos" de `/chats`. */
export function ChatSessionsList() {
  const { status, sessions } = useLiveChatSessions();
  return (
    <SessionsList
      status={status}
      sessions={sessions}
      emptyMessage="Nenhuma sessão. As sessões somem 7 dias após a última mensagem."
      onRetry={() => void refreshChatSessions()}
    />
  );
}

/** Painel da seção Chat geral: "Novo chat" no topo e a lista completa das sessões. */
export function ChatPanel() {
  return (
    <>
      <NewChatRow />
      <ChatSessionsList />
    </>
  );
}
