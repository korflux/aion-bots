// Id curto de registro (TAB-03): formato aceito, faixa de busca e resolução no servidor sobre PostgreSQL real.
// O que as provas garantem: o prefixo só resolve dentro da tabela informada e depois da checagem de acesso; ambiguidade nunca escolhe um registro e traz os
// candidatos com nome; prefixo inexistente, formato inválido e ator sem acesso têm o código estável; o id completo passa como está.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DataTable } from '@aion/shared';
import { AmbiguousRecordError, isRecordRef, MAX_AMBIGUITY_CANDIDATES, prefixBounds, recordRefSchema } from './record-prefix';
import { createTablesWorld, owner } from './test-support';

let world: Awaited<ReturnType<typeof createTablesWorld>>;
beforeAll(async () => { world = await createTablesWorld(); });
afterAll(async () => { await world.cleanup(); });

/** Insere registros com ids escolhidos, para fabricar colisões de prefixo que `randomUUID` quase nunca produz. */
async function insertRecords(table: DataTable, rows: { id: string; values: Record<string, unknown> }[]): Promise<void> {
  for (const row of rows) await world.pool.query('INSERT INTO table_records (table_id, id, values) VALUES ($1, $2, $3)', [table.id, row.id, JSON.stringify(row.values)]);
}
/** O bot da fixture, dono das tabelas criadas por `world.create`. */
const actor = () => ({ kind: 'bot', botId: world.bot.id }) as const;
const hex = (head: string, tail: string): string => `${head}-0000-4000-8000-${tail.padStart(12, '0')}`;

describe('formato do prefixo', () => {
  it('aceita 8 a 36 caracteres que sejam prefixo canônico de UUID, com hífens só nas posições do UUID, e recusa o resto', () => {
    const uuid = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
    for (const length of [8, 9, 10, 13, 14, 18, 19, 23, 24, 35, 36]) expect(isRecordRef(uuid.slice(0, length)), String(length)).toBe(true);
    expect(isRecordRef(uuid.toUpperCase())).toBe(true);
    for (const bad of ['', '0a1b2c3', `${uuid}0`, '0a1b2c3d4e5f', '0a1b2c3d-4e5f4a6b', '0a1b2c3g', '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4z', "0a1b2c3d'; DROP TABLE bots;--", '0a1b2c3d%', '0a1b2c3d_', ' 0a1b2c3d', '0a1b2c3d\n']) expect(isRecordRef(bad), bad).toBe(false);
    expect(recordRefSchema.safeParse('0a1b2c3d').success).toBe(true);
    expect(recordRefSchema.safeParse('0a1b2c3').success).toBe(false);
  });

  it('a faixa vai do menor ao maior UUID com o prefixo, e o prefixo completo é um único valor', () => {
    expect(prefixBounds('0a1b2c3d')).toEqual({ lo: '0a1b2c3d-0000-0000-0000-000000000000', hi: '0a1b2c3d-ffff-ffff-ffff-ffffffffffff' });
    expect(prefixBounds('0a1b2c3d-4e')).toEqual({ lo: '0a1b2c3d-4e00-0000-0000-000000000000', hi: '0a1b2c3d-4eff-ffff-ffff-ffffffffffff' });
    expect(prefixBounds('0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d')).toEqual({ lo: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', hi: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d' });
  });
});

