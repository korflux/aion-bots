// Unidades do histórico, colapso de último recurso, histerese do corte e a reserva do grupo mais recente (phase 8, F3): provas puras, sem banco nem provedor.
import { describe, expect, it } from 'vitest';
import { buildTurns, type ContextAttachment, type ContextRow } from './context';
import { COLLAPSE_INDEX_LINES, collapseHistory, collapsibleCount, fitByCollapse, historyUnits, type CollapseStanding } from './context-collapse';

const base = (partial: Partial<ContextRow>): ContextRow => ({ run_id: '1', role: 'assistant', kind: 'text', status: 'done', opens_round: false, step: 1, content: '', data: {}, ...partial });
const owner = (id: string, content: string, opens = true): ContextRow => base({ id, role: 'user', step: null, opens_round: opens, content });
const call = (id: string, step: number, content: string, tool = 'schema_search'): ContextRow => base({ id, kind: 'activity', status: 'completed', step, content, tool_arguments: '{"q":"x"}', data: { callId: `c${id}`, tool, label: 'x', arguments: '{"q":"x"}', detail: null } });

/** Duas rodadas: a primeira com 3 etapas (a 2ª com duas chamadas), a atual com abertura e 2 etapas. */
const rows = (): ContextRow[] => [
  owner('1', 'Primeiro pedido do dono, com bastante texto para a prévia ser cortada. '.repeat(4)),
  call('2', 1, 'a'.repeat(5000)),
  call('3', 2, 'b'.repeat(5000)), call('4', 2, 'c'.repeat(5000)),
  base({ id: '5', step: 3, content: 'Pronto.' }),
  owner('6', 'Pedido atual.'),
  call('7', 1, 'd'.repeat(5000)),
  call('8', 2, 'e'.repeat(5000), 'table_write'),
];

describe('unidades do histórico', () => {
  it('agrupam as linhas da mesma etapa e deixam mensagem e cartão sozinhos, como buildTurns', () => {
    expect(historyUnits(rows()).map((unit) => [unit.start, unit.end, unit.key])).toEqual([
      [0, 1, null], [1, 2, '1:1'], [2, 4, '1:2'], [4, 5, '1:3'], [5, 6, null], [6, 7, '1:1'], [7, 8, '1:2'],
    ]);
  });

  it('só colapsam o que não é a abertura da rodada atual nem a etapa mais recente', () => {
    // 7 unidades - abertura atual (índice 5) - última etapa = 5 colapsáveis.
    expect(collapsibleCount(rows())).toBe(5);
    expect(collapsibleCount([owner('1', 'só a mensagem')])).toBe(0);
  });
});

describe('estado das chamadas no índice', () => {
  /** Mesma chamada de `call`, com o status do banco e a marca de efeito externo que o executor grava (`writeActivity`). */
  const state = (id: string, step: number, status: string, external = false): ContextRow => {
    const row = call(id, step, '');
    return { ...row, status, data: { ...(row.data as object), ...(external ? { external: true } : {}) } };
  };

  it('chamada interna que ficou running aparece como interrompida, sem o status cru; efeito externo incerto segue sinalizado', () => {
    const input = [
      owner('1', 'Pedido.'), state('2', 1, 'running'), state('3', 2, 'running', true), state('4', 3, 'failed', true), state('5', 4, 'failed'), state('6', 5, 'completed'),
      owner('7', 'Pedido atual.'), call('8', 1, 'x'),
    ];
    const index = collapseHistory(input, collapsibleCount(input)).notice!.text;
    const line = (id: string) => index.split('\n').find((text) => text.startsWith(`- id=${id} `))!;
    expect(line('2')).toContain(', interrompida, sem resultado,');
    expect(line('3')).toContain(', efeito externo incerto, confirme antes de repetir,');
    expect(line('4')).toContain(', efeito externo incerto, confirme antes de repetir,');
    expect(line('5')).toContain(', falhou,');
    expect(line('6')).toContain(', concluída,');
    expect(index).not.toMatch(/\brunning\b/u);
  });
});

