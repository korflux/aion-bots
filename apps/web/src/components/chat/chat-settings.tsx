'use client';

// Cartão "Modelo do Chat geral" de Configurações → Preferências (T23, F16; phase 5, T4): o modelo padrão (e o effort) com que todo chat novo começa. É
// OBRIGATÓRIO: sem ele o Chat geral não deixa conversar (o composer mostra uma faixa que leva até aqui) e o primeiro favorito não vale como saída. Salva ao
// escolher, sem botão: é um único campo, e a troca de modelo/effort DENTRO de um chat vale só para aquele chat e não muda este padrão.
//
// Gravar é otimista: a tela mostra a escolha na hora e, como nos demais campos de Preferências, MANTÉM o valor escolhido se o servidor recusar (modelo fora da lista
// do provedor, effort que o modelo não aceita), com o erro abaixo do campo e "Tentar de novo". "Salvo" aparece ao lado do título do cartão. Arrastar a barra
// de effort grava uma vez por etapa, então só vale a resposta da gravação MAIS RECENTE.
import { useEffect, useRef, useState } from 'react';
import { ModelField } from '@/components/models/model-field';
import type { ModelChoice } from '@/components/models/model-selector';
import { FieldError, SAVE_FAILED_MESSAGE, SavedMark, useFieldFeedback } from '@/components/settings/field-feedback';
import { StatusBadge } from '@/components/settings/status-badge';
import { Button } from '@/components/ui/button';
import { apiErrorMessage } from '@/lib/api-client';
import { useSession } from '@/lib/session-context';
import { fetchChatSettings, saveChatSettings } from './chat-api';

type Load = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; choice: ModelChoice };

export function ChatModelCard({ onModelChange }: { onModelChange?: (model: string | null) => void }) {
  const { csrfToken } = useSession();
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const { feedback, saved: markSaved, failed, reset } = useFieldFeedback();
  /** Número da gravação mais recente: respostas de gravações antigas (que chegaram atrasadas) são descartadas. */
  const latestSave = useRef(0);

  useEffect(() => {
    let cancelled = false;
    fetchChatSettings().then(
      (choice) => {
        if (!cancelled) { setLoad({ status: 'ready', choice }); onModelChange?.(choice.model); }
      },
      (error: unknown) => {
        if (!cancelled) setLoad({ status: 'error', message: apiErrorMessage(error) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [attempt, onModelChange]);

  /** Grava a escolha (o seletor desta tela nunca entrega modelo nulo, porque o padrão é obrigatório). */
  async function change(next: ModelChoice) {
    if (next.model === null || load.status !== 'ready') return;
    const mine = ++latestSave.current;
    setLoad({ status: 'ready', choice: next });
    reset();
    try {
      const saved = await saveChatSettings({ model: next.model, effort: next.effort }, csrfToken);
      if (mine !== latestSave.current) return;
      setLoad({ status: 'ready', choice: saved });
      onModelChange?.(saved.model);
      markSaved();
    } catch {
      if (mine !== latestSave.current) return;
      failed(SAVE_FAILED_MESSAGE); // a escolha continua na tela
    }
  }

  return (
    <section aria-labelledby="chat-modelo-padrao" className="rounded-lg border border-line bg-surface grad-sheen p-4 md:p-5">
      <div className="flex items-center justify-between gap-3">
        <h2 id="chat-modelo-padrao" className="text-sm font-semibold text-fg">
          Modelo do Chat geral
        </h2>
        <div className="flex items-center gap-2">
          <SavedMark feedback={feedback} />
          {load.status === 'ready' ? (
            load.choice.model === null ? <StatusBadge tone="warning">Obrigatório</StatusBadge> : <StatusBadge tone="success">Definido</StatusBadge>
          ) : null}
        </div>
      </div>
      <p className="mb-4 mt-1 text-sm text-muted">
        Todo chat novo começa com este modelo e este effort. Sem um modelo padrão o Chat geral não deixa conversar. Trocar o modelo dentro de um
        chat vale só para aquele chat.
      </p>
      {load.status === 'error' ? (
        <div className="flex flex-col items-start gap-3">
          <p role="alert" className="text-sm text-danger">
            {load.message}
          </p>
          <Button
            onClick={() => {
              setLoad({ status: 'loading' });
              setAttempt((value) => value + 1);
            }}
          >
            Tentar novamente
          </Button>
        </div>
      ) : load.status === 'loading' ? (
        <div aria-busy="true" aria-label="Carregando" className="h-20 animate-pulse rounded-md bg-app" />
      ) : (
        <>
          <ModelField
            required
            model={load.choice.model}
            effort={load.choice.effort}
            onChange={(choice) => void change(choice)}
            help="Obrigatório. O effort só oferece os níveis que o modelo aceitou no teste."
          />
          <FieldError id="chat-modelo-erro" feedback={feedback} onRetry={() => void change(load.choice)} />
        </>
      )}
    </section>
  );
}
