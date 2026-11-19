// @vitest-environment jsdom
// Prova do editor visual de doc (phase 14, passo 1; A17 e A19). O ProseMirror precisa de DOM, por isso este é o único teste do web em
// jsdom: o ambiente dos demais continua node (vitest.config.ts). Os casos são do critério, não do código:
// - A17: carregar e serializar sem editar devolve o texto idêntico (ida e volta REAL, sem o atalho de "sem alteração"); sem alteração o
//   editor não sinaliza mudança (nem na montagem, nem com foco e seleção) e devolve o texto gravado byte a byte; com alteração serializa
//   o documento inteiro; desfazer a alteração volta a "sem alteração".
// - A19: HTML cru e sintaxe de imagem ficam como texto (nunca viram `script` nem `img`) e sobrevivem à ida e volta, inclusive quando o
//   dono edita outro trecho; links levam `noopener` e o esquema perigoso não vira `href`.
// Edições do dono são transações do ProseMirror (as mesmas que a digitação gera); a caixa da checklist é provada por clique e atalho.
import { StrictMode, act, createRef } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DocEditor, type DocEditorCore, type DocEditorHandle, createDocEditor } from './doc-editor';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Forma canônica do editor (marcador `-`, tabela compacta, linha `---`) com cada elemento do conjunto GFM da decisão 6. */
const GFM_FIXTURE = [
  '# Título principal',
  '',
  '## Seção',
  '',
  'Parágrafo com **negrito**, *itálico*, ~~tachado~~, `código` e [um link](https://example.com "título do link").',
  '',
  '- item um',
  '- item dois',
  '  - item aninhado',
  '',
  '1. primeiro',
  '2. segundo',
  '',
  '- [ ] tarefa aberta',
  '- [x] tarefa feita',
  '',
  '> citação com **ênfase**',
  '',
  '```ts',
  'const a = 1;',
  '```',
  '',
  '| Nome | Idade |',
  '| - | - |',
  '| Ana | 30 |',
  '',
  '---',
  '',
  'Fim.',
  '',
].join('\n');

