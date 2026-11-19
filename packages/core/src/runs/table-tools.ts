// Catálogo local de tabelas: origem do bot vem exclusivamente da execução. Nenhuma ferramenta concede compartilhamento. As que criam ou alteram uma tabela (importar, criar, atualizar, gravar e as vistas)
// devolvem também a referência dela (`ToolOutcome.artifacts`, A4 da phase 14), com o nome lido do banco, para a conversa mostrar o cartão do artefato.
import { z } from 'zod';
import { tableImportToolSchema, tableImportToolParametersSchema, TABLE_IMPORT_DOCUMENT_EXAMPLE, type ArtifactRef, type TableImportToolInput } from '@aion/shared';
import { importAttachment } from '../tables/attachment-import';
import { ERROR_CODES, tableIdSchema, tableCreateSchema, tableUpdateSchema, tableWriteSchema, tableRecordCreateSchema, tableRecordUpdateSchema, tableValuesSchema, tableFilterSchema, tableFormulaSchema, tableFormulaPreviewSchema as tableFormulaPreviewBase, FORMULA_OPERATORS, FORMULA_TYPES, tableVersionSchema, tableQuerySchema, tableViewCreateSchema as tableViewCreateBase, tableViewUpdateSchema as tableViewUpdateBase, tableViewRemoveSchema, tableDestructiveSchema, tableConfirmSchema, type TableDestructive } from '@aion/shared';
import { DomainError } from '../errors';
import { TableService, type TableActor } from '../tables/service';
import { withModelColumns } from '../tables/model-format';
import { AmbiguousRecordError, normalizeRecordRef, recordRefSchema } from '../tables/record-prefix';
import { readTableRemovalReceipt } from '../tables/removal-receipt';
import { TABLE_ACTIONS } from '../tables/actions';
import { mergeEvidence, type EvidenceProvenance } from './evidence-provenance';

import { modelJsonSchema } from './tool-arguments';
import { defineTool, toolFailure, type ToolContext, type ToolHandler } from './tools';

export const TABLE_QUERY_TOOL = 'table_query';
/** Actor e guarda de commit são reconstruídos do contexto confiável, nunca dos argumentos do modelo. */
function scope(context: ToolContext): { service: TableService; actor: TableActor } {
  if (!context.botId) throw toolFailure('TABLE_ACCESS_DENIED');
  return { service: new TableService({ pool: context.pool, now: context.now, onEvidence: context.captureEvidence, execution: { runId: context.runId, signal: context.signal, leaseOwner: context.leaseOwner } }), actor: { kind: 'bot', botId: context.botId } };
}
/**
 * Formato de cada tipo de célula, que `TABLE_INVALID_VALUE` passa a levar (phase 15, passo 4, Q1). O serviço recusa o valor sem dizer qual célula nem por quê (`validateScalar`), e a
 * mensagem fixa "Valor inválido para a coluna." deixava o modelo sem saber o que corrigir (número como `100.00`, rótulo no lugar do id da opção, data com barras são recusados): em produção
 * 8 de 76 consultas de `table_query` falhavam assim. A regra de cada tipo é a de `tables/scalars.ts`.
 */
const VALUE_FORMATS = 'Formatos: texto; number e money como TEXTO decimal canônico ("12.5" e "100", nunca "100.00"; money até 2 casas); boolean true/false; date "AAAA-MM-DD"; time "HH:mm"; ' +
  'datetime ISO com fuso ("2026-11-07T14:30:00-03:00"); select = id da opção (de table_get), não o rótulo; multiselect = lista de ids; relation = id do registro de destino; coluna calculada é só leitura.';
/**
 * O que fazer quando o serviço recusa uma fórmula (`TABLE_INVALID_FORMULA`). Medido no banco de testes com o modelo real: 23 de 35 `table_formula_preview` e 3 de 4 `table_update` com coluna
 * calculada falharam, e a execução do caso gastou o limite de etapas, porque o modelo não conhecia a regra de tipos (`money ÷ money` e `money × money` não existem; o resultType precisa ser o tipo
 * do resultado) e a mensagem fixa "Fórmula inválida ou incompatível com as colunas." não dizia nada. Outro caso visto: coluna calculada criada junto da tabela com `ref` de colunas que ainda
 * não existem (o modelo inventa UUIDs). As regras são as de `tables/formulas.ts` (`compile`).
 */
const FORMULA_HELP = 'Tipos: ADD e SUBTRACT só entre o mesmo tipo (e moeda), resultado desse tipo; MULTIPLY: number×number=number e money×number=money (nunca money×money); ' +
  'DIVIDE e ROUND exigem number no 2º argumento e o resultado tem o tipo do 1º (não existe money÷money); EQ..GTE exigem o mesmo tipo dos dois lados; resultType é o tipo do resultado (money exige currency). ' +
  'Cada ref usa o UUID de uma coluna que já existe (table_get): coluna calculada nova entra com table_update depois de criar a tabela. Teste antes com table_formula_preview.';
