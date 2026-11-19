// Texto que o bot lê ao procurar ações de um app no Composio (T29). Em vez de despejar o JSON Schema inteiro de cada ação (grande, repetitivo e
// o que mais pesa no contexto), mostra os parâmetros como uma lista curta: nome, tipo, se é obrigatório e uma linha de descrição. O modelo lê
// isso como PRÉVIA PARCIAL. As primeiras ações trazem parâmetros resumidos; as demais só nome e descrição. O contrato completo é recuperável pela
// mesma busca com app+action+offset, juntando páginas com sourceHash igual; estruturas aninhadas e campos omitidos não são inferidos da prévia.
//
// O catálogo do Composio é dado externo: tudo aqui é cortado em tamanho (um app com esquemas gigantes não pode estourar o contexto) e nada além
// do que o Composio descreve é repetido.
import type { ConnectorTool } from '../credentials/composio';

/** Quantas ações da busca trazem os parâmetros; as demais vêm só com nome e descrição. */
export const SEARCH_RESULTS_WITH_PARAMETERS = 3;
const DESCRIPTION_MAX = 240;
const SHORT_DESCRIPTION_MAX = 160;
const PARAMETER_DESCRIPTION_MAX = 140;
const PARAMETERS_MAX = 25;
const ENUM_VALUES_MAX = 8;

/** Texto em uma linha e no máximo `max` caracteres (com reticências quando corta). */
function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** O tipo de um parâmetro em poucas palavras: `string`, `array<string>`, `enum: a|b`, `string|null`... */
function typeLabel(property: Record<string, unknown>): string {
  if (Array.isArray(property.enum) && property.enum.length > 0) {
    const values = property.enum.slice(0, ENUM_VALUES_MAX).map((value) => String(value));
    return `enum: ${values.join('|')}${property.enum.length > ENUM_VALUES_MAX ? '|…' : ''}`;
  }
  const type = property.type;
  const base = Array.isArray(type) ? type.join('|') : typeof type === 'string' ? type : 'qualquer';
  if (base === 'array') {
    const items = property.items;
    const inner = items !== null && typeof items === 'object' && typeof (items as { type?: unknown }).type === 'string' ? (items as { type: string }).type : 'qualquer';
    return `array<${inner}>`;
  }
  return base;
}

/**
 * Os parâmetros de uma ação, um por linha: `- nome (tipo, obrigatório): descrição`. Sem parâmetros, "nenhum". Passando de `PARAMETERS_MAX`, os
 * obrigatórios vêm primeiro e o resto é resumido numa linha com a contagem.
 */
export function describeParameters(schema: Record<string, unknown>): string {
  const raw = schema.properties;
  const properties = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const required = new Set(Array.isArray(schema.required) ? schema.required.map((name) => String(name)) : []);
  const names = Object.keys(properties).sort((a, b) => Number(required.has(b)) - Number(required.has(a)));
  if (names.length === 0) return '   Parâmetros: nenhum.';
  const shown = names.slice(0, PARAMETERS_MAX).map((name) => {
    const property = (properties[name] !== null && typeof properties[name] === 'object' ? properties[name] : {}) as Record<string, unknown>;
    const description = typeof property.description === 'string' && property.description.trim() !== '' ? `: ${oneLine(property.description, PARAMETER_DESCRIPTION_MAX)}` : '';
    return `   - ${name} (${typeLabel(property)}${required.has(name) ? ', obrigatório' : ''})${description}`;
  });
  const omitted = names.length - shown.length;
  const requiredOmitted = names.slice(PARAMETERS_MAX).filter((name) => required.has(name)).length;
  return ['   Parâmetros:', ...shown, ...(omitted > 0 ? [requiredOmitted > 0 ? `   (+${requiredOmitted} obrigatórios e ${omitted - requiredOmitted} opcionais omitidos)` : `   (+${omitted} parâmetros opcionais omitidos)`] : [])].join('\n');
}

/**
 * O resultado de `composio_search_actions`: as ações achadas (as primeiras com os parâmetros) e a instrução do passo seguinte. Sem resultado,
 * diz como tentar de novo (as ações do Composio têm nome em inglês, então a busca em inglês costuma achar mais).
 */
export function formatSearchResults(app: { slug: string; name: string }, query: string, tools: readonly ConnectorTool[]): string {
  const where = `${app.name} (${app.slug})`;
  if (tools.length === 0) {
    return `Nenhuma ação de ${where} combinou com "${query}". Tente outras palavras; os nomes das ações estão em inglês (por exemplo "send email" ou "create page").`;
  }
  const lines = tools.map((tool, index) => {
    const head = `${index + 1}. ${tool.slug} — ${tool.name}`;
    if (index < SEARCH_RESULTS_WITH_PARAMETERS) {
      const description = tool.description === '' ? [] : [`   ${oneLine(tool.description, DESCRIPTION_MAX)}`];
      return [head, ...description, describeParameters(tool.inputSchema)].join('\n');
    }
    return `${head}${tool.description === '' ? '' : `: ${oneLine(tool.description, SHORT_DESCRIPTION_MAX)}`}`;
  });
  return [
    `Ações de ${where} para "${query}" (${tools.length}):`,
    '',
    ...lines,
    '',
    'Prévia parcial: descrições, enums, parâmetros e estruturas aninhadas podem estar resumidos. Para o esquema completo, use composio_search_actions com app, action igual ao slug e offset 0; avance nextOffset até null.',
    'Para executar, chame composio_execute_action com action igual ao slug e arguments com os parâmetros.',
  ].join('\n');
}