describe('resolução no servidor', () => {
  it('resolve prefixo único (inclusive maiúsculo e nas pontas da faixa), preserva a ordem e deixa o id completo passar sem consulta', async () => {
    const table = await world.create([{ name: 'Nome', type: 'text' }]);
    const name = table.columns[0]!.id;
    const nil = '00000000-0000-0000-0000-000000000000';
    const last = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
    await insertRecords(table, [{ id: nil, values: { [name]: 'Primeiro' } }, { id: last, values: { [name]: 'Último' } }, { id: hex('5c0de000', '1'), values: { [name]: 'Meio' } }]);
    const resolved = await world.tables.resolveRecordRefs(table.id, ['FFFFFFFF', '5c0de000', '00000000', hex('5c0de000', '1').toUpperCase()], actor());
    expect(resolved).toEqual([last, hex('5c0de000', '1'), nil, hex('5c0de000', '1')]);
    // Id completo, mesmo inexistente ou de tabela alheia, passa como veio: quem o usa (escrita, consulta) decide, como sempre.
    const stranger = randomUUID();
    expect(await world.tables.resolveRecordRefs(randomUUID(), [stranger], actor())).toEqual([stranger]);
    expect(await world.tables.resolveRecordRefs(table.id, [], actor())).toEqual([]);
  });

  it('prefixo ambíguo nunca escolhe um registro: erro com prefixo e candidatos (id completo e nome), no máximo 10, na ordem do id', async () => {
    const phase: DataTable = await world.create([{ name: 'Fase', type: 'select', options: [{ id: randomUUID(), label: 'Aberta' }] }, { name: 'Nome', type: 'text' }]);
    const option = (phase.columns[0] as Extract<DataTable['columns'][number], { type: 'select' }>).options[0]!.id;
    const [fase, nome] = phase.columns.map((column) => column.id) as [string, string];
    await insertRecords(phase, Array.from({ length: 12 }, (_, index) => ({ id: hex('ab12cd34', String(index + 1)), values: { [fase]: option, [nome]: `Registro ${index + 1}` } })));
    await insertRecords(phase, [{ id: hex('ab12cd35', '1'), values: { [fase]: option, [nome]: 'Vizinho' } }]);
    const error = await world.tables.resolveRecordRefs(phase.id, ['ab12cd35', 'AB12CD34'], actor()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AmbiguousRecordError);
    const ambiguous = error as AmbiguousRecordError;
    expect(ambiguous.code).toBe('TABLE_RECORD_AMBIGUOUS');
    expect(ambiguous.prefix).toBe('ab12cd34');
    expect(ambiguous.candidates).toHaveLength(MAX_AMBIGUITY_CANDIDATES);
    // Doze registros começam igual e a lista traz dez: o erro diz quantos ficaram de fora, para o modelo não ler a lista como o conjunto inteiro.
    expect(ambiguous.moreCandidates).toBe(2);
    // O nome vem da primeira coluna visível que guarda valor (a seleção, com o rótulo da opção), não do id da opção.
    expect(ambiguous.candidates[0]).toEqual({ id: hex('ab12cd34', '1'), name: 'Aberta' });
    expect(ambiguous.candidates.map((candidate) => candidate.id)).toEqual(Array.from({ length: 10 }, (_, index) => hex('ab12cd34', String(index + 1))));
    // Prefixo de 35 caracteres que ainda cobre vários (os nove primeiros) continua recusado, com a lista completa; o de 36 é o id completo, que passa sem consulta.
    const nine = await world.tables.resolveRecordRefs(phase.id, ['ab12cd34-0000-4000-8000-00000000000'], actor()).catch((caught: unknown) => caught) as AmbiguousRecordError;
    expect(nine).toBeInstanceOf(AmbiguousRecordError);
    expect(nine.candidates).toHaveLength(9); expect(nine.moreCandidates).toBe(0);
    expect(await world.tables.resolveRecordRefs(phase.id, ['ab12cd34-0000-4000-8000-000000000002'], actor())).toEqual([hex('ab12cd34', '2')]);
    const three = await world.tables.resolveRecordRefs(phase.id, ['ab12cd34-0000-4000-8000-00000000001'], actor()).catch((caught: unknown) => caught) as AmbiguousRecordError;
    expect(three.candidates).toHaveLength(3); expect(three.moreCandidates).toBe(0);
  });

  it('um prefixo de 9 a 35 caracteres resolve um único registro onde o de 8 era ambíguo (consulta real), na ordem pedida e numa só chamada', async () => {
    const table = await world.create([{ name: 'Nome', type: 'text' }]);
    const [one, twoA, twoB] = ['a3b4c5d6-1111-4000-8000-000000000001', 'a3b4c5d6-2222-4000-8000-000000000001', 'a3b4c5d6-2233-4000-8000-000000000002'];
    await insertRecords(table, [{ id: one, values: {} }, { id: twoA, values: {} }, { id: twoB, values: {} }]);
    const ambiguity = (ref: string) => world.tables.resolveRecordRefs(table.id, [ref], actor()).catch((caught: unknown) => caught as AmbiguousRecordError);
    // Com 8 caracteres e com 9 (o hífen do UUID ainda não separa nada) os três coincidem.
    for (const ref of ['a3b4c5d6', 'a3b4c5d6-']) expect((await ambiguity(ref) as AmbiguousRecordError).candidates.map((candidate) => candidate.id), ref).toEqual([one, twoA, twoB]);
    // A partir do 10º caractere cada prefixo que separa um único registro resolve; o que ainda cobre dois continua recusado.
    expect(await world.tables.resolveRecordRefs(table.id, ['a3b4c5d6-1'], actor())).toEqual([one]);
    expect((await ambiguity('a3b4c5d6-2') as AmbiguousRecordError).candidates.map((candidate) => candidate.id)).toEqual([twoA, twoB]);
    expect((await ambiguity('a3b4c5d6-22') as AmbiguousRecordError).candidates.map((candidate) => candidate.id)).toEqual([twoA, twoB]);
    expect(await world.tables.resolveRecordRefs(table.id, ['a3b4c5d6-222'], actor())).toEqual([twoA]);
    expect(await world.tables.resolveRecordRefs(table.id, ['a3b4c5d6-2233-4000-8000-00000000000'], actor())).toEqual([twoB]);
    // Vários tamanhos no mesmo pedido (um prefixo curto único, um longo e um id completo): ordem preservada.
    expect(await world.tables.resolveRecordRefs(table.id, ['A3B4C5D6-2233-4000', 'a3b4c5d6-1', twoA], actor())).toEqual([twoB, one, twoA]);
  });

  it('o nome do candidato vem da primeira célula COM valor: pula primeira coluna vazia, nula ou em branco, e sem nenhuma célula com valor o nome é o id completo', async () => {
    const table = await world.create([{ name: 'Título', type: 'text' }, { name: 'Detalhe', type: 'text' }]);
    const [titulo, detalhe] = table.columns.map((column) => column.id) as [string, string];
    const [empty, nulls, blank, filled, nothing] = ['1', '2', '3', '4', '5'].map((tail) => hex('facade01', tail)) as [string, string, string, string, string];
    await insertRecords(table, [
      { id: empty, values: { [titulo]: '', [detalhe]: 'Detalhe do vazio' } },
      { id: nulls, values: { [titulo]: null, [detalhe]: 'Detalhe do nulo' } },
      { id: blank, values: { [titulo]: '   ', [detalhe]: 'Detalhe do branco' } },
      { id: filled, values: { [titulo]: 'Título presente', [detalhe]: 'Ignorado' } },
      { id: nothing, values: { [titulo]: null, [detalhe]: '' } },
    ]);
    const error = await world.tables.resolveRecordRefs(table.id, ['facade01'], actor()).catch((caught: unknown) => caught) as AmbiguousRecordError;
    expect(error.candidates).toEqual([
      { id: empty, name: 'Detalhe do vazio' }, { id: nulls, name: 'Detalhe do nulo' }, { id: blank, name: 'Detalhe do branco' },
      { id: filled, name: 'Título presente' }, { id: nothing, name: nothing },
    ]);
  });

  it('o nome do candidato vem da primeira coluna de valor visível: pula a relação, vale no máximo 60 caracteres e segue igual quando a relação deixa de ser visível', async () => {
    const target = await world.create([{ name: 'Alvo', type: 'text' }]);
    const table = await world.create([{ name: 'Ligação', type: 'relation', targetTableId: target.id, cardinality: 'one' }, { name: 'Nome', type: 'text' }]);
    const nome = table.columns[1]!.id;
    await insertRecords(table, [{ id: hex('cafe0001', '1'), values: { [nome]: 'x'.repeat(100) } }, { id: hex('cafe0001', '2'), values: { [nome]: 'Curto' } }]);
    const error = await world.tables.resolveRecordRefs(table.id, ['cafe0001'], actor()).catch((caught: unknown) => caught) as AmbiguousRecordError;
    expect(error.candidates.map((candidate) => candidate.name)).toEqual([`${'x'.repeat(59)}…`, 'Curto']);
    // Se a relação deixa de ser visível ao bot, a primeira coluna visível com valor continua sendo a de texto.
    await world.pool.query('DELETE FROM table_bot_access WHERE table_id = $1', [target.id]);
    const again = await world.tables.resolveRecordRefs(table.id, ['cafe0001'], actor()).catch((caught: unknown) => caught) as AmbiguousRecordError;
    expect(again.candidates.map((candidate) => candidate.name)).toEqual([`${'x'.repeat(59)}…`, 'Curto']);
  });

  it('prefixo inexistente é TABLE_NOT_FOUND e nunca resolve registro de outra tabela', async () => {
    const mine = await world.create([{ name: 'Nome', type: 'text' }]);
    const other = await world.create([{ name: 'Nome', type: 'text' }]);
    await insertRecords(other, [{ id: hex('0ddba11a', '1'), values: {} }]);
    await insertRecords(mine, [{ id: hex('0ddba11b', '1'), values: {} }]);
    await expect(world.tables.resolveRecordRefs(mine.id, ['0ddba11a'], actor())).rejects.toMatchObject({ code: 'TABLE_NOT_FOUND' });
    await expect(world.tables.resolveRecordRefs(mine.id, ['0ddba11b', '99999999'], actor())).rejects.toMatchObject({ code: 'TABLE_NOT_FOUND' });
    expect(await world.tables.resolveRecordRefs(other.id, ['0ddba11a'], actor())).toEqual([hex('0ddba11a', '1')]);
  });

  it('só resolve depois do acesso: bot sem a tabela recebe a mesma resposta de tabela inexistente, o Chat geral é negado e formato inválido é recusado', async () => {
    const table = await world.create([{ name: 'Nome', type: 'text' }]);
    await insertRecords(table, [{ id: hex('5ec12e70', '1'), values: {} }]);
    const stranger = await world.bots.create({ name: 'Sem acesso', color: '#60A5FA', instructions: '', model: null, effort: null, stepLimit: 50 }, { ip: '203.0.113.21', userAgent: 'record-prefix-test' });
    await expect(world.tables.resolveRecordRefs(table.id, ['5ec12e70'], { kind: 'bot', botId: stranger.id })).rejects.toMatchObject({ code: 'TABLE_NOT_FOUND' });
    await expect(world.tables.resolveRecordRefs(table.id, ['5ec12e70'], { kind: 'chat' })).rejects.toMatchObject({ code: 'TABLE_ACCESS_DENIED' });
    await expect(world.tables.resolveRecordRefs(randomUUID(), ['5ec12e70'], actor())).rejects.toMatchObject({ code: 'TABLE_NOT_FOUND' });
    expect(await world.tables.resolveRecordRefs(table.id, ['5ec12e70'], owner)).toEqual([hex('5ec12e70', '1')]);
    expect(await world.tables.resolveRecordRefs(table.id, ['5ec12e70-'], actor())).toEqual([hex('5ec12e70', '1')]);
    for (const bad of ['5ec12e7', "5ec12e70' OR '1'='1", '5ec12e70%', 'zzzzzzzz']) {
      await expect(world.tables.resolveRecordRefs(table.id, [bad], actor()), bad).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    }
  });
});