/**
 * Envelope seguro para falhas esperadas; nenhum argumento, consulta ou stack é devolvido ao modelo. A ambiguidade de id curto (TAB-03) tem caminho próprio: o
 * envelope comum só leva `code` e mensagem, e o modelo só consegue refazer a chamada se receber o prefixo e os candidatos (id completo e nome de cada registro).
 * Campo e motivo (`DomainError.fields`), quando o serviço sabe, vão no envelope: dizem ao modelo o que corrigir, sem valor nem nome de dado do dono.
 */
async function safe<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); }
  catch (error) {
    if (error instanceof AmbiguousRecordError) throw toolFailure(error.code, undefined, { prefix: error.prefix, candidates: error.candidates, moreCandidates: error.moreCandidates });
    if (error instanceof DomainError) {
      const message = error.code === 'TABLE_INVALID_VALUE' ? `${ERROR_CODES[error.code].message} ${VALUE_FORMATS}` : error.code === 'TABLE_INVALID_FORMULA' ? `${ERROR_CODES[error.code].message} ${FORMULA_HELP}` : ERROR_CODES[error.code].message;
      throw toolFailure(error.code, message, error.fields?.length ? { fields: error.fields } : {});
    }
    throw error;
  }
}
/**
 * Primeira frase COMPLETA de uma descrição: até o primeiro ponto seguido de espaço, sem o ponto final quando a descrição é uma frase só. Só o ponto seguido de espaço encerra a frase; o de
 * "etc.)" ou o de "ex.:" no meio dela não corta, e era isso que deixava o rótulo de `table_query` em "(eq/lt/etc" (A28, phase 14). A regra `/\.\s/u` é a mesma do índice de `discover_tools`
 * (`discoveryTool`, `tool-discovery.ts`), que a escreve inline e não a exporta; ela é repetida aqui porque extrair uma função única editaria arquivos fora do recorte deste módulo.
 */
function firstSentence(description: string): string {
  return description.split(/\.\s/u)[0]!.replace(/\.$/u, '');
}
/**
 * Referências de artefato (A4, phase 14) das tabelas que uma chamada alterou. O NOME vem do banco por `TableService.get`, com o acesso do bot (a fonte única da regra de acesso), nunca dos argumentos nem
 * do resultado do modelo. A leitura usa um serviço SEM o coletor de evidência: o nome não é um dado que chega ao modelo, então não entra na proveniência, e a evidência das tabelas segue a de antes (A29).
 * Uma tabela que o bot deixou de acessar entre a escrita e esta leitura, ou que sumiu, fica sem referência e a escrita, já gravada, continua valendo. Sem repetir o mesmo id.
 */
async function tableArtifacts(context: ToolContext, ids: readonly string[]): Promise<ArtifactRef[]> {
  if (!context.botId) return [];
  const service = new TableService({ pool: context.pool, now: context.now });
  const refs: ArtifactRef[] = [];
  for (const id of new Set(ids)) {
    try { refs.push({ type: 'table', id, title: (await service.get(id, { kind: 'bot', botId: context.botId })).name }); }
    catch (error) { if (!(error instanceof DomainError)) throw error; }
  }
  return refs;
}
/** A tabela alterada é a do argumento (`tableId`): gravar registros e mexer nas vistas. */
const tableOfArgs = (args: { tableId: string }): string[] => [args.tableId];
/** A tabela alterada é a que o resultado devolveu (`id`): criar e atualizar a estrutura. */
const tableOfResult = (_args: unknown, value: unknown): string[] => [(value as { id: string }).id];
/**
 * As tabelas que uma chamada de `table_import_attachment` ALTEROU, a partir do que ela devolveu (o formato `Applied` de `tables/attachment-import.ts`). Só `apply` altera, e só quando algo mudou: a repetição que
 * pulou tudo (`skipped`, `applied` zero) não é alteração. Com `sourceTableId` a operação é de uma tabela (a que o resultado devolve na criação e na estrutura, ou a vinculada nos `bindings`); sem ele a fase é
 * global e o resultado lista as tabelas da importação em `bindings` (até 20): todas entram, mesmo que o lote tenha tocado só uma, porque a resposta inteira trabalhou nessa importação.
 * ponytail: a fase global que falha no meio (`TABLE_IMPORT_PARTIAL`) fecha a atividade como falha, sem referência, mesmo com tabelas já criadas (a referência chega pela próxima chamada que as alterar,
 * nunca por uma criação repetida que só pula o que já existe), e a fase global que aplica algo refere todas as tabelas da importação, não só as do lote, quando o dono estranhar cartão faltando ou sobrando
 * numa importação grande (o importador devolver as tabelas tocadas por lote, inclusive na falha parcial).
 */
