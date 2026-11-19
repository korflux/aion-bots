'use client';

// Seção "Contas do conector" do editor do bot (phase 13, CONN-02; A13; decisão 7): as contas do Composio liberadas a ESTE bot, SÓ PARA LEITURA (nome ou rótulo automático, app e
// estado). Não há controle de edição de propósito: a liberação e o nome da conta têm uma única tela de edição, Configurações → Conexões, para não existirem duas fontes da mesma
// liberação; o texto da seção aponta para lá. O servidor confere a liberação de novo a cada execução (a seção é só informação para o dono, nunca permissão).
//
// Estados: carregando, com contas, sem conta liberada (o bot fica sem o Composio, A16), Composio ainda não conectado (orientação, não erro) e erro seguro com "Tentar novamente".
// `BotConnectorAccounts` busca; `BotConnectorAccountsView` só desenha um estado e é o que os testes de componente renderizam (sem DOM, as buscas não rodam).
import type { BotConnectorAccounts as BotConnectorAccountsResponse } from '@aion/shared';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ConnectorAccountStatusBadge } from '@/components/settings/status-badge';
import { Button } from '@/components/ui/button';
import { apiErrorMessage } from '@/lib/api-client';
import { fetchBotConnectorAccounts } from './bot-accounts-api';

type Account = BotConnectorAccountsResponse['accounts'][number];

/** Estado da carga da seção: o que a visão desenha. `not-configured` é o Composio sem chave (a API responde 200 com `configured: false`), que orienta em vez de acusar erro. */
export type BotAccountsLoad =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'not-configured' }
  | { status: 'ready'; accounts: Account[] };

/**
 * Traduz a resposta 200 da API no estado da carga: `configured: false` é o Composio ainda sem chave (orientação), e `true` traz as contas liberadas ao bot (a lista vazia é "nenhuma
 * conta liberada", um estado diferente). Pura e fora do efeito para os testes provarem a tradução sem DOM; falha de verdade (chave inválida, Composio fora do ar) chega como erro da busca.
 */
export function botAccountsLoadOf(response: BotConnectorAccountsResponse): BotAccountsLoad {
  return response.configured ? { status: 'ready', accounts: response.accounts } : { status: 'not-configured' };
}

/** Caminho da única tela onde a liberação se edita. */
const CONNECTIONS_HREF = '/configuracoes/conexoes';

/** Uma conta: o nome (ou o rótulo, que já traz o app) e, quando há nome do dono, o app logo abaixo; o estado à direita no desktop e abaixo no celular (o selo é o da tela de Conexões). */
function AccountRow({ account }: { account: Account }) {
  return (
    <li className="flex flex-col gap-2 border-b border-line py-3 first:pt-0 last:border-b-0 md:flex-row md:items-center md:justify-between md:gap-4">
      <div className="min-w-0">
        <p className="text-sm font-medium text-fg [overflow-wrap:anywhere]">{account.label}</p>
        {account.name === null ? null : <p className="text-[13px]/5 text-subtle [overflow-wrap:anywhere]">{account.appName}</p>}
      </div>
      <div className="shrink-0">
        <ConnectorAccountStatusBadge status={account.status} />
      </div>
    </li>
  );
}

/** Desenha um estado da seção. Puro: quem busca é `BotConnectorAccounts`. */
export function BotConnectorAccountsView({ load, onRetry }: { load: BotAccountsLoad; onRetry: () => void }) {
  return (
    <>
      <p className="text-sm text-muted">
        Contas do Composio que este bot pode usar. Para liberar, revogar ou dar nome a uma conta, use{' '}
        <Link href={CONNECTIONS_HREF} className="underline">
          Configurações → Conexões
        </Link>
        .
      </p>
      {load.status === 'loading' ? <div role="status" aria-busy="true" aria-label="Carregando contas do bot" className="h-11 animate-pulse rounded-md bg-surface" /> : null}
      {load.status === 'not-configured' ? <p className="text-sm text-muted">Conecte o Composio para poder liberar contas a este bot.</p> : null}
      {load.status === 'error' ? (
        <div className="flex flex-wrap items-center gap-3 text-sm text-muted">
          <p>{load.message}</p>
          <Button variant="secondary" size="sm" onClick={onRetry}>
            Tentar novamente
          </Button>
        </div>
      ) : null}
      {load.status === 'ready' && load.accounts.length === 0 ? (
        <p className="text-sm text-muted">Nenhuma conta liberada a este bot. Sem conta liberada, ele não usa o Composio.</p>
      ) : null}
      {load.status === 'ready' && load.accounts.length > 0 ? (
        <ul className="flex flex-col">
          {load.accounts.map((account) => (
            <AccountRow key={account.id} account={account} />
          ))}
        </ul>
      ) : null}
    </>
  );
}

/** Busca as contas liberadas ao bot e as entrega à visão; `key={botId}` do editor reinicia o estado ao trocar de bot, e o efeito refaz a busca por `botId` e `attempt`. */
export function BotConnectorAccounts({ botId }: { botId: string }) {
  const [load, setLoad] = useState<BotAccountsLoad>({ status: 'loading' });
  // Incrementar dispara nova busca ("Tentar novamente").
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetchBotConnectorAccounts(botId).then(
      (result) => {
        if (!cancelled) setLoad(botAccountsLoadOf(result));
      },
      (error: unknown) => {
        if (!cancelled) setLoad({ status: 'error', message: apiErrorMessage(error) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [botId, attempt]);

  return (
    <BotConnectorAccountsView
      load={load}
      onRetry={() => {
        setLoad({ status: 'loading' });
        setAttempt((value) => value + 1);
      }}
    />
  );
}
