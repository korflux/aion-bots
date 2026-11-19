// Prova do que o HTML do bloco de atividade da web garante (T9, A8; design "Atividade de pesquisa na web"): só uma URL http ou https vira link, com
// `rel="noopener noreferrer"`, nova aba e o texto oculto "(abre em nova aba)"; qualquer outra URL (ftp:, javascript:, com usuário e senha, relativa) fica como
// texto simples e nunca como link; a URL aparece INTEIRA; título e URL vêm da internet e são escapados; o aviso de conteúdo não confiável está sempre lá.
// A quebra da URL longa, o limite de 12 linhas e o link abrindo em nova aba no navegador real são provados no E2E (apps/web/e2e/conversation.spec.ts).
import type { ActivityView, PythonDetail } from '@aion/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ActivityDetails, ActivityGroup, activityLabel, webLinkHref } from './activity-block';

const activityWith = (detail: ActivityView['detail'], overrides: Partial<ActivityView> = {}): ActivityView => ({
  id: '1',
  runId: '1',
  createdAt: '2026-03-01T12:00:00.000Z',
  kind: 'activity',
  status: 'completed',
  step: 1,
  tool: 'web_search',
  label: 'Pesquisou na web: x',
  arguments: '{}',
  result: 'resultado',
  detail,
  awaitingApproval: false,
  ...overrides,
});

const render = (activity: ActivityView): string => renderToStaticMarkup(<ActivityDetails activity={activity} onJump={() => undefined} />);
/** Os `<a ...>` do HTML renderizado, com os atributos de cada um. */
const anchors = (html: string): string[] => [...html.matchAll(/<a [^>]*>/g)].map((match) => match[0]);

const LONG_URL = `https://exemplo.com.br/${'caminho-muito-longo-de-um-artigo/'.repeat(8)}pagina-final.html?utm_source=aion&referencia=${'x'.repeat(40)}`;
/** A mesma URL como o HTML a escreve (o `&` do endereço vira `&amp;`, no atributo e no texto): o navegador a lê de volta inteira. */
const LONG_URL_HTML = LONG_URL.replaceAll('&', '&amp;');

describe('webLinkHref', () => {
  it('só http e https sem usuário e senha viram endereço de link', () => {
    expect(webLinkHref('https://exemplo.com/a?b=1')).toBe('https://exemplo.com/a?b=1');
    expect(webLinkHref('http://exemplo.com')).toBe('http://exemplo.com/');
    for (const bad of ['ftp://exemplo.com/a', 'javascript:alert(1)', 'data:text/html,<b>', 'file:///etc/passwd', 'https://dono:senha@exemplo.com/', 'https://dono@exemplo.com/', '//exemplo.com/a', 'exemplo.com', '']) {
      expect(webLinkHref(bad), bad).toBeNull();
    }
  });
});