function importedTables(args: TableImportToolInput, value: unknown): string[] {
  if (args.operation !== 'apply') return [];
  const result = value as { applied?: number; skipped?: unknown; tableId?: string; bindings?: { tableId: string }[] };
  if (args.sourceTableId === undefined) return (result.applied ?? 0) > 0 ? (result.bindings ?? []).map((binding) => binding.tableId) : [];
  if (result.skipped === true || result.applied === 0) return [];
  const tableId = result.tableId ?? args.bindings.find((binding) => binding.sourceTableId === args.sourceTableId)?.tableId;
  return tableId === undefined ? [] : [tableId];
}
/**
 * Coluna de tabela como o modelo a lê (phase 15, Q7): as 11 variantes por tipo viram um objeto só (`flattenTypedUnions`, `tool-arguments.ts`), que pesava cerca de 3 KB em cada uma de `table_create`,
 * `table_update` e `table_prepare_operation`. O que cada tipo exige a mais está aqui, na ordem das recusas medidas no banco com o modelo real (a de `calculated` em `money` sem `currency` é a mais comum): a recusa de uma coluna sem motivo próprio mostra o começo deste texto (`describeArgumentIssues` corta a descrição em 130 caracteres). O Zod continua recusando a combinação errada com o campo e o motivo. Hoje a coluna é a única união
 * discriminada por `type` com 3 variantes ou mais nos parâmetros das ferramentas de tabela; uma segunda passaria a ser fundida com ESTE texto, então ela precisaria de um `help` próprio.
 */
const COLUMN_HELP = 'calculated exige formula, resultType e currency se for money; money exige currency (ISO, ex.: BRL); select e multiselect exigem options [{id,label}]; ' +
  'relation exige targetTableId e cardinality (one ou many). name e type sempre.';
/**
 * Define um handler estrito e botOnly; JSON Schema serve à descoberta, Zod permanece a validação autoritativa. O rótulo da atividade na tela é o da AÇÃO nas destrutivas (`kind`) e, nas demais,
 * a primeira frase da `description` (`firstSentence`): quem escreve uma descrição nova decide o rótulo pela frase de abertura, que precisa fazer sentido sozinha. `touched` é só das ferramentas que CRIAM ou
 * ALTERAM uma tabela: dos argumentos e do valor que `work` devolveu, diz quais tabelas mudaram, e o executor recebe a referência de cada uma (`ToolOutcome.artifacts`, A4); ler, listar e as destrutivas
 * (que têm o próprio cartão de aprovação) não a passam.
 */
function tableTool<S extends z.ZodType>(name: string, description: string, schema: S, work: (args: z.output<S>, context: ToolContext) => Promise<unknown>, kind?: TableDestructive['kind'], parametersSchema: z.ZodType = schema, touched?: (args: z.output<S>, value: unknown) => readonly string[]): ToolHandler {
  const base = {
    definition: { name, description, parameters: modelJsonSchema(parametersSchema, { io: 'input', unrepresentable: 'any' }, { help: COLUMN_HELP }) },
    botOnly: true, replayable: true, resultLimitBytes: 64 * 1024, argsSchema: schema, label: () => kind ? TABLE_ACTIONS[kind].label : firstSentence(description),
    ...(kind ? { inspect: async (args: z.output<S>, context: ToolContext) => safe(async () => {
      const { service, actor } = scope(context);
      const input = args as { tableId: string; preparationId: string };
      const prepared = await service.preparedOperation(input.tableId, input.preparationId, actor);
      if (prepared.impact.kind !== kind) throw new DomainError('VALIDATION_FAILED');
      return prepared.impact;
    }) } : {}),
    execute: async (args: z.output<S>, context: ToolContext) => {
      const sources: EvidenceProvenance[] = [];
      const scoped = { ...context, captureEvidence: (source: EvidenceProvenance) => sources.push(source) };
      const value = await safe(() => work(args, scoped));
      const result = JSON.stringify(value);
      // Limite de 64 KiB do resultado (A21): o código GENÉRICO (`TOOL_RESULT_TOO_LARGE`, com a orientação de pedir menos itens ou um filtro, o mesmo que o executor responde ao `resultLimitBytes`) vale para toda
      // ferramenta de tabela; só a consulta mantém `TABLE_QUERY_LIMIT`, o código da consulta de tabelas (cursor, página e tamanho da linha, `tables/queries.ts`), que ela já usa e que o executor
      // documenta para o `table_query` (`SELF_LIMITED_RESULTS`). Antes todas as ferramentas respondiam `TABLE_QUERY_LIMIT`, o que dava a uma escrita grande a mensagem de uma consulta.
      if (Buffer.byteLength(result, 'utf8') > 64 * 1024) throw toolFailure(name === TABLE_QUERY_TOOL ? 'TABLE_QUERY_LIMIT' : 'TOOL_RESULT_TOO_LARGE');
      if (kind === 'delete_table') {
        const receipt = await readTableRemovalReceipt(context.pool, context.botId, JSON.stringify(args));
        if (receipt) return { ...receipt, evidence: mergeEvidence(...sources) };
      }
      const artifacts = touched ? await tableArtifacts(context, touched(args, value)) : [];
      return { result, evidence: mergeEvidence(...sources), ...(artifacts.length ? { artifacts } : {}) };
    },
  };
  return kind ? defineTool({ ...base, approvalRequired: true, action: TABLE_ACTIONS[kind] }) : defineTool(base);
}
const id = { tableId: tableIdSchema };

