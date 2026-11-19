'use client';

// Cartão "Armazenamento" de Configurações → Atividade e arquivos (phase 5, T4; spec F9, Suposição 21; design "Tela: Áreas de Configurações"): quanto do limite de arquivos
// (imagens, planilhas e texto de documentos de todos os bots e do Chat geral) está usado, a barra de uso e "Ver arquivos (N)", que abre a lista completa em
// `/configuracoes/arquivos` (fora do menu). Os números vêm da mesma leitura da lista de arquivos (`fetchFiles`) e a barra segue as três faixas de `quotaState` (cor e texto,
// nunca só cor). Uma leitura que falha mostra o erro neste cartão, com "Tentar novamente", sem esconder as execuções recentes ao lado.
//
// ponytail: os totais vêm da primeira página da lista de arquivos (até 50 itens de metadados, que aqui são descartados), porque a API não tem um endpoint só de totais;
// trocar por um endpoint de totais se essa leitura pesar.
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { attachmentSize } from '@/components/conversation/attachment-list';
import { Button } from '@/components/ui/button';
import { apiErrorMessage } from '@/lib/api-client';
import { fetchFiles } from './files-api';
import { quotaState } from './files-state';
import { QuotaBar } from './quota-bar';

type Load = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; usedBytes: number; maxBytes: number; count: number };

/** O cartão: títulos, números e barra de uso, com a leitura própria (e o erro com "Tentar novamente") e o link da lista completa. */
export function StorageCard() {
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetchFiles({}).then(
      ({ usedBytes, maxBytes, count }) => {
        if (!cancelled) setLoad({ status: 'ready', usedBytes, maxBytes, count });
      },
      (error: unknown) => {
        if (!cancelled) setLoad({ status: 'error', message: apiErrorMessage(error) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const quota = load.status === 'ready' ? quotaState(load.usedBytes, load.maxBytes) : null;
  return (
    <section aria-labelledby="armazenamento-titulo" className="rounded-lg border border-line bg-surface grad-sheen p-4 md:p-5">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <h2 id="armazenamento-titulo" className="text-sm font-semibold text-fg">
          Armazenamento
        </h2>
        {load.status === 'ready' ? (
          <span className="text-xs text-muted">
            {attachmentSize(load.usedBytes, true)} de {attachmentSize(load.maxBytes, true)}
          </span>
        ) : null}
      </div>
      <p className="mt-1 text-sm text-muted">Imagens, planilhas e texto de documentos de todos os bots e do Chat geral. O arquivo original de PDF e DOCX não é guardado.</p>
      {load.status === 'error' ? (
        <div className="mt-4 flex flex-col items-start gap-3">
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
      ) : load.status === 'loading' || quota === null ? (
        <div aria-busy="true" aria-label="Carregando armazenamento" className="mt-4 h-9 animate-pulse rounded-md bg-app" />
      ) : (
        <>
          <QuotaBar quota={quota} className="my-3" />
          <p className="mb-3 text-xs text-muted">{quota.text}.</p>
          <Button asChild variant="secondary" size="sm">
            <Link href="/configuracoes/arquivos">Ver arquivos ({load.count})</Link>
          </Button>
        </>
      )}
    </section>
  );
}