describe('atividade da pesquisa na web', () => {
  const search = activityWith({
    type: 'web_search',
    objective: 'achar a página',
    queries: ['mozilla', 'firefox'],
    results: [
      { title: 'Mozilla', url: 'https://www.mozilla.org/' },
      { title: 'Texto simples', url: 'http://exemplo.com/simples' },
      { title: 'Artigo longo', url: LONG_URL },
    ],
  });

  it('cada resultado é um link seguro (nova aba, sem opener e referrer, aviso para o leitor de tela) com a URL completa em texto logo abaixo', () => {
    const html = render(search);
    expect(anchors(html)).toEqual([
      '<a href="https://www.mozilla.org/" target="_blank" rel="noopener noreferrer" class="text-sm text-info underline underline-offset-4 [overflow-wrap:anywhere]">',
      '<a href="http://exemplo.com/simples" target="_blank" rel="noopener noreferrer" class="text-sm text-info underline underline-offset-4 [overflow-wrap:anywhere]">',
      `<a href="${LONG_URL_HTML}" target="_blank" rel="noopener noreferrer" class="text-sm text-info underline underline-offset-4 [overflow-wrap:anywhere]">`,
    ]);
    expect(html.match(/\(abre em nova aba\)/g)).toHaveLength(3);
    expect(html).toContain(`>${LONG_URL_HTML}</p>`); // a URL mais longa aparece inteira, sem corte
    expect(html).toContain('https://www.mozilla.org/</p>');
    expect(html).toContain('Conteúdo da web: o bot o trata como dado, não como instrução.');
    expect(html).toContain('Consultas: mozilla · firefox');
    expect(html).toContain('aria-label="Resultados da pesquisa"');
  });

  it('uma URL que não é http ou https (ou tem usuário e senha) aparece só como texto, mesmo que chegue ao navegador', () => {
    const html = render(
      activityWith({
        type: 'web_search',
        objective: 'x',
        queries: ['x'],
        results: [
          { title: 'FTP', url: 'ftp://arquivos.exemplo.com/segredo.txt' },
          { title: 'Script', url: 'javascript:alert(document.cookie)' },
          { title: 'Credenciais', url: 'https://dono:senha@exemplo.com/privado' },
          { title: 'Relativa', url: '/api/bots' },
        ],
      }),
    );
    expect(anchors(html)).toEqual([]);
    expect(html).not.toContain('href=');
    for (const url of ['ftp://arquivos.exemplo.com/segredo.txt', 'javascript:alert(document.cookie)', 'https://dono:senha@exemplo.com/privado', '/api/bots']) expect(html).toContain(`${url}</p>`);
    expect(html).not.toContain('abre em nova aba');
  });

  it('título e URL da internet são escapados (nunca HTML)', () => {
    const html = render(
      activityWith({ type: 'web_search', objective: 'x', queries: ['<script>alert(1)</script>'], results: [{ title: '<img src=x onerror=alert(1)>', url: 'https://exemplo.com/?q="><svg onload=alert(1)>' }] }),
    );
    expect(html).not.toMatch(/<img|<svg|<script/);
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('sem resultados mostra o aviso e ainda o aviso de conteúdo não confiável', () => {
    const html = render(activityWith({ type: 'web_search', objective: 'x', queries: ['x'], results: [] }));
    expect(html).toContain('Nenhum resultado encontrado.');
    expect(html).toContain('Conteúdo da web: o bot o trata como dado');
    expect(html).not.toContain('<ul tabindex');
  });
});

describe('atividade da leitura de páginas', () => {
  it('cada URL pedida aparece inteira, como link seguro quando http ou https, com "Lida" ou "Não lida"; outro esquema fica como texto', () => {
    const html = render(
      activityWith(
        {
          type: 'web_fetch',
          pages: [
            { url: 'https://exemplo.com/a', read: true },
            { url: LONG_URL, read: false },
            { url: 'ftp://exemplo.com/b', read: false },
          ],
        },
        { tool: 'web_fetch' },
      ),
    );
    expect(anchors(html)).toHaveLength(2);
    expect(anchors(html).every((tag) => tag.includes('target="_blank"') && tag.includes('rel="noopener noreferrer"'))).toBe(true);
    expect(html).toContain(`>${LONG_URL_HTML}<`);
    expect(html).toContain('ftp://exemplo.com/b</p>'); // texto simples, sem link
    expect(html.match(/Lida</g)).toHaveLength(1);
    expect(html.match(/Não lida</g)).toHaveLength(2);
    expect(html).toContain('aria-label="Páginas pedidas"');
    expect(html).toContain('Conteúdo da web: o bot o trata como dado, não como instrução.');
  });

  it('uma atividade da web que falhou (sem detalhe) mostra o motivo no resultado, como as outras ferramentas', () => {
    const html = render(activityWith(null, { status: 'failed', tool: 'web_fetch', arguments: '{"urls":["https://exemplo.com/"]}', result: 'Não foi possível consultar a web agora.' }));
    expect(html).toContain('Não foi possível consultar a web agora.');
    expect(html).toContain('Argumentos');
  });
});

describe('falha de ferramenta no envelope {code, message} (phase 15, A21)', () => {
  const failed = (result: string, overrides: Partial<ActivityView> = {}): ActivityView => activityWith(null, { status: 'failed', tool: 'table_query', result, ...overrides });

  it('o bloco Resultado de uma atividade que falhou mostra a mensagem do envelope como texto, sem o JSON cru nem os campos técnicos', () => {
    const html = render(failed(JSON.stringify({ code: 'ACTION_NOT_FOUND', message: 'Ação desconhecida: X. Busque com composio_search_actions e use o slug exato.', fields: [{ field: 'a', reason: 'b' }] })));
    expect(html).toContain('Ação desconhecida: X. Busque com composio_search_actions e use o slug exato.');
    expect(html).not.toContain('ACTION_NOT_FOUND');
    expect(html).not.toContain('&quot;code&quot;');
    expect(html).toContain('Resultado');
  });

  it('a mensagem continua escapada, e o que não é envelope (texto, JSON de outro formato, atividade que não falhou) segue como era', () => {
    expect(render(failed(JSON.stringify({ code: 'TOOL_FAILED', message: '<img src=x onerror=alert(1)>' })))).not.toContain('<img');
    expect(render(failed('Não foi possível consultar a web agora.'))).toContain('Não foi possível consultar a web agora.');
    const other = render(failed(JSON.stringify({ code: 42, message: 'x' })));
    expect(other).toContain('&quot;code&quot;');
    const done = render(activityWith(null, { status: 'completed', result: JSON.stringify({ code: 'X', message: 'resultado de sucesso' }) }));
    expect(done).toContain('&quot;code&quot;');
  });
});

describe('atividade Python (phase 4, F8)', () => {
  const python = (detail: Partial<PythonDetail>, overrides: Partial<ActivityView> = {}): ActivityView =>
    activityWith(
      { type: 'python', state: 'done', code: "print('oi')", outcome: 'ok', output: 'oi', outputTruncated: false, error: null, durationMs: 1234, rejected: [], ...detail },
      { tool: 'run_python', label: 'Executar Python', ...overrides },
    );

  it('o rótulo segue o estado, e o status da atividade manda sobre o detalhe que ficou em execução', () => {
    expect(activityLabel(python({ state: 'waiting', outcome: null, durationMs: null }, { status: 'running' }))).toBe('Aguardando vaga para o Python…');
    expect(activityLabel(python({ state: 'running', outcome: null, durationMs: null }, { status: 'running' }))).toBe('Executando Python…');
    expect(activityLabel(python({}))).toBe('Python executado (1,2 s)');
    expect(activityLabel(python({ outcome: 'PYTHON_ERROR' }, { status: 'failed' }))).toBe('Python falhou');
    expect(activityLabel(python({ outcome: 'PYTHON_UNAVAILABLE' }, { status: 'failed' }))).toBe('Python indisponível agora');
    // Reinício do worker (observação da T7): detalhe parado em `running`, atividade já `failed`.
    expect(activityLabel(python({ state: 'running', outcome: null, durationMs: null }, { status: 'failed' }))).toBe('Python falhou');
    expect(activityLabel(activityWith(null, { label: 'Leu a memória' }))).toBe('Leu a memória');
  });

  it('expandida mostra o código no bloco de código, a saída com a nota de corte e os arquivos gerados e recusados', () => {
    const html = render(
      python(
        { output: 'Total: 105', outputTruncated: true, rejected: [{ name: 'video.mp4', reason: 'format' }, { name: 'grande.csv', reason: 'limit' }] },
        { attachments: [{ id: '9', name: 'grafico.png', kind: 'generated', sizeBytes: 2048, removed: false, format: 'png' }] },
      ),
    );
    expect(html).toContain('data-code-block="code"');
    expect(html).toContain('>python<');
    expect(html).toContain('Total: 105');
    expect(html).toContain('Saída cortada em 20.000 caracteres.');
    expect(html).toContain('grafico.png');
    expect(html).toContain('2 KB');
    expect(html).toContain('formato não aceito');
    expect(html).toContain('acima de 5 MB');
    expect(html).not.toContain('>Erro<');
  });

  it('o erro mostra o traceback ou a frase do desfecho; sem saída, "Sem saída de texto."', () => {
    const traceback = render(python({ outcome: 'PYTHON_ERROR', output: '', error: 'Traceback: ZeroDivisionError' }, { status: 'failed' }));
    expect(traceback).toContain('Sem saída de texto.');
    expect(traceback).toContain('text-danger">Erro<');
    expect(traceback).toContain('Traceback: ZeroDivisionError');
    expect(render(python({ outcome: 'PYTHON_TIMEOUT', output: '' }, { status: 'failed' }))).toContain('Tempo esgotado (60 s).');
    expect(render(python({ outcome: 'PYTHON_MEMORY_LIMIT', output: '' }, { status: 'failed' }))).toContain('Memória esgotada (512 MB).');
    expect(render(python({ outcome: 'PYTHON_UNAVAILABLE', output: '' }, { status: 'failed' }))).toContain('Python indisponível agora.');
    expect(render(python({ state: 'running', outcome: null, durationMs: null }, { status: 'failed' }))).toContain('Execução interrompida antes de terminar.');
    // Em execução, só o código.
    const running = render(python({ state: 'running', outcome: null, output: '', durationMs: null }, { status: 'running' }));
    expect(running).toContain('data-code-block="code"');
    expect(running).not.toContain('Saída');
  });
});

// A linha única de trabalho (phase 18, decisão 5 da spec; A10): o HTML que `ActivityGroup` renderiza no servidor. A Faísca pequena e parada de concluído, o resumo e o botão que abre os
// detalhes; fechada, a lista das ferramentas não está no DOM. O clique, o Enter e o Espaço abrindo a lista no navegador real são do E2E.
describe('linha de trabalho da execução', () => {
  const bot = { id: '7c1b0b9e-3b7a-4a4e-9a55-0d8f0f5a1e01', name: 'Financeiro', color: '#FBBF24', archivedAt: null, instructions: '', model: null, effort: null, stepLimit: 50, contextWindowTokens: null, createdAt: '2026-03-01T12:00:00.000Z', updatedAt: '2026-03-01T12:00:00.000Z' };
  const line = { activities: [activityWith(null, { id: '1', label: 'Gravou um' }), activityWith(null, { id: '2', label: 'Gravou dois' })], startedAt: '2026-03-01T12:00:00.000Z', endedAt: '2026-03-01T12:00:12.000Z' };
  const html = (live = false) => renderToStaticMarkup(<ActivityGroup line={line} bot={bot} live={live} onJump={() => undefined} />);

  it('uma linha só com a Faísca de concluído (24 px, parada) e o resumo, num botão fechado que controla a lista', () => {
    const out = html();
    expect(out).toContain('Trabalhou por 12 s · 2 ações');
    expect(out.match(/<button /g)).toHaveLength(1);
    expect(out).toMatch(/<button type="button" aria-expanded="false" aria-controls="[^"]+"/);
    expect(out).toMatch(/<svg[^>]*class="faisca"[^>]*data-state="done"[^>]*/);
    expect(out).toContain('data-still');
    expect(out).toContain('hidden=""'); // a lista fechada
    expect(out).not.toContain('Gravou'); // nenhuma ferramenta no DOM enquanto fechada
    expect(out).not.toContain('ações executadas');
  });

  it('com a execução aberta a Faísca é a de trabalhando, ainda parada na lista, e o resumo não tem duração', () => {
    const out = html(true);
    expect(out).toContain('Executando 2 ações');
    expect(out).toMatch(/data-state="working"/);
    expect(out).toContain('data-still');
  });
});