// Entradas com id curto de registro (TAB-03). O contrato compartilhado (`@aion/shared`, usado pela API) continua exigindo UUID; só estes schemas de FERRAMENTA aceitam
// também o prefixo que `table_query` mostra. O prefixo é trocado pelo UUID completo (`withFullIds`, e `TableService.resolveRelationRefs` nas células de relação do
// `table_write`, que dependem da coluna e por isso não têm schema próprio aqui) antes de a entrada chegar ao serviço, que a valida de novo pelo contrato
// compartilhado: o vínculo, o recibo de mutação, a preparação destrutiva e a auditoria só veem o id completo.
/** Lista sem repetição, comparando as grafias já normalizadas: o mesmo registro por duas grafias do id seria lista repetida, como no contrato compartilhado. */
const distinctRefs = (refs: readonly string[]): boolean => new Set(refs.map(normalizeRecordRef)).size === refs.length;
/**
 * Células por UUID de coluna. A descrição é a dica que a mensagem de recusa repete ao modelo (`describeArgumentIssues` lê a descrição do campo no schema publicado): chave com o NOME da
 * coluna e número JSON numa célula decimal são recusados pelo schema, e a mensagem só trazia o caminho (em produção, 10 de 33 escritas de `table_write` falhavam com `VALIDATION_FAILED`). Curta de propósito (abaixo de 120
 * caracteres, para `modelJsonSchema` não a omitir na segunda ocorrência).
 */
const valuesByColumn = tableValuesSchema.describe('Chave = UUID da coluna, nunca o nome. Valor: texto, true/false, lista ou null; número e dinheiro como texto ("12.5").');
const writeInputByRef = tableWriteSchema.safeExtend({
  creates: z.array(tableRecordCreateSchema.extend({ values: valuesByColumn })).max(100).default([]),
  updates: z.array(tableRecordUpdateSchema.extend({ id: recordRefSchema, values: valuesByColumn })).max(100).default([]),
}).refine((input) => distinctRefs(input.updates.map((update) => update.id)));
/**
 * Diz o que há de errado num filtro, no vocabulário do modelo. O schema compartilhado (`tableFilterSchema`) recusa com uma frase só ("Filtro inválido ou acima dos limites."), que não
 * distingue operador em maiúsculas, nome de coluna no lugar do UUID, número JSON no valor ou filtro vazio; as regras são as mesmas dele (`validFilter`, `packages/shared/src/tables.ts`), só
 * que cada uma devolve o seu motivo. Nunca ecoa o valor. Devolve nulo quando não acha problema (o schema compartilhado decide em seguida e continua autoritativo).
 */
