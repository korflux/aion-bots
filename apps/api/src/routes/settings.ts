// Rotas das preferências gerais do dono: ler e gravar o idioma das respostas dos bots, o fuso horário (T28) e "Como te chamar" (phase 5, T4), e ligar ou
// desligar a pesquisa na web (phase 1, T8). Casca fina: a regra (allowlist de idioma, fuso que existe no runtime, auditoria) vive em SettingsService
// (core) e o formato dos dados nos schemas de @aion/shared. As preferências de contexto (janelas por escopo e "Modelo do resumo", phase 9 T4) têm rota
// própria, `/settings/context`, com o mesmo contrato de borda estrita.
// Python (phase 4, F11): `GET /settings/python` devolve só o estado do sandbox ("disponível", "não instalado" ou "indisponível agora").
//
// Segurança: nenhuma rota é pública, então o hook de segurança exige sessão válida e, no PUT, Origin e token CSRF. O corpo aceita só `language`,
// `timeZone` e `ownerName` (campos extras recusados, 422 no envelope padrão); um fuso, idioma ou nome inválido (mais de 40 caracteres ou com caractere de
// controle; os espaços das pontas saem) nunca chega ao banco. O nome é entrada do dono e não vai a log nem à auditoria (o corpo não é logado). O PUT da pesquisa na web aceita só
// `{ enabled: boolean }`. A leitura da pesquisa na web traz o estado da chave só mascarado (a chave nunca sai do servidor; salvar e desconectar a
// chave são as rotas de credenciais, tipo `web_search`, com o limite de validações compartilhado).
import type { CredentialService, PythonSandboxClient, SettingsService } from '@aion/core';
import { contextPreferencesViewSchema, contextPreferenceUpdateSchema, appSettingsSchema, pythonStatusSchema, webSearchSettingsSchema, webSearchToggleSchema } from '@aion/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { originOf } from './origin';

export interface SettingsRoutesOptions {
  settings: SettingsService;
  /** Só lê o estado mascarado da chave da pesquisa na web para a tela (`statusOf`). */
  credentials: CredentialService;
  /** Conferência de saúde do sandbox (phase 4, F11); nulo sem a configuração do sandbox. */
  python: Pick<PythonSandboxClient, 'health'> | null;
}

export const settingsRoutes: FastifyPluginAsyncZod<SettingsRoutesOptions> = async (app, { settings, credentials, python }) => {
  app.get('/settings', { schema: { response: { 200: appSettingsSchema } } }, async () => settings.read());

  app.put('/settings', { schema: { body: appSettingsSchema, response: { 200: appSettingsSchema } } }, async (request) =>
    settings.update(request.body, originOf(request)),
  );

  // Cada escrita altera apenas uma preferência de contexto (a janela de um escopo ou o "Modelo do resumo", phase 9 T4); a borda comum exige sessão, Origin e CSRF.
  // O modelo do resumo precisa ser um modelo validado: o serviço recusa os demais com VALIDATION_FAILED no campo `summaryModel`, no envelope padrão. A resposta
  // traz sempre as janelas e o modelo (nulo = o modelo de cada conversa).
  app.get('/settings/context', { schema: { response: { 200: contextPreferencesViewSchema } } }, async () => settings.readContextPreferences());
  app.put('/settings/context', { bodyLimit: 1024, schema: { body: contextPreferenceUpdateSchema, response: { 200: contextPreferencesViewSchema } } },
    async (request) => settings.updateContextPreference(request.body, originOf(request)));

  // Pesquisa na web (Configurações → Pesquisa na web): o interruptor e o estado da chave opcional (anônimo, ou conectada com a máscara).
  const readWebSearch = async () => ({ enabled: await settings.readWebSearchEnabled(), key: await credentials.statusOf('web_search') });

  app.get('/settings/web-search', { schema: { response: { 200: webSearchSettingsSchema } } }, readWebSearch);

  // Liga ou desliga; vale a partir da próxima execução. Devolve o estado completo como ficou, para a tela não precisar de uma segunda leitura.
  app.put('/settings/web-search', { schema: { body: webSearchToggleSchema, response: { 200: webSearchSettingsSchema } } }, async (request) => {
    await settings.setWebSearchEnabled(request.body.enabled, originOf(request));
    return readWebSearch();
  });

  // Python (phase 4, F11): o estado vem da conferência de saúde feita AQUI, no servidor, com o token e prazo de 3 s; o navegador nunca fala com o
  // sandbox nem recebe o endereço ou o token. Sem a configuração, "não instalado" sem nenhuma chamada.
  app.get('/settings/python', { schema: { response: { 200: pythonStatusSchema } } }, async () => ({ status: python ? await python.health() : ('not_installed' as const) }));
};
