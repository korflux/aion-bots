'use client';

// Campo "Pergunte ao Aion" do Início e de Chats (phase 5, T5 e T10; spec F4 passo 5 e Suposição 15): o MESMO composer do Chat geral (texto, modelo e effort, anexos e ditado),
// começando no modelo padrão do Chat geral, mas SEM conversa: abrir o Início ou Chats não cria nada visível. É UM componente para as duas telas (em `/chats` o dono não
// precisa do "+" do canto para começar um chat): o nome "Home" é histórico, e nada nele é específico do Início.
//
// Fluxo:
// - A conversa nasce sob demanda (`ensureSession`): só ao ANEXAR um arquivo (o anexo pertence a uma conversa, então o upload a abre antes) ou ao ENVIAR. É o rascunho
//   invisível do Chat geral (`POST /api/chat/sessions`, o mesmo de "Novo chat"): o servidor reutiliza o que já existe e ele só entra na lista de sessões na primeira
//   mensagem. Uma promessa por composição, reaproveitada pelos anexos e pelo envio.
// - Enviar: abre a sessão, aplica o modelo e o effort escolhidos AQUI só a ela (nunca o padrão do Chat geral; só se o dono mexeu neles), envia a mensagem e leva a /chat/<id>.
// - O texto não enviado fica no `localStorage` do aparelho (`HOME_DRAFT_KEY`, gravado pelo `Composer`) até o envio dar certo; uma falha mantém o texto e mostra o motivo
//   acima do campo (o próprio `Composer`). O rascunho é COMPARTILHADO entre o Início e Chats (a mesma chave) de propósito: os dois campos são o mesmo "novo chat", então o que
//   foi começado num aparece no outro, em vez de dois rascunhos paralelos do mesmo chat que o dono teria de lembrar.
// - Sem provedor ou sem modelo padrão do Chat geral: campo desabilitado e a mesma faixa da conversa ("Abrir Conexões" / "Abrir Preferências"). Falha ao ler esses dois dados:
//   campo desabilitado com "Tentar de novo", sem esconder o resto do Início.
import type { ConversationSource } from '@/components/conversation/conversation-api';
import { hasModelProvider, type EffortLevel, type ModelChoiceView } from '@aion/shared';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createChatSession, fetchChatSettings } from '@/components/chat/chat-api';
import { Composer } from '@/components/conversation/composer';
import { ContextPanel } from '@/components/conversation/context-panel';
import { saveModelPreference, sendMessage } from '@/components/conversation/conversation-api';
import { DEFAULT_MODEL_REASON, PROVIDER_REASON, SetupBanner } from '@/components/conversation/setup-banner';
import type { ActionResult } from '@/components/conversation/use-conversation';
import { fetchModelProfiles } from '@/components/models/models-api';
import { fetchCredentials } from '@/components/settings/credentials-api';
import { Button } from '@/components/ui/button';
import { apiErrorMessage } from '@/lib/api-client';
import { useSession } from '@/lib/session-context';

/** Chave do `localStorage` do texto não enviado do campo "Pergunte ao Aion" (por aparelho; Início e Chats usam a mesma, ver o cabeçalho). Só o texto digitado: sem arquivo e sem credencial. */
export const HOME_DRAFT_KEY = 'aion:home-draft';

const PROMPT = 'Pergunte ao Aion';
/** Escolha de modelo enquanto o padrão do Chat geral não chegou (ou não existe): o composer desabilitado não a mostra. */
const NO_MODEL: ModelChoiceView = { model: null, effort: null, effortLevels: [] };

/** O que o composer precisa saber do servidor: se há provedor e o modelo padrão do Chat geral. */
type Setup = { status: 'loading' } | { status: 'error' } | { status: 'ready'; providerConfigured: boolean; chat: ModelChoiceView };