function filterProblem(node: unknown, depth = 1, predicates = { count: 0 }): string | null {
  if (depth > 3) return 'no máximo 3 níveis de grupos and/or';
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return 'cada filtro é um objeto {"op","columnId","value"} ou um grupo {"op":"and"|"or","filters":[...]}';
  const item = node as Record<string, unknown>;
  if (item.op === 'and' || item.op === 'or') {
    if (Object.keys(item).some((key) => key !== 'op' && key !== 'filters')) return 'grupo and/or leva só op e filters';
    if (!Array.isArray(item.filters) || item.filters.length < 1 || item.filters.length > 20) return 'filters é uma lista de 1 a 20 filtros';
    for (const child of item.filters) { const problem = filterProblem(child, depth + 1, predicates); if (problem) return problem; }
    return null;
  }
  if (++predicates.count > 20) return 'no máximo 20 filtros';
  if (!['eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'contains', 'includes', 'empty', 'not_empty'].includes(String(item.op))) return 'op deve ser um de eq|ne|lt|lte|gt|gte|contains|includes|empty|not_empty|and|or, em minúsculas';
  if (!tableIdSchema.safeParse(item.columnId).success) return 'columnId deve ser o UUID da coluna (de table_get), não o nome';
  const extra = Object.keys(item).filter((key) => !['op', 'columnId', 'value'].includes(key));
  if (extra.length) return `campo não aceito no filtro: ${extra.slice(0, 3).map((key) => key.slice(0, 40)).join(', ')} (aceitos: op, columnId, value)`;
  if (item.op === 'empty' || item.op === 'not_empty') return Object.hasOwn(item, 'value') ? 'empty e not_empty não levam value' : null;
  if (!Object.hasOwn(item, 'value')) return 'falta value';
  return typeof item.value === 'number' ? 'value não pode ser número JSON: número e dinheiro vão como texto ("100")' : null;
}
/** O filtro de `table_query` com os motivos de `filterProblem` e, depois deles, o schema compartilhado. A descrição (com o exemplo) é a do compartilhado. */
const filterByTool = z.preprocess((input, context) => {
  const problem = filterProblem(input);
  if (problem !== null) { context.addIssue({ code: 'custom', message: 'Filtro inválido', params: { hint: problem } }); return z.NEVER; }
  return input;
}, tableFilterSchema).describe(tableFilterSchema.description ?? '');
/**
 * Diz o que há de errado numa fórmula AST, como `filterProblem` faz com o filtro: o schema compartilhado (`tableFormulaSchema`) recusa com uma frase só e o modelo não sabia se o erro
 * era o operador em minúsculas, o número JSON num literal, `column` no lugar de `columnId` ou a fórmula escrita como texto. As regras são as de `validFormula`
 * (`packages/shared/src/tables.ts`), cada uma com o seu motivo; nunca ecoa o valor. Nulo quando não acha problema (o schema compartilhado decide em seguida).
 */
function formulaProblem(root: unknown): string | null {
  const pending = [{ node: root, depth: 1 }];
  let count = 0;
  while (pending.length) {
    const { node, depth } = pending.pop()!;
    if (++count > 100) return 'no máximo 100 nós';
    if (depth > 10) return 'no máximo 10 níveis';
    if (node === null || typeof node !== 'object' || Array.isArray(node)) return 'cada nó é um objeto {"kind":"literal"|"ref"|"call",...}; fórmula escrita como texto não vale';
    const item = node as Record<string, unknown>;
    const keys = Object.keys(item);
    if (item.kind === 'ref') {
      if (!tableIdSchema.safeParse(item.columnId).success) return 'ref leva columnId com o UUID da coluna (de table_get), não o nome';
      if (keys.length !== 2) return 'ref aceita só kind e columnId';
    } else if (item.kind === 'literal') {
      if (keys.some((key) => !['kind', 'type', 'value', 'currency'].includes(key))) return 'literal aceita só kind, type, value e currency';
      if (!FORMULA_TYPES.includes(item.type as (typeof FORMULA_TYPES)[number])) return 'literal.type deve ser um de ' + FORMULA_TYPES.join('|');
      if (!keys.includes('value')) return 'literal exige value';
      if (typeof item.value === 'number') return 'literal.value não pode ser número JSON: number e money vão como texto ("1")';
      if (item.value !== null && typeof item.value !== 'string' && typeof item.value !== 'boolean') return 'literal.value é texto, true/false ou null';
      if (item.type === 'money' && item.currency === undefined) return 'literal money exige currency (ISO, por exemplo "BRL")';
      if (item.currency !== undefined && (item.type !== 'money' || typeof item.currency !== 'string' || !Intl.supportedValuesOf('currency').includes(item.currency))) return 'currency só vale em literal money, com código ISO (por exemplo "BRL")';
    } else if (item.kind === 'call') {
      if (!FORMULA_OPERATORS.includes(item.op as (typeof FORMULA_OPERATORS)[number])) return 'op deve ser um de ' + FORMULA_OPERATORS.join('|') + ' (maiúsculas)';
      if (keys.length !== 3) return 'call aceita só kind, op e args';
      if (!Array.isArray(item.args) || item.args.length > 100) return 'args é uma lista de nós, de 0 a 100';
      pending.push(...item.args.map((child) => ({ node: child, depth: depth + 1 })));
    } else return 'kind deve ser literal, ref ou call';
  }
  return JSON.stringify(root).length > 4000 ? 'no máximo 4000 caracteres' : null;
}
/** A fórmula de `table_formula_preview` com os motivos de `formulaProblem` e, depois deles, o schema compartilhado. A descrição é a do compartilhado. */
const formulaByTool = z.preprocess((input, context) => {
  const problem = formulaProblem(input);
  if (problem !== null) { context.addIssue({ code: 'custom', message: 'Fórmula inválida', params: { hint: problem } }); return z.NEVER; }
  return input;
}, tableFormulaSchema).describe(tableFormulaSchema.description ?? '');
const tableFormulaPreviewSchema = tableFormulaPreviewBase.extend({ formula: formulaByTool });
/** As vistas guardam o mesmo filtro da consulta: a mesma recusa com motivo. */
const tableViewCreateSchema = tableViewCreateBase.extend({ filter: filterByTool.nullable().optional() });
const tableViewUpdateSchema = tableViewUpdateBase.extend({ filter: filterByTool.nullable().optional() });
const queryByRef = tableQuerySchema.extend({ filter: filterByTool.nullable().optional(), recordIds: z.array(recordRefSchema).min(1).max(100).refine(distinctRefs).optional() });
const destructiveByRef = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('delete_records'), expectedVersion: tableVersionSchema, records: z.array(z.strictObject({ id: recordRefSchema, expectedVersion: tableVersionSchema })).min(1).max(100).refine((rows) => distinctRefs(rows.map((row) => row.id))) }),
  ...tableDestructiveSchema.options.filter((option) => option.shape.kind.value !== 'delete_records'),
]);
/**
 * Troca o id curto de cada item pelo UUID completo, dentro da tabela informada e depois da checagem de acesso (a do serviço). Ordem preservada. `operationId` é o
 * da escrita que usa a lista: o serviço o usa para o replay com id curto terminar como terminaria com o id completo (ver `TableService.resolveRecordRefs`).
 */
