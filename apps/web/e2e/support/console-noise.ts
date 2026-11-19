// Filtro do ruído de console que NÃO é do Aion: o antivírus da máquina de desenvolvimento injeta um script nas páginas do E2E.
// Módulo puro (sem importar o Playwright) de propósito: o Vitest do web o importa em `src/lib/console-noise.test.ts`, porque o
// Playwright trataria qualquer `*.test.ts` dentro de `e2e/` como spec e o Vitest só enxerga `src/**`.
//
// Origem do ruído (ver `.erros-encontrados/2026-10-02-e2e-antivirus-injeta-script-e-polui-o-console.md`): o Kaspersky injeta um script no
// HTML servido por http://127.0.0.1, e o XHR dele a `*.kaspersky-labs.com` leva o cabeçalho de IP que `extraHTTPHeaders` (fixtures.ts)
// coloca em TODA requisição do contexto, então o preflight de CORS falha e o Chromium registra um erro de console.

/**
 * Erro de CORS de um XHR do Chromium para um subdomínio de `kaspersky-labs.com`. O host é só rótulos DNS (`[a-z0-9-]`) mais porta opcional,
 * e a barra que vem depois dele é obrigatória: assim `evil.com?x=.kaspersky-labs.com/` e `kaspersky-labs.com.evil.com/` NÃO passam
 * (um `[^/]*` solto no host aceitaria a origem estranha com o domínio do antivírus escondido na query).
 */
const ANTIVIRUS_CORS_ERROR = /^Access to XMLHttpRequest at 'https?:\/\/(?:[a-z0-9-]+\.)+kaspersky-labs\.com(?::\d+)?\/[^']*' from origin '[^']*' has been blocked by CORS policy/;

/**
 * A mensagem de console é o erro de CORS do script do antivírus (deve ser ignorada pelo `watchPage`)? Só esse domínio é ignorado: um erro
 * de CORS de qualquer outra origem (o Firebase, por exemplo) continua contando como problema do Aion.
 */
export function isAntivirusNoise(consoleText: string): boolean {
  return ANTIVIRUS_CORS_ERROR.test(consoleText);
}
