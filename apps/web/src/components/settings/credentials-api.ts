// Chamadas da tela de Configurações às chaves de terceiros (F3 e F4, mais a chave opcional da Parallel) e utilitários de estado compartilhados por
// Provedores, Conectores e Pesquisa na web. A chave só viaja no corpo do POST de salvar; nenhuma chamada abaixo a recebe de volta:
// a API devolve só o estado mascarado.
import {
  type ConnectorAccountView,
  type ConnectorAccountsResponse,
  type CredentialKind,
  type CredentialStatus,
  type CredentialsOverview,
  type ReleaseConnectorAccountRequest,
  type RenameConnectorAccountRequest,
} from '@aion/shared';
import { useEffect, useState } from 'react';
import { ApiError, apiFetch } from '@/lib/api-client';

/** Estado das duas chaves (configurada ou não e versão mascarada); sem chamada externa no servidor. */
export const fetchCredentials = () => apiFetch<CredentialsOverview>('/api/credentials');

/** Envia a chave para validar e salvar (ou substituir). É o único ponto em que a chave sai do navegador. */
export const saveCredential = (kind: CredentialKind, key: string, csrfToken: string) =>
  apiFetch<CredentialStatus>(`/api/credentials/${kind}`, { method: 'POST', body: { key }, csrfToken });

/** Apaga a chave guardada no servidor. */
export const disconnectCredential = (kind: CredentialKind, csrfToken: string) =>
  apiFetch(`/api/credentials/${kind}`, { method: 'DELETE', csrfToken });

// Contas do Composio liberadas por bot (phase 13, CONN-02): a tela de Conexões lê uma linha por conta e altera só o nome e os bots liberados. Nenhuma resposta traz a chave.

/** Todas as contas conhecidas (ativas e desconectadas), lidas ao vivo pelo servidor com a chave guardada. */
export const fetchConnectorAccounts = () => apiFetch<ConnectorAccountsResponse>('/api/connector/accounts');

/** Dá nome à conta, ou volta ao rótulo automático com `name: null`. A versão é a que a tela leu: versão antiga volta `CONNECTOR_ACCOUNT_CONFLICT`. */
export const renameConnectorAccount = (id: string, request: RenameConnectorAccountRequest, csrfToken: string) =>
  apiFetch<ConnectorAccountView>(`/api/connector/accounts/${encodeURIComponent(id)}`, { method: 'PATCH', body: request, csrfToken });

/** Define a lista COMPLETA de bots que usam a conta; quem sai da lista perde o acesso. */
export const releaseConnectorAccount = (id: string, request: ReleaseConnectorAccountRequest, csrfToken: string) =>
  apiFetch<ConnectorAccountView>(`/api/connector/accounts/${encodeURIComponent(id)}/access`, { method: 'PUT', body: request, csrfToken });

/**
 * Remove a conta DESCONECTADA (a que o Composio não lista mais) e as liberações dela; 204 sem corpo. O servidor confere o estado ao vivo e recusa a conta que o Composio ainda lista com
 * `CONNECTOR_ACCOUNT_CONFLICT` (tela desatualizada), a já removida com `NOT_FOUND` e, com o Composio fora do ar, o erro de leitura, sem apagar nada.
 */
export const removeConnectorAccount = (id: string, csrfToken: string) => apiFetch(`/api/connector/accounts/${encodeURIComponent(id)}`, { method: 'DELETE', csrfToken });

/** Estado de uma credencial recém-desconectada (a API não devolve corpo no DELETE). */
export const unconfiguredStatus = (kind: CredentialKind): CredentialStatus => ({
  kind,
  configured: false,
  masked: null,
  updatedAt: null,
  modelCount: null,
});

/**
 * Mensagem segura para exibir: as mensagens da API já vêm sem detalhe técnico. Só a validação do corpo ganha
 * texto próprio, porque a mensagem genérica ("Dados inválidos.") não diz o que corrigir na chave.
 */
export function credentialErrorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return 'Não foi possível concluir. Tente novamente.';
  if (error.code === 'VALIDATION_FAILED') return 'Chave inválida: use de 1 a 512 caracteres, sem espaços.';
  return error.message;
}

/**
 * Mensagem segura de uma alteração de conta (nome ou liberação). As mensagens da API já vêm sem detalhe técnico ("Já existe uma conta com esse nome neste app.", "As contas mudaram.
 * Recarregue antes de salvar."); só a validação do corpo ganha o texto de quem chama, porque a genérica ("Dados inválidos.") não diz o que corrigir.
 */
export function connectorAccountErrorMessage(error: unknown, validationMessage: string): string {
  if (error instanceof ApiError && error.code === 'VALIDATION_FAILED') return validationMessage;
  return credentialErrorMessage(error);
}

/** A alteração falhou porque a tela está desatualizada (versão antiga, conta ou bot que já não existem): o remédio é recarregar as contas, não tentar de novo. */
export const isStaleAccountError = (error: unknown): boolean =>
  error instanceof ApiError && (error.code === 'CONNECTOR_ACCOUNT_CONFLICT' || error.code === 'BOT_NOT_FOUND' || error.code === 'NOT_FOUND');

/**
 * Carrega o estado de uma credencial obrigatória (provedor ou conector, as que a visão geral traz). `setStatus` permite atualizar localmente depois
 * de salvar ou desconectar. A chave opcional da pesquisa na web não passa por aqui: seu estado vem junto do interruptor (`fetchWebSearchSettings`).
 */
export function useCredentialStatus(kind: keyof CredentialsOverview) {
  const [status, setStatus] = useState<CredentialStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Incrementar força uma nova carga (botão "Tentar novamente").
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetchCredentials().then(
      (overview) => {
        if (cancelled) return;
        setStatus(overview[kind]);
        setError(null);
      },
      (caught: unknown) => {
        if (!cancelled) setError(credentialErrorMessage(caught));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [kind, reloadKey]);

  return { status, error, setStatus, reload: () => setReloadKey((key) => key + 1) };
}