/** Rodada atual longa com um complemento do dono absorvido no meio (CONV-03, `opens_round` falso): a restrição vem depois dos 80 caracteres da prévia do índice. */
const COMPLEMENT = `${'Atenção a esta restrição nova do dono. '.repeat(3)}NAO envie nada ao cliente antes da minha aprovacao.`;
const ATTACHMENT_TEXT = 'conteúdo do anexo do complemento';
const complementAttachment: ContextAttachment = { id: '9', message_id: '5', kind: 'document', name: 'regras.txt', original_bytes: 100, total_chars: ATTACHMENT_TEXT.length, removed: false, extracted_text: ATTACHMENT_TEXT, image_bytes: null };
const withComplement = (): ContextRow[] => [
  owner('1', 'Pedido atual.'),
  call('2', 1, 'a'.repeat(5000)), call('3', 2, 'b'.repeat(5000)), call('4', 2, 'c'.repeat(5000)),
  { ...owner('5', COMPLEMENT, false), data: { complement: true }, attachments: [complementAttachment] },
  call('6', 3, 'd'.repeat(5000)), call('7', 4, 'e'.repeat(5000)), call('8', 5, 'f'.repeat(5000)),
];

describe('mensagens do dono da rodada atual no colapso (R1)', () => {
  it('o complemento absorvido no meio da rodada não é colapsável, nem a abertura nem a etapa mais recente', () => {
    // 7 unidades (abertura, etapa 1, etapa 2 com duas chamadas, complemento, etapas 3, 4 e 5) - abertura - complemento - última etapa = 4.
    expect(historyUnits(withComplement()).length).toBe(7);
    expect(collapsibleCount(withComplement())).toBe(4);
  });

  it('colapsa o máximo e mantém o complemento inteiro, com anexo, fora do índice, sem partir pares de chamada e resultado', () => {
    const input = withComplement();
    const { rows: kept, notice } = collapseHistory(input, 4);
    // Só ficam a abertura, o complemento e a etapa mais recente; as etapas 1 a 4 (com as duas chamadas da etapa 2) viraram índice.
    expect(kept.map((row) => row.id)).toEqual(['1', '5', '8']);
    const index = notice!.text;
    for (const line of ['id=2 schema_search', 'id=3 schema_search', 'id=4 schema_search', 'id=6 schema_search', 'id=7 schema_search']) expect(index).toContain(line);
    // O complemento nunca vira prévia truncada, e o aviso diz ao modelo onde ele está.
    expect(index).not.toContain('id=5 dono');
    expect(index).not.toContain('NAO envie');
    expect(index).toContain('mensagens do dono da rodada atual não entram neste índice');
    // O pedido montado leva o texto íntegro do complemento e o conteúdo do anexo dele (rodada atual), com chamada e resultado pareados.
    const turns = buildTurns(kept);
    const complementTurn = turns.find((turn) => turn.role === 'user' && turn.text.includes('NAO envie nada ao cliente antes da minha aprovacao.'));
    expect(complementTurn?.text).toContain(COMPLEMENT);
    expect(complementTurn?.text).toContain(ATTACHMENT_TEXT);
    const calls = turns.flatMap((turn) => (turn.role === 'assistant' ? turn.toolCalls.map((item) => item.id) : []));
    expect(turns.filter((turn) => turn.role === 'tool').map((turn) => (turn.role === 'tool' ? turn.callId : ''))).toEqual(calls);
  });

  it('um corte parcial também preserva o complemento, e o corte guardado (through) aponta a última linha colapsada, não o complemento', () => {
    // Três unidades colapsadas: etapas 1, 2 e 3 (a etapa 3 vem DEPOIS do complemento e é colapsada na frente dele).
    const { rows: kept } = collapseHistory(withComplement(), 3);
    expect(kept.map((row) => row.id)).toEqual(['1', '5', '7', '8']);
    const fit = fitByCollapse({ rows: withComplement(), size: ({ units }) => 1000 - units * 100, targets: [800] });
    expect(fit).toMatchObject({ units: 2, fits: true, through: '4' });
  });
});

