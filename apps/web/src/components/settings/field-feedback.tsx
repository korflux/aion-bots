'use client';

// Retorno de um campo que salva sozinho (phase 5, T4; spec F9 e Suposição 22; design "Salvo" com região `aria-live` e erro por campo): o estado
// do último salvamento ("Salvo" por cerca de 2 s, ou o erro com a opção de tentar de novo), o "Salvo" ao lado do rótulo e o erro abaixo do campo.
// Usado por todos os campos de Preferências (Como te chamar, Idioma, Fuso e Modelo do Chat geral), que gravam ao mudar e, se a gravação falha, MANTÊM o
// valor escolhido na tela: sem uma ação para tentar de novo, um seletor cujo valor já é o escolhido não teria como reenviar.
import { Check } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';

/** Mensagem do campo quando a gravação falha (texto da spec, Suposição 22). */
export const SAVE_FAILED_MESSAGE = 'Não foi possível salvar. Tente de novo.';

/** Quanto tempo o "Salvo" fica visível. */
const SAVED_VISIBLE_MS = 2000;

export type FieldFeedback = { kind: 'idle' } | { kind: 'saved' } | { kind: 'error'; message: string };

/** O estado do retorno de UM campo e as três transições (gravou, falhou, voltou a ser editado). O "Salvo" some sozinho; o erro fica até a próxima edição. */
export function useFieldFeedback(): { feedback: FieldFeedback; saved: () => void; failed: (message: string) => void; reset: () => void } {
  const [feedback, setFeedback] = useState<FieldFeedback>({ kind: 'idle' });
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const stopTimer = useCallback(() => {
    if (timer.current !== undefined) clearTimeout(timer.current);
    timer.current = undefined;
  }, []);
  useEffect(() => stopTimer, [stopTimer]);

  const saved = useCallback(() => {
    stopTimer();
    setFeedback({ kind: 'saved' });
    timer.current = setTimeout(() => setFeedback({ kind: 'idle' }), SAVED_VISIBLE_MS);
  }, [stopTimer]);
  const failed = useCallback(
    (message: string) => {
      stopTimer();
      setFeedback({ kind: 'error', message });
    },
    [stopTimer],
  );
  const reset = useCallback(() => {
    stopTimer();
    setFeedback({ kind: 'idle' });
  }, [stopTimer]);

  return { feedback, saved, failed, reset };
}

/**
 * "Salvo" ao lado do rótulo do campo. A região `aria-live` existe SEMPRE (um leitor de tela só anuncia o que muda numa região já presente) e o texto só entra
 * depois de gravar. Entra com `dur-base` só em opacidade (`starting:`); ao sair some sem animação, o que fica dentro dos 120 ms do design.
 */
export function SavedMark({ feedback }: { feedback: FieldFeedback }) {
  return (
    <span aria-live="polite" className="min-h-4 text-xs">
      {feedback.kind === 'saved' ? (
        <span className="inline-flex items-center gap-1 text-success transition-opacity duration-[var(--dur-base)] ease-[var(--ease-out)] starting:opacity-0">
          <Check className="size-3.5" strokeWidth={2} aria-hidden />
          Salvo
        </span>
      ) : null}
    </span>
  );
}

/** O erro do campo, abaixo dele, com a ação de tentar de novo (reenvia o valor que está na tela). Nada quando não há erro. */
export function FieldError({ id, feedback, onRetry }: { id: string; feedback: FieldFeedback; onRetry?: () => void }) {
  if (feedback.kind !== 'error') return null;
  return (
    <p id={id} role="alert" className="mt-1.5 flex flex-wrap items-center gap-x-2 text-xs text-danger">
      {feedback.message}
      {onRetry ? (
        <Button type="button" variant="ghost" size="sm" onClick={onRetry} className="-my-1 px-2 text-xs">
          Tentar de novo
        </Button>
      ) : null}
    </p>
  );
}
