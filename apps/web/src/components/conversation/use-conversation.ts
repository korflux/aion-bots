'use client';

// Hook da conversa (do bot ou de uma sessão do chat geral): carrega o snapshot, acompanha o SSE, informa presença e leitura (`usePresence`)
// e expõe as ações (enviar, parar, repetir, trocar modelo, carregar mensagens antigas e, na phase 4, cancelar complemento e receber o rascunho
// devolvido). Quem o usa deve receber `key={id}`: o estado reinicia sozinho ao trocar de conversa.
//
// Como o tempo real funciona: depois do snapshot abre-se um EventSource em `?after=<último evento do snapshot>`. Cada evento
// traz o estado atual de uma mensagem ou execução, e `conversation-state` o aplica como upsert, então duplicatas e reconexões
// são inofensivas. Ao reconectar sozinho, o navegador manda `Last-Event-ID` e a API retoma de lá. Se o servidor recusa a
// conexão (sessão vencida, bot removido, sessão apagada) o EventSource fecha de vez: aí o snapshot é pedido de novo, que trata o erro
// (redireciona ao login ou mostra "não encontrado"). A queda de rede só vira aviso se durar mais que `OFFLINE_GRACE_MS`, para
// a reciclagem normal da conexão (a API a renova a cada poucos minutos) não piscar aviso.
//
// Versões do Chat geral (phase 4, F1 a F4): o evento `path` do SSE (o caminho ativo mudou em algum aparelho) pede um snapshot novo, que traz as
// rodadas e as versões já resolvidas pelo servidor; retroceder, restaurar e trocar de versão devolvem esse snapshot na resposta e ele substitui o
// estado na hora. Editar e gerar devolvem a execução criada, e a releitura vem pelo mesmo `path`. Toda recusa (CONVERSATION_BUSY,
// VERSION_NOT_FOUND...) vira toast de erro persistente, e VERSION_NOT_FOUND também relê o estado (a versão sumiu ou a tela estava atrasada).
import {
  objectiveViewSchema,
  contextStateSchema,
  type ContextState,
  draftEventSchema,
  messageViewSchema,
  runViewSchema,
  type ChooseVersionRequest,
  type ComplementView,
  type ConversationSnapshot,
  type DraftView,
  type EffortLevel,
  type ModelChoiceView,
  type RunView,
} from '@aion/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { toast } from 'sonner';
import { notifyApprovalsChanged } from '@/components/approvals/pending-approvals';
import { refreshBots } from '@/components/bots/bots-store';
import { ApiError, apiErrorMessage } from '@/lib/api-client';
import { useSession } from '@/lib/session-context';
import {
  activeRunOf,
  applyComplement,
  applyDraft,
  applyMessage,
  applyRun,
  dropComplement,
  fromSnapshot,
  prependPage,
  type ConversationState,
} from './conversation-state';
import {
  NOT_FOUND_CODE,
  cancelComplement as requestCancelComplement,
  chooseVersion,
  consumeDraft,
  editMessage,
  eventsUrl,
  fetchConversation,
  fetchOlderMessages,
  regenerateRun,
  restorePath,
  retryRun,
  rewindTo,
  saveModelPreference,
  sendMessage,
  stopRun,
  type ConversationSource,
} from './conversation-api';
import { readThroughOf } from './presence';
import { usePresence } from './use-presence';

const OFFLINE_GRACE_MS = 2_500;
const OFFLINE_TOAST_ID = 'conversation-offline';

export type ConversationLoad =
  | { status: 'loading' }
  | { status: 'not-found' }
  | { status: 'error'; message: string }
  | { status: 'ready'; state: ConversationState; cursor: string };

/** Resultado de uma ação do composer: o texto digitado só é limpo quando deu certo. */
export type ActionResult = { ok: true } | { ok: false; message: string };

/** Resultado de carregar a página anterior: se ainda há mais para trás, ou a mensagem segura do erro (a lista a mostra no topo, sem toast). */
export type OlderResult = { ok: true; hasMore: boolean } | { ok: false; message: string };