describe('colapso de último recurso', () => {
  it('troca as unidades mais antigas por UM índice recuperável, sem partir pares nem tocar a abertura e a etapa recente', () => {
    const input = rows(), snapshot = JSON.stringify(input);
    const { rows: kept, notice } = collapseHistory(input, 3);
    // 3 unidades mais antigas: a mensagem 1, a etapa 1 e a etapa 2 (com as duas chamadas).
    expect(kept.map((row) => row.id)).toEqual(['5', '6', '7', '8']);
    expect(notice?.role).toBe('user');
    const text = notice!.text;
    expect(text).toContain('Histórico anterior colapsado por espaço');
    expect(text).toContain('read_activity');
    expect(text).toContain('search_history');
    for (const line of ['id=1 dono:', 'id=2 schema_search({"q":"x"}), concluída, 5000 bytes', 'id=3 schema_search', 'id=4 schema_search']) expect(text).toContain(line);
    // Prévia curta da mensagem do dono: o texto integral não vai no índice.
    expect(text).not.toContain('Primeiro pedido do dono, com bastante texto para a prévia ser cortada. '.repeat(3));
    // Nada do conteúdo dos resultados vaza para o índice, e as linhas de entrada não foram alteradas.
    expect(text).not.toContain('a'.repeat(100));
    expect(JSON.stringify(input)).toBe(snapshot);
    // Os turnos montados continuam com chamada e resultado pareados.
    const turns = buildTurns(kept);
    const calls = turns.flatMap((turn) => (turn.role === 'assistant' ? turn.toolCalls.map((item) => item.id) : []));
    expect(turns.filter((turn) => turn.role === 'tool').map((turn) => (turn.role === 'tool' ? turn.callId : ''))).toEqual(calls);
  });

  it('count 0 não altera nada; limita as linhas do índice às mais recentes e resume as que ficaram de fora com faixa de ids e contagem por tipo', () => {
    const input = rows();
    expect(collapseHistory(input, 0)).toEqual({ rows: input, notice: null });
    const limited = collapseHistory(input, 3, 2).notice!.text;
    // Os itens 1 (dono) e 2 (ferramenta) ficam sem linha própria, mas nunca somem: o aviso dá a faixa de ids e o que há nela.
    expect(limited).toContain('Sem linha própria: 2 itens, ids de 1 a 2 (mensagens do dono: 1; chamadas de ferramenta: 1)');
    expect(limited).toContain('id=3 ');
    expect(limited).toContain('id=4 ');
    expect(limited).not.toContain('id=1 dono:');
  });

  it('cartões só do dono não entram no índice, efeito externo incerto é sinalizado e a mesma conversa gera o mesmo pedido', () => {
    const input = [
      owner('1', 'antigo'),
      base({ id: '2', role: 'system', kind: 'card', step: null, content: 'aprovação', data: { type: 'approval' } }),
      base({ id: '3', kind: 'activity', status: 'failed', step: 1, content: 'não confirmado', data: { callId: 'x', tool: 'GMAIL_SEND', label: 'x', arguments: '{}', detail: null, external: true } }),
      owner('4', 'atual'), call('5', 1, 'resultado'),
    ];
    const first = collapseHistory(input, 3);
    expect(first.notice!.text).not.toContain('id=2 ');
    expect(first.notice!.text).toContain('id=3 GMAIL_SEND, efeito externo incerto, confirme antes de repetir');
    expect(collapseHistory(input, 3)).toEqual(first);
  });
});

/** Rodada antiga com um item de cada tipo que o índice conta (dono, resposta, ferramenta e aviso) e a rodada atual por cima. */
const everyKind = (): ContextRow[] => [
  owner('10', 'Pedido antigo.'),
  call('11', 1, 'resultado antigo'),
  base({ id: '12', step: 2, content: 'Resposta antiga.' }),
  base({ id: '13', role: 'system', kind: 'card', step: null, content: 'Limite de etapas atingido.', data: { type: 'run_limit' } }),
  owner('14', 'Pedido atual.'),
  call('15', 1, 'resultado atual'),
];

