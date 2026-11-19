'use client';

// Configurações → Conexões → Python (phase 4, F11; phase 5, T4; design "Execução de Python (Configurações)"), o último cartão da área Conexões: um cartão com o estado do serviço sandbox, conferido pelo
// SERVIDOR a cada leitura (`GET /api/settings/python`, saúde com prazo de 3 s). O navegador nunca fala com o sandbox nem recebe o endereço ou o token.
//
// Três estados: "Disponível" (os bots e o Chat geral podem executar Python), "Não instalado" (sem a configuração no servidor; o resto do Aion
// funciona igual) e "Indisponível agora" (configurado, mas não respondeu), este com "Verificar de novo", que repete a conferência sem tirar o cartão
// da tela. Layout e estados de carga e erro são os da página de Pesquisa na web.
import type { PythonStatus } from '@aion/shared';
import { LoaderCircle } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { fetchPythonStatus } from './settings-api';
import { StatusBadge, type BadgeTone } from './status-badge';

/** Selo e texto de apoio de cada estado (textos do design). */
const STATES: Record<PythonStatus['status'], { tone: BadgeTone; badge: string; text: string }> = {
  available: {
    tone: 'success',
    badge: 'Disponível',
    text: 'Os bots e o Chat geral podem executar Python isolado para cálculos e análise de arquivos, sem acesso à internet.',
  },
  not_installed: {
    tone: 'neutral',
    badge: 'Não instalado',
    text: 'O serviço sandbox não está configurado. Os bots funcionam normalmente sem Python. Veja "Serviço sandbox" em docs/operacao.md para instalar.',
  },
  unavailable: {
    tone: 'warning',
    badge: 'Indisponível agora',
    text: 'O serviço sandbox está configurado, mas não respondeu. As execuções seguem sem Python até ele voltar.',
  },
};

/** Estados da página: esqueleto na primeira carga, falha de leitura (com "Tentar novamente") e pronta. */
type Load = { status: 'loading' } | { status: 'error' } | { status: 'ready'; python: PythonStatus['status'] };

export function PythonSettings() {
  const titleId = useId();
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  // "Verificar de novo" repete a conferência com o cartão na tela (o botão mostra o giro), em vez de voltar ao esqueleto.
  const [checking, setChecking] = useState(false);

  // Incrementar repete a leitura ("Tentar novamente" e "Verificar de novo").
  const [attempt, setAttempt] = useState(0);

  // Lê o estado no servidor; uma falha da LEITURA (não do sandbox, que é um estado) vira o erro com "Tentar novamente". Uma resposta atrasada de
  // uma leitura anterior é descartada.
  useEffect(() => {
    let cancelled = false;
    fetchPythonStatus().then(
      ({ status }) => {
        if (!cancelled) setLoad({ status: 'ready', python: status });
      },
      () => {
        if (!cancelled) setLoad({ status: 'error' });
      },
    ).finally(() => {
      if (!cancelled) setChecking(false);
    });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const state = load.status === 'ready' ? STATES[load.python] : null;
  return (
    <>
      {load.status === 'error' ? (
        <div className="flex flex-col items-start gap-3">
          <p role="alert" className="text-sm text-danger">
            Não foi possível carregar o estado do Python.
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
      ) : load.status === 'loading' || state === null ? (
        <div aria-busy="true" aria-label="Carregando" className="h-28 animate-pulse rounded-md border border-line bg-surface" />
      ) : (
        <section aria-labelledby={titleId} className="rounded-md border border-line bg-surface grad-sheen p-4 md:p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id={titleId} className="text-sm font-medium text-fg">
              Execução de Python
            </h2>
            <StatusBadge tone={state.tone}>{state.badge}</StatusBadge>
          </div>
          {/* Anunciado ao mudar depois de "Verificar de novo" (o selo muda junto). */}
          <p aria-live="polite" className="mt-1 text-xs text-muted">
            {state.text}
          </p>
          {load.python === 'unavailable' ? (
            <Button
              variant="secondary"
              size="sm"
              className="mt-3"
              disabled={checking}
              onClick={() => {
                setChecking(true);
                setAttempt((value) => value + 1);
              }}
            >
              {checking ? <LoaderCircle data-icon="LoaderCircle" className="size-4 animate-spin motion-reduce:animate-none" strokeWidth={1.5} aria-hidden /> : null}
              Verificar de novo
            </Button>
          ) : null}
        </section>
      )}
    </>
  );
}
