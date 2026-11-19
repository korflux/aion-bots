// Regras de tela do doc que não dependem de React (phase 14, passo 5; A8, A11, A17, A20): o que `doc-view.tsx`, `doc-history.tsx`, `doc-sharing.tsx` e `new-doc.tsx` decidem
// antes de falar com a API e depois de ela responder. Funções PURAS, provadas em `doc-state.test.ts` sem navegador (como `home-state.ts`); o que precisa de DOM e de rede é
// provado em `doc-view.test.tsx`.
//
// SEÇÕES
//   1. Limites (A8): `titleProblem`, `contentProblem` e `draftProblem` dão a mensagem que o dono lê ANTES de qualquer envio; o servidor recusa pelos mesmos limites
//      (`VALIDATION_FAILED`, `DOC_TOO_LARGE`) e a tela mostra a mensagem dele quando a corrida passa por aqui.
//   2. Sessão de edição (A17): `EditSession` e as transições entre o editor visual e o "Ver Markdown". Decide o que é ALTERAÇÃO do dono e qual texto salvar.
//   3. Corpo da gravação e falhas (A17, A11): `buildUpdate` (sem alteração não há corpo) e `failureOf`.
//   4. Arquivo para baixar (A20): `markdownFile`.
//   5. Idempotência: `IntentLedger`, a `operationId` de cada intenção.
//   6. Rótulos.
//
// DECISÃO CENTRAL (A17): o Markdown gravado só muda quando o dono altera algo. O editor visual normaliza o que não foi tocado se serializar (marcador `*` vira `-`, tabela
// perde o preenchimento), então `DocEditor.getMarkdown()` devolve o texto recebido enquanto não há alteração, e esta sessão garante que a ida e volta pelo "Ver Markdown"
// (visual -> texto cru -> visual) preserve esse texto: o campo visual é remontado com o texto cru, sem passar pelo serializador.
import { DOC_LIMITS, countChars, docContentSchema, docTitleSchema, type Doc, type DocAuthor, type DocUpdateInput } from '@aion/shared';
import { ApiError, apiErrorMessage } from '@/lib/api-client';

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
// 1. Limites (A8)
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------

/** O título como o servidor o grava: aparado e em NFC (`docTitleSchema`). */
export const normalizeTitle = (title: string): string => title.trim().normalize('NFC');

/** Mensagem do título que o servidor recusaria (vazio, acima de 120 caracteres, quebra de linha ou controle), ou `null` quando serve. O emoji conta 1, como no banco. */
export function titleProblem(title: string): string | null {
  const size = countChars(normalizeTitle(title));
  if (size === 0) return 'Dê um título ao doc.';
  if (size > DOC_LIMITS.titleChars) return `O título passou de ${DOC_LIMITS.titleChars} caracteres.`;
  return docTitleSchema.safeParse(title).success ? null : 'O título tem caracteres que não são aceitos.';
}

/** Mensagem do texto que o servidor recusaria (acima de 100.000 caracteres ou com caractere de controle), ou `null`. O texto vazio é válido. */
export function contentProblem(content: string): string | null {
  const size = countChars(content);
  if (size > DOC_LIMITS.contentChars) {
    return `O texto passou de ${DOC_LIMITS.contentChars.toLocaleString('pt-BR')} caracteres (${size.toLocaleString('pt-BR')}). Reduza o texto para salvar.`;
  }
  return docContentSchema.safeParse(content).success ? null : 'O texto tem caracteres que não são aceitos.';
}

export interface DraftProblem {
  /** Qual campo a tela marca como inválido. */
  field: 'title' | 'content';
  message: string;
}

