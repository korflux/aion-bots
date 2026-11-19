// Destino pós-login (`?next=`) seguro. O valor vem da URL, ou seja, de fora: aceitar qualquer coisa seria
// um open redirect (o atacante monta um link de login que, depois de o dono digitar a senha, o leva a um
// site falso). Só caminhos relativos internos passam; o resto cai no destino padrão: o Início (`/`, phase 5 T5; antes `/bots`). `/bots` segue abrindo o último bot
// para quem chega por um link antigo, e um `next` válido continua respeitado.

/** Origin fictício só para o `URL` resolver o caminho e revelar se ele escaparia da origem do app. */
const PLACEHOLDER_ORIGIN = 'http://aion.invalid';

/** Para onde o login leva sem `next` (ou com um `next` recusado): o Início. */
export const DEFAULT_AFTER_LOGIN = '/';

export function safeNextPath(raw: string | null | undefined, fallback: string = DEFAULT_AFTER_LOGIN): string {
  if (!raw) return fallback;
  // Precisa ser caminho absoluto interno: "/x", nunca "//host" (protocol-relative) nem "/\host".
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return fallback;
  // Caracteres de controle e barras invertidas são usados para confundir parsers e forçar quebras de cabeçalho.
  if (/[\u0000-\u001f\u007f\\]/.test(raw)) return fallback;

  try {
    const url = new URL(raw, PLACEHOLDER_ORIGIN);
    if (url.origin !== PLACEHOLDER_ORIGIN) return fallback;
    // Voltar para o próprio login criaria um laço.
    if (url.pathname === '/login' || url.pathname.startsWith('/login/')) return fallback;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return fallback;
  }
}