async function withFullIds<T extends { id: string }>(service: TableService, tableId: string, items: readonly T[], actor: TableActor, operationId?: string): Promise<T[]> {
  const ids = await service.resolveRecordRefs(tableId, items.map((item) => item.id), actor, operationId);
  return items.map((item, index) => ({ ...item, id: ids[index]! }));
}
/** Metadata limitada mantém IDs das colunas criadas sem repetir AST/opções; estrutura completa usa paginação própria. */
function metadata(table: import('@aion/shared').DataTable) {
  return { id: table.id, name: table.name, description: table.description, version: table.version, schemaVersion: table.schemaVersion, columns: table.columns.map(({ id: columnId, name, type }) => ({ id: columnId, name, type })) };
}
/**
 * Catálogo completo sem dados no system; consulta exige projeção/filtro conforme necessidade e limita o envelope inteiro a 64KiB.
 * ponytail: `table_list`, `table_get` e `table_query` paginam por cursor opaco do serviço compartilhado (o contrato da API de tabelas), enquanto as demais ferramentas internas usam `offset`, `limit` e
 *   `nextOffset` (A21, phase 15); trocar o cursor por `offset` nas três quando o contrato da API de tabelas puder mudar.
 */
export const tableTools: readonly ToolHandler[] = [
  tableTool('table_import_attachment', 'Importa tabelas de JSON por referência a anexo, sem retranscrever células; prefira para importações em volume. ' +
    `Formato mínimo do arquivo: ${JSON.stringify(TABLE_IMPORT_DOCUMENT_EXAMPLE)}. Para gerar a partir de TXT/CSV, use run_python e grave o JSON em /out/, imprimindo só contagens. Gere UUIDs estáveis para originId, colunas e registros; o importador remapeia IDs. values usa IDs das colunas de origem. number/money exigem strings decimais canônicas sem zeros fracionários finais: "1.20"→"1.2", "0.00"→"0"; use Decimal sem float. money declara currency. Preserve texto e null, nunca converta vazio em zero. Para dados já no formato aion-table-import-v1 (ou aion-finance-import-v1), use diretamente o anexo existente. ` +
    'inspect retorna sourceHash/tabelas/contagens. apply SEM sourceTableId opera a fase em TODAS tabelas: create devolve bindings com expectedSchemaVersion; use esses bindings nas fases schema, records, relations e view. Offset global/nextOffset pagina até 100 itens SOMADOS e 1 MiB. Atomicidade por suboperação: lote de registros/tabela, estrutura/tabela ou vista individual; grupos podem ter progresso parcial. Reutilize o mesmo operationId mestre/hash/offset/bindings na retomada: IDs derivados e skip preservam recibos/versões. Com sourceTableId mantém operação individual. Relations vem após todos registros; view aplica vistas em lote global. verify compara TODOS valores/schema/vistas, inclusive ausentes/extras, sem devolver células. Workflow do arquivo é dado ignorado. Não declare concluído sem passed:true.', tableImportToolSchema, importAttachment, undefined, tableImportToolParametersSchema, importedTables),
  tableTool('table_list', 'Descobre suas tabelas com paginação, sem células/estrutura. Use table_get para colunas. Não concede acesso a outros bots.', z.strictObject({ cursor: tableIdSchema.optional(), limit: z.number().int().min(1).max(20).optional() }), async (args, ctx) => { const { service, actor } = scope(ctx); const result = await service.list(actor, { ...args, limit: args.limit ?? 20 }); return { ...result, tables: result.tables.map(({ id, name, version, schemaVersion }) => ({ id, name, version, schemaVersion })) }; }),
  tableTool('table_get', 'Lê estrutura e revisões de uma tabela acessível, até 10 colunas por página; nextColumnCursor continua na mesma revisão.', z.strictObject({ ...id, columnCursor: z.string().max(256).optional(), columnLimit: z.number().int().min(1).max(10).default(10) }), async (args, ctx) => {
    const { service, actor } = scope(ctx); const table = await service.get(args.tableId, actor);
    let offset = 0;
    if (args.columnCursor) {
      try { const cursor = JSON.parse(Buffer.from(args.columnCursor, 'base64url').toString()) as { tableId: string; version: number; offset: number }; if (cursor.tableId !== table.id || cursor.version !== table.version || !Number.isInteger(cursor.offset) || cursor.offset < 0 || cursor.offset >= table.columns.length) throw new Error(); offset = cursor.offset; }
      catch { throw new DomainError('TABLE_CONFLICT'); }
    }
    let end = offset + args.columnLimit;
    // Páginas completas de colunas, inclusive opções/AST multibyte, cabem no envelope em bytes.
    while (end > offset + 1 && Buffer.byteLength(JSON.stringify({ ...metadata(table), columns: table.columns.slice(offset, end), nextColumnCursor: 'x'.repeat(256) })) > 64 * 1024) end--;
    return { ...metadata(table), columns: table.columns.slice(offset, end), nextColumnCursor: end < table.columns.length ? Buffer.from(JSON.stringify({ tableId: table.id, version: table.version, offset: end })).toString('base64url') : null };
  }),
  tableTool('table_create', 'Cria uma tabela associada a você. A PRIMEIRA coluna fica fixa à esquerda na tela do dono e identifica cada registro: use nela um texto que nomeie o item (ex.: Nome, Descrição). Envie columns sem id; o servidor gera e devolve IDs, que você usa em table_write. IDs de opções select/multiselect são obrigatórios. Coluna calculada referencia colunas por ID, que só existem depois da criação: crie a tabela e acrescente a calculada com table_update. operationId UUID novo identifica replay; decimais são strings exatas, células vazias null. ' +
    'Exemplo: {"name":"Tarefas","columns":[{"name":"Tarefa","type":"text"},{"name":"Prazo","type":"date"},{"name":"Feita","type":"boolean"}],"operationId":"<UUID novo>"}. Devolve id, schemaVersion e as colunas com seus IDs.', tableCreateSchema, async (args, ctx) => { const { service, actor } = scope(ctx); return metadata(await service.create(args, actor)); }, undefined, undefined, tableOfResult),
  tableTool('table_update', 'Atualiza estrutura sem perda. expectedSchemaVersion (a schemaVersion atual) e operationId (UUID novo) vão DENTRO de input, junto de columns: {"tableId":"<UUID>","input":{"columns":[...],"expectedSchemaVersion":<n>,"operationId":"<UUID novo>"}}. Comece por table_get e copie as colunas; é isso que input.columns leva, mais as novas. A ordem de input.columns é a ordem na tela; mantenha primeiro a coluna que identifica o registro, fixa à esquerda. input.columns exige lista COMPLETA de colunas visíveis de table_get, com IDs/definições preservados, mais novas colunas; não é patch. O servidor preserva ocultas. Exclusões/conversões exigem operação destrutiva. Use preparar/confirmar para excluir ou converter; IDs de colunas permanecem estáveis.', z.strictObject({ ...id, input: tableUpdateSchema }), async (args, ctx) => { const { service, actor } = scope(ctx); return metadata(await service.update(args.tableId, args.input, actor)); }, undefined, undefined, tableOfResult),
  tableTool(TABLE_QUERY_TOOL, // A primeira frase da descrição (até o primeiro ponto seguido de espaço, `firstSentence`) é o rótulo da atividade na tela: o "etc.)" dela não a encerra.
    'Consulta campos por IDs com filtros op minúsculo (eq/lt/etc.) ou grupos and/or com filters; nos filtros, seleções usam o ID da opção (de table_get), não o rótulo. ' +
    'Em tabela grande peça só as colunas de que precisa (columns), use limit menor e prefira agregações: columns:[] com aggregate/groupBy devolve só totais, que cobrem todo filtro. Até 100 registros por página; enquanto hasMore, reutilize nextCursor com a mesma consulta, inclusive projeção, filtro, ordem e limit; totalCount é o total filtrado. ' +
    'O resultado é uma tabela markdown: linha de metadados (totalCount, hasMore, nextCursor, aggregate), legenda "nome = id" das colunas e uma linha por registro com id curto, v (versão, para expectedVersion) e uma coluna por nome. ' +
    'O id curto (8+ caracteres, único dentro do resultado) vale como id de registro em table_write, table_query (recordIds) e table_prepare_operation, tal como o UUID completo. Opções de seleção aparecem pelo rótulo; célula vazia é nula; \\| e \\n são "|" e quebra de linha. ' +
    'Resultado longo é cortado no fim (a última linha diz quantas linhas vieram): peça menos colunas ou limit menor. Fórmulas literal/ref/call pertencem a table_formula_preview.', z.strictObject({ ...id, query: queryByRef }), async (args, ctx) => {
    const { service, actor } = scope(ctx);
    const { recordIds, ...query } = args.query;
    // O resultado gravado leva também os nomes das colunas e os rótulos das opções (`model-format.ts`): é o que o pedido ao modelo lê para montar a tabela markdown.
    return service.queryShaped(args.tableId, { ...query, ...(recordIds ? { recordIds: await service.resolveRecordRefs(args.tableId, recordIds, actor) } : {}) }, actor, withModelColumns);
  }),
  tableTool('table_write', 'Grava células por UUID de coluna retornado por table_create/table_get, nunca por nome. Para importar dados em volume, prefira table_import_attachment por referência; se precisar transformar TXT/CSV, use run_python para gerar o arquivo. Cria/atualiza lote atômico até 100 registros e 1MiB. Dinheiro e número vão como texto decimal sem zeros finais ("45.9" e "5000", nunca "45.90" nem "5000.00"). Patches preservam campos omitidos; use revisões e operationId estável no replay; calculadas são somente leitura. ' +
    'Exemplo de criação: {"tableId":"<UUID>","input":{"operationId":"<UUID novo>","expectedSchemaVersion":<schemaVersion devolvida por table_create/table_get>,"creates":[{"values":{"<columnId Tarefa>":"Comprar presente","<columnId Prazo>":"2026-11-07","<columnId Feita>":false}}]}}. ' +
    'Para alterar um registro use updates:[{"id":"<id curto ou UUID do registro, de table_query>","expectedVersion":<v lida em table_query>,"values":{"<columnId>":valor}}]. ' +
    'Célula de relação: o id curto ou UUID do registro de DESTINO (de table_query da tabela de destino); lista nas de cardinalidade many.', z.strictObject({ ...id, input: writeInputByRef }), async (args, ctx) => {
    const { service, actor } = scope(ctx);
    // Dois lugares recebem id curto: `updates[].id` (registro desta tabela) e as células de relação (registro da tabela de DESTINO da coluna). Ambos são trocados pelo UUID
    // completo, no servidor e depois da checagem de acesso, antes de a entrada chegar ao `write`, que só vê ids completos.
    const updates = await withFullIds(service, args.tableId, args.input.updates, actor, args.input.operationId);
    const batch = await service.resolveRelationRefs(args.tableId, { creates: args.input.creates, updates }, actor, args.input.operationId);
    const result = await service.write(args.tableId, { ...args.input, ...batch }, actor);
    return { records: result.records.map(({ id: recordId, version }) => ({ id: recordId, version })) };
  }, undefined, undefined, tableOfArgs),
  tableTool('table_formula_preview', 'Valida e avalia uma AST literal/ref/call sem persistir. tableId fica fora de input: {"tableId":"<UUID>","input":{"formula":...,"resultType":"number","values":{"<columnId>":"4500"}}}. Operadores maiúsculos; number/money usam strings decimais exatas, nunca números JSON. Tipos: ADD/SUBTRACT só do mesmo tipo; money×number=money (nunca money×money); DIVIDE e ROUND levam number no 2º argumento (não existe money÷money); resultType é o tipo do resultado. Exemplo de data: {kind:"call",op:"ADD_MONTHS",args:[{kind:"literal",type:"date",value:"2026-10-31"},{kind:"literal",type:"number",value:"1"}]}, resultType:"date". values fornece células por columnId; ref lê essas células. Usa a mesma precisão e calendário da consulta.', z.strictObject({ ...id, input: tableFormulaPreviewSchema }), async (args, ctx) => { const { service, actor } = scope(ctx); return service.previewFormula(args.tableId, args.input, actor); }),
  tableTool('table_views', 'Lista IDs/nomes/revisões das vistas acessíveis, sem copiar definições extensas. Consulte pela viewId.', z.strictObject(id), async (args, ctx) => { const { service, actor } = scope(ctx); return { views: (await service.views(args.tableId, actor)).views.map(({ id: viewId, name, version }) => ({ id: viewId, name, version })) }; }),
  tableTool('table_view_create', 'Salva definição de vista sem copiar registros. Vistas aparecem ao dono como atalhos prontos acima da tabela: crie uma por recorte recorrente (ex.: A pagar, Atrasadas, Pagas), com nome curto e filtro/ordem próprios.', z.strictObject({ ...id, input: tableViewCreateSchema }), async (args, ctx) => { const { service, actor } = scope(ctx); const view = await service.saveView(args.tableId, args.input, actor); return { id: view.id, name: view.name, version: view.version }; }, undefined, undefined, tableOfArgs),
  tableTool('table_view_update', 'Atualiza vista pela revisão esperada.', z.strictObject({ ...id, viewId: tableIdSchema, input: tableViewUpdateSchema }), async (args, ctx) => { const { service, actor } = scope(ctx); const view = await service.saveView(args.tableId, args.input, actor, args.viewId); return { id: view.id, name: view.name, version: view.version }; }, undefined, undefined, tableOfArgs),
  tableTool('table_view_remove', 'Remove somente a definição da vista; mantém todos os registros.', z.strictObject({ ...id, viewId: tableIdSchema, input: tableViewRemoveSchema }), async (args, ctx) => { const { service, actor } = scope(ctx); return service.removeView(args.tableId, args.viewId, args.input, actor); }, undefined, undefined, tableOfArgs),
  tableTool('table_prepare_operation', 'Prepara exclusão/conversão com alvos concretos e revisão total; retorna preparationId e impacto. Não altera dados. Confirmar usa a categoria específica sob as regras de aprovação.', z.strictObject({ ...id, operation: destructiveByRef }), async (args, ctx) => {
    const { service, actor } = scope(ctx);
    // A preparação grava a definição com o id completo: o id curto só existe na entrada da ferramenta.
    const operation = args.operation.kind === 'delete_records' ? { ...args.operation, records: await withFullIds(service, args.tableId, args.operation.records, actor) } : args.operation;
    return service.prepareDestructive(args.tableId, operation, actor);
  }),
  ...(['delete_table', 'delete_records', 'delete_column', 'convert_column'] as const).map((kind) => tableTool(`table_${kind}`, `${TABLE_ACTIONS[kind].label}. Exige preparationId da preparação correspondente; regra permanente só autoriza esta categoria, nunca concede acesso. Mudança posterior invalida a preparação.`, z.strictObject({ ...id, ...tableConfirmSchema.shape }), async (args, ctx) => { const { service, actor } = scope(ctx); return service.confirmDestructive(args.tableId, { preparationId: args.preparationId, operationId: args.operationId, confirmation: args.confirmation }, actor, ctx.approval); }, kind)),
];
