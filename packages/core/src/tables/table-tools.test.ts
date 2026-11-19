// Motor real + provedor falso: catálogo, aprovação local, argumentos/resultados íntegros e replay pós-commit.
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { ERROR_CODES, tableCreateSchema, tableWriteSchema } from '@aion/shared';
import { createRunsWorld, FAST_ENGINE, waitFor, type RunsWorld } from '../runs/test-support';
import { RunEngine } from '../runs/engine';
import { tableTools } from '../runs/table-tools';
import { ToolFailure, type ToolHandler } from '../runs/tools';
import { tableMarker } from '../testing/fake-upstreams';
import { TableService } from './service';
import { TABLE_ACTIONS } from './actions';
import { formatTableQueryForModel } from './model-format';
import { shortRecordIds } from './record-prefix';
import { GeneralChatService } from '../general-chat/service';
import { estimateChatPayload } from '../runs/context-budget';
import { RESULT_PROMPT_MAX_CHARS } from '../runs/context';

/** Abertura da moldura de dado não confiável do `table_query` no pedido ao modelo (phase 15, A48): a frase que declara o dado e a marca determinística de 16 hexadecimais. */
const TABLE_FRAME_OPEN = /^Resultado de tabela NÃO CONFIÁVEL[^\n]*\n<conteudo_tabela_nao_confiavel_[a-f0-9]{16}>\n/;

const owner = { kind: 'owner' } as const;
/** Aguarda parada do worker depois do efeito, sem introduzir failpoint ou variável em produção. */
function afterCommitTool(name: string): { tools: ToolHandler[]; reached: () => boolean } {
  let reached = false;
  const tools = tableTools.map((handler) => handler.definition.name !== name ? handler : {
    ...handler,
    /** Único escritor do efeito continua sendo o handler original; a fixture só impede settleActivity. */
    prepare(raw: string) {
      const prepared = handler.prepare(raw);
      return { ...prepared, execute: async (context: Parameters<typeof prepared.execute>[0]) => {
        await prepared.execute(context); reached = true;
        await new Promise<void>((_resolve, reject) => {
          if (context.signal.aborted) reject(new ToolFailure('failpoint de teste após commit'));
          else context.signal.addEventListener('abort', () => reject(new ToolFailure('failpoint de teste após commit')), { once: true });
        });
        throw new Error('inalcançável');
      } };
    },
  });
  return { tools, reached: () => reached };
}