describe('índice sem linhas: faixa de ids e contagem por tipo (phase 9, F5)', () => {
  it('nos degraus sem linhas (lines 0) o aviso nunca é uma lista vazia: traz a faixa do primeiro ao último id e a contagem por tipo', () => {
    const { notice } = collapseHistory(everyKind(), 4, 0);
    const text = notice!.text;
    expect(text).toContain('Sem linha própria: 4 itens, ids de 10 a 13 (mensagens do dono: 1; respostas do bot: 1; chamadas de ferramenta: 1; avisos do sistema: 1)');
    // Sem linhas, nenhum item é listado: só a faixa e a contagem, e o modelo é mandado a search_history e read_activity.
    expect(text.split('\n').filter((line) => line.startsWith('- '))).toEqual([]);
    expect(text).toContain('search_history');
    expect(text).toContain('read_activity');
  });

  it('com linhas limitadas, a faixa e a contagem cobrem só o que ficou sem linha própria, e as linhas mostram as mais recentes', () => {
    const text = collapseHistory(everyKind(), 4, 1).notice!.text;
    expect(text).toContain('Sem linha própria: 3 itens, ids de 10 a 12 (mensagens do dono: 1; respostas do bot: 1; chamadas de ferramenta: 1)');
    expect(text.split('\n').filter((line) => line.startsWith('- '))).toEqual(['- id=13 aviso do sistema (run_limit)']);
  });

  it('com todas as linhas à mostra não há resumo de faixa (nada ficou sem linha)', () => {
    expect(collapseHistory(everyKind(), 4, COLLAPSE_INDEX_LINES).notice!.text).not.toContain('Sem linha própria');
  });

  it('só cartões do dono colapsados não geram aviso, mesmo sem linhas (não há o que recuperar)', () => {
    const onlyOwnerCards = [base({ id: '1', role: 'system', kind: 'card', step: null, content: '', data: { type: 'approval' } }), owner('2', 'atual'), call('3', 1, 'x')];
    expect(collapseHistory(onlyOwnerCards, 1, 0).notice).toBeNull();
  });

  it('é determinístico: o mesmo corte gera o mesmo aviso, byte a byte, e acréscimos ao fim do histórico não o mudam', () => {
    const first = collapseHistory(everyKind(), 4, 0).notice!.text;
    expect(collapseHistory(everyKind(), 4, 0).notice!.text).toBe(first);
    const grown = [...everyKind(), call('16', 2, 'mais um resultado'), call('17', 3, 'e outro')];
    expect(collapseHistory(grown, 4, 0).notice!.text).toBe(first);
  });

  it('todo id exibido, nas linhas ou na faixa, tem só dígitos: nunca "#"', () => {
    for (const lines of [0, 1, COLLAPSE_INDEX_LINES]) {
      const text = collapseHistory(everyKind(), 4, lines).notice!.text;
      expect(text).not.toMatch(/#\d/u);
      expect([...text.matchAll(/\bid=(\S+)/gu)].every((found) => /^\d+$/u.test(found[1]!))).toBe(true);
    }
  });
});

describe('escolha de quanto colapsar', () => {
  /** Tamanho simulado: cada unidade colapsada economiza 100 de um histórico de 1000; o aviso custa 50; sem proteger a última etapa, mais 300 a menos. */
  const simulate = (log: { units: number; lines: number; protect: boolean }[]) => ({ units, lines }: { units: number; lines: number }, protect: boolean) => {
    log.push({ units, lines, protect });
    return 1000 - units * 100 + (units > 0 ? 50 + lines : 0) - (protect ? 0 : 300);
  };

  it('acha o MENOR corte que atinge a meta mais folgada possível (histerese) e deixa essa configuração aplicada por último', () => {
    const log: { units: number; lines: number; protect: boolean }[] = [];
    const result = fitByCollapse({ rows: rows(), size: simulate(log), targets: [480, 800] });
    // Meta folgada 480: units=5 => 1000-500+50+25 = 575 > 480, não cabe nesse degrau; meta mínima 800: units=3 => 1000-300+75 = 775 cabe, units=2 => 875 não.
    expect(result).toEqual({ units: 3, lines: 25, protectLatest: true, fits: true, through: '4' });
    expect(log.at(-1)).toEqual({ units: 3, lines: 25, protect: true });
  });

  it('degrada o índice e depois a etapa mais recente, e sem solução devolve fits false com o máximo aplicado', () => {
    const log: { units: number; lines: number; protect: boolean }[] = [];
    expect(fitByCollapse({ rows: rows(), size: simulate(log), targets: [336, 560] })).toEqual({ units: 5, lines: 0, protectLatest: true, fits: true, through: '7' });
    const impossible: { units: number; lines: number; protect: boolean }[] = [];
    expect(fitByCollapse({ rows: rows(), size: simulate(impossible), targets: [6, 10] })).toEqual({ units: 5, lines: 0, protectLatest: false, fits: false, through: '7' });
    expect(impossible.at(-1)).toEqual({ units: 5, lines: 0, protect: false });
  });
});

describe('histerese do corte entre etapas (R2, cache do provedor)', () => {
  /** Rodada atual crescendo ao fim, como numa execução: a abertura e `steps` etapas de 300 bytes (uma chamada cada, ids crescentes). */
  const growing = (steps: number): ContextRow[] => [owner('1', 'Pedido atual.'), ...Array.from({ length: steps }, (_, index) => call(String(index + 2), index + 1, 'x'.repeat(300)))];
  /** Limite do histórico (100% do orçamento) e meta saudável (70%), no tamanho simulado abaixo. */
  const LIMIT = 12_000, HEALTHY = 8_400;
  /** Tamanho simulado do histórico com o colapso aplicado: bytes das linhas que sobram (mais 100 de moldura cada) e o texto do aviso do índice. */
  const sizeOf = (rows: readonly ContextRow[], units: number, lines: number): number => {
    const { rows: kept, notice } = collapseHistory(rows, units, lines);
    return kept.reduce((sum, row) => sum + row.content.length + 100, 0) + (notice ? notice.text.length : 0);
  };

  /** Uma execução de `total` etapas como o executor a conduz: só colapsa quando o pedido passa do limite; com `hysteresis`, reaplica o corte vigente antes de recalcular. */
  const execute = (total: number, hysteresis: boolean) => {
    let standing: CollapseStanding | null = null;
    const trail: { through: string | null; size: number; notice: string | null }[] = [];
    for (let steps = 1; steps <= total; steps++) {
      const rows = growing(steps);
      if (sizeOf(rows, 0, 0) <= LIMIT) { standing = null; trail.push({ through: null, size: sizeOf(rows, 0, 0), notice: null }); continue; }
      const fit = fitByCollapse({ rows, size: ({ units, lines }) => sizeOf(rows, units, lines), targets: [HEALTHY, LIMIT], standing: hysteresis ? standing : null });
      standing = fit.through === null ? null : { through: fit.through, lines: fit.lines, protectLatest: fit.protectLatest };
      trail.push({ through: fit.through, size: sizeOf(rows, fit.units, fit.lines), notice: collapseHistory(rows, fit.units, fit.lines).notice?.text ?? null });
    }
    return trail;
  };
  const distinctCuts = (trail: ReturnType<typeof execute>): number => new Set(trail.map((entry) => entry.through).filter((through) => through !== null)).size;

  it('mantém o corte, e portanto o índice byte a byte, enquanto o pedido couber, e só o avança quando não cabe mais', () => {
    const trail = execute(90, true);
    const collapsed = trail.filter((entry) => entry.through !== null);
    // Pressão real: boa parte da execução roda colapsada, e todo pedido colapsado cabe.
    expect(collapsed.length).toBeGreaterThan(50);
    for (const entry of collapsed) expect(entry.size).toBeLessThanOrEqual(LIMIT);
    let advances = 0;
    for (let index = 1; index < trail.length; index++) {
      const previous = trail[index - 1]!, current = trail[index]!;
      if (previous.through === null || current.through === null) continue;
      // Mesmo corte: mesmo aviso, byte a byte (o prefixo do pedido não muda).
      if (current.through === previous.through) { expect(current.notice).toBe(previous.notice); continue; }
      advances++;
      // O corte só avança se o vigente, aplicado ao histórico de agora, estourava o limite (cada unidade é uma linha: unidades = id - 1) e volta à ocupação saudável.
      expect(sizeOf(growing(index + 1), Number(previous.through) - 1, COLLAPSE_INDEX_LINES)).toBeGreaterThan(LIMIT);
      expect(current.size).toBeLessThanOrEqual(HEALTHY);
      expect(Number(current.through)).toBeGreaterThan(Number(previous.through));
    }
    expect(advances).toBeGreaterThan(0);
    // Com a margem de 70% a 100% o corte avança uma vez a cada vários passos, não a cada passo.
    expect(distinctCuts(trail)).toBeLessThanOrEqual(collapsed.length / 5);
  });

  it('sem guardar o corte o mesmo cenário o avançaria quase a cada etapa (o comportamento que derrubava o cache)', () => {
    const trail = execute(90, false);
    const collapsed = trail.filter((entry) => entry.through !== null);
    expect(distinctCuts(trail)).toBeGreaterThan(collapsed.length * 0.8);
  });

  it('o corte guardado vale por id: linhas antigas que saíram do histórico visível (cobertas por resumo) não o invalidam', () => {
    const visible = rows().slice(2); // a primeira mensagem e a etapa 1 já estão num resumo
    const reused = fitByCollapse({ rows: visible, size: () => 100, targets: [500, 1000], standing: { through: '4', lines: COLLAPSE_INDEX_LINES, protectLatest: true } });
    expect(reused).toMatchObject({ units: 1, through: '4', fits: true });
    // Corte guardado que já não cabe: recalcula (aqui, para o mínimo que atinge a meta) em vez de insistir nele.
    const tight = fitByCollapse({ rows: visible, size: ({ units }) => 1000 - units * 300, targets: [500, 600], standing: { through: '4', lines: COLLAPSE_INDEX_LINES, protectLatest: true } });
    expect(tight).toMatchObject({ units: 2, through: '5', fits: true });
  });
});
