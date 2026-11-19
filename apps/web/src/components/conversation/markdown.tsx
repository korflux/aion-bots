'use client';

// Renderização do Markdown das respostas do bot (design: texto `body`, código em `mono` sobre `--bg-surface`).
//
// O texto vem do modelo, então é NÃO CONFIÁVEL. O `react-markdown` monta elementos React (nunca injeta HTML em texto), e mesmo assim:
// - `skipHtml` descarta qualquer HTML cru que o texto traga;
// - imagens são removidas: o navegador buscaria uma URL escolhida pelo modelo (vazaria a leitura da conversa e a CSP as bloquearia);
// - links abrem em outra aba sem `opener` nem `referrer`, e o filtro padrão de URL barra `javascript:` e similares;
// - tabelas ganham um contêiner com rolagem horizontal própria, para nunca alargar a página; ele rola por dentro e por isso recebe foco
//   de teclado;
// - cada bloco cercado (```) vira o cartão `CodeBlock` (texto copiável ou código com Quebrar linhas e Copiar, phase 3 F8); o código
//   inline segue como `<code>` simples, sem cartão.
// ponytail: sem destaque de sintaxe nos blocos de código, acrescentar se o uso real pedir.
import type { Components, ExtraProps } from 'react-markdown';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { CodeBlock } from './code-block';

const REMARK_PLUGINS = [remarkGfm];

/** Nó HTML (hast) que o react-markdown entrega a cada componente, e um filho dele. */
type HastElement = NonNullable<ExtraProps['node']>;
type HastChild = HastElement['children'][number];

/** Texto puro de um nó: sem plugin de destaque, o `<code>` de um bloco só tem nós de texto, mas a leitura é recursiva por segurança. */
const textOf = (node: HastChild): string =>
  node.type === 'text' ? node.value : node.type === 'element' ? node.children.map(textOf).join('') : '';

/**
 * Linguagem e conteúdo exato de um bloco `<pre><code>`. O remark acrescenta UMA quebra no fim do conteúdo de toda cerca (e nenhuma no
 * bloco vazio); ela sai aqui, para a cópia levar exatamente o que estava entre as cercas (Suposição 27 da spec da phase 3). A linguagem vem
 * da classe `language-<id>` que o remark põe no `<code>`.
 */
export function fencedBlock(pre: HastElement | undefined): { language: string | null; content: string } {
  const code = pre?.children.find((child): child is HastElement => child.type === 'element' && child.tagName === 'code');
  if (!code) return { language: null, content: pre ? pre.children.map(textOf).join('') : '' };
  const classes = code.properties.className;
  const languageClass = (Array.isArray(classes) ? classes : []).map(String).find((name) => name.startsWith('language-'));
  const text = code.children.map(textOf).join('');
  return { language: languageClass ? languageClass.slice('language-'.length) : null, content: text.endsWith('\n') ? text.slice(0, -1) : text };
}

const COMPONENTS: Components = {
  // Um link cujo destino o filtro de URL barrou (ex.: javascript:) chega sem href: vira texto, nunca um link vazio.
  a: ({ href, children }) =>
    href ? (
      <a href={href} target="_blank" rel="noopener noreferrer nofollow">
        {children}
      </a>
    ) : (
      <span>{children}</span>
    ),
  img: () => null,
  // Todo bloco cercado (e o indentado, que o Markdown também trata como código) vira o cartão; o conteúdo vem do nó, não dos filhos já
  // renderizados, para a cópia ser o texto original.
  pre: ({ node }) => <CodeBlock {...fencedBlock(node)} />,
  // Tabelas que rolam na horizontal precisam ser alcançáveis pelo teclado (axe: scrollable-region-focusable, WCAG 2.1.1).
  table: ({ children }) => (
    <div className="markdown-table" tabIndex={0}>
      <table>{children}</table>
    </div>
  ),
};

/** O texto Markdown de uma resposta do bot, com as regras de segurança e os componentes acima. */
export function Markdown({ children }: { children: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} skipHtml components={COMPONENTS}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
