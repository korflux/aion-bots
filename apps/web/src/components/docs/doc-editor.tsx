'use client';

// Editor visual de doc (phase 14, passo 1; DOC-03 e DOC-04, A17 a A19): o dono edita o doc formatado (títulos, negrito, itálico, tachado,
// listas, checklist, links, citação, bloco de código, tabela e linha divisória) e o Markdown continua sendo o formato gravado, o que o
// bot lê e escreve. A leitura formatada, sem editor, é do `conversation/markdown.tsx`; este arquivo é só o campo editável.
//
// ESTRUTURA
// - `createDocEditor`: o núcleo, sem React. Monta o Milkdown (ProseMirror com parser e serializador remark, o mesmo ecossistema do
//   `react-markdown` e do `remark-gfm` da leitura) sobre um contêiner, rastreia a alteração do dono e serializa sob demanda. É também o
//   ponto de acesso dos testes, que dirigem o `EditorView` com as mesmas transações que a digitação gera.
// - `DocEditor`: o componente React que cuida do ciclo de vida (monta, destrói, StrictMode) e expõe `getMarkdown` e `isDirty` por `ref`.
//
// DECISÃO CENTRAL: o Markdown NÃO é reserializado sem alteração. Abrir o doc e salvar sem mexer devolve o texto gravado byte a byte
// (`getMarkdown` devolve o texto recebido enquanto `isDirty` é falso), porque o serializador normaliza o que o dono não tocou (marcador
// `*` vira `-`, `***` vira `---`, a tabela perde o preenchimento das colunas, referência de link vira link em linha). Só com
// alteração o documento inteiro é serializado. "Alteração" é do dono: a montagem, as regras internas do ProseMirror (ids de título,
// rótulos de lista) e alternar para o "Ver Markdown" e voltar não contam. Por isso o estado "alterado" é "o documento difere do que o
// editor tinha ao ficar pronto" (e desfazer a alteração volta a "sem alteração"), e não "houve alguma transação". Para trocar a linha de
// base (depois de salvar ou de recarregar uma versão), quem usa remonta o componente com outra `key` e outro `markdown`: o texto inicial
// é lido só na montagem.
// ponytail: a serialização depois de uma edição normaliza trechos que o dono não editou (marcador de lista, linha divisória, escapes,
// referência de link, título sublinhado), aceito enquanto o dono não reclamar; trocar por serialização só do trecho alterado se incomodar.
//
// FORMA GRAVADA: o editor escreve `-` nos marcadores de lista, `---` na linha divisória e tabelas compactas (`tablePipeAlign: false`, sem
// preencher as colunas): corrigir uma célula não realinha a tabela inteira nem muda linhas que o dono não tocou, e o bot, que edita por
// trecho exato, continua achando o texto que leu.
//
// SEGURANÇA (A19, o texto do doc vem de um bot que lê conteúdo externo, então é NÃO CONFIÁVEL):
// - HTML cru é um nó atômico em linha que o Milkdown mostra como TEXTO (`textContent`, nunca `innerHTML`) e serializa de volta verbatim;
//   `<script>` e `<img onerror>` aparecem como texto e nunca viram elemento.
// - Imagem NÃO é imagem: o nó `image` do preset vira um literal em texto (`![alt](src "título")`), sem `<img>` nem pedido de rede, e os
//   comandos de inserir e atualizar imagem e o parse de `<img>` colado saíram (o preset não registra a regra de digitação de imagem).
//   A sintaxe sobrevive à ida e volta como texto (editar outro trecho não apaga a imagem do Markdown); para mexer nela, o dono usa o
//   "Ver Markdown".
// - Links abrem em outra aba com `noopener noreferrer nofollow`; o Milkdown já neutraliza `javascript:` e similares no `href`.
// - O campo não injeta HTML: tudo é montado por nós do ProseMirror.
// ponytail: HTML e imagem aparecem como texto literal e só se editam no "Ver Markdown", trocar por nós editáveis se o dono pedir.
//
// CHECKLIST: o Milkdown não traz a caixa da checklist (ela vive num componente Vue do `@milkdown/components`, que não entra). A caixa
// aqui é um glifo de CSS (☐ e ☑, que o leitor de tela anuncia) no recuo do item; o clique nela e Ctrl+Shift+Enter (Cmd+Shift+Enter no
// Mac) alternam o item.
// ponytail: a caixa da checklist não é um controle com foco próprio, trocar por um NodeView com role=checkbox se o uso pedir.
//
// LAYOUT: o editor reaproveita as regras `.markdown` do chat (globals.css) para títulos, listas, citação, código e tabela; aqui entram só
// as regras do que o chat não tem (checklist, bloco de código editável e tabela de largura fixa). Nada rola por dentro do campo (tabela e
// código quebram a linha): uma região rolável dentro de um campo editável não é alcançável pelo teclado.
import type { MilkdownPlugin } from '@milkdown/ctx';
import { Editor, defaultValueCtx, editorViewCtx, editorViewOptionsCtx, remarkStringifyOptionsCtx, rootCtx } from '@milkdown/core';
import { clipboard } from '@milkdown/plugin-clipboard';
import { history } from '@milkdown/plugin-history';
import { commonmark, htmlAttr, imageAttr, imageSchema, insertImageCommand, linkAttr, updateImageCommand } from '@milkdown/preset-commonmark';
import { gfm, remarkGFMPlugin } from '@milkdown/preset-gfm';
import { keydownHandler } from '@milkdown/prose/keymap';
import type { Attrs, Node as ProseNode } from '@milkdown/prose/model';
import { Plugin } from '@milkdown/prose/state';
import type { EditorState, Transaction } from '@milkdown/prose/state';
import type { EditorView } from '@milkdown/prose/view';
import { $prose, getMarkdown } from '@milkdown/utils';
import 'prosemirror-view/style/prosemirror.css';
import { type Ref, useEffect, useEffectEvent, useImperativeHandle, useRef, useState } from 'react';

