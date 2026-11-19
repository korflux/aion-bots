'use client';

// Preferências do dono compartilhadas pelo shell: trocar de conversa reutiliza a mesma leitura,
// e salvar o idioma atualiza imediatamente o próximo ditado, sem cache persistente no navegador.
import type { AppSettings } from '@aion/shared';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { apiErrorMessage } from '@/lib/api-client';
import { fetchAppSettings } from './settings-api';

type SettingsLoad = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; saved: AppSettings };
const SettingsContext = createContext<{ load: SettingsLoad; retry: () => void; update: (saved: AppSettings) => void } | null>(null);

/** Uma leitura autenticada por shell; falhas têm recuperação explícita na tela de preferências. */
export function SettingsProvider({ children }: { children: ReactNode }) {
  const [load, setLoad] = useState<SettingsLoad>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    fetchAppSettings().then(
      (saved) => { if (!cancelled) setLoad({ status: 'ready', saved }); },
      (error: unknown) => { if (!cancelled) setLoad({ status: 'error', message: apiErrorMessage(error) }); },
    );
    return () => { cancelled = true; };
  }, [attempt]);
  /** Reabre a leitura após uma falha, sem usar um idioma presumido no ditado. */
  function retry() { setLoad({ status: 'loading' }); setAttempt((value) => value + 1); }
  /** A resposta do servidor é a autoridade após salvar as preferências. */
  function update(saved: AppSettings) { setLoad({ status: 'ready', saved }); }
  return <SettingsContext.Provider value={{ load, retry, update }}>{children}</SettingsContext.Provider>;
}

/** Leitura do idioma e do fuso já carregados pelo shell autenticado. */
export function useAppSettings() {
  const context = useContext(SettingsContext);
  if (context === null) throw new Error('SettingsProvider ausente.');
  return context;
}