/** O primeiro problema do rascunho (título, depois texto), ou `null` quando os dois servem. */
export function draftProblem(title: string, content: string): DraftProblem | null {
  const titleMessage = titleProblem(title);
  if (titleMessage) return { field: 'title', message: titleMessage };
  const contentMessage = contentProblem(content);
  return contentMessage ? { field: 'content', message: contentMessage } : null;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------
// 2. Sessão de edição (A17)
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------

/** Como o dono edita: no texto formatado (editor visual) ou no Markdown cru ("Ver Markdown"). */
export type EditMode = 'visual' | 'markdown';

/** O que a tela sabe de uma edição em andamento. O texto digitado mora no campo (editor ou textarea); aqui fica só o que decide alteração e remontagem. */
export interface EditSession {
  mode: EditMode;
  /** O título como o dono o digitou (ainda sem aparar). */
  title: string;
  /** No modo visual, o texto com que o editor foi montado (ele só o lê na montagem); no modo markdown, o texto atual do campo cru. */
  text: string;
  /** Muda a cada remontagem do editor visual: é a `key` do componente (o editor lê o texto só ao montar). */
  fieldKey: number;
  /** O editor visual avisou que o dono alterou o documento (e não desfez). Sempre falso no modo markdown. */
  editorDirty: boolean;
}

/** Começa a editar o doc gravado: editor visual, sem alteração. */
export const startEditing = (saved: Pick<Doc, 'title' | 'content'>): EditSession => ({ mode: 'visual', title: saved.title, text: saved.content, fieldKey: 0, editorDirty: false });

export const renameDraft = (session: EditSession, title: string): EditSession => ({ ...session, title });

/** O dono digitou no texto cru. */
export const typeMarkdown = (session: EditSession, text: string): EditSession => ({ ...session, text });

/** O editor visual avisa que o documento passou a diferir (ou voltou a igualar) o que ele tinha ao ficar pronto. */
export const markEditorDirty = (session: EditSession, dirty: boolean): EditSession => (session.editorDirty === dirty ? session : { ...session, editorDirty: dirty });

/**
 * "Ver Markdown": o texto cru passa a ser o que o editor devolve agora (`current`, ver `currentText`): o gravado byte a byte quando o dono não alterou nada, o
 * documento serializado quando alterou. Alternar sem digitar não cria alteração.
 */
export const showMarkdown = (session: EditSession, current: string): EditSession => ({ ...session, mode: 'markdown', text: current, editorDirty: false });

/** Volta ao editor visual com o texto cru atual: o campo é remontado (outra chave) e o texto NÃO passa pelo serializador. */
export const showVisual = (session: EditSession): EditSession => ({ ...session, mode: 'visual', fieldKey: session.fieldKey + 1, editorDirty: false });

/** O editor visual não montou: o dono continua no texto cru, com o texto de partida intacto (o campo visual nunca chegou a ser editado). */
export const fallBackToMarkdown = (session: EditSession): EditSession => ({ ...session, mode: 'markdown', editorDirty: false });

/** O texto que Salvar enviaria agora: o do editor visual (`editorText`, que devolve o gravado sem alteração) ou o do campo cru. */
export const currentText = (session: EditSession, editorText: () => string): string => (session.mode === 'visual' ? editorText() : session.text);

/**
 * O dono alterou algo em relação ao doc gravado? Título diferente (depois de aparado), texto cru diferente, ou o editor visual avisando alteração. No modo visual com
 * o editor sem alteração, o texto de partida ainda conta: ele pode ter vindo do texto cru que o dono editou antes de voltar ao visual.
 */
export function hasChanges(saved: Pick<Doc, 'title' | 'content'>, session: EditSession): boolean {
  if (normalizeTitle(session.title) !== saved.title) return true;
  if (session.text !== saved.content) return true;
  return session.mode === 'visual' && session.editorDirty;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------
// 3. Corpo da gravação e falhas (A17, A11)
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------

/**
 * O corpo do PATCH (sem `operationId`) para gravar o rascunho sobre o doc que a tela leu, ou `null` quando nada mudou: sem alteração Salvar não chama a API e nenhuma
 * versão nasce (A17). Só o que mudou vai: o título (que não cria versão) e/ou o texto inteiro por `rewrite` (que cria uma versão). A versão esperada é a que a tela
 * leu; se o bot gravou nesse meio tempo, o servidor responde `DOC_CONFLICT` e nada é gravado (A11).
 */
export function buildUpdate(saved: Pick<Doc, 'title' | 'content' | 'version'>, draft: { title: string; content: string }): Omit<DocUpdateInput, 'operationId'> | null {
  const title = normalizeTitle(draft.title);
  const titleChanged = title !== saved.title;
  const contentChanged = draft.content !== saved.content;
  if (!titleChanged && !contentChanged) return null;
  return {
    expectedVersion: saved.version,
    ...(titleChanged ? { title } : {}),
    ...(contentChanged ? { edit: { operation: 'rewrite' as const, content: draft.content } } : {}),
  };
}

/** O que a tela faz com uma gravação que falhou: conflito de versão, doc que sumiu, ou só mostrar a mensagem segura da API. O texto do dono fica na tela nos três casos. */
export type SaveFailure = { kind: 'conflict' } | { kind: 'gone' } | { kind: 'message'; message: string };

export function failureOf(error: unknown): SaveFailure {
  if (error instanceof ApiError && error.code === 'DOC_CONFLICT') return { kind: 'conflict' };
  if (error instanceof ApiError && error.code === 'DOC_NOT_FOUND') return { kind: 'gone' };
  return { kind: 'message', message: apiErrorMessage(error) };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------
// 4. Arquivo para baixar (A20)
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------

/** Quantos caracteres do título entram no nome do arquivo. */
const FILE_NAME_CHARS = 80;

/** Nome do arquivo a partir do título: sem os caracteres que os sistemas de arquivos recusam, espaços colapsados, sem ponto final e `doc.md` quando nada sobra. */
export function fileNameFor(title: string): string {
  const base = title
    // Os caracteres que Windows e os demais sistemas recusam em nome de arquivo, mais os controles ASCII.
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
  return `${Array.from(base).slice(0, FILE_NAME_CHARS).join('').trim() || 'doc'}.md`;
}

/** O arquivo "Baixar .md": o texto GRAVADO, sem normalizar uma letra (o `Blob` não converte fim de linha nem acrescenta marca de ordem de bytes). */
export const markdownFile = (doc: Pick<Doc, 'title' | 'content'>): File => new File([doc.content], fileNameFor(doc.title), { type: 'text/markdown;charset=utf-8' });

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------
// 5. Idempotência
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------

/**
 * A `operationId` da intenção em andamento (CLAUDE.md, item 25; o servidor guarda um recibo por (dono, operação)). A MESMA intenção, ou seja, o mesmo corpo, reaproveita
 * o id: se a rede caiu depois de o servidor gravar, repetir devolve o resultado gravado em vez de gravar de novo. Outro corpo é outra intenção e ganha id novo (o servidor
 * recusa a mesma operação com outro conteúdo). Depois do sucesso, `clear` descarta o id. Um ledger por tela e por tipo de escrita (gravar, restaurar, compartilhar,
 * excluir, criar).
 */
export class IntentLedger {
  private last: { signature: string; id: string } | null = null;

  /** O corpo com a `operationId` da intenção. O corpo recebido não é alterado. */
  stamp<T extends object>(body: T): T & { operationId: string } {
    const signature = JSON.stringify(body);
    if (this.last?.signature !== signature) this.last = { signature, id: crypto.randomUUID() };
    return { ...body, operationId: this.last.id };
  }

  /** A intenção terminou (sucesso): a próxima, ainda que igual, é outra. */
  clear(): void {
    this.last = null;
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------
// 6. Rótulos
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------

/** Quem gravou a versão: o dono ("Você") ou um bot. A versão não registra qual bot, só que foi um. */
export const authorLabel = (author: DocAuthor): string => (author === 'owner' ? 'Você' : 'Bot');

/** "1.234 caracteres". */
export const sizeLabel = (size: number): string => `${size.toLocaleString('pt-BR')} ${size === 1 ? 'caractere' : 'caracteres'}`;