/** Aparência do HTML cru e da sintaxe de imagem, mostrados como texto: monoespaçado, sobre a superfície, quebrando a linha. */
const LITERAL_CLASS = 'rounded-sm bg-surface px-1 font-mono text-code text-muted whitespace-pre-wrap';

/**
 * Classes do campo editável (o `.ProseMirror`), além das regras `.markdown` do chat:
 * - tabela com largura do campo e colunas iguais, para o texto quebrar em vez de rolar;
 * - bloco de código como cartão simples, que quebra a linha;
 * - item de checklist: sem marcador e com o recuo (`pl-7`) ocupado pela caixa (☐/☑, glifo de CSS), que é a área que o clique alterna.
 */
const EDITOR_CLASS = [
  'markdown min-h-48',
  '[&_table]:w-full [&_table]:table-fixed',
  '[&_pre]:rounded-md [&_pre]:border [&_pre]:border-line [&_pre]:bg-surface [&_pre]:p-3',
  '[&_li[data-item-type=task]]:-ml-6 [&_li[data-item-type=task]]:list-none [&_li[data-item-type=task]]:pl-7',
  "[&_li[data-item-type=task]]:before:absolute [&_li[data-item-type=task]]:before:left-0 [&_li[data-item-type=task]]:before:cursor-pointer [&_li[data-item-type=task]]:before:content-['☐']",
  "[&_li[data-item-type=task][data-checked=true]]:before:text-fg [&_li[data-item-type=task][data-checked=true]]:before:content-['☑']",
].join(' ');

/** Largura, a partir da borda esquerda do item, que conta como clique na caixa da checklist: o recuo do item (`pl-7`, 28 px). */
const CHECKBOX_HIT_WIDTH = 28;

/** A sintaxe Markdown de uma imagem, só para exibir como texto. */
const imageSyntax = (attrs: Attrs) => `![${attrs.alt}](${attrs.src}${attrs.title ? ` "${attrs.title}"` : ''})`;

/**
 * O nó `image` do preset, trocado por um literal em texto: mesmo nome, atributos e Markdown de ida e volta (a imagem do texto gravado
 * volta como estava), mas o DOM é um `<span>` com a sintaxe, nunca um `<img>` (que pediria a URL escolhida pelo modelo). Os atributos
 * viajam em `data-*` para a cópia e a colagem dentro do editor reconstruírem o nó; `<img>` vindo de fora não é mais lido como imagem.
 */
const literalImage = imageSchema.extendSchema((previous) => (ctx) => ({
  ...previous(ctx),
  parseDOM: [
    {
      tag: 'span[data-type="image"]',
      getAttrs: (dom) => ({ src: dom.dataset.src ?? '', alt: dom.dataset.alt ?? '', title: dom.dataset.title ?? '' }),
    },
  ],
  toDOM: (node) => [
    'span',
    { ...ctx.get(imageAttr.key)(node), 'data-type': 'image', 'data-src': node.attrs.src, 'data-alt': node.attrs.alt, 'data-title': node.attrs.title },
    imageSyntax(node.attrs),
  ],
}));

/** Tudo que cria ou altera uma imagem de verdade: sai do preset junto com o nó original (o literal acima o substitui no mesmo lugar). */
const IMAGE_CREATION = new Set<unknown>([imageSchema, insertImageCommand, updateImageCommand].flat());

