// Índice único da limpeza dos resultados de conector (CTX-12, phase 11, T4): o que o modelo lê no lugar do resultado gravado de `composio_execute_action`.
//
// O resultado gravado fica íntegro (até 256 KiB) e é o que `read_activity` devolve; a limpeza vale só para o texto que vai ao pedido. É uma função PURA do
// slug da ação e do texto gravado, sem relógio, rede nem estado, para a forma enviada ser a mesma em toda etapa, retomada e rodada (spec, decisão 4), e NUNCA
// lança: o que não consegue interpretar sai só pela camada genérica ou como veio. A moldura de dado não confiável e a ligação ao pedido são de quem chama
// (`runs/context.ts`).
//
// Fluxo de `shapeConnectorResult(slug, texto)`:
//   texto não é JSON (ou JSON truncado pela gravação) -> só a camada genérica de texto (`cleanString`)
//   texto é JSON -> regras do conector dono do slug (se houver arquivo) -> camada genérica (`renderGeneric`): limpa, tira repetição e escreve o texto
//   O resultado nunca é maior que o texto gravado: se a limpeza não encurtar, vale o texto gravado.
//
// COMO ADICIONAR UM CONECTOR NOVO (sem tocar no executor nem nos arquivos dos outros conectores):
//   1. Criar `<conector>.ts` aqui ao lado e exportar um `ConnectorShaper` (ver `types.ts`): `connector` (o nome), `actionPrefixes` (os prefixos do slug das ações,
//      como `GMAIL_`; o slug é o da ação do Composio, por exemplo `GMAIL_FETCH_EMAILS`) e `shape(slug, json)`, que tira do JSON o que o modelo não usa. Regra por
//      ação é um `if` ou uma tabela por slug dentro de `shape`, como `ACTION_RULES` em `gmail.ts`.
//   2. Registrá-lo na lista `SHAPERS` abaixo (uma linha).
//   3. Escrever a fixture anonimizada em `fixtures.ts` e o caso em `result-shaping.test.ts`: o texto útil presente, o tamanho menor e as URLs intactas.
//   Conector sem arquivo (qualquer um além de Gmail, Notion e Google Calendar) já passa pela camada genérica, sem nenhum passo acima; o mesmo vale para uma ação de
//   um conector com arquivo que não tem regra própria (por exemplo, uma ação `GOOGLECALENDAR_` além das duas de listagem de eventos).
import { gmailShaper } from './gmail';
import { cleanString, parseStoredJson, renderGeneric } from './generic';
import { googleCalendarShaper } from './google-calendar';
import { notionShaper } from './notion';
import type { ConnectorShaper } from './types';

/** Conectores com regras próprias, consultados pelo prefixo do slug; o primeiro que reconhece a ação vale. */
const SHAPERS: readonly ConnectorShaper[] = [gmailShaper, notionShaper, googleCalendarShaper];

/** O conector dono do slug, ou `undefined` (então só a camada genérica se aplica). */
function shaperFor(actionSlug: string): ConnectorShaper | undefined {
  return SHAPERS.find((shaper) => shaper.actionPrefixes.some((prefix) => actionSlug.startsWith(prefix)));
}

/**
 * O resultado de uma ação do conector como o modelo o lê, limpo. `actionSlug` é o slug da ação como o Composio o nomeia; `storedText` é o texto gravado do
 * resultado. Vazio depois da limpeza (resultado só de nulos) devolve o texto gravado, para o modelo nunca receber um resultado em branco.
 */
export function shapeConnectorResult(actionSlug: string, storedText: string): string {
  try {
    if (typeof storedText !== 'string') return '';
    const slug = typeof actionSlug === 'string' ? actionSlug.trim().toUpperCase() : '';
    const parsed = parseStoredJson(storedText);
    let shaped: string;
    if (parsed === undefined) {
      // ponytail: JSON gravado truncado acima de 256 KiB não é lido (não parseia) e recebe só a limpeza de texto, sem as regras do conector, melhorar se resultados reais do conector passarem desse tamanho com frequência
      shaped = cleanString(storedText);
    } else {
      let data = parsed.value;
      const shaper = shaperFor(slug);
      if (shaper !== undefined) {
        try {
          data = shaper.shape(slug, data);
        } catch {
          // Regra do conector falhou num formato inesperado: segue só pela genérica, com o JSON como veio.
          data = parsed.value;
        }
      }
      shaped = renderGeneric(data);
    }
    return shaped !== '' && shaped.length < storedText.length ? shaped : storedText;
  } catch {
    return typeof storedText === 'string' ? storedText : '';
  }
}
