'use client';

// Bloqueio temporário de um formulário de autenticação (AUTH-04): depois de `AUTH_LOCKED`, o formulário fica
// desabilitado pelo tempo que a API pediu no `Retry-After`. Compartilhado pelo login e pelo segundo passo (TOTP),
// que recebem o mesmo erro do mesmo controle de tentativas.
import { useCallback, useEffect, useRef, useState } from 'react';

/** Maior atraso que `setTimeout` aceita (2^31 - 1 ms); acima disso dispararia na hora. */
const MAX_TIMEOUT_MS = 2_147_000_000;
const DEFAULT_LOCK_SECONDS = 60;

export function useLockout(): { locked: boolean; lockFor: (seconds: number | undefined) => void } {
  const [locked, setLocked] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Não deixa o temporizador de desbloqueio vivo se o formulário sair da tela.
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const lockFor = useCallback((seconds: number | undefined) => {
    if (timer.current) clearTimeout(timer.current);
    setLocked(true);
    timer.current = setTimeout(() => setLocked(false), Math.min((seconds ?? DEFAULT_LOCK_SECONDS) * 1000, MAX_TIMEOUT_MS));
  }, []);

  return { locked, lockFor };
}
