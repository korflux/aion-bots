// Chamada da web à rota SÓ DE LEITURA das contas do conector (Composio) liberadas a um bot (phase 13, CONN-02; decisão 7). Único lugar que conhece esse caminho para a seção
// "Contas do conector" do editor do bot. A liberação e o nome da conta se alteram só em Configurações → Conexões (`settings/credentials-api.ts`), então aqui não há alteração
// nem token CSRF: a resposta não traz os outros bots da conta nem a versão, e nunca a chave do Composio (SEC-01).
import type { BotConnectorAccounts } from '@aion/shared';
import { apiFetch } from '@/lib/api-client';

/**
 * Contas liberadas ao bot, com o estado de cada uma lido ao vivo no Composio. O Composio sem chave NÃO é erro: vem como 200 com `configured: false` e lista vazia (a seção abre em toda
 * visita ao bot e orienta a conectar). Só a chave que existe e falha rejeita (`CONNECTOR_KEY_INVALID` ou `CONNECTOR_UNAVAILABLE`).
 */
export const fetchBotConnectorAccounts = (botId: string): Promise<BotConnectorAccounts> =>
  apiFetch<BotConnectorAccounts>(`/api/bots/${encodeURIComponent(botId)}/connector-accounts`);