/** O preset CommonMark sem o que cria imagem, com o literal no lugar do nó `image` (a ordem dos nós do schema fica a mesma). */
const COMMONMARK_WITHOUT_IMAGES: MilkdownPlugin[] = commonmark.flatMap((plugin) => {
  if (plugin === imageSchema.ctx) return [literalImage.ctx];
  if (plugin === imageSchema.node) return [literalImage.node];
  return IMAGE_CREATION.has(plugin) ? [] : [plugin];
});

/** Alterna o item de checklist que contém a posição (o mais interno, em listas aninhadas); `null` fora de uma checklist. */
function toggleTaskAt(state: EditorState, pos: number): Transaction | null {
  const $pos = state.doc.resolve(pos);
  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    const item = $pos.node(depth);
    if (item.type.name === 'list_item' && item.attrs.checked != null) {
      return state.tr.setNodeMarkup($pos.before(depth), undefined, { ...item.attrs, checked: !item.attrs.checked });
    }
  }
  return null;
}

/**
 * A caixa da checklist: clique na caixa (o recuo do item, na primeira linha dele, para não alternar o item pai ao clicar ao lado de um
 * item aninhado) e Ctrl+Shift+Enter com o cursor no item. Cada alternância é uma transação comum, então conta como alteração do dono.
 */
const taskCheckbox = $prose(
  () =>
    new Plugin({
      props: {
        handleDOMEvents: {
          click: (view, event) => {
            const item = event.target;
            if (!(item instanceof HTMLElement) || !item.matches('li[data-item-type="task"]')) return false;
            if (event.clientX - item.getBoundingClientRect().left > CHECKBOX_HIT_WIDTH) return false;
            const firstLine = item.firstElementChild?.getBoundingClientRect();
            if (firstLine && event.clientY > firstLine.bottom) return false;
            const tr = toggleTaskAt(view.state, view.posAtDOM(item, 0));
            if (!tr) return false;
            view.dispatch(tr);
            return true;
          },
        },
        handleKeyDown: keydownHandler({
          'Mod-Shift-Enter': (state, dispatch) => {
            const tr = toggleTaskAt(state, state.selection.from);
            if (!tr) return false;
            dispatch?.(tr);
            return true;
          },
        }),
      },
    }),
);

/**
 * Rastreia a alteração do dono: o documento atual difere do documento de referência (o que o editor tinha ao ficar pronto, já com as
 * normalizações internas do ProseMirror)? Compara a estrutura, não o texto, então não serializa a cada tecla, e desfazer a alteração
 * volta a "sem alteração". Antes de `arm`, nada é notificado (a montagem não conta).
 */
function dirtyTracker(notify: (dirty: boolean) => void) {
  let baseline: ProseNode | null = null;
  let dirty = false;
  const plugin = $prose(
    () =>
      new Plugin({
        view: () => ({
          update: (view, previous) => {
            if (!baseline || view.state.doc === previous.doc) return;
            const next = !view.state.doc.eq(baseline);
            if (next === dirty) return;
            dirty = next;
            notify(next);
          },
        }),
      }),
  );
  return { plugin, arm: (doc: ProseNode) => (baseline = doc), isDirty: () => dirty };
}

export interface CreateDocEditorOptions {
  /** Contêiner onde o campo editável é montado. O chamador o possui: `destroy` não o remove. */
  host: HTMLElement;
  /** Texto Markdown gravado: o ponto de partida e o que `getMarkdown` devolve enquanto o dono não alterar nada. */
  markdown: string;
  /** Nome acessível do campo editável (`aria-label`). */
  label: string;
  /** Chamado quando "alterado" muda (só depois de o editor ficar pronto). */
  onDirtyChange?: (dirty: boolean) => void;
}

export interface DocEditorCore {
  /** O `EditorView` do ProseMirror, para os testes e integrações dirigirem o campo. */
  readonly view: EditorView;
  /** O Markdown a salvar: o texto recebido, byte a byte, sem alteração; com alteração, o documento inteiro serializado. */
  getMarkdown(): string;
  /** A serialização completa do documento atual, sempre. Só a prova da ida e volta e `getMarkdown` a usam; para salvar, use `getMarkdown`. */
  serialize(): string;
  /** O dono alterou o documento (e não desfez)? */
  isDirty(): boolean;
  /** Desmonta o campo e solta o ProseMirror. */
  destroy(): Promise<void>;
}

/**
 * Monta o editor sobre `host` e resolve quando ele está pronto. Rejeita se o Milkdown não conseguir montar; nesse caso não há o que
 * destruir (o Milkdown fica em "criando" para sempre e `destroy` esperaria sem fim), então o chamador só remove o contêiner.
 */
