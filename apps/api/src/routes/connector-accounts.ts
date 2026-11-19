// Rotas das contas do conector (Composio) liberadas por bot (phase 13, CONN-02; spec decisões 6 a 8; A11, A12, A13, A19). Casca fina: nome, liberação, versão esperada e auditoria
// vivem em `ConnectorAccountService` (core), e o formato dos dados (allowlist, tamanhos, campos extras recusados) nos schemas de `@aion/shared`, aplicados pelo Fastify na borda.
//
//   GET  /connector/accounts              as contas conhecidas, uma linha por conta (nome ou rótulo, estado, bots liberados, versão): a tela de Conexões
//   PATCH /connector/accounts/:id         dá nome à conta, ou volta ao rótulo automático com `name: null`
//   PUT  /connector/accounts/:id/access   define QUAIS bots usam a conta (a lista completa; quem sai perde o acesso)
//   DELETE /connector/accounts/:id        remove a conta DESCONECTADA (que o Composio não lista mais), com as liberações dela; 204 sem corpo (R8)
//   GET  /bots/:id/connector-accounts    as contas liberadas a UM bot, só leitura: a seção do editor do bot (decisão 7: a liberação tem uma única tela de edição);
//                                         sem chave do Composio responde 200 `configured: false` com lista vazia, em vez do erro da lista de Conexões
//
// Segurança (decisão 8 da spec, A19): nenhuma rota é pública, então o hook central de `plugins/security.ts` exige sessão válida e, nas que alteram estado (PATCH, PUT e DELETE), Origin e token
// CSRF; nada disso se repete aqui. A conta (`:id`, no alfabeto dos ids do Composio) e o bot (UUID) da URL são validados antes de chegar ao serviço, que ainda confere que existem
// (`NOT_FOUND`, `BOT_NOT_FOUND`); os corpos são `strictObject`, então campo fora do permitido é recusado com `VALIDATION_FAILED`; a versão antiga volta `CONNECTOR_ACCOUNT_CONFLICT` e
// o nome repetido no app `CONNECTOR_ACCOUNT_NAME_TAKEN`, ambos exceções de domínio traduzidas pelo handler central. As rotas não convertem erro, com UMA exceção: a do bot (`GET /bots/:id/connector-accounts`)
// transforma `CONNECTOR_NOT_CONFIGURED` em 200 `configured: false` (estado normal da seção do editor), e todo outro erro sobe ao handler central. Nenhuma resposta carrega a chave do Composio
// (SEC-01): o serviço nunca a vê (a leitura das contas é de `CredentialService`) e os schemas de resposta descartam o que não está no contrato.
import { DomainError, type ConnectorAccountService } from '@aion/core';
import {
  botConnectorAccountsSchema,
  botIdParamsSchema,
  connectorAccountParamsSchema,
  connectorAccountViewSchema,
  connectorAccountsResponseSchema,
  releaseConnectorAccountRequestSchema,
  renameConnectorAccountRequestSchema,
} from '@aion/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { originOf } from './origin';

/** Corpo máximo das alterações: a maior (liberar a 100 bots) tem cerca de 4 KiB, então 8 KiB cobrem o contrato com folga e o resto é recusado antes de qualquer leitura (`PAYLOAD_TOO_LARGE`). */
const CONNECTOR_ACCOUNTS_BODY_LIMIT = 8 * 1024;

export interface ConnectorAccountRoutesOptions {
  accounts: ConnectorAccountService;
}

export const connectorAccountRoutes: FastifyPluginAsyncZod<ConnectorAccountRoutesOptions> = async (app, { accounts }) => {
  // Lê o Composio ao vivo (o estado de cada conta) e grava as contas novas; falha da leitura (`CONNECTOR_NOT_CONFIGURED`, `CONNECTOR_KEY_INVALID`, `CONNECTOR_UNAVAILABLE`) sobe como está.
  app.get('/connector/accounts', { schema: { response: { 200: connectorAccountsResponseSchema } } }, async () => ({ accounts: await accounts.list() }));

  // As duas alterações respondem com a conta lida de novo (`get`), com o estado ao vivo, que é o que a tela mostra: o serviço devolve só o que o banco guarda.
  // Se o Composio sair do ar entre a gravação e essa leitura, a alteração já valeu e a resposta é o erro de leitura (a tela recarrega a lista e vê o resultado).
  app.patch(
    '/connector/accounts/:id',
    { bodyLimit: CONNECTOR_ACCOUNTS_BODY_LIMIT, schema: { params: connectorAccountParamsSchema, body: renameConnectorAccountRequestSchema, response: { 200: connectorAccountViewSchema } } },
    async (request) => {
      await accounts.rename(request.params.id, request.body, originOf(request));
      return accounts.get(request.params.id);
    },
  );

  app.put(
    '/connector/accounts/:id/access',
    { bodyLimit: CONNECTOR_ACCOUNTS_BODY_LIMIT, schema: { params: connectorAccountParamsSchema, body: releaseConnectorAccountRequestSchema, response: { 200: connectorAccountViewSchema } } },
    async (request) => {
      await accounts.release(request.params.id, request.body, originOf(request));
      return accounts.get(request.params.id);
    },
  );

  // Remove a conta desconectada (R8). O serviço lê o Composio ao vivo e só apaga a conta que ele NÃO lista: a que ele lista (ativa, pendente ou que requer atenção) volta 409
  // `CONNECTOR_ACCOUNT_CONFLICT`, a desconhecida 404 `NOT_FOUND` e a leitura que falha (Composio fora do ar, chave inválida) sobe como está, sem apagar nada. Sem corpo nem versão esperada.
  app.delete('/connector/accounts/:id', { schema: { params: connectorAccountParamsSchema } }, async (request, reply) => {
    await accounts.remove(request.params.id, originOf(request));
    return reply.status(204).send();
  });

  // Só leitura: o editor do bot mostra as contas liberadas a ele, sem os outros bots da conta nem a versão.
  // Diferente da lista de Conexões, o Composio SEM CHAVE não é erro aqui: a seção abre em toda visita ao bot e "ainda não conectado" é um estado normal que a tela orienta, então a
  // resposta é 200 com `configured: false` e lista vazia. `forBot` confere o bot (`BOT_NOT_FOUND` segue 404) e só depois pede a chave, que é lida antes de qualquer chamada ao Composio:
  // sem chave nada é chamado nem gravado. Só `CONNECTOR_NOT_CONFIGURED` vira estado; `CONNECTOR_KEY_INVALID` e `CONNECTOR_UNAVAILABLE` (a chave existe e falhou) sobem como erro.
  app.get('/bots/:id/connector-accounts', { schema: { params: botIdParamsSchema, response: { 200: botConnectorAccountsSchema } } }, async (request) => {
    try {
      return { configured: true, accounts: await accounts.forBot(request.params.id) };
    } catch (error) {
      if (error instanceof DomainError && error.code === 'CONNECTOR_NOT_CONFIGURED') return { configured: false, accounts: [] };
      throw error;
    }
  });
};
