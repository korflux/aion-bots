// Prova do texto que o bot lê ao procurar ações no Composio (T29): os parâmetros como lista curta (e não o JSON Schema inteiro), só as primeiras
// ações com parâmetros, e tudo cortado em tamanho, porque o catálogo do Composio é dado externo e não pode estourar o contexto do modelo.
import { describe, expect, it } from 'vitest';
import type { ConnectorTool } from '../credentials/composio';
import { SEARCH_RESULTS_WITH_PARAMETERS, describeParameters, formatSearchResults } from './composio-format';

const tool = (n: number, overrides: Partial<ConnectorTool> = {}): ConnectorTool => ({
  slug: `GMAIL_ACAO_${n}`,
  name: `Acao ${n}`,
  description: `Faz a ação ${n}.`,
  toolkitSlug: 'gmail',
  toolkitName: 'Gmail',
  inputSchema: { type: 'object', properties: { to: { type: 'string', description: 'Destinatário' } }, required: ['to'] },
  ...overrides,
});

describe('parâmetros de uma ação', () => {
  it('lista nome, tipo, se é obrigatório e a descrição; os obrigatórios vêm primeiro', () => {
    const text = describeParameters({
      type: 'object',
      properties: {
        cc: { type: 'string', description: 'Com cópia' },
        to: { type: 'string', description: 'Destinatário' },
        labels: { type: 'array', items: { type: 'string' } },
        mode: { enum: ['a', 'b'] },
        meta: { type: ['object', 'null'] },
        raw: {},
      },
      required: ['to'],
    });
    expect(text.split('\n')).toEqual([
      '   Parâmetros:',
      '   - to (string, obrigatório): Destinatário',
      '   - cc (string): Com cópia',
      '   - labels (array<string>)',
      '   - mode (enum: a|b)',
      '   - meta (object|null)',
      '   - raw (qualquer)',
    ]);
  });

  it('sem parâmetros diz "nenhum"; esquema fora do formato não quebra; descrição, lista de valores e quantidade são cortadas', () => {
    expect(describeParameters({ type: 'object', properties: {} })).toBe('   Parâmetros: nenhum.');
    expect(describeParameters({})).toBe('   Parâmetros: nenhum.');
    expect(describeParameters({ properties: [1, 2] as unknown as Record<string, unknown> })).toBe('   Parâmetros: nenhum.');
    expect(describeParameters({ properties: { x: null } })).toContain('- x (qualquer)');

    const long = describeParameters({ properties: { x: { type: 'string', description: `${'palavra '.repeat(100)}` } } });
    expect(long.split('\n')[1]!.length).toBeLessThan(200);
    expect(long).toContain('…');
    expect(describeParameters({ properties: { m: { enum: Array.from({ length: 20 }, (_, i) => `v${i}`) } } })).toContain('enum: v0|v1|v2|v3|v4|v5|v6|v7|…');

    const many = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`p${String(i).padStart(2, '0')}`, { type: 'string' }]));
    const text = describeParameters({ properties: many, required: ['p39'] });
    expect(text.split('\n')[1]).toContain('p39 (string, obrigatório)'); // o obrigatório sobe mesmo sendo o último
    expect(text).toContain('(+15 parâmetros opcionais omitidos)');
  });
});

describe('resultado da busca', () => {
  it('as primeiras ações trazem os parâmetros e as demais só o nome e a descrição; termina dizendo como executar', () => {
    const text = formatSearchResults({ slug: 'gmail', name: 'Gmail' }, 'send email', [1, 2, 3, 4, 5].map((n) => tool(n)));
    expect(text).toContain('Ações de Gmail (gmail) para "send email" (5):');
    for (const n of [1, 2, 3]) expect(text).toContain(`${n}. GMAIL_ACAO_${n} — Acao ${n}\n   Faz a ação ${n}.\n   Parâmetros:\n   - to (string, obrigatório): Destinatário`);
    expect(text).toContain('4. GMAIL_ACAO_4 — Acao 4: Faz a ação 4.');
    expect(text).not.toMatch(/4\. GMAIL_ACAO_4[^\n]*\n\s+Parâmetros/);
    expect(text.match(/Parâmetros:/g)).toHaveLength(SEARCH_RESULTS_WITH_PARAMETERS);
    expect(text).toContain('composio_execute_action com action igual ao slug');
    expect(text).toContain('Prévia parcial:');
    expect(text).toContain('app, action igual ao slug e offset 0');
  });

  it('sem resultado orienta a tentar de novo em inglês; até 3 ações não repetem a dica das últimas', () => {
    expect(formatSearchResults({ slug: 'notion_mcp', name: 'Notion' }, 'zzz', [])).toBe(
      'Nenhuma ação de Notion (notion_mcp) combinou com "zzz". Tente outras palavras; os nomes das ações estão em inglês (por exemplo "send email" ou "create page").',
    );
    expect(formatSearchResults({ slug: 'gmail', name: 'Gmail' }, 'x', [tool(1)])).not.toContain('das últimas');
  });

  it('descrições enormes ou sem texto não estouram nem deixam linha vazia', () => {
    const text = formatSearchResults({ slug: 'gmail', name: 'Gmail' }, 'x', [tool(1, { description: 'a '.repeat(500) }), tool(2, { description: '' })]);
    const first = text.split('\n').find((line) => line.startsWith('   a a'))!;
    expect(first.length).toBeLessThanOrEqual(3 + 240);
    expect(text).not.toContain('2. GMAIL_ACAO_2 — Acao 2\n   \n');
  });
});

it('conta obrigatórios omitidos corretamente quando mais de 25 são exigidos', () => {
  const properties = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`p${i}`, { type: 'string' }]));
  expect(describeParameters({ properties, required: Object.keys(properties) })).toContain('(+15 obrigatórios e 0 opcionais omitidos)');
});