export async function createDocEditor({ host, markdown, label, onDirtyChange }: CreateDocEditorOptions): Promise<DocEditorCore> {
  const tracker = dirtyTracker((dirty) => onDirtyChange?.(dirty));
  const editor = Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, host);
      ctx.set(defaultValueCtx, markdown);
      // O `class` se soma ao `ProseMirror` do campo; o papel `textbox` o Milkdown já põe.
      ctx.update(editorViewOptionsCtx, (options) => ({
        ...options,
        attributes: { class: EDITOR_CLASS, 'aria-label': label, 'aria-multiline': 'true' },
      }));
      // Forma gravada (ver o comentário do arquivo): `-`, `---` e tabela compacta.
      ctx.update(remarkStringifyOptionsCtx, (options) => ({ ...options, bullet: '-' as const, rule: '-' as const }));
      ctx.set(remarkGFMPlugin.options.key, { tablePipeAlign: false });
      ctx.set(linkAttr.key, () => ({ target: '_blank', rel: 'noopener noreferrer nofollow' }));
      ctx.set(htmlAttr.key, () => ({ class: LITERAL_CLASS }));
      ctx.set(imageAttr.key, () => ({ class: LITERAL_CLASS }));
    })
    .use(COMMONMARK_WITHOUT_IMAGES)
    .use(gfm)
    .use(history)
    .use(clipboard)
    .use(taskCheckbox)
    .use(tracker.plugin);

  await editor.create();
  const view = editor.action((ctx) => ctx.get(editorViewCtx));
  // A linha de base é o documento já assentado: o que o editor normalizou ao montar não é alteração do dono.
  tracker.arm(view.state.doc);

  const serialize = () => editor.action(getMarkdown());
  return {
    view,
    getMarkdown: () => (tracker.isDirty() ? serialize() : markdown),
    serialize,
    isDirty: tracker.isDirty,
    destroy: async () => {
      await editor.destroy();
    },
  };
}

/** O que quem usa o componente alcança por `ref`. */
export interface DocEditorHandle {
  /** O Markdown a salvar (ver `DocEditorCore.getMarkdown`); antes de o editor ficar pronto, o texto recebido. */
  getMarkdown(): string;
  /** O dono alterou o documento (e não desfez)? */
  isDirty(): boolean;
}

export interface DocEditorProps {
  /** Texto Markdown gravado. Lido só na montagem: para carregar outro texto, remonte o componente com outra `key`. */
  markdown: string;
  /** Nome acessível do campo editável. Lido só na montagem. */
  label: string;
  /** Chamado quando "alterado" muda; montagem, normalização interna e remontagem não contam. */
  onDirtyChange?: (dirty: boolean) => void;
  /** O editor não montou: quem usa mostra o "Ver Markdown", que edita o texto cru. */
  onError?: (error: Error) => void;
  ref?: Ref<DocEditorHandle>;
}

/**
 * O campo editável do doc. Monta o editor no navegador (o servidor só renderiza o contêiner vazio) e o destrói ao desmontar; em
 * StrictMode a primeira montagem é descartada sem deixar campo duplicado. `data-ready="true"` marca o editor pronto (o E2E espera por ele).
 */
export function DocEditor({ markdown, label, onDirtyChange, onError, ref }: DocEditorProps) {
  const [mounted] = useState(() => ({ markdown, label }));
  const containerRef = useRef<HTMLDivElement>(null);
  const coreRef = useRef<DocEditorCore | null>(null);
  const [ready, setReady] = useState(false);
  const reportDirty = useEffectEvent((dirty: boolean) => onDirtyChange?.(dirty));
  const reportError = useEffectEvent((error: Error) => onError?.(error));

  useImperativeHandle(
    ref,
    () => ({
      getMarkdown: () => coreRef.current?.getMarkdown() ?? mounted.markdown,
      isDirty: () => coreRef.current?.isDirty() ?? false,
    }),
    [mounted],
  );

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;
    // Um contêiner por montagem: em StrictMode a primeira é desmontada enquanto ainda cria, e as duas não dividem o mesmo elemento.
    const host = document.createElement('div');
    container.append(host);
    let cancelled = false;
    let core: DocEditorCore | null = null;
    const dispose = (target: DocEditorCore) => {
      target
        .destroy()
        .catch((error: unknown) => console.error('Falha ao desmontar o editor do doc', error))
        .finally(() => host.remove());
    };

    createDocEditor({ host, markdown: mounted.markdown, label: mounted.label, onDirtyChange: (dirty) => reportDirty(dirty) }).then(
      (created) => {
        if (cancelled) {
          dispose(created);
          return;
        }
        core = created;
        coreRef.current = created;
        setReady(true);
      },
      (error: unknown) => {
        host.remove();
        if (!cancelled) reportError(error instanceof Error ? error : new Error(String(error)));
      },
    );

    return () => {
      cancelled = true;
      coreRef.current = null;
      if (core) dispose(core);
    };
  }, [mounted]);

  return <div ref={containerRef} data-ready={ready ? 'true' : 'false'} className="min-h-48" />;
}