/** Lê o provedor e o modelo padrão do Chat geral (os mesmos endpoints do índice de Configurações); `retry` repete depois de uma falha. */
function useHomeSetup(): { setup: Setup; retry: () => void } {
  const [setup, setSetup] = useState<Setup>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    Promise.all([fetchCredentials(), fetchChatSettings()]).then(
      ([credentials, chat]) => {
        if (!cancelled) setSetup({ status: 'ready', providerConfigured: hasModelProvider(credentials), chat });
      },
      () => {
        if (!cancelled) setSetup({ status: 'error' });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [attempt]);
  const retry = useCallback(() => {
    setSetup({ status: 'loading' });
    setAttempt((value) => value + 1);
  }, []);
  return { setup, retry };
}

/** Apaga o texto guardado no aparelho depois de um envio aceito (o `Composer` também o apaga ao esvaziar o campo; aqui é a garantia antes de a tela trocar). */
function forgetStoredText(): void {
  try {
    window.localStorage.removeItem(HOME_DRAFT_KEY);
  } catch {
    // Storage bloqueado: não havia o que apagar.
  }
}

/** `large` é o campo do meio do Início (3 linhas de altura); em Chats ele segue no rodapé, com uma linha. */
export function HomeComposer({ large = false }: { large?: boolean }) {
  const router = useRouter();
  const { csrfToken } = useSession();
  const { setup, retry } = useHomeSetup();
  /** Modelo e effort escolhidos neste campo; nulo enquanto o dono não mexeu (vale o padrão do Chat geral e nada é aplicado à sessão). */
  const [choice, setChoice] = useState<ModelChoiceView | null>(null);
  /** A conversa deste campo: a abertura em curso ou concluída; nula antes de anexar ou enviar (e depois de uma abertura que falhou, para tentar de novo). */
  const opened = useRef<Promise<ConversationSource> | null>(null);

  /** Abre (uma vez) o rascunho invisível do Chat geral e devolve a conversa. Quem anexa e quem envia chamam; a segunda chamada reaproveita a primeira. */
  const ensureSession = useCallback((): Promise<ConversationSource> => {
    opened.current ??= createChatSession(csrfToken).then(
      (session): ConversationSource => ({ kind: 'session', id: session.id }),
      (error: unknown) => {
        opened.current = null;
        throw error;
      },
    );
    return opened.current;
  }, [csrfToken]);

  const providerMissing = setup.status === 'ready' && !setup.providerConfigured;
  const modelMissing = setup.status === 'ready' && setup.providerConfigured && setup.chat.model === null;
  const reason = providerMissing ? PROVIDER_REASON : modelMissing ? DEFAULT_MODEL_REASON : PROMPT;
  /** O que o campo mostra: a escolha feita aqui ou, sem ela, o padrão do Chat geral. */
  const model = choice ?? (setup.status === 'ready' ? setup.chat : NO_MODEL);

  /**
   * Troca de modelo ou de effort só na tela (a gravação na sessão é no envio). Com o mesmo modelo os níveis de effort já são conhecidos; com outro, vêm da lista do
   * provedor (o mesmo teste que o seletor mostra), e enquanto não chegam o seletor de effort do campo fica de fora.
   */
  const changeModel = (next: string, effort: EffortLevel | null): void => {
    const sameModel = model.model === next;
    setChoice({ model: next, effort, effortLevels: sameModel ? (model.effortLevels ?? []) : [] });
    if (sameModel) return;
    void fetchModelProfiles().then(
      (models) => {
        const levels = models.find((entry) => entry.id === next)?.test?.effortLevels ?? [];
        setChoice((current) => (current?.model === next ? { ...current, effortLevels: levels } : current));
      },
      () => undefined,
    );
  };

  /** Envia pelo Início: sessão, modelo e effort só dela, mensagem, e a conversa abre. Falha devolve o motivo e o campo mantém o texto e os arquivos. */
  const send = async (content: string, attachmentIds: string[] = []): Promise<ActionResult> => {
    try {
      const target = await ensureSession();
      if (choice?.model) await saveModelPreference(target, choice.model, choice.effort, csrfToken);
      await sendMessage(target, content, csrfToken, attachmentIds);
      forgetStoredText();
      router.push(`/chat/${target.id}`);
      return { ok: true };
    } catch (error) {
      return { ok: false, message: apiErrorMessage(error) };
    }
  };

  return (
    <>
      {providerMissing ? <SetupBanner text={PROVIDER_REASON} href="/configuracoes/conexoes" action="Abrir Conexões" /> : null}
      {modelMissing ? <SetupBanner text={DEFAULT_MODEL_REASON} href="/configuracoes/preferencias" action="Abrir Preferências" /> : null}
      {setup.status === 'error' ? (
        <div className="px-3 pb-3 md:px-6">
          <div className="mx-auto flex w-full max-w-[760px] flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-surface p-3">
            <p role="alert" className="text-sm text-danger">
              Não foi possível preparar o campo de mensagem.
            </p>
            <Button variant="secondary" size="sm" onClick={retry}>
              Tentar de novo
            </Button>
          </div>
        </div>
      ) : null}
      <Composer
        large={large}
        contextPanel={<ContextPanel mode="opening" state={null} />}
        disabled={setup.status !== 'ready' || providerMissing || modelMissing}
        disabledReason={reason}
        model={model}
        onModelChange={changeModel}
        source={ensureSession}
        onSend={send}
        onSent={() => undefined}
        prompt={PROMPT}
        storageKey={HOME_DRAFT_KEY}
      />
    </>
  );
}