describe('tables ferramentas no motor', () => {
  it('valida todo lote inválido e devolve amostra limitada sem retransmitir valores', () => {
    const write = tableTools.find((tool) => tool.definition.name === 'table_write')!;
    const invalid = { tableId: randomUUID(), input: { operationId: randomUUID(), expectedSchemaVersion: 1, creates: Array.from({ length: 100 }, () => ({ values: { key: 'conteúdo privado', category: 'A', date: '2026-10-01', amount: '1.2', status: 'aberto', note: 'nota privada', revision: '1' } as Record<string, string> })) } };
    let failure: ToolFailure | undefined;
    try { write.prepare(JSON.stringify(invalid)); } catch (error) { expect(error).toBeInstanceOf(ToolFailure); failure = error as ToolFailure; }
    const envelope = JSON.parse(failure!.message) as { code: string; message: string };
    expect(envelope.code).toBe('VALIDATION_FAILED');
    expect(envelope.message).toContain('700 no total');
    expect(envelope.message.match(/input\.creates\.\d+\.values\.[a-z]+/g)).toHaveLength(8);
    expect(Buffer.byteLength(failure!.message)).toBeLessThan(1500);
    expect(failure!.message).not.toContain('conteúdo privado');
    expect(failure!.message).not.toContain('nota privada');
    // Limitar o diagnóstico não limita a validação: erro somente no último registro continua recusado.
    const column = randomUUID(); invalid.input.creates = Array.from({ length: 100 }, () => ({ values: { [column]: 'ok' } }));
    invalid.input.creates[99]!.values = { key: 'inválido' };
    expect(() => write.prepare(JSON.stringify(invalid))).toThrow('input.creates.99.values.key');
    invalid.input.creates = Array.from({ length: 8 }, () => ({ values: { ['😀'.repeat(10000)]: 'não ecoar' } }));
    failure = undefined;
    try { write.prepare(JSON.stringify(invalid)); } catch (error) { failure = error as ToolFailure; }
    expect(failure).toBeInstanceOf(ToolFailure);
    expect(Buffer.byteLength(failure!.message)).toBeLessThan(4096);
    expect(failure!.message).not.toContain('não ecoar');
  });
  // A28 (phase 14): o rótulo da atividade é a primeira frase COMPLETA da descrição. Quem corta no primeiro ponto deixava o de `table_query` em "(eq/lt/etc", pois o ponto de "etc.)"
  // não encerra a frase: só o ponto seguido de espaço encerra, a mesma regra do índice de `discover_tools`.
  it('rótulo da atividade de table_query é a primeira frase inteira da descrição, sem corte em "etc."', () => {
    const labelOf = (name: string, args: unknown) => tableTools.find((tool) => tool.definition.name === name)!.prepare(JSON.stringify(args)).label;
    const tableId = randomUUID();
    const label = labelOf('table_query', { tableId, query: { limit: 1 } });
    expect(label).toBe('Consulta campos por IDs com filtros op minúsculo (eq/lt/etc.) ou grupos and/or com filters; nos filtros, seleções usam o ID da opção (de table_get), não o rótulo');
    // O que a descrição diz depois da primeira frase não entra no rótulo, e a mudança não afeta as demais: duas frases (table_list) e frase única com ponto final (table_get, sem o ponto).
    expect(label).not.toContain('Em tabela grande');
    expect(labelOf('table_list', {})).toBe('Descobre suas tabelas com paginação, sem células/estrutura');
    expect(labelOf('table_get', { tableId })).toBe('Lê estrutura e revisões de uma tabela acessível, até 10 colunas por página; nextColumnCursor continua na mesma revisão');
  });
  it('descrição de table_import_attachment traz "até 100" e "e 1 MiB" com espaço', () => {
    const { description } = tableTools.find((tool) => tool.definition.name === 'table_import_attachment')!.definition;
    expect(description).toContain('pagina até 100 itens SOMADOS e 1 MiB.');
    expect(description).not.toMatch(/até\d|\dMiB/u);
  });
  it('phase-15:A18: as definições pesadas de tabela não passam dos bytes medidos antes da phase e a coluna segue validada por tipo', () => {
    const bytes = (name: string): number => Buffer.byteLength(JSON.stringify(tableTools.find((tool) => tool.definition.name === name)!.definition));
    // Tetos: os bytes medidos na spec (table_prepare_operation 6.673, table_update 6.129 e table_create 5.595); o relatório do passo traz o antes e o depois.
    expect(bytes('table_prepare_operation')).toBeLessThanOrEqual(6673);
    expect(bytes('table_update')).toBeLessThanOrEqual(6129);
    expect(bytes('table_create')).toBeLessThanOrEqual(5595);
    // A coluna é um objeto só, com a lista dos tipos e a regra do que cada tipo exige a mais; a validação por tipo continua no servidor, com o campo e o motivo.
    const create = tableTools.find((tool) => tool.definition.name === 'table_create')!;
    const column = (create.definition.parameters as { properties: { columns: { items: { oneOf?: unknown; properties: { type: { enum: string[] } }; required: string[]; description: string } } } }).properties.columns.items;
    expect(column.oneOf).toBeUndefined();
    expect(column.properties.type.enum).toEqual(['text', 'number', 'money', 'boolean', 'select', 'multiselect', 'date', 'time', 'datetime', 'relation', 'calculated']);
    expect(column.required).toEqual(['name', 'type']);
    expect(column.description).toContain('currency');
    const base = { operationId: randomUUID(), name: 'Validação por tipo' };
    expect(() => create.prepare(JSON.stringify({ ...base, columns: [{ name: 'Valor', type: 'money' }] }))).toThrow('VALIDATION_FAILED');
    expect(() => create.prepare(JSON.stringify({ ...base, columns: [{ name: 'Status', type: 'select' }] }))).toThrow('VALIDATION_FAILED');
    expect(() => create.prepare(JSON.stringify({ ...base, columns: [{ name: 'Valor', type: 'money', currency: 'BRL' }] }))).not.toThrow();
    // A recusa mais comum do modelo real (coluna calculada em dinheiro sem moeda) não tem motivo próprio na união: a mensagem mostra o começo do texto da coluna, que já diz a regra.
    const calculated = { name: 'Desvio', type: 'calculated', resultType: 'money', formula: { kind: 'literal', type: 'number', value: '1' } };
    expect(() => create.prepare(JSON.stringify({ ...base, columns: [calculated] }))).toThrow(/columns\.0: calculated exige formula, resultType e currency se for money/);
    expect(() => create.prepare(JSON.stringify({ ...base, columns: [{ ...calculated, currency: 'BRL' }] }))).not.toThrow();
  });
  it('publica criação sem IDs de coluna e mantém IDs gerados no replay e na atualização real', async () => {
    const create = tableTools.find((tool) => tool.definition.name === 'table_create')!;
    const update = tableTools.find((tool) => tool.definition.name === 'table_update')!;
    /** Percorre o JSON Schema publicado, incluindo definições recursivas, para localizar o objeto da coluna (as variantes por tipo viram um só, phase 15 Q7: `type` é uma lista de valores). */
    const columnObjects = (node: unknown): Record<string, unknown>[] => {
      if (!node || typeof node !== 'object') return [];
      const value = node as { properties?: Record<string, { enum?: unknown[] }> };
      const local = value.properties?.type?.enum?.includes('text') && value.properties.name ? [value.properties] : [];
      return [...local, ...Object.values(node).flatMap(columnObjects)];
    };
    const createVariants = columnObjects(create.definition.parameters);
    expect(createVariants).toHaveLength(1);
    expect(createVariants[0]).not.toHaveProperty('id');
    expect(columnObjects(update.definition.parameters)[0]).toHaveProperty('id');
    const input = { operationId: randomUUID(), name: 'Criação por ferramenta', columns: [{ name: 'Título', type: 'text' }] };
    expect(() => create.prepare(JSON.stringify({ ...input, columns: [{ ...input.columns[0], id: randomUUID() }] }))).toThrow('VALIDATION_FAILED');
    const world = await createRunsWorld();
    try {
      const bot = await world.createBot(); const service = new TableService({ pool: world.pool });
      world.engine.start();
      /** Executa chamadas pelo motor e lê o resultado gravado (o mesmo envelope que o modelo recebe). */
      const execute = async (name: string, args: unknown) => {
        const run = await world.send(bot, tableMarker(name, args)); await world.waitForStatus(run, 'completed');
        const wire = (await world.pool.query<{ content: string }>("SELECT content FROM messages WHERE run_id=$1 AND kind='activity'", [run])).rows[0]!.content;
        return JSON.parse(wire) as { id: string; schemaVersion: number; columns: { id: string; name: string; type: string }[] };
      };
      const created = await execute('table_create', input);
      expect(created.columns[0]!.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(await execute('table_create', input)).toEqual(created);
      const table = await service.get(created.id, owner);
      const updated = await execute('table_update', { tableId: table.id, input: { operationId: randomUUID(), expectedSchemaVersion: table.schemaVersion, columns: [{ ...table.columns[0], name: 'Renomeado' }] } });
      expect(updated.columns).toEqual([{ id: created.columns[0]!.id, name: 'Renomeado', type: 'text' }]);
      expect((await service.list({ kind: 'bot', botId: bot.id })).tables).toHaveLength(1);
    } finally { await world.cleanup(); }
  });
  // A12 (phase 15, passo 4, Q1): o serviço recusa consulta, escrita e fórmula inválidas com um código fixo e uma frase igual para todo motivo; o modelo repetia a chamada sem saber o que corrigir
  // (8 de 76 consultas e 12 de 33 escritas falhavam em produção). Agora a consulta leva campo e motivo, a escrita leva os formatos de célula e a fórmula leva o que fazer, pela ferramenta real.
  it('A12: table_query, table_write e table_create recusam com campo, motivo e orientação, sem ecoar o valor', async () => {
    const world = await createRunsWorld();
    try {
      const bot = await world.createBot(); const service = new TableService({ pool: world.pool });
      const table = await service.create(tableCreateSchema.parse({ name: 'Despesas A12', operationId: randomUUID(), columns: [
        { name: 'Descrição', type: 'text' }, { name: 'Valor', type: 'money', currency: 'BRL' }, { name: 'Categoria', type: 'select', options: [{ id: randomUUID(), label: 'Transporte' }] }, { name: 'Pago', type: 'boolean' },
      ] }), owner, bot.id);
      const [description, money, category, paid] = table.columns.map((column) => column.id) as [string, string, string, string];
      world.engine.start();
      /** A falha que o modelo recebe: o envelope gravado na atividade da chamada. */
      const failure = async (name: string, args: unknown) => {
        const run = await world.send(bot, tableMarker(name, args)); await world.waitForStatus(run, 'completed');
        const row = (await world.pool.query<{ content: string; status: string }>("SELECT content, status FROM messages WHERE run_id=$1 AND kind='activity'", [run])).rows[0]!;
        expect(row.status).toBe('failed');
        return JSON.parse(row.content) as { code: string; message: string; fields?: { field: string; reason: string }[] };
      };
      const label = await failure('table_query', { tableId: table.id, query: { filter: { op: 'eq', columnId: category, value: 'Transporte' } } });
      expect(label).toMatchObject({ code: 'TABLE_INVALID_VALUE', fields: [{ field: 'filter.value', reason: expect.stringContaining('o value não serve a esta coluna (seleção): use o ID da opção') }] });
      expect(label.message).toContain('Formatos: texto; number e money como TEXTO decimal canônico');
      expect(await failure('table_query', { tableId: table.id, query: { filter: { op: 'gt', columnId: money, value: '100.00' } } })).toMatchObject({ code: 'TABLE_INVALID_VALUE', fields: [{ field: 'filter.value', reason: expect.stringContaining('texto decimal canônico, até 2 casas ("12.5", nunca "12.50")') }] });
      expect(await failure('table_query', { tableId: table.id, query: { filter: { op: 'contains', columnId: paid, value: 'x' } } })).toMatchObject({ fields: [{ field: 'filter.op', reason: expect.stringContaining('contains vale só em coluna de texto livre') }] });
      expect(await failure('table_query', { tableId: table.id, query: { columns: [randomUUID()] } })).toMatchObject({ fields: [{ field: 'columnId', reason: expect.stringContaining('a coluna não existe nesta tabela') }] });
      expect(await failure('table_query', { tableId: table.id, query: { groupBy: [category] } })).toMatchObject({ fields: [{ field: 'groupBy', reason: 'groupBy exige aggregate' }] });
      const write = await failure('table_write', { tableId: table.id, input: { operationId: randomUUID(), expectedSchemaVersion: table.schemaVersion, creates: [{ values: { [description]: 'Conteúdo privado', [money]: '100.00' } }] } });
      expect(write).toMatchObject({ code: 'TABLE_INVALID_VALUE', message: expect.stringContaining('nunca "100.00"') });
      expect(JSON.stringify(write)).not.toContain('Conteúdo privado');
      const formula = await failure('table_create', { name: 'Com fórmula', operationId: randomUUID(), columns: [
        { name: 'A', type: 'number' }, { name: 'Dobro', type: 'calculated', resultType: 'number', formula: { kind: 'call', op: 'MULTIPLY', args: [{ kind: 'ref', columnId: randomUUID() }, { kind: 'literal', type: 'number', value: '2' }] } },
      ] });
      expect(formula).toMatchObject({ code: 'TABLE_INVALID_FORMULA', message: expect.stringContaining('nunca money×money') });
      // A fórmula que o modelo mais repetiu no banco de testes (percentual de gasto): money ÷ money não existe, e a mensagem diz a regra de tipos.
      expect(await failure('table_formula_preview', { tableId: table.id, input: { resultType: 'number', values: { [money]: '10' }, formula: { kind: 'call', op: 'DIVIDE', args: [{ kind: 'ref', columnId: money }, { kind: 'ref', columnId: money }] } } }))
        .toMatchObject({ code: 'TABLE_INVALID_FORMULA', message: expect.stringContaining('não existe money÷money') });
      expect((await service.records(table.id, owner)).records).toHaveLength(0);
    } finally { await world.cleanup(); }
  });
  it('oferece contratos recursivos e executa filtro, agregado paginado e calendário pelos handlers reais', async () => {
    const world = await createRunsWorld();
    try {
      const bot = await world.createBot(); const service = new TableService({ pool: world.pool });
      const table = await service.create(tableCreateSchema.parse({ name: 'Financeiro contrato', operationId: randomUUID(), columns: [{ name: 'Aberto', type: 'boolean' }, { name: 'Vencimento', type: 'date' }, { name: 'Valor', type: 'money', currency: 'BRL' }] }), owner, bot.id);
      const [status, date, money] = table.columns.map((column) => column.id) as [string, string, string];
      await service.write(table.id, tableWriteSchema.parse({ operationId: randomUUID(), expectedSchemaVersion: table.schemaVersion, creates: [
        { values: { [status]: true, [date]: '2026-10-01', [money]: '0.1' } },
        { values: { [status]: true, [date]: '2026-10-02', [money]: '0.2' } },
        { values: { [status]: false, [date]: '2026-10-01', [money]: '999' } },
        { values: { [status]: true, [date]: '2026-11-01', [money]: '999' } },
      ] }), owner);
      world.engine.start();
      /** Extrai o resultado que chega ao modelo depois da ferramenta, sem chamar o serviço no lugar do handler. */
      const execute = async (name: string, args: unknown) => {
        const run = await world.send(bot, tableMarker(name, args)); await world.waitForStatus(run, 'completed');
        const row = (await world.pool.query<{ content: string }>("SELECT content FROM messages WHERE run_id=$1 AND kind='activity'", [run])).rows[0]!;
        return JSON.parse(row.content);
      };
      const query = { columns: [date, money], filter: { op: 'and', filters: [{ op: 'eq', columnId: status, value: true }, { op: 'lt', columnId: date, value: '2026-11-01' }] }, sort: [{ columnId: date, direction: 'asc' }], aggregate: [{ alias: 'Total', op: 'sum', columnId: money }], limit: 1 };
      const first = await execute('table_query', { tableId: table.id, query });
      expect(first).toMatchObject({ totalCount: 2, hasMore: true, aggregate: { Total: '0.3' }, records: [{ values: { [date]: '2026-10-01', [money]: '0.1' } }] });
      const second = await execute('table_query', { tableId: table.id, query: { ...query, cursor: first.nextCursor } });
      expect(second).toMatchObject({ totalCount: 2, hasMore: false, nextCursor: null, aggregate: { Total: '0.3' }, records: [{ values: { [date]: '2026-10-02', [money]: '0.2' } }] });
      const preview = { tableId: table.id, input: { resultType: 'date', formula: { kind: 'call', op: 'ADD_MONTHS', args: [{ kind: 'literal', type: 'date', value: '2026-10-31' }, { kind: 'literal', type: 'number', value: '1' }] } } };
      expect(await execute('table_formula_preview', preview)).toEqual({ value: '2026-11-30' });
      expect(() => tableTools.find((tool) => tool.definition.name === 'table_formula_preview')!.prepare(JSON.stringify({ ...preview, input: { ...preview.input, formula: { kind: 'literal', type: 'number', value: 1 } } }))).toThrow(ToolFailure);
      // O esquema efetivamente entregue ao provedor conserva as referências e suas definições de recursão. No bot (phase 15) ele chega no resultado de abrir_grupo, no fim do histórico.
      for (const name of ['table_query', 'table_formula_preview', 'table_create', 'table_view_create']) {
        // Uma abertura real por conversa prova cada schema sem exigir o catálogo inteiro fora do orçamento.
        const probe=await world.createBot({contextWindowTokens:65536});const run=await world.send(probe,tableMarker('abrir_grupo',{path:name}));await world.waitForStatus(run,'completed');
        const body=world.conversationRequests().at(-1)!.body as {messages:{role:string;content:string}[]};
        const opened=body.messages.filter((message)=>message.role==='tool').map((message)=>JSON.parse(message.content) as {name?:string;parameters?:{$defs?:Record<string,{anyOf?:unknown[]}>}}).find((entry)=>entry.name===name)!;
        const schema = opened.parameters!;
        expect(Object.values(schema.$defs ?? {}).some((node) => (node.anyOf?.length ?? 0) >= 3)).toBe(true);
        /** Resolve os $refs no documento raiz efetivamente entregue ao provedor, não num schema avulso. */
        const checkReferences = (node: unknown): void => {
          if (!node || typeof node !== 'object') return;
          const item = node as Record<string, unknown>;
          if (typeof item.$ref === 'string') {
            expect(item.$ref.startsWith('#/')).toBe(true);
            const resolved = item.$ref.slice(2).split('/').reduce<unknown>((current, key) => (current as Record<string, unknown> | undefined)?.[key.replaceAll('~1', '/').replaceAll('~0', '~')], schema);
            expect(resolved).toBeDefined();
          }
          Object.values(item).forEach(checkReferences);
        };
        checkReferences(schema);
      }
      expect((await service.records(table.id, owner)).records).toHaveLength(4);
    } finally { await world.cleanup(); }
  });
  it('table_update rejeita lista parcial como erro acionável e aceita lista completa preservando registros', async () => {
    const world = await createRunsWorld();
    try {
      const bot = await world.createBot(); const service = new TableService({ pool: world.pool });
      const table = await service.create(tableCreateSchema.parse({ name: 'Estrutura completa', operationId: randomUUID(), columns: [{ name: 'Nome', type: 'text' }] }), owner, bot.id);
      await service.write(table.id, tableWriteSchema.parse({ operationId: randomUUID(), expectedSchemaVersion: 1, creates: [{ values: { [table.columns[0]!.id]: 'Preservar' } }] }), owner);
      const baseline = await service.get(table.id, owner);
      const records = await service.records(table.id, owner); world.engine.start();
      const partial = await world.send(bot, tableMarker('table_update', { tableId: table.id, input: { operationId: randomUUID(), expectedSchemaVersion: 1, columns: [{ name: 'Nova', type: 'text' }] } }));
      await world.waitForStatus(partial, 'completed');
      const activity = (await world.pool.query<{ status: string; content: string }>("SELECT status,content FROM messages WHERE run_id=$1 AND kind='activity'", [partial])).rows[0]!;
      expect(activity.status).toBe('failed'); expect(JSON.parse(activity.content)).toMatchObject({ code: 'TABLE_COLUMNS_INCOMPLETE' });
      expect(await service.get(table.id, owner)).toEqual(baseline); expect(await service.records(table.id, owner)).toEqual(records);
      const full = await world.send(bot, tableMarker('table_update', { tableId: table.id, input: { operationId: randomUUID(), expectedSchemaVersion: 1, columns: [...table.columns, { name: 'Nova', type: 'text' }] } }));
      await world.waitForStatus(full, 'completed');
      expect((await service.get(table.id, owner)).columns).toHaveLength(2);
      expect((await service.records(table.id, owner)).records[0]).toMatchObject(records.records[0]!);
    } finally { await world.cleanup(); }
  });

  it('A21: o resultado acima de 64 KiB de uma ferramenta de tabela responde TOOL_RESULT_TOO_LARGE (o código genérico, com a orientação), e só a consulta mantém TABLE_QUERY_LIMIT', async () => {
    const world = await createRunsWorld();
    // Nenhuma ferramenta de tabela devolve 64 KiB com dados reais (as páginas do serviço cabem nesse limite), então o resultado grande vem de um serviço trocado por um que devolve preenchimento: a prova é
    // do código que o envoltório das ferramentas responde, não do tamanho que o serviço produz.
    const filler = 'x'.repeat(70_000);
    const spies = [
      vi.spyOn(TableService.prototype, 'list').mockResolvedValueOnce({ tables: [], nextCursor: null, filler } as never),
      vi.spyOn(TableService.prototype, 'queryShaped').mockResolvedValueOnce({ records: [], nextCursor: null, filler } as never),
    ];
    try {
      const bot = await world.createBot(); const service = new TableService({ pool: world.pool });
      world.engine.start();
      const table = await service.create(tableCreateSchema.parse({ name: 'Consulta', columns: [{ name: 'Texto', type: 'text' }], operationId: randomUUID() }), owner, bot.id);
      const failedWith = async (marker: string): Promise<unknown> => {
        const run = await world.send(bot, marker);
        const activity = await waitFor('atividade de tabela terminar', async () => {
          const row = (await world.pool.query<{ status: string; content: string }>("SELECT status, content FROM messages WHERE run_id = $1 AND kind = 'activity'", [run])).rows[0];
          return row && row.status !== 'running' ? row : null;
        });
        expect(activity.status).toBe('failed');
        // A execução termina antes da próxima mensagem: enviada com a execução ativa, ela viraria complemento da mesma execução (CONV-03) e a leitura seria da atividade anterior.
        await world.waitForStatus(run, 'completed');
        return JSON.parse(activity.content);
      };
      // A listagem (uma ferramenta que não é a consulta) recebe o código genérico e a orientação para pedir menos itens.
      expect(await failedWith(tableMarker('table_list', {}))).toEqual({ code: 'TOOL_RESULT_TOO_LARGE', message: expect.stringMatching(/menos itens|filtro/i) });
      // A consulta mantém o código da consulta de tabelas.
      expect(await failedWith(tableMarker('table_query', { tableId: table.id, query: { columns: [table.columns[0]!.id] } }))).toEqual({ code: 'TABLE_QUERY_LIMIT', message: expect.any(String) });
    } finally { for (const spy of spies) spy.mockRestore(); await world.cleanup(); }
  });

  it('Chat geral recusa chamada forjada e nunca oferece ferramentas de tabelas', async () => {
    const world = await createRunsWorld();
    try {
      const chat = await new GeneralChatService({ pool: world.pool }).create();
      await world.conversations.setPreference({ sessionId: chat.id }, 'opencode/glm-5.1', null);
      const run = (await world.conversations.send({ sessionId: chat.id }, tableMarker('table_create', { name: 'Forjada', operationId: randomUUID() }))).id;
      world.engine.start(); await world.waitForStatus(run, 'completed');
      const body = world.conversationRequests()[0]!.body as { tools: { function: { name: string } }[] };
      expect(body.tools.some((tool) => tool.function.name.startsWith('table_'))).toBe(false);
      expect((await world.pool.query('SELECT 1 FROM data_tables')).rowCount).toBe(0);
      expect((await world.pool.query<{ content: string }>("SELECT content FROM messages WHERE run_id=$1 AND kind='activity'", [run])).rows[0]?.content).toContain('"code":"TOOL_NOT_FOUND"');
    } finally { await world.cleanup(); }
  });
  it('catálogo botOnly, validação segura e categorias locais permitir/negar/sempre com impacto real', async () => {
    const world = await createRunsWorld();
    try {
      const bot = await world.createBot();
      const service = new TableService({ pool: world.pool });
      const create = () => service.create(tableCreateSchema.parse({ name: 'Apagar', operationId: randomUUID() }), owner, bot.id);
      world.engine.start();
      const table = await create();
      const actor = { kind: 'bot', botId: bot.id } as const;
      const prepared = await service.prepareDestructive(table.id, { kind: 'delete_table', expectedVersion: table.version }, actor);
      const args = { tableId: table.id, preparationId: prepared.preparationId, operationId: randomUUID(), confirmation: true };
      const denied = await world.send(bot, tableMarker('table_delete_table', args));
      await world.waitForStatus(denied, 'waiting_approval');
      const approval = (await world.approvalOf(denied))!;
      const card = (await world.pool.query<{ data: unknown }>('SELECT data FROM messages WHERE id=(SELECT card_id FROM approvals WHERE id=$1)', [approval.id])).rows[0]!.data;
      expect(card).toMatchObject({ appName: 'Tabelas do Aion', action: TABLE_ACTIONS.delete_table.slug, impact: { tableId: table.id, expectedVersion: table.version, recordCount: 0 } });
      await world.approvals.respond(approval.id, 'deny', { ip: '127.0.0.1', userAgent: 'tables-test' });
      await world.waitForStatus(denied, 'completed');
      expect(await service.get(table.id, owner)).toMatchObject({ id: table.id });
      const allowed = await world.send(bot, tableMarker('table_delete_table', { ...args, operationId: randomUUID() }));
      await world.waitForStatus(allowed, 'waiting_approval');
      await world.approvals.respond((await world.approvalOf(allowed))!.id, 'allow_always', { ip: '127.0.0.1', userAgent: 'tables-test' });
      await world.waitForStatus(allowed, 'completed');
      await expect(service.get(table.id, owner)).rejects.toMatchObject({ code: 'TABLE_NOT_FOUND' });
      const another = await create();
      const prep = await service.prepareDestructive(another.id, { kind: 'delete_table', expectedVersion: another.version }, actor);
      const permanent = await world.send(bot, tableMarker('table_delete_table', { ...args, tableId: another.id, preparationId: prep.preparationId, operationId: randomUUID() }));
      await world.waitForStatus(permanent, 'completed');
      expect(await world.approvalOf(permanent)).toBeNull();
      expect(world.composioExecutions()).toHaveLength(0);
      const invalid = await world.send(bot, tableMarker('table_get', { tableId: randomUUID(), botId: bot.id }));
      await world.waitForStatus(invalid, 'completed');
      const activity = (await world.pool.query<{ content: string }>("SELECT content FROM messages WHERE run_id=$1 AND kind='activity'", [invalid])).rows[0]!;
      expect(JSON.parse(activity.content)).toMatchObject({ code: 'VALIDATION_FAILED' });
    } finally { await world.cleanup(); }
  });

  it('revogação/alteração durante espera e cancelamento não executam a preparação antiga', async () => {
    const world = await createRunsWorld();
    try {
      const bot = await world.createBot(); const service = new TableService({ pool: world.pool });
      world.engine.start();
      for (const change of ['data', 'access', 'stop'] as const) {
        const table = await service.create(tableCreateSchema.parse({ name: change, operationId: randomUUID() }), owner, bot.id);
        const prep = await service.prepareDestructive(table.id, { kind: 'delete_table', expectedVersion: table.version }, { kind: 'bot', botId: bot.id });
        const run = await world.send(bot, tableMarker('table_delete_table', { tableId: table.id, preparationId: prep.preparationId, operationId: randomUUID(), confirmation: true }));
        await world.waitForStatus(run, 'waiting_approval');
        if (change === 'data') await service.write(table.id, tableWriteSchema.parse({ operationId: randomUUID(), expectedSchemaVersion: table.schemaVersion, creates: [{ values: {} }] }), owner);
        if (change === 'access') await service.share(table.id, { operationId: randomUUID(), expectedVersion: table.version, botIds: [] }, owner);
        if (change === 'stop') { await world.conversations.stop(bot.id); await world.waitForStatus(run, 'interrupted'); }
        else { await world.approvals.respond((await world.approvalOf(run))!.id, 'allow_once', { ip: '127.0.0.1', userAgent: 'tables-test' }); await world.waitForStatus(run, 'completed'); }
        expect((await service.get(table.id, owner)).id).toBe(table.id);
      }
    } finally { await world.cleanup(); }
  });

  it('restart pós-commit relê argumentos >8000, não duplica registros/versão e query multibyte chega íntegra ao próximo pedido', async () => {
    const fixture = afterCommitTool('table_write');
    const world = await createRunsWorld({ tools: fixture.tools });
    let resumed: RunEngine | undefined;
    // Usage realista (30% da estimativa crua do pedido, como um provedor de verdade): o motor calibra a escala já na primeira chamada. O valor fixo do provedor falso é
    // implausível e nunca calibra, e a estimativa de 1 token por byte do histórico (argumentos de 30 KB mais o resultado) passaria do orçamento (CONTEXT_TOO_LARGE)
    // sem que a prova seja disso: ela mede a releitura dos argumentos gravados e a integridade da consulta, não o orçamento de contexto.
    const upstream = world.provider.streamChat.bind(world.provider);
    world.provider.streamChat = async function* (key, protocol, request, signal) {
      for await (const event of upstream(key, protocol, request, signal)) {
        yield event.type === 'usage' ? { type: 'usage', usage: { ...event.usage, inputTokens: Math.round(estimateChatPayload(request, protocol).textTokens * 0.3) } } : event;
      }
    };
    try {
      const bot = await world.createBot(); const service = new TableService({ pool: world.pool });
      const table = await service.create(tableCreateSchema.parse({ name: 'Íntegro', columns: [{ name: 'A', type: 'text' }, { name: 'B', type: 'text' }], operationId: randomUUID() }), owner, bot.id);
      const values = { [table.columns[0]!.id]: '漢'.repeat(5000), [table.columns[1]!.id]: '字'.repeat(5000) };
      const args = { tableId: table.id, input: tableWriteSchema.parse({ operationId: randomUUID(), expectedSchemaVersion: table.schemaVersion, creates: [{ values }] }) };
      const run = await world.send(bot, tableMarker('table_write', args)); world.engine.start();
      const { waitFor } = await import('../runs/test-support');
      await waitFor('failpoint após commit', async () => fixture.reached());
      const version = (await service.get(table.id, owner)).version;
      await world.engine.stop();
      const raw = (await world.pool.query<{ tool_arguments: string; data: { arguments: string } }>("SELECT tool_arguments,data FROM messages WHERE run_id=$1 AND kind='activity'", [run])).rows[0]!;
      expect(raw.tool_arguments.length).toBeGreaterThan(8000); expect(JSON.parse(raw.tool_arguments)).toEqual(args);
      expect(raw.data.arguments).toBe(`${raw.tool_arguments.slice(0, 8000)}… [truncado]`);
      resumed = new RunEngine({ pool: world.pool, credentials: world.credentials, provider: world.provider, models: world.models, logger: world.logger, config: FAST_ENGINE }); resumed.start();
      await world.waitForStatus(run, 'completed');
      expect((await service.get(table.id, owner)).version).toBe(version);
      expect((await service.records(table.id, owner)).records).toHaveLength(1);
      const query = await world.send(bot, tableMarker('table_query', { tableId: table.id, query: { columns: table.columns.map((column) => column.id) } }));
      await world.waitForStatus(query, 'completed');
      const result = (await world.pool.query<{ content: string }>("SELECT content FROM messages WHERE run_id=$1 AND kind='activity'", [query])).rows[0]!.content;
      expect(result.length).toBeGreaterThan(8000); expect(Buffer.byteLength(result)).toBeLessThanOrEqual(64 * 1024);
      expect(JSON.parse(result).records[0].values).toEqual(values);
      const request = world.conversationRequests().at(-1)!.body as { messages: { role: string; content: string; tool_calls?: { function: { arguments: string } }[] }[] };
      // O pedido leva a forma markdown do resultado gravado (TAB-03, sem corte porque ela cabe nos 12.000 caracteres do teto): as células multibyte chegam íntegras e o JSON gravado fica só no banco.
      const sent = request.messages.filter((message) => message.role === 'tool').at(-1)!.content;
      const form = formatTableQueryForModel(result)!;
      expect(form.length).toBeLessThan(RESULT_PROMPT_MAX_CHARS - 300);
      expect(sent).toMatch(TABLE_FRAME_OPEN);
      expect(sent).toContain(`\n${form}\n</conteudo_tabela_nao_confiavel_`);
      expect(sent).toContain(values[table.columns[0]!.id]!); expect(sent).toContain(values[table.columns[1]!.id]!);
      expect(sent).not.toContain('"records"');
      const persisted = (await world.pool.query<{ content: string; data: unknown }>("SELECT content,data FROM messages WHERE run_id=$1 AND kind='activity'", [run])).rows;
      expect(persisted).toHaveLength(1);
    } finally { await resumed?.stop(); await world.cleanup(); }
  });

  it('consulta >8000 persistida atravessa restart antes do próximo pedido, sem cortar células/cursor', async () => {
    const world = await createRunsWorld(); let resumed: RunEngine | undefined;
    const original = world.provider.streamChat.bind(world.provider);
    try {
      const bot = await world.createBot(); const service = new TableService({ pool: world.pool });
      const table = await service.create(tableCreateSchema.parse({ name: 'Query retomada', columns: [{ name: 'Texto', type: 'text' }], operationId: randomUUID() }), owner, bot.id);
      const values = { [table.columns[0]!.id]: '漢🙂'.repeat(2666) };
      await service.write(table.id, tableWriteSchema.parse({ operationId: randomUUID(), expectedSchemaVersion: table.schemaVersion, creates: [{ values }, { values }] }), owner);
      let reached = false;
      world.provider.streamChat = async function* (key, protocol, request, signal) {
        if (request.turns.at(-1)?.role === 'tool' && (request.turns.at(-1) as { name: string }).name === 'table_query') {
          reached = true;
          await new Promise<void>((_resolve, reject) => { signal?.addEventListener('abort', () => reject(new Error('worker de teste parado após persistência')), { once: true }); });
        }
        yield* original(key, protocol, request, signal);
      };
      const run = await world.send(bot, tableMarker('table_query', { tableId: table.id, query: { columns: [table.columns[0]!.id], limit: 1 } }));
      world.engine.start(); const { waitFor } = await import('../runs/test-support');
      await waitFor('query persistida antes da próxima chamada', async () => reached);
      const before = (await world.pool.query<{ content: string }>("SELECT content FROM messages WHERE run_id=$1 AND kind='activity'", [run])).rows[0]!.content;
      expect(before.length).toBeGreaterThan(8000); expect(Buffer.byteLength(before)).toBeLessThanOrEqual(64 * 1024);
      expect(JSON.parse(before)).toMatchObject({ records: [{ values }], hasMore: true });
      await world.engine.stop(); world.provider.streamChat = original;
      resumed = world.createEngine(); resumed.start(); await world.waitForStatus(run, 'completed');
      const after = (await world.pool.query<{ content: string }>("SELECT content FROM messages WHERE run_id=$1 AND kind='activity'", [run])).rows;
      expect(after).toEqual([{ content: before }]);
      const request = world.conversationRequests().at(-1)!.body as { messages: { role: string; content: string }[] };
      // O pedido leva a forma markdown do resultado persistido (a mesma de antes do restart), com a célula multibyte inteira e o cursor, sem corte: a forma cabe no teto de 12.000.
      const sent = request.messages.filter((message) => message.role === 'tool').at(-1)!.content;
      const form = formatTableQueryForModel(before)!;
      expect(form.length).toBeLessThan(RESULT_PROMPT_MAX_CHARS - 300);
      expect(sent).toMatch(TABLE_FRAME_OPEN);
      expect(sent).toContain(`\n${form}\n</conteudo_tabela_nao_confiavel_`);
      expect(sent).toContain(values[table.columns[0]!.id]!);
      expect(sent).toMatch(/\ntotalCount=2 hasMore=true nextCursor=\S+\n/);
    } finally { world.provider.streamChat = original; await resumed?.stop(); await world.cleanup(); }
  });

  it('consulta acima de 12.000 caracteres persistida atravessa restart: o pedido leva a mesma forma markdown cortada antes e depois da retomada, com metadados, legenda e marcador (A3, A6)', async () => {
    const world = await createRunsWorld({ contextWindow: 'product' }); let resumed: RunEngine | undefined;
    const original = world.provider.streamChat.bind(world.provider);
    try {
      const bot = await world.createBot(); const service = new TableService({ pool: world.pool });
      const table = await service.create(tableCreateSchema.parse({ name: 'Página cheia', columns: [{ name: 'Título', type: 'text' }, { name: 'Detalhe', type: 'text' }], operationId: randomUUID() }), owner, bot.id);
      const creates = Array.from({ length: 100 }, (_, index) => ({ values: { [table.columns[0]!.id]: `Registro ${index}`, [table.columns[1]!.id]: `Detalhe do registro ${index}: ${'texto de apoio '.repeat(8)}` } }));
      await service.write(table.id, tableWriteSchema.parse({ operationId: randomUUID(), expectedSchemaVersion: table.schemaVersion, creates }), owner);
      let reached = false; let blocked = '';
      world.provider.streamChat = async function* (key, protocol, request, signal) {
        const last = request.turns.at(-1);
        if (last?.role === 'tool' && last.name === 'table_query') {
          // O pedido que o modelo recebeu antes do restart: a forma que o motor monta da linha já gravada.
          blocked = last.text; reached = true;
          await new Promise<void>((_resolve, reject) => { signal?.addEventListener('abort', () => reject(new Error('worker de teste parado após persistência')), { once: true }); });
        }
        yield* original(key, protocol, request, signal);
      };
      const run = await world.send(bot, tableMarker('table_query', { tableId: table.id, query: { limit: 100 } }));
      world.engine.start(); const { waitFor } = await import('../runs/test-support');
      await waitFor('query persistida antes da próxima chamada', async () => reached);
      const stored = (await world.pool.query<{ id: string; content: string }>("SELECT id::text, content FROM messages WHERE run_id=$1 AND kind='activity'", [run])).rows[0]!;
      expect(JSON.parse(stored.content).records).toHaveLength(100);
      expect(Buffer.byteLength(stored.content)).toBeLessThanOrEqual(64 * 1024);
      await world.engine.stop(); world.provider.streamChat = original;
      resumed = world.createEngine(); resumed.start(); await world.waitForStatus(run, 'completed');
      const request = world.conversationRequests().at(-1)!.body as { messages: { role: string; content: string }[] };
      const sent = request.messages.filter((message) => message.role === 'tool').at(-1)!.content;
      // A forma da retomada é a mesma byte a byte, na moldura, no teto e cortada numa quebra de linha, com metadados e legenda; o resto volta por `read_activity` a partir do offset do marcador.
      expect(sent).toBe(blocked);
      expect(sent.length).toBeLessThanOrEqual(RESULT_PROMPT_MAX_CHARS);
      expect(sent.length).toBeGreaterThan(RESULT_PROMPT_MAX_CHARS - 600);
      expect(sent).toMatch(new RegExp(`${TABLE_FRAME_OPEN.source}totalCount=100 hasMore=false\\ncolunas: Título = \\S+; Detalhe = \\S+\\n\\| id \\| v \\| Título \\| Detalhe \\|\\n`));
      expect(sent).toMatch(new RegExp(`\\n</conteudo_tabela_nao_confiavel_[a-f0-9]{16}>\\n\\[mostrando [\\d.]+ de [\\d.]+ caracteres; continue em read_activity messageId=${stored.id} offset=\\d+\\]$`));
      expect(sent).not.toContain('"records"');
    } finally { world.provider.streamChat = original; await resumed?.stop(); await world.cleanup(); }
  });

  it('parada durante INSERT lento impede commit tardio e não deixa registros parciais', async () => {
    const world = await createRunsWorld();
    try {
      const bot = await world.createBot(); const service = new TableService({ pool: world.pool });
      const table = await service.create(tableCreateSchema.parse({ name: 'Parada', operationId: randomUUID() }), owner, bot.id);
      // Espera local do PostgreSQL abre a janela controlada; a ferramenta original continua responsável pela transação.
      await world.pool.query('CREATE FUNCTION test_slow_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.3); RETURN NEW; END $$; CREATE TRIGGER test_slow_insert AFTER INSERT ON table_records FOR EACH ROW EXECUTE FUNCTION test_slow_insert()');
      const handler = tableTools.find((tool) => tool.definition.name === 'table_write')!;
      const custom = tableTools.map((tool) => tool !== handler ? tool : { ...tool, prepare(raw: string) {
        const prepared = handler.prepare(raw);
        return { ...prepared, execute: async (ctx: Parameters<typeof prepared.execute>[0]) => {
          const stop = setTimeout(() => { void world.conversations.stop(bot.id); }, 80);
          try { return await prepared.execute(ctx); } finally { clearTimeout(stop); }
        } };
      } });
      const engine = new RunEngine({ pool: world.pool, credentials: world.credentials, provider: world.provider, models: world.models, logger: world.logger, config: FAST_ENGINE, tools: custom });
      try {
        const run = await world.send(bot, tableMarker('table_write', { tableId: table.id, input: { operationId: randomUUID(), expectedSchemaVersion: table.schemaVersion, creates: [{ values: {} }] } }));
        engine.start(); await world.waitForStatus(run, 'interrupted');
        expect((await service.records(table.id, owner)).records).toEqual([]);
        expect((await service.get(table.id, owner)).version).toBe(table.version);
      } finally { await engine.stop(); }
    } finally { await world.cleanup(); }
  });

  // ---------------------------------------------------------------------------------------------
  // Phase 11 (TAB-03): resultado com nomes e rótulos, e id curto de registro nas entradas das ferramentas
  // ---------------------------------------------------------------------------------------------

  /** Chama uma ferramenta de tabela pelo motor e devolve a atividade gravada: o status e o texto que o modelo recebe. */
  const call = async (world: RunsWorld, bot: { id: string }, name: string, args: unknown) => {
    const run = await world.send(bot as never, tableMarker(name, args)); await world.waitForStatus(run, 'completed');
    return (await world.pool.query<{ status: string; content: string }>("SELECT status, content FROM messages WHERE run_id=$1 AND kind='activity'", [run])).rows[0]!;
  };
  /** Id com o mesmo começo em vários registros: o que `randomUUID` quase nunca produz e a ambiguidade exige. */
  const twin = (tail: string): string => `ab12cd34-0000-4000-8000-${tail.padStart(12, '0')}`;

  it('table_query grava nomes e rótulos usados, e o id curto da forma ao modelo vale em table_write; o recibo guarda o id completo e o replay com o id completo o reconhece', async () => {
    const world = await createRunsWorld();
    try {
      const bot = await world.createBot(); const service = new TableService({ pool: world.pool });
      world.engine.start();
      const option = randomUUID();
      const table = await service.create(tableCreateSchema.parse({ name: 'Id curto', operationId: randomUUID(), columns: [{ name: 'Nome', type: 'text' }, { name: 'Fase', type: 'select', options: [{ id: option, label: 'Em análise' }, { id: randomUUID(), label: 'Nunca usada' }] }] }), owner, bot.id);
      const [name, phase] = table.columns.map((column) => column.id) as [string, string];
      const written = await service.write(table.id, tableWriteSchema.parse({ operationId: randomUUID(), expectedSchemaVersion: table.schemaVersion, creates: [{ values: { [name]: 'Alfa', [phase]: option } }, { values: { [name]: 'Beta', [phase]: null } }] }), owner);
      const [alfa, beta] = written.records.map((record) => record.id) as [string, string];

      const query = await call(world, bot, 'table_query', { tableId: table.id, query: { columns: [name, phase], sort: [{ columnId: name, direction: 'asc' }] } });
      const stored = JSON.parse(query.content) as { records: { id: string }[]; columns: unknown; totalCount: number };
      // O resultado gravado mantém o envelope do serviço e leva, só para o que aparece nas células, o nome da coluna e o rótulo das opções usadas.
      expect(stored).toMatchObject({ totalCount: 2, hasMore: false, nextCursor: null });
      expect(stored.records.map((record) => record.id)).toEqual([alfa, beta]);
      expect(stored.columns).toEqual([{ id: name, name: 'Nome' }, { id: phase, name: 'Fase', labels: { [option]: 'Em análise' } }]);
      const rows = formatTableQueryForModel(query.content)!.split('\n').slice(4);
      expect(rows[0]).toMatch(/^\| [0-9a-f]{8} \| 1 \| Alfa \| Em análise \|$/);
      expect(rows[1]).toMatch(/^\| [0-9a-f]{8} \| 1 \| Beta \| {2}\|$/);

      // O id curto copiado da linha de Alfa grava no registro certo, com a versão esperada, e a resposta devolve o id completo.
      const operationId = randomUUID();
      const input = { operationId, expectedSchemaVersion: table.schemaVersion, updates: [{ id: rows[0]!.slice(2, 10), expectedVersion: 1, values: { [name]: 'Alfa 2' } }] };
      const done = await call(world, bot, 'table_write', { tableId: table.id, input });
      expect(done.status).toBe('completed');
      expect(JSON.parse(done.content)).toEqual({ records: [{ id: alfa, version: 2 }] });
      expect((await service.records(table.id, owner)).records.find((record) => record.id === alfa)!.values[name]).toBe('Alfa 2');
      // O recibo foi gravado com o id completo: a mesma operação pelo UUID completo (e de novo pelo prefixo em maiúsculas) cai no replay, sem conflito nem nova versão.
      const receipt = (await world.pool.query<{ result: { records: { id: string }[] } }>('SELECT result FROM table_mutation_receipts WHERE operation_id = $1', [operationId])).rows[0]!;
      expect(receipt.result.records[0]!.id).toBe(alfa);
      const full = await call(world, bot, 'table_write', { tableId: table.id, input: { ...input, updates: [{ ...input.updates[0]!, id: alfa }] } });
      expect(full).toMatchObject({ status: 'completed' }); expect(JSON.parse(full.content)).toEqual({ records: [{ id: alfa, version: 2 }] });
      const upper = await call(world, bot, 'table_write', { tableId: table.id, input: { ...input, updates: [{ ...input.updates[0]!, id: input.updates[0]!.id.toUpperCase() }] } });
      expect(JSON.parse(upper.content)).toEqual({ records: [{ id: alfa, version: 2 }] });
      expect((await service.records(table.id, owner)).records.find((record) => record.id === alfa)!.version).toBe(2);
    } finally { await world.cleanup(); }
  });

  it('o id mostrado na forma ao modelo sempre resolve de volta ao próprio registro, mesmo com ids que começam igual; ambiguidade, inexistente, formato inválido, outra tabela e tabela sem acesso têm o código certo e nada é gravado', async () => {
    const world = await createRunsWorld();
    try {
      const bot = await world.createBot(); const stranger = await world.createBot(); const service = new TableService({ pool: world.pool });
      world.engine.start();
      const table = await service.create(tableCreateSchema.parse({ name: 'Colisão', operationId: randomUUID(), columns: [{ name: 'Nome', type: 'text' }] }), owner, bot.id);
      const name = table.columns[0]!.id;
      const [one, two, three] = [twin('1'), twin('2'), 'ab12cd35-0000-4000-8000-000000000001'];
      await world.pool.query('INSERT INTO table_records (table_id, id, values) VALUES ($1,$2,$3),($1,$4,$5),($1,$6,$7)', [table.id, one, JSON.stringify({ [name]: 'Gêmeo A' }), two, JSON.stringify({ [name]: 'Gêmeo B' }), three, JSON.stringify({ [name]: 'Vizinho' })]);
      // Outra tabela do mesmo bot, com um registro de prefixo próprio (a criação já grava um recibo, por isso vem antes da contagem).
      const other = await service.create(tableCreateSchema.parse({ name: 'Outra', operationId: randomUUID(), columns: [{ name: 'Nome', type: 'text' }] }), owner, bot.id);
      await world.pool.query('INSERT INTO table_records (table_id, id, values) VALUES ($1,$2,$3)', [other.id, 'feedbabe-0000-4000-8000-000000000001', '{}']);
      const write = (id: string, label: string) => call(world, bot, 'table_write', { tableId: table.id, input: { operationId: randomUUID(), expectedSchemaVersion: table.schemaVersion, updates: [{ id, expectedVersion: 1, values: { [name]: label } }] } });
      const untouched = async () => (await service.records(table.id, owner)).records.map((record) => [record.id, record.version, record.values[name]]);
      const before = await untouched();
      const receipts = async () => Number((await world.pool.query<{ count: string }>('SELECT count(*) FROM table_mutation_receipts')).rows[0]!.count);
      const receiptsBefore = await receipts();

      // A forma da consulta mostra id mais longo só para os que precisam, e cada id mostrado resolve para o próprio registro.
      const listed = await call(world, bot, 'table_query', { tableId: table.id, query: { columns: [name], sort: [{ columnId: name, direction: 'asc' }] } });
      const shown = formatTableQueryForModel(listed.content)!.split('\n').slice(4).map((line) => line.slice(2).split(' | ')[0]!);
      expect(shown).toEqual(shortRecordIds([one, two, three]));
      expect(shown.map((id) => id.length)).toEqual([36, 36, 8]);
      expect(await service.resolveRecordRefs(table.id, shown, { kind: 'bot', botId: bot.id })).toEqual([one, two, three]);

      // Ambiguidade: o resultado traz o prefixo e os candidatos com o nome; nada é gravado nem tem recibo.
      const ambiguous = await write('ab12cd34', 'não deve gravar');
      expect(ambiguous.status).toBe('failed');
      expect(JSON.parse(ambiguous.content)).toEqual({ code: 'TABLE_RECORD_AMBIGUOUS', message: ERROR_CODES.TABLE_RECORD_AMBIGUOUS.message, prefix: 'ab12cd34', candidates: [{ id: one, name: 'Gêmeo A' }, { id: two, name: 'Gêmeo B' }], moreCandidates: 0 });
      expect(await untouched()).toEqual(before); expect(await receipts()).toBe(receiptsBefore);

      // Inexistente na tabela, formato inválido (recusado já na borda) e registro de OUTRA tabela do mesmo bot, por prefixo ou por id completo: nenhum resolve e nada muda.
      for (const [id, code] of [['deadbeef', 'TABLE_NOT_FOUND'], ['feedbabe', 'TABLE_NOT_FOUND'], ['a1b2c3d', 'VALIDATION_FAILED'], ["ab12cd34'; DROP TABLE bots;--", 'VALIDATION_FAILED'], ['feedbabe-0000-4000-8000-000000000001', 'TABLE_NOT_FOUND']] as const) {
        const refused = await write(id, 'não deve gravar');
        expect(refused.status, id).toBe('failed'); expect(JSON.parse(refused.content), id).toMatchObject({ code });
      }
      expect(await untouched()).toEqual(before); expect(await receipts()).toBe(receiptsBefore);
      expect((await service.records(other.id, owner)).records.map((record) => record.version)).toEqual([1]);

      // Tabela de outro bot: o prefixo e o id completo recebem a mesma resposta de tabela inexistente (nenhum oráculo de existência).
      const foreign = await service.create(tableCreateSchema.parse({ name: 'Alheia', operationId: randomUUID(), columns: [{ name: 'Nome', type: 'text' }] }), owner, stranger.id);
      await world.pool.query('INSERT INTO table_records (table_id, id, values) VALUES ($1,$2,$3)', [foreign.id, 'beadcafe-0000-4000-8000-000000000001', '{}']);
      for (const id of ['beadcafe', 'beadcafe-0000-4000-8000-000000000001']) {
        const denied = await call(world, bot, 'table_query', { tableId: foreign.id, query: { recordIds: [id], columns: [] } });
        expect(denied.status, id).toBe('failed'); expect(JSON.parse(denied.content), id).toMatchObject({ code: 'TABLE_NOT_FOUND' });
      }

      // Depois do erro o bot refaz com o id completo e a escrita acontece.
      const retried = await write(one, 'Gêmeo A2');
      expect(retried.status).toBe('completed'); expect(JSON.parse(retried.content)).toEqual({ records: [{ id: one, version: 2 }] });
    } finally { await world.cleanup(); }
  });

  it('table_query por recordIds e table_prepare_operation delete_records aceitam o id curto e gravam só ids completos', async () => {
    const world = await createRunsWorld();
    try {
      const bot = await world.createBot(); const service = new TableService({ pool: world.pool });
      world.engine.start();
      const table = await service.create(tableCreateSchema.parse({ name: 'Recortes', operationId: randomUUID(), columns: [{ name: 'Nome', type: 'text' }] }), owner, bot.id);
      const name = table.columns[0]!.id;
      const written = await service.write(table.id, tableWriteSchema.parse({ operationId: randomUUID(), expectedSchemaVersion: table.schemaVersion, creates: [{ values: { [name]: 'Um' } }, { values: { [name]: 'Dois' } }, { values: { [name]: 'Três' } }] }), owner);
      const [first, second] = written.records.map((record) => record.id) as [string, string, string];

      const lookup = await call(world, bot, 'table_query', { tableId: table.id, query: { recordIds: [second.slice(0, 8).toUpperCase(), first], columns: [name] } });
      expect(lookup.status).toBe('completed');
      const found = JSON.parse(lookup.content) as { records: { id: string; values: Record<string, string> }[]; totalCount: number };
      expect(found.totalCount).toBe(2);
      expect(found.records.map((record) => [record.id, record.values[name]]).sort()).toEqual([[first, 'Um'], [second, 'Dois']].sort());
      // Lista com o mesmo registro por duas grafias é recusada na borda, como a lista repetida do contrato compartilhado.
      expect(JSON.parse((await call(world, bot, 'table_query', { tableId: table.id, query: { recordIds: [second.slice(0, 8), second.slice(0, 8).toUpperCase()] } })).content)).toMatchObject({ code: 'VALIDATION_FAILED' });

      const current = await service.get(table.id, owner);
      const prepared = await call(world, bot, 'table_prepare_operation', { tableId: table.id, operation: { kind: 'delete_records', expectedVersion: current.version, records: [{ id: second.slice(0, 8), expectedVersion: 1 }] } });
      expect(prepared.status).toBe('completed');
      const { preparationId, impact } = JSON.parse(prepared.content) as { preparationId: string; impact: { recordIds: string[]; recordCount: number } };
      expect(impact).toMatchObject({ recordIds: [second], recordCount: 1 });
      const definition = (await world.pool.query<{ definition: { records: { id: string }[] } }>('SELECT definition FROM table_operation_preparations WHERE id = $1', [preparationId])).rows[0]!.definition;
      expect(definition.records).toEqual([{ id: second, expectedVersion: 1 }]);
      // A preparação não apaga nada, e as outras categorias seguem aceitas pelo mesmo schema (delete_table só precisa da revisão).
      expect((await service.records(table.id, owner)).records).toHaveLength(3);
      expect((await call(world, bot, 'table_prepare_operation', { tableId: table.id, operation: { kind: 'delete_table', expectedVersion: current.version } })).status).toBe('completed');
    } finally { await world.cleanup(); }
  });

  it('replay da escrita com id curto termina como com o id completo: devolve o recibo mesmo com o prefixo agora ambíguo ou o registro sumido, sem nova escrita, e não afrouxa conflito, remoção nem acesso', async () => {
    const world = await createRunsWorld();
    try {
      const bot = await world.createBot(); const stranger = await world.createBot(); const service = new TableService({ pool: world.pool });
      world.engine.start();
      const table = await service.create(tableCreateSchema.parse({ name: 'Replay', operationId: randomUUID(), columns: [{ name: 'Nome', type: 'text' }] }), owner, bot.id);
      const name = table.columns[0]!.id;
      const [target, rival, solo] = [twin('1'), twin('2'), 'cafe0001-0000-4000-8000-000000000001'];
      await world.pool.query('INSERT INTO table_records (table_id, id, values) VALUES ($1,$2,$3),($1,$4,$5)', [table.id, target, JSON.stringify({ [name]: 'Alvo' }), solo, JSON.stringify({ [name]: 'Sozinho' })]);
      const write = (as: { id: string }, id: string, label: string, operationId: string) => call(world, as, 'table_write', { tableId: table.id, input: { operationId, expectedSchemaVersion: table.schemaVersion, updates: [{ id, expectedVersion: 1, values: { [name]: label } }] } });
      const records = async () => (await service.records(table.id, owner)).records.map((record) => [record.id, record.version, record.values[name]]);
      const receipts = async () => Number((await world.pool.query<{ count: string }>('SELECT count(*) FROM table_mutation_receipts')).rows[0]!.count);

      // Primeira escrita pelo id curto: grava, e o recibo fica com o id completo.
      const op = randomUUID();
      const first = await write(bot, 'ab12cd34', 'Alvo 2', op);
      expect(first.status).toBe('completed'); expect(JSON.parse(first.content)).toEqual({ records: [{ id: target, version: 2 }] });

      // Depois do commit, outro registro passa a começar igual: uma escrita NOVA pelo mesmo prefixo é ambígua (controle), mas o replay da operação já gravada não.
      await world.pool.query('INSERT INTO table_records (table_id, id, values) VALUES ($1,$2,$3)', [table.id, rival, JSON.stringify({ [name]: 'Rival' })]);
      const fresh = await write(bot, 'ab12cd34', 'não deve gravar', randomUUID());
      expect(fresh.status).toBe('failed'); expect(JSON.parse(fresh.content)).toMatchObject({ code: 'TABLE_RECORD_AMBIGUOUS', candidates: [{ id: target }, { id: rival }], moreCandidates: 0 });
      const settled = await records(); const receiptsSettled = await receipts();
      const replay = await write(bot, 'ab12cd34', 'Alvo 2', op);
      expect(replay).toEqual(first);
      expect(await records()).toEqual(settled); expect(await receipts()).toBe(receiptsSettled);

      // A operação com o mesmo operationId e conteúdo diferente continua sendo conflito: a resolução pelo recibo não aceita entrada diferente da gravada.
      const changed = await write(bot, 'ab12cd34', 'outro valor', op);
      expect(changed.status).toBe('failed'); expect(JSON.parse(changed.content)).toMatchObject({ code: 'TABLE_CONFLICT' });
      expect(await records()).toEqual(settled); expect(await receipts()).toBe(receiptsSettled);

      // Registro que sumiu da tabela sem passar pela exclusão confirmada (o recibo segue intacto): o replay devolve o recibo, igual ao replay com o id completo.
      await world.pool.query('DELETE FROM table_records WHERE table_id = $1 AND id = $2', [table.id, target]);
      const vanished = await records();
      expect(await write(bot, 'ab12cd34', 'Alvo 2', op)).toEqual(first);
      expect(await write(bot, target, 'Alvo 2', op)).toEqual(first);
      expect(await records()).toEqual(vanished); expect(await receipts()).toBe(receiptsSettled);

      // Registro removido pela exclusão confirmada: o recibo vira "recurso removido", e o replay pelo id curto responde o mesmo que pelo id completo, sem gravar.
      const removedOp = randomUUID();
      expect(JSON.parse((await write(bot, 'cafe0001', 'Sozinho 2', removedOp)).content)).toEqual({ records: [{ id: solo, version: 2 }] });
      const { preparationId } = await service.prepareDestructive(table.id, { kind: 'delete_records', expectedVersion: (await service.get(table.id, owner)).version, records: [{ id: solo, expectedVersion: 2 }] }, owner);
      await service.confirmDestructive(table.id, { preparationId, operationId: randomUUID(), confirmation: true }, owner);
      const afterRemoval = await records(); const receiptsAfterRemoval = await receipts();
      const byFull = await write(bot, solo, 'Sozinho 2', removedOp);
      const byShort = await write(bot, 'cafe0001', 'Sozinho 2', removedOp);
      expect(byFull.status).toBe('failed'); expect(JSON.parse(byFull.content)).toMatchObject({ code: 'TABLE_RESOURCE_REMOVED' });
      expect(byShort).toEqual(byFull);
      expect(await records()).toEqual(afterRemoval); expect(await receipts()).toBe(receiptsAfterRemoval);

      // Acesso: outro bot (sem a tabela) e o próprio bot depois de perder o acesso recebem a resposta de tabela inexistente, com o prefixo e com o id completo; o recibo nunca é entregue.
      const lost = await write(stranger, 'ab12cd34', 'Alvo 2', op);
      expect(lost.status).toBe('failed'); expect(JSON.parse(lost.content)).toMatchObject({ code: 'TABLE_NOT_FOUND' });
      await world.pool.query('DELETE FROM table_bot_access WHERE table_id = $1', [table.id]);
      const byShortDenied = await write(bot, 'ab12cd34', 'Alvo 2', op);
      const byFullDenied = await write(bot, target, 'Alvo 2', op);
      expect(byFullDenied.status).toBe('failed'); expect(JSON.parse(byFullDenied.content)).toMatchObject({ code: 'TABLE_NOT_FOUND' });
      expect(byShortDenied).toEqual(byFullDenied);
      expect(await records()).toEqual(afterRemoval); expect(await receipts()).toBe(receiptsAfterRemoval);
    } finally { await world.cleanup(); }
  });

  it('célula de relação aceita o id curto lido no table_query do DESTINO: vínculo e recibo guardam o UUID completo, só a tabela de destino da coluna resolve, e ambíguo, inexistente, mal formado e destino sem acesso têm o código certo sem gravar nada', async () => {
    const world = await createRunsWorld();
    try {
      const bot = await world.createBot(); const stranger = await world.createBot(); const service = new TableService({ pool: world.pool });
      world.engine.start();
      // Destino: dois registros que começam igual (ambiguidade real), um vizinho que só difere no 8º caractere e um isolado.
      const dest = await service.create(tableCreateSchema.parse({ name: 'Destino', operationId: randomUUID(), columns: [{ name: 'Nome', type: 'text' }] }), owner, bot.id);
      const destName = dest.columns[0]!.id;
      const [twinA, twinB, neighbor, solo] = [twin('1'), twin('2'), 'ab12cd35-0000-4000-8000-000000000001', 'beef0001-0000-4000-8000-000000000001'];
      await world.pool.query('INSERT INTO table_records (table_id, id, values) VALUES ($1,$2,$3),($1,$4,$5),($1,$6,$7),($1,$8,$9)', [dest.id, twinA, JSON.stringify({ [destName]: 'Gêmeo A' }), twinB, JSON.stringify({ [destName]: 'Gêmeo B' }), neighbor, JSON.stringify({ [destName]: 'Vizinho' }), solo, JSON.stringify({ [destName]: 'Isolado' })]);
      const table = await service.create(tableCreateSchema.parse({ name: 'Origem', operationId: randomUUID(), columns: [{ name: 'Nome', type: 'text' }, { name: 'Um', type: 'relation', targetTableId: dest.id, cardinality: 'one' }, { name: 'Muitos', type: 'relation', targetTableId: dest.id, cardinality: 'many' }] }), owner, bot.id);
      const [name, one, many] = table.columns.map((column) => column.id) as [string, string, string];
      const write = (input: Record<string, unknown>) => call(world, bot, 'table_write', { tableId: table.id, input: { operationId: randomUUID(), expectedSchemaVersion: table.schemaVersion, ...input } });
      const links = async () => (await world.pool.query<{ column_id: string; target_table_id: string; target_record_id: string }>('SELECT column_id, target_table_id, target_record_id FROM table_links WHERE table_id = $1 ORDER BY column_id, target_record_id', [table.id])).rows;

      // O que o modelo lê no table_query do DESTINO: os gêmeos precisam do id inteiro, o vizinho e o isolado bastam com 8 caracteres.
      const listed = await call(world, bot, 'table_query', { tableId: dest.id, query: { columns: [destName], sort: [{ columnId: destName, direction: 'asc' }] } });
      const shown = formatTableQueryForModel(listed.content)!.split('\n').slice(4).map((line) => line.slice(2).split(' | ')[0]!);
      expect(shown).toEqual(shortRecordIds([twinA, twinB, solo, neighbor]));
      expect(shown.map((id) => id.length)).toEqual([36, 36, 8, 8]);
      const [shownTwinA, , shownSolo, shownNeighbor] = shown as [string, string, string, string];

      // Criação com ids curtos (um em maiúsculas) e um UUID completo na lista: o vínculo e o recibo guardam o UUID completo, e o texto parecido com id numa coluna de TEXTO não é tocado.
      const created = await write({ creates: [{ values: { [name]: 'Linha', [one]: shownSolo.toUpperCase(), [many]: [shownNeighbor, shownTwinA] } }, { values: { [name]: 'deadbeef' } }] });
      expect(created.status).toBe('completed');
      const rows = (await service.records(table.id, owner)).records;
      const line = rows.find((record) => record.values[name] === 'Linha')!;
      expect(line.values).toEqual({ [name]: 'Linha', [one]: solo, [many]: [twinA, neighbor] });
      expect(rows.some((record) => record.values[name] === 'deadbeef')).toBe(true);
      const linked = await links();
      expect(linked).toHaveLength(3);
      expect(linked).toEqual(expect.arrayContaining([{ column_id: one, target_table_id: dest.id, target_record_id: solo }, ...[twinA, neighbor].map((id) => ({ column_id: many, target_table_id: dest.id, target_record_id: id }))]));
      const receipt = (await world.pool.query<{ result: { records: { id: string; values: Record<string, unknown> }[] } }>("SELECT result FROM table_mutation_receipts WHERE table_id = $1 AND action = 'table.write'", [table.id])).rows[0]!;
      expect(receipt.result.records.find((record) => record.id === line.id)!.values).toMatchObject({ [one]: solo, [many]: [twinA, neighbor] });

      // Atualização: o id curto do registro (updates[].id) e o da célula de relação resolvem juntos, e a lista omitida é preservada.
      const updated = await write({ updates: [{ id: line.id.slice(0, 8), expectedVersion: 1, values: { [one]: shownNeighbor } }] });
      expect(updated.status).toBe('completed');
      expect((await service.records(table.id, owner)).records.find((record) => record.id === line.id)!.values).toMatchObject({ [one]: neighbor, [many]: [twinA, neighbor] });

      // Recusas: nada é gravado (registros, vínculos e recibos ficam como estavam).
      const other = await service.create(tableCreateSchema.parse({ name: 'Outra', operationId: randomUUID(), columns: [{ name: 'Nome', type: 'text' }] }), owner, bot.id);
      await world.pool.query('INSERT INTO table_records (table_id, id, values) VALUES ($1,$2,$3)', [other.id, 'feedbabe-0000-4000-8000-000000000001', '{}']);
      const snapshot = async () => ({ records: (await service.records(table.id, owner)).records, links: await links(), receipts: Number((await world.pool.query<{ count: string }>('SELECT count(*) FROM table_mutation_receipts')).rows[0]!.count) });
      const before = await snapshot();
      const refuse = async (label: string, values: Record<string, unknown>, code: string) => {
        const refused = await write({ creates: [{ values: { [name]: 'não deve gravar', ...values } }] });
        expect(refused.status, label).toBe('failed'); expect(JSON.parse(refused.content), label).toMatchObject({ code });
      };
      // Inexistente no DESTINO, inclusive o prefixo de um registro que existe só em OUTRA tabela ou só na própria tabela escrita: a coluna manda, nenhuma outra tabela resolve.
      await refuse('inexistente', { [one]: 'deadbeef' }, 'TABLE_NOT_FOUND');
      await refuse('só em outra tabela', { [one]: 'feedbabe' }, 'TABLE_NOT_FOUND');
      await refuse('só na tabela escrita', { [one]: line.id.slice(0, 8) }, 'TABLE_NOT_FOUND');
      await refuse('inexistente numa lista', { [many]: [shownSolo, 'deadbeef'] }, 'TABLE_NOT_FOUND');
      // Formato inválido (curto demais, injeção, não hexadecimal, nome no lugar do id) é recusado antes de qualquer busca.
      await refuse('curto demais', { [one]: 'a1b2c3d' }, 'VALIDATION_FAILED');
      await refuse('injeção', { [one]: "ab12cd34'; DROP TABLE bots;--" }, 'VALIDATION_FAILED');
      await refuse('não hexadecimal', { [many]: ['zzzzzzzz'] }, 'VALIDATION_FAILED');
      await refuse('nome no lugar do id', { [one]: 'Isolado' }, 'VALIDATION_FAILED');
      const refusedUpdate = await write({ updates: [{ id: line.id.slice(0, 8), expectedVersion: 2, values: { [one]: 'deadbeef' } }] });
      expect(refusedUpdate.status).toBe('failed'); expect(JSON.parse(refusedUpdate.content)).toMatchObject({ code: 'TABLE_NOT_FOUND' });
      // Ambíguo: a resposta traz o prefixo e os candidatos do DESTINO com o nome (o bot refaz a chamada com o id certo), numa célula única ou numa lista.
      for (const values of [{ [one]: 'ab12cd34' }, { [many]: [shownSolo, 'AB12CD34'] }]) {
        const ambiguous = await write({ creates: [{ values: { [name]: 'não deve gravar', ...values } }] });
        expect(ambiguous.status).toBe('failed');
        expect(JSON.parse(ambiguous.content)).toEqual({ code: 'TABLE_RECORD_AMBIGUOUS', message: ERROR_CODES.TABLE_RECORD_AMBIGUOUS.message, prefix: 'ab12cd34', candidates: [{ id: twinA, name: 'Gêmeo A' }, { id: twinB, name: 'Gêmeo B' }], moreCandidates: 0 });
      }
      expect(await snapshot()).toEqual(before);
      // Depois do erro, o id completo do candidato certo grava.
      const retried = await write({ creates: [{ values: { [name]: 'Refeita', [one]: twinB } }] });
      expect(retried.status).toBe('completed');
      expect((await service.records(table.id, owner)).records.find((record) => record.values[name] === 'Refeita')!.values[one]).toBe(twinB);

      // Destino sem acesso do bot: o prefixo e o UUID completo recebem a mesma resposta de tabela inexistente (nenhum oráculo de existência do prefixo).
      const foreign = await service.create(tableCreateSchema.parse({ name: 'Alheia', operationId: randomUUID(), columns: [{ name: 'Nome', type: 'text' }] }), owner, stranger.id);
      await world.pool.query('INSERT INTO table_records (table_id, id, values) VALUES ($1,$2,$3)', [foreign.id, 'beadcafe-0000-4000-8000-000000000001', '{}']);
      const hidden = await service.create(tableCreateSchema.parse({ name: 'Com destino alheio', operationId: randomUUID(), columns: [{ name: 'Nome', type: 'text' }, { name: 'Oculta', type: 'relation', targetTableId: foreign.id, cardinality: 'one' }] }), owner, bot.id);
      const [hiddenName, hiddenRelation] = hidden.columns.map((column) => column.id) as [string, string];
      for (const ref of ['beadcafe', 'BEADCAFE', 'beadcafe-0000-4000-8000-000000000001', 'deadbeef']) {
        const denied = await call(world, bot, 'table_write', { tableId: hidden.id, input: { operationId: randomUUID(), expectedSchemaVersion: hidden.schemaVersion, creates: [{ values: { [hiddenName]: 'x', [hiddenRelation]: ref } }] } });
        expect(denied.status, ref).toBe('failed'); expect(JSON.parse(denied.content), ref).toMatchObject({ code: 'TABLE_NOT_FOUND' });
      }
      expect((await service.records(hidden.id, owner)).records).toEqual([]);
    } finally { await world.cleanup(); }
  });

  it('replay da escrita com id curto numa célula de relação termina como com o UUID completo: devolve o recibo mesmo com o destino ambíguo ou sumido, sem nova escrita, e não afrouxa conflito, remoção nem acesso ao destino', async () => {
    const world = await createRunsWorld();
    try {
      const bot = await world.createBot(); const service = new TableService({ pool: world.pool });
      world.engine.start();
      const dest = await service.create(tableCreateSchema.parse({ name: 'Destino do replay', operationId: randomUUID(), columns: [{ name: 'Nome', type: 'text' }] }), owner, bot.id);
      const destName = dest.columns[0]!.id;
      const [target, rival, solo] = [twin('1'), twin('2'), 'cafe0001-0000-4000-8000-000000000001'];
      await world.pool.query('INSERT INTO table_records (table_id, id, values) VALUES ($1,$2,$3),($1,$4,$5)', [dest.id, target, JSON.stringify({ [destName]: 'Alvo' }), solo, JSON.stringify({ [destName]: 'Sozinho' })]);
      const table = await service.create(tableCreateSchema.parse({ name: 'Replay de relação', operationId: randomUUID(), columns: [{ name: 'Nome', type: 'text' }, { name: 'Destino', type: 'relation', targetTableId: dest.id, cardinality: 'one' }] }), owner, bot.id);
      const [name, relation] = table.columns.map((column) => column.id) as [string, string];
      const write = (ref: string, label: string, operationId: string) => call(world, bot, 'table_write', { tableId: table.id, input: { operationId, expectedSchemaVersion: table.schemaVersion, creates: [{ values: { [name]: label, [relation]: ref } }] } });
      const snapshot = async () => ({ records: (await service.records(table.id, owner)).records, receipts: Number((await world.pool.query<{ count: string }>('SELECT count(*) FROM table_mutation_receipts')).rows[0]!.count) });

      // Primeira escrita pelo prefixo (único na hora): grava o UUID completo.
      const op = randomUUID();
      const first = await write('ab12cd34', 'Linha', op);
      expect(first.status).toBe('completed');
      expect((await service.records(table.id, owner)).records[0]!.values[relation]).toBe(target);

      // Depois do commit outro registro do destino passa a começar igual: uma escrita NOVA pelo prefixo é ambígua (controle), mas o replay da operação já gravada não.
      await world.pool.query('INSERT INTO table_records (table_id, id, values) VALUES ($1,$2,$3)', [dest.id, rival, JSON.stringify({ [destName]: 'Rival' })]);
      const fresh = await write('ab12cd34', 'não deve gravar', randomUUID());
      expect(fresh.status).toBe('failed'); expect(JSON.parse(fresh.content)).toMatchObject({ code: 'TABLE_RECORD_AMBIGUOUS', candidates: [{ id: target }, { id: rival }], moreCandidates: 0 });
      const settled = await snapshot();
      expect(await write('ab12cd34', 'Linha', op)).toEqual(first);
      expect(await snapshot()).toEqual(settled);

      // A mesma operação com conteúdo diferente continua sendo conflito: a resolução pelo recibo não aceita entrada diferente da gravada.
      const changed = await write('ab12cd34', 'outro valor', op);
      expect(changed.status).toBe('failed'); expect(JSON.parse(changed.content)).toMatchObject({ code: 'TABLE_CONFLICT' });
      expect(await snapshot()).toEqual(settled);

      // O destino some sem passar pela exclusão confirmada (o vínculo cai junto com o registro de origem; o recibo segue intacto) e só o rival resta com aquele começo: o replay
      // devolve o recibo, em vez de resolver o prefixo para o rival e tratar a entrada como outra operação.
      await world.pool.query('DELETE FROM table_records WHERE table_id = $1', [table.id]);
      await world.pool.query('DELETE FROM table_records WHERE table_id = $1 AND id = $2', [dest.id, target]);
      const vanished = await snapshot();
      expect(await write('ab12cd34', 'Linha', op)).toEqual(first);
      expect(await write(target, 'Linha', op)).toEqual(first);
      expect(await snapshot()).toEqual(vanished);

      // Registro removido pela exclusão confirmada: o recibo vira "recurso removido", e o replay pelo prefixo responde o mesmo que pelo UUID completo, sem gravar.
      const removedOp = randomUUID();
      expect((await write('cafe0001', 'Removida', removedOp)).status).toBe('completed');
      const removedRow = (await service.records(table.id, owner)).records.find((record) => record.values[name] === 'Removida')!;
      const { preparationId } = await service.prepareDestructive(table.id, { kind: 'delete_records', expectedVersion: (await service.get(table.id, owner)).version, records: [{ id: removedRow.id, expectedVersion: 1 }] }, owner);
      await service.confirmDestructive(table.id, { preparationId, operationId: randomUUID(), confirmation: true }, owner);
      const afterRemoval = await snapshot();
      const byFull = await write(solo, 'Removida', removedOp);
      const byShort = await write('cafe0001', 'Removida', removedOp);
      expect(byFull.status).toBe('failed'); expect(JSON.parse(byFull.content)).toMatchObject({ code: 'TABLE_RESOURCE_REMOVED' });
      expect(byShort).toEqual(byFull);
      expect(await snapshot()).toEqual(afterRemoval);

      // Acesso ao DESTINO perdido: o replay pelo prefixo responde como o replay pelo UUID completo (tabela inexistente), e o recibo nunca é entregue.
      await world.pool.query('DELETE FROM table_bot_access WHERE table_id = $1', [dest.id]);
      const byShortDenied = await write('ab12cd34', 'Linha', op);
      const byFullDenied = await write(target, 'Linha', op);
      expect(byFullDenied.status).toBe('failed'); expect(JSON.parse(byFullDenied.content)).toMatchObject({ code: 'TABLE_NOT_FOUND' });
      expect(byShortDenied).toEqual(byFullDenied);
      expect(await snapshot()).toEqual(afterRemoval);
    } finally { await world.cleanup(); }
  });
});
