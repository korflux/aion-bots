// Contratos das preferências gerais do dono (T28): o idioma em que os bots respondem e o fuso horário. Compartilhados entre a API, o core
// e a web. Hoje são duas escolhas globais (dono único): o idioma entra na seção "Dados" do turno de sistema do modelo ("- Idioma: ...") e o fuso,
// no bloco "# Dados" do pedido atual ("Agora" e "Fuso", phase 3) e como padrão das rotinas novas (cada rotina continua guardando o próprio fuso).
// Phase 5, T4: "Como te chamar" (`ownerName`) é a terceira preferência, só de APRESENTAÇÃO (a saudação do Início): nunca entra no contexto dos
// modelos, nos logs nem na auditoria (que só registra se mudou).
//
// ponytail: o idioma só decide em que língua os bots respondem; a interface do Aion segue em português do Brasil. Traduzir as telas só se o
// dono passar a usar o app em outra língua.
import { z } from 'zod';
import { credentialStatusSchema } from './credentials';
import { DEFAULT_ROUTINE_TIMEZONE, timezoneSchema } from './routines';

/** Códigos de idioma aceitos (allowlist: o servidor nunca grava um idioma de fora desta lista). */
export const LANGUAGE_CODES = ['pt-BR', 'en', 'es'] as const;
export type LanguageCode = (typeof LANGUAGE_CODES)[number];
export const languageCodeSchema = z.enum(LANGUAGE_CODES);

/**
 * O que cada idioma é para a tela (`label`, no próprio idioma), para o modelo (`instruction`, a linha "- Idioma" da seção "Dados" do contexto) e para a
 * formatação da data e hora do contexto (`locale`). Acrescentar um idioma é acrescentar o código acima e uma linha aqui.
 */
export const LANGUAGES: Record<LanguageCode, { label: string; instruction: string; locale: string }> = {
  'pt-BR': { label: 'Português (Brasil)', instruction: 'português do Brasil', locale: 'pt-BR' },
  en: { label: 'English', instruction: 'inglês (English)', locale: 'en-US' },
  es: { label: 'Español', instruction: 'espanhol (español)', locale: 'es-ES' },
};

/** Tamanho máximo, em caracteres (pontos de código, não unidades UTF-16), de "Como te chamar" depois de aparado. */
export const OWNER_NAME_MAX_CHARS = 40;

/** Caracteres de controle (C0, DEL e C1) e os separadores de linha e parágrafo Unicode: invisíveis, quebram a linha da saudação e não são nome. */
const OWNER_NAME_FORBIDDEN = /[\p{Cc}\p{Zl}\p{Zp}]/u;

/**
 * "Como te chamar": texto aparado (os espaços das pontas saem ANTES de contar e de conferir) de 0 a 40 caracteres, sem caracteres de controle;
 * vazio é válido e significa "sem nome". Fonte única da borda da API, do core e da conferência que a tela faz antes de enviar.
 */
export const ownerNameSchema = z
  .string()
  .trim()
  .refine((value) => Array.from(value).length <= OWNER_NAME_MAX_CHARS, { message: 'Use até 40 caracteres.' })
  .refine((value) => !OWNER_NAME_FORBIDDEN.test(value), { message: 'Sem símbolos de controle.' });

/**
 * Preferências gerais: usadas na leitura e na gravação (a gravação aceita só estes três campos, todos juntos: o PUT leva o objeto completo). A
 * existência do fuso no banco de fusos é conferida pelo core.
 */
export const appSettingsSchema = z.strictObject({ language: languageCodeSchema, timeZone: timezoneSchema, ownerName: ownerNameSchema });
export type AppSettings = z.infer<typeof appSettingsSchema>;

/**
 * O recorte das preferências que o motor dos bots e do Chat geral pode ler (contexto do modelo, rotinas): idioma e fuso. O nome do dono NÃO faz
 * parte, de propósito: quem monta contexto recebe este tipo e, por isso, não tem como incluí-lo.
 */
export type ContextSettings = Pick<AppSettings, 'language' | 'timeZone'>;

/** Valores de quem ainda não escolheu nada (o comportamento anterior ao T28; sem nome). */
export const DEFAULT_APP_SETTINGS: AppSettings = { language: 'pt-BR', timeZone: DEFAULT_ROUTINE_TIMEZONE, ownerName: '' };

// ---------------------------------------------------------------------------------------------
// Pesquisa na web (phase 1, T8): interruptor global e estado da chave opcional da Parallel.
// ---------------------------------------------------------------------------------------------

/**
 * Corpo do PUT que liga ou desliga a pesquisa na web: um booleano estrito (nada de texto, número nem campo extra). O interruptor vale a
 * partir da próxima execução dos bots e do Chat geral.
 */
export const webSearchToggleSchema = z.strictObject({ enabled: z.boolean() });
export type WebSearchToggle = z.infer<typeof webSearchToggleSchema>;

/**
 * O que a tela de Configurações → Pesquisa na web lê: o interruptor (ligado por padrão) e o estado da chave opcional (anônimo, ou conectada
 * com a versão mascarada). A chave inteira nunca está em nenhuma resposta; este schema, que descarta campos desconhecidos, é a segunda barreira.
 */
export const webSearchSettingsSchema = z.object({ enabled: z.boolean(), key: credentialStatusSchema });
export type WebSearchSettings = z.infer<typeof webSearchSettingsSchema>;

// ---------------------------------------------------------------------------------------------
// Python (phase 4, F11): estado do serviço sandbox, conferido pelo servidor.
// ---------------------------------------------------------------------------------------------

/**
 * Estado do Python em Configurações → Python: `not_installed` (o servidor não tem o endereço e o token do sandbox), `available` (a conferência de
 * saúde respondeu em até 3 s) ou `unavailable` (configurado, mas o sandbox não respondeu ou ainda está aquecendo). O navegador nunca recebe o
 * endereço nem o token do sandbox; só este estado.
 */
export const PYTHON_STATUSES = ['available', 'not_installed', 'unavailable'] as const;
export const pythonStatusSchema = z.object({ status: z.enum(PYTHON_STATUSES) });
export type PythonStatus = z.infer<typeof pythonStatusSchema>;