export function useConversation(kind: ConversationSource['kind'], id: string) {
  const { csrfToken } = useSession();
  // Objeto estável enquanto o dono da conversa não muda: as funções e efeitos abaixo dependem dele sem se refazer a cada render.
  const source = useMemo<ConversationSource>(() => ({ kind, id }), [kind, id]);
  const [load, setLoad] = useState<ConversationLoad>({ status: 'loading' });
  // Incrementar pede um novo snapshot (tentar de novo depois de erro, ou reconexão que o navegador desistiu de fazer).
  const [attempt, setAttempt] = useState(0);
  /** Execução cuja parada já foi pedida: o botão mostra "Parando…" até ela terminar. */
  const [stopping, setStopping] = useState<string | null>(null);
  /** Estado mais recente para os manipuladores de evento lerem sem depender do ciclo de render. */
  const stateRef = useRef<ConversationState | null>(null);
  /** Serializa gravações da barra para o último gesto vencer também no banco, sem respostas antigas sobrescreverem a tela. */
  const modelSave = useRef<Promise<ModelChoiceView | undefined>>(Promise.resolve(undefined));
  const modelRevision = useRef(0);
  useEffect(() => {
    stateRef.current = load.status === 'ready' ? load.state : null;
  }, [load]);

  const update = useCallback((change: (state: ConversationState) => ConversationState) => {
    setLoad((current) => (current.status === 'ready' ? { ...current, state: change(current.state) } : current));
  }, []);

  // Snapshot. Numa recarga a tela antiga continua visível até o novo estado chegar (sem piscar o esqueleto).
  useEffect(() => {
    let cancelled = false;
    fetchConversation(source).then(
      (snapshot) => {
        if (!cancelled) setLoad({ status: 'ready', state: fromSnapshot(snapshot), cursor: snapshot.lastEventId });
      },
      (error: unknown) => {
        if (cancelled) return;
        if (error instanceof ApiError && error.code === NOT_FOUND_CODE[source.kind]) setLoad({ status: 'not-found' });
        else setLoad({ status: 'error', message: apiErrorMessage(error) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [source, attempt]);

  // SSE: uma conexão por snapshot (o `cursor` só muda quando o snapshot é recarregado).
  const cursor = load.status === 'ready' ? load.cursor : null;
  useEffect(() => {
    if (cursor === null) return;
    const stream = new EventSource(eventsUrl(source, cursor));
    let offlineTimer: ReturnType<typeof setTimeout> | undefined;

    const parse = (raw: string): unknown => {
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    };
    stream.addEventListener('message', (event) => {
      const parsed = messageViewSchema.safeParse(parse((event as MessageEvent<string>).data));
      if (!parsed.success) return;
      update((state) => applyMessage(state, parsed.data));
      // Um cartão de aprovação novo ou atualizado muda o número de pendências do badge.
      if (parsed.data.kind === 'card' && parsed.data.card.type === 'approval') notifyApprovalsChanged();
    });
    stream.addEventListener('objective', (event) => {
      const value = parse((event as MessageEvent<string>).data);
      const parsed = objectiveViewSchema.nullable().safeParse(value);
      if (parsed.success) update((state) => ({ ...state, objective: parsed.data }));
    });
    // Contexto usa o mesmo canal da conversa: manutenção em outro aparelho e preparo automático chegam sem consulta paralela.
    stream.addEventListener('context', (event) => {
      const parsed = contextStateSchema.safeParse(parse((event as MessageEvent<string>).data));
      if (parsed.success) update((state) => ({ ...state, context: parsed.data }));
    });
    stream.addEventListener('run', (event) => {
      const parsed = runViewSchema.safeParse(parse((event as MessageEvent<string>).data));
      if (!parsed.success) return;
      update((state) => applyRun(state, parsed.data));
      // O estado ao vivo do bot (Faísca do cabeçalho e da lista) é derivado do status da execução: a cada evento de execução, inclusive o terminal,
      // relê a lista na hora em vez de esperar o próximo ciclo de 5 ou 15 s. O Chat geral não tem bot, então não há estado a atualizar.
      if (source.kind === 'bot') void refreshBots({ background: true });
    });
    // Caminho ativo mudou (phase 4, F1 a F4; só na sessão do Chat geral): relê o snapshot, que traz as rodadas e as versões resolvidas. A tela atual
    // continua visível até ele chegar.
    stream.addEventListener('path', () => setAttempt((value) => value + 1));
    // Rascunho devolvido (phase 4, F5): chega aos aparelhos abertos, e `draft: null` o tira de quem ainda o mostrava.
    stream.addEventListener('draft', (event) => {
      const parsed = draftEventSchema.safeParse(parse((event as MessageEvent<string>).data));
      if (parsed.success) update((state) => applyDraft(state, parsed.data));
    });
    stream.onopen = () => {
      clearTimeout(offlineTimer);
      toast.dismiss(OFFLINE_TOAST_ID);
    };
    stream.onerror = () => {
      if (stream.readyState === EventSource.CLOSED) {
        // O servidor recusou (401, 404): o snapshot novo trata o erro como toda outra chamada.
        setAttempt((value) => value + 1);
        return;
      }
      clearTimeout(offlineTimer);
      offlineTimer = setTimeout(() => toast.error('Sem conexão. Tentando reconectar…', { id: OFFLINE_TOAST_ID, duration: Infinity }), OFFLINE_GRACE_MS);
    };
    return () => {
      clearTimeout(offlineTimer);
      toast.dismiss(OFFLINE_TOAST_ID);
      stream.close();
    };
  }, [source, cursor, update]);

  const retry = useCallback(() => {
    setLoad({ status: 'loading' });
    setAttempt((value) => value + 1);
  }, []);

  /**
   * Envia a mensagem; a execução criada (ou o complemento, com execução ativa) entra na tela já, e o evento do SSE a confirma depois, sem
   * duplicar.
   */
  const send = useCallback(
    async (content: string, attachmentIds: string[] = []): Promise<ActionResult> => {
      try {
        const { kind, ...created } = await sendMessage(source, content, csrfToken, attachmentIds);
        if (kind === 'run') update((state) => applyRun(state, created as RunView));
        else update((state) => applyComplement(state, created as ComplementView));
        return { ok: true };
      } catch (error) {
        return { ok: false, message: apiErrorMessage(error) };
      }
    },
    [source, csrfToken, update],
  );

  const stop = useCallback(async (): Promise<void> => {
    const active = stateRef.current ? activeRunOf(stateRef.current) : null;
    if (!active) return;
    setStopping(active.id);
    try {
      await stopRun(source, csrfToken);
    } catch (error) {
      setStopping(null);
      // RUN_NOT_ACTIVE é informativo (a execução acabou no meio do clique), não erro.
      if (error instanceof ApiError && error.code === 'RUN_NOT_ACTIVE') toast('A execução já terminou.');
      else toast.error(apiErrorMessage(error), { duration: Infinity });
    }
  }, [source, csrfToken]);

  /**
   * "Cancelar" de um complemento pendente: some da execução e volta como rascunho, que o composer recebe pelas regras dele. Se o assistente já o
   * leu (COMPLEMENT_NOT_FOUND), avisa sem erro: a mensagem já está na conversa.
   */
  const cancelComplement = useCallback(
    async (complementId: string): Promise<void> => {
      try {
        const draft = await requestCancelComplement(source, complementId, csrfToken);
        update((state) => applyDraft(dropComplement(state, complementId), { id: draft.id, draft }));
      } catch (error) {
        if (error instanceof ApiError && error.code === 'COMPLEMENT_NOT_FOUND') toast(apiErrorMessage(error));
        else toast.error(apiErrorMessage(error), { duration: Infinity });
      }
    },
    [source, csrfToken, update],
  );

  /**
   * Pede o rascunho devolvido para este composer. Devolve o texto e os anexos, ou nulo se outro aparelho já o recebeu (DRAFT_NOT_FOUND, sem
   * aviso: é o caminho normal com dois aparelhos abertos) ou se a chamada falhou (com aviso). Em todos os casos ele sai da tela daqui.
   */
  const takeDraft = useCallback(
    async (draftId: string): Promise<DraftView | null> => {
      try {
        const draft = await consumeDraft(source, draftId, csrfToken);
        update((state) => applyDraft(state, { id: draftId, draft: null }));
        return draft;
      } catch (error) {
        if (error instanceof ApiError && error.code === 'DRAFT_NOT_FOUND') update((state) => applyDraft(state, { id: draftId, draft: null }));
        else toast.error(apiErrorMessage(error), { duration: Infinity });
        return null;
      }
    },
    [source, csrfToken, update],
  );

  const retryFailed = useCallback(
    async (runId: string, limitMessageId?: string): Promise<void> => {
      try {
        const run = await retryRun(source, runId, csrfToken, limitMessageId);
        update((state) => applyRun(state, run));
      } catch (error) {
        toast.error(apiErrorMessage(error), { duration: Infinity });
      }
    },
    [source, csrfToken, update],
  );

  // ---------------------------------------------------------------------------------------------
  // Versões da sessão do Chat geral (phase 4, F1 a F4). Só a origem `session` as chama (a tela do bot nem mostra os controles).
  // ---------------------------------------------------------------------------------------------

  /** Aplica o snapshot devolvido por retroceder, restaurar ou escolher: substitui o estado e retoma o SSE do ponto dele. */
  const applySnapshot = useCallback((snapshot: ConversationSnapshot) => {
    setLoad({ status: 'ready', state: fromSnapshot(snapshot), cursor: snapshot.lastEventId });
  }, []);

  /** Recusa de um comando de versão: toast de erro persistente; a versão que sumiu (VERSION_NOT_FOUND) também relê o estado. */
  const versionFailed = useCallback((error: unknown) => {
    toast.error(apiErrorMessage(error), { duration: Infinity });
    if (error instanceof ApiError && error.code === 'VERSION_NOT_FOUND') setAttempt((value) => value + 1);
  }, []);

  /**
   * Editar (F1): a versão nova entra na fila e o snapshot é relido já (o `path` do SSE faria o mesmo, um pouco depois). A falha volta como
   * resultado, sem toast: a caixa de edição mostra o motivo no próprio campo e preserva o texto.
   */
  const edit = useCallback(
    async (messageId: string, content: string, attachmentIds: string[]): Promise<ActionResult> => {
      try {
        const run = await editMessage(source.id, messageId, content, attachmentIds, csrfToken);
        update((state) => applyRun(state, run));
        setAttempt((value) => value + 1);
        return { ok: true };
      } catch (error) {
        return { ok: false, message: apiErrorMessage(error) };
      }
    },
    [source, csrfToken, update],
  );

  /** Gerar outra resposta (F2): a execução nova entra na tela e o snapshot relido tira as rodadas que pendiam da versão anterior. */
  const regenerate = useCallback(
    async (runId: string): Promise<void> => {
      try {
        const run = await regenerateRun(source.id, runId, csrfToken);
        update((state) => applyRun(state, run));
        setAttempt((value) => value + 1);
      } catch (error) {
        versionFailed(error);
      }
    },
    [source, csrfToken, update, versionFailed],
  );

  /** Retroceder até a resposta `runId` (F3); devolve se deu certo (o popup fecha nos dois casos, e a falha vira toast). */
  const rewind = useCallback(
    async (runId: string): Promise<boolean> => {
      try {
        applySnapshot(await rewindTo(source.id, runId, csrfToken));
        return true;
      } catch (error) {
        versionFailed(error);
        return false;
      }
    },
    [source, csrfToken, applySnapshot, versionFailed],
  );

  /** "Restaurar" (F3): volta o caminho de antes do retrocesso. */
  const restore = useCallback(async (): Promise<void> => {
    try {
      applySnapshot(await restorePath(source.id, csrfToken));
    } catch (error) {
      versionFailed(error);
    }
  }, [source, csrfToken, applySnapshot, versionFailed]);

  /** Trocar de versão (F4); devolve se deu certo, para a tela anunciar "Versão k de n" e devolver o foco ao seletor. */
  const choose = useCallback(
    async (target: ChooseVersionRequest): Promise<boolean> => {
      try {
        applySnapshot(await chooseVersion(source.id, target, csrfToken));
        return true;
      } catch (error) {
        versionFailed(error);
        return false;
      }
    },
    [source, csrfToken, applySnapshot, versionFailed],
  );

  /** Troca de modelo e effort no composer: aparece na hora e volta atrás se o servidor recusar. */
  const setModel = useCallback(
    async (model: string, effort: EffortLevel | null): Promise<void> => {
      const previous = stateRef.current?.model;
      const revision = ++modelRevision.current;
      update((state) => ({ ...state, model: { model, effort, effortLevels: state.model.model === model ? state.model.effortLevels : [] } }));
      const preceding = modelSave.current;
      const save = async (): Promise<ModelChoiceView | undefined> => {
        const confirmed = (await preceding) ?? previous;
        try {
          const saved = await saveModelPreference(source, model, effort, csrfToken);
          if (revision === modelRevision.current) update((state) => ({ ...state, model: saved }));
          return saved;
        } catch (error) {
          if (revision === modelRevision.current) {
            if (confirmed) update((state) => ({ ...state, model: confirmed }));
            toast.error(apiErrorMessage(error), { duration: Infinity });
          }
          return confirmed;
        }
      };
      modelSave.current = save();
      await modelSave.current;
    },
    [source, csrfToken, update],
  );

  /**
   * Carrega as rodadas anteriores à mais antiga conhecida (a API devolve 10 por vez). Não avisa por toast: quem pediu mostra a falha no lugar
   * certo (a faixa no topo da lista; o link "ver na conversa" avisa por conta própria), e a tela que já está montada não perde nada. O estado
   * é aplicado com `flushSync` para que, quando a promessa resolver, a lista já esteja no DOM: o salto até uma mensagem antiga confere o
   * elemento logo em seguida, e a compensação da rolagem (thread.tsx) roda no mesmo commit que insere as mensagens.
   */
  const loadOlder = useCallback(async (): Promise<OlderResult> => {
    const oldest = stateRef.current?.items[0];
    if (!oldest) return { ok: true, hasMore: false };
    try {
      const page = await fetchOlderMessages(source, oldest.id);
      flushSync(() => update((current) => prependPage(current, page)));
      return { ok: true, hasMore: page.hasMore };
    } catch (error) {
      return { ok: false, message: apiErrorMessage(error) };
    }
  }, [source, update]);

  // A parada pedida vale só para aquela execução: quando ela sai de cena (ids nunca se repetem) o botão volta ao normal sozinho.
  const activeId = load.status === 'ready' ? (activeRunOf(load.state)?.id ?? null) : null;
  const stopRequested = stopping !== null && stopping === activeId;

  // Presença e leitura sincronizadas no servidor (phase 3, T2): a conversa carregada, visível e em foco informa até onde foi mostrada.
  usePresence(source, load.status === 'ready' ? readThroughOf(load.state.items) : null, load.status === 'ready');

  /** Aplica leitura/resposta de manutenção no mesmo estado consumido pelo snapshot e SSE. */
  const setContext = useCallback((context: ContextState) => update((state) => ({ ...state, context })), [update]);
  return { load, retry, send, stop, stopRequested, retryFailed, setModel, setContext, loadOlder, cancelComplement, takeDraft, edit, regenerate, rewind, restore, choose };
}