/** Um padrão por elemento que o critério A17 lista: a fixture precisa mesmo usar todos. */
const GFM_CONSTRUCTS: Array<[string, RegExp]> = [
  ['títulos', /^## Seção$/m],
  ['negrito', /\*\*negrito\*\*/],
  ['itálico', /\*itálico\*/],
  ['tachado', /~~tachado~~/],
  ['lista com marcadores', /^- item um$/m],
  ['lista numerada', /^1\. primeiro$/m],
  ['checklist', /^- \[x\] tarefa feita$/m],
  ['link', /\[um link\]\(https:\/\/example\.com "título do link"\)/],
  ['citação', /^> citação/m],
  ['bloco de código', /^```ts$/m],
  ['tabela', /^\| - \| - \|$/m],
  ['linha divisória', /^---$/m],
];

/** Texto que o editor normaliza ao serializar (marcador `*`, linha `***`, tabela alinhada): o doc gravado por um bot pode vir assim. */
const NON_CANONICAL = ['* item com asterisco', '* outro item', '', '***', '', '| Nome | Idade |', '| ---- | ----- |', '| Ana  | 30    |', ''].join('\n');

/** Mistura o que as regras internas do ProseMirror mexem na montagem: ids de título, rótulos de lista, notas, HTML e imagem. */
const HEAVY_FIXTURE = [
  '# Repetido',
  '',
  '# Repetido',
  '',
  '5. cinco',
  '6. seis',
  '',
  '1. [ ] numerada com tarefa',
  '2. [x] outra',
  '',
  'Nota[^1] e <b>html</b> e ![img](https://exemplo.com/a.png).',
  '',
  '[^1]: texto da nota',
  '',
].join('\n');

/** Critério A19: HTML com `<script>` e `<img onerror>`, imagem em Markdown e link. Sem esquema perigoso, que a serialização escapa. */
const UNSAFE_FIXTURE = [
  'Texto com <script>alert(1)</script> embutido.',
  '',
  '<img src="https://evil.example/pixel.png" onerror="alert(1)">',
  '',
  '![imagem](https://evil.example/x.png "legenda")',
  '',
  '[link](https://example.com)',
  '',
].join('\n');

const hosts: HTMLElement[] = [];
const cores: DocEditorCore[] = [];

afterEach(async () => {
  await Promise.all(cores.splice(0).map((core) => core.destroy()));
  for (const host of hosts.splice(0)) host.remove();
});

/** Abre o editor num contêiner do documento, como o componente faz, e o encerra no `afterEach`. */
async function open(markdown: string, onDirtyChange?: (dirty: boolean) => void) {
  const host = document.createElement('div');
  document.body.append(host);
  hosts.push(host);
  const core = await createDocEditor({ host, markdown, label: 'Texto do doc', onDirtyChange });
  cores.push(core);
  return { host, core };
}

/** Insere texto na posição dada, como a digitação do dono faz (uma transação que altera o documento). */
const type = (core: DocEditorCore, text: string, at = 1) => core.view.dispatch(core.view.state.tr.insertText(text, at));
const settle = () => new Promise((resolve) => setTimeout(resolve, 40));
/** Quantos nós `image` o documento tem: são sempre literais em texto, nenhum vira `<img>`. */
const imageNodes = (core: DocEditorCore) => {
  let count = 0;
  core.view.state.doc.descendants((node) => {
    if (node.type.name === 'image') count += 1;
  });
  return count;
};

describe('A17: ida e volta do Markdown GFM', () => {
  it('a fixture usa todos os elementos do conjunto GFM', () => {
    for (const [name, pattern] of GFM_CONSTRUCTS) expect(GFM_FIXTURE, name).toMatch(pattern);
  });

  it('carregar e serializar sem editar devolve o texto idêntico, caractere por caractere (serializador real, sem o atalho)', async () => {
    const { core } = await open(GFM_FIXTURE);
    expect(core.serialize()).toBe(GFM_FIXTURE);
  });

  it('a montagem não conta como alteração, nem com foco, seleção e o assentamento do ProseMirror', async () => {
    for (const markdown of [GFM_FIXTURE, HEAVY_FIXTURE, UNSAFE_FIXTURE, NON_CANONICAL, '']) {
      const onDirtyChange = vi.fn();
      const { host, core } = await open(markdown, onDirtyChange);
      const field = host.querySelector<HTMLElement>('[role="textbox"]');
      field?.dispatchEvent(new FocusEvent('focus'));
      document.dispatchEvent(new Event('selectionchange'));
      field?.dispatchEvent(new FocusEvent('blur'));
      await settle();
      expect(onDirtyChange, markdown).not.toHaveBeenCalled();
      expect(core.isDirty()).toBe(false);
    }
  });

  it('sem alteração devolve o texto gravado byte a byte, mesmo fora da forma canônica; com alteração serializa o documento inteiro', async () => {
    const onDirtyChange = vi.fn();
    const { core } = await open(NON_CANONICAL, onDirtyChange);
    // O serializador normaliza este texto: só o atalho de "sem alteração" garante que Salvar não reescreva o doc sozinho.
    expect(core.serialize()).not.toBe(NON_CANONICAL);
    expect(core.getMarkdown()).toBe(NON_CANONICAL);

    type(core, 'Novo ', 3);
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    expect(core.isDirty()).toBe(true);
    const edited = core.getMarkdown();
    expect(edited).toBe(core.serialize());
    expect(edited).toContain('- Novo item com asterisco');
    expect(edited).toContain('- outro item');
    expect(edited).toContain('---');
  });

  it('desfazer a alteração volta a "sem alteração" e a devolver o texto gravado', async () => {
    const onDirtyChange = vi.fn();
    const { core } = await open(NON_CANONICAL, onDirtyChange);
    type(core, 'x', 3);
    expect(core.isDirty()).toBe(true);
    core.view.dispatch(core.view.state.tr.delete(3, 4));
    expect(core.isDirty()).toBe(false);
    expect(onDirtyChange.mock.calls.map(([dirty]) => dirty)).toEqual([true, false]);
    expect(core.getMarkdown()).toBe(NON_CANONICAL);
  });

  it('a caixa da checklist alterna por clique na caixa e por Ctrl+Shift+Enter, e o clique no texto não alterna', async () => {
    const onDirtyChange = vi.fn();
    const { host, core } = await open('- [ ] fazer\n- [x] feito\n', onDirtyChange);
    const [first] = host.querySelectorAll<HTMLElement>('li[data-item-type="task"]');
    expect(first?.dataset.checked).toBe('false');

    first?.querySelector('p')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(core.isDirty()).toBe(false);

    first?.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 4 }));
    expect(core.isDirty()).toBe(true);
    expect(core.getMarkdown()).toBe('- [x] fazer\n- [x] feito\n');

    // O cursor começa na primeira linha; o atalho alterna de volta e o documento deixa de contar como alterado.
    host.querySelector('[role="textbox"]')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, shiftKey: true, bubbles: true }));
    expect(core.isDirty()).toBe(false);
    expect(core.getMarkdown()).toBe('- [ ] fazer\n- [x] feito\n');
  });
});

describe('A19: HTML, imagem e link no editor', () => {
  it('HTML cru e sintaxe de imagem ficam como texto, sem criar script nem img, e a ida e volta preserva o texto', async () => {
    const { host, core } = await open(UNSAFE_FIXTURE);
    expect(host.querySelector('script')).toBeNull();
    // O ProseMirror põe um `img.ProseMirror-separator` sem `src` ao lado de nós em linha; nada além dele pode ser imagem.
    expect(host.querySelectorAll('img:not(.ProseMirror-separator)')).toHaveLength(0);
    for (const element of host.querySelectorAll('*')) {
      expect(element.hasAttribute('onerror'), element.outerHTML).toBe(false);
      expect(element.hasAttribute('src'), element.outerHTML).toBe(false);
      expect(element.hasAttribute('srcset'), element.outerHTML).toBe(false);
    }
    const text = host.textContent ?? '';
    expect(text).toContain('<script>alert(1)</script>');
    expect(text).toContain('<img src="https://evil.example/pixel.png" onerror="alert(1)">');
    expect(text).toContain('![imagem](https://evil.example/x.png "legenda")');
    expect(core.serialize()).toBe(UNSAFE_FIXTURE);
  });

  it('editar outro trecho não apaga o HTML nem a sintaxe de imagem', async () => {
    const { core } = await open(UNSAFE_FIXTURE);
    type(core, 'Alterado: ');
    const saved = core.getMarkdown();
    expect(saved).toBe(UNSAFE_FIXTURE.replace('Texto com', 'Alterado: Texto com'));
  });

  it('links abrem com noopener e o esquema perigoso não vira href', async () => {
    const { host } = await open('[ok](https://example.com) e [perigoso](javascript:alert(1)) e <https://auto.example.com>\n');
    const links = [...host.querySelectorAll('a')];
    expect(links).toHaveLength(3);
    for (const link of links) {
      expect(link.getAttribute('rel')).toContain('noopener');
      expect(link.getAttribute('target')).toBe('_blank');
    }
    expect(links.map((link) => link.getAttribute('href'))).toEqual(['https://example.com', '', 'https://auto.example.com']);
  });

  it('colar HTML com <img> não cria imagem', async () => {
    const { host, core } = await open('');
    // `pasteHTML` passa pelas regras de leitura (`parseDOM`) do schema: é o caminho de uma imagem copiada de outra página.
    core.view.pasteHTML('<p>antes</p><img src="https://evil.example/p.png" alt="p"><p>depois</p>', new Event('paste') as ClipboardEvent);
    expect(host.textContent).toContain('antes');
    expect(host.textContent).toContain('depois');
    expect(host.querySelectorAll('img:not(.ProseMirror-separator)')).toHaveLength(0);
    expect(imageNodes(core)).toBe(0);
  });

  it('colar Markdown com imagem insere a sintaxe como texto, sem img', async () => {
    const { host, core } = await open('');
    const text = '![colada](https://evil.example/c.png)';
    const clipboardData = { getData: (type: string) => (type === 'text/plain' ? text : '') };
    core.view.pasteText(text, Object.assign(new Event('paste'), { clipboardData }) as unknown as ClipboardEvent);
    expect(host.textContent).toContain(text);
    expect(host.querySelectorAll('img:not(.ProseMirror-separator)')).toHaveLength(0);
    expect(imageNodes(core)).toBe(1);
    expect(core.getMarkdown()).toBe(`${text}\n`);
  });
});

describe('DocEditor (componente)', () => {
  async function mount(ui: React.ReactElement) {
    const container = document.createElement('div');
    document.body.append(container);
    hosts.push(container);
    const root = createRoot(container);
    await act(async () => root.render(ui));
    return { container, root };
  }
  const whenReady = (container: HTMLElement) =>
    act(async () => {
      await vi.waitFor(() => expect(container.querySelector('[data-ready="true"]')).not.toBeNull());
    });

  it('monta uma única vez em StrictMode, expõe o campo com nome acessível e devolve o texto gravado sem edição', async () => {
    const ref = createRef<DocEditorHandle>();
    const onDirtyChange = vi.fn();
    const { container, root } = await mount(
      <StrictMode>
        <DocEditor markdown={NON_CANONICAL} label="Texto do doc" onDirtyChange={onDirtyChange} ref={ref} />
      </StrictMode>,
    );
    // Antes de pronto não há edição possível: devolve o texto recebido.
    expect(ref.current?.getMarkdown()).toBe(NON_CANONICAL);
    await whenReady(container);
    await act(async () => settle());

    expect(container.querySelectorAll('.ProseMirror')).toHaveLength(1);
    const field = container.querySelector('[role="textbox"]');
    expect(field?.getAttribute('aria-label')).toBe('Texto do doc');
    expect(field?.getAttribute('aria-multiline')).toBe('true');
    expect(ref.current?.getMarkdown()).toBe(NON_CANONICAL);
    expect(ref.current?.isDirty()).toBe(false);
    expect(onDirtyChange).not.toHaveBeenCalled();

    await act(async () => root.unmount());
    await act(async () => settle());
    expect(container.querySelector('.ProseMirror')).toBeNull();
  });

  it('a falha ao criar o editor chega ao onError, sem rejeição solta e sem editor pronto', async () => {
    const onError = vi.fn();
    const { container } = await mount(<DocEditor markdown={undefined as unknown as string} label="Texto do doc" onError={onError} />);
    await act(async () => {
      await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    });
    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    expect(container.querySelector('[data-ready="true"]')).toBeNull();
  });
});
