// Prova das regras de tela do doc (phase 14, passo 5; A8, A11, A17, A20) sem navegador: o que `doc-view.tsx` decide e o que o servidor recusaria.
// Os casos saem dos critérios, não do código:
// - A8: título de 0, 1, 120 e 121 caracteres (emoji conta 1) e texto de 100.000 e 100.001; a mensagem sai antes de qualquer envio.
// - A17: abrir, alternar "Ver Markdown" e voltar SEM digitar não é alteração; só mudança do dono (título, texto cru, editor) é; e sem alteração não há corpo a enviar.
// - A11: `DOC_CONFLICT` vira conflito (o texto digitado segue na tela), `DOC_NOT_FOUND` vira "o doc sumiu", o resto vira a mensagem segura da API.
// - A20: o arquivo baixado leva o texto gravado, byte a byte, e um nome seguro para qualquer sistema de arquivos.
// - Idempotência (CLAUDE.md, item 25): a mesma intenção reaproveita a `operationId`, outra intenção ganha uma nova.
import { DOC_LIMITS } from '@aion/shared';
import { describe, expect, it } from 'vitest';
import { ApiError } from '@/lib/api-client';
import {
  IntentLedger,
  authorLabel,
  buildUpdate,
  contentProblem,
  currentText,
  draftProblem,
  failureOf,
  fileNameFor,
  hasChanges,
  markdownFile,
  markEditorDirty,
  renameDraft,
  showMarkdown,
  showVisual,
  sizeLabel,
  startEditing,
  titleProblem,
  typeMarkdown,
  fallBackToMarkdown,
} from './doc-state';

const SAVED = { title: 'Plano', content: '# Plano\n\n* item um\n* item dois\n\n***\n' };

describe('A8: título e texto antes de enviar', () => {
  it.each([
    ['vazio', '', 'Dê um título ao doc.'],
    ['só espaços', '   ', 'Dê um título ao doc.'],
    ['121 caracteres', 'a'.repeat(121), 'O título passou de 120 caracteres.'],
  ])('recusa o título %s com a mensagem', (_name, title, message) => {
    expect(titleProblem(title)).toBe(message);
  });

  it('aceita 1 e 120 caracteres, e o emoji vale 1 (como o banco conta)', () => {
    expect(titleProblem('a')).toBeNull();
    expect(titleProblem('a'.repeat(120))).toBeNull();
    expect(titleProblem('😀'.repeat(120))).toBeNull();
    expect(titleProblem('😀'.repeat(121))).not.toBeNull();
  });

  it('o espaço nas pontas não conta para o limite (o servidor apara)', () => {
    expect(titleProblem(` ${'a'.repeat(120)} `)).toBeNull();
  });

  it('recusa título com quebra de linha ou caractere de controle', () => {
    expect(titleProblem('Plano\nsemanal')).toBe('O título tem caracteres que não são aceitos.');
    expect(titleProblem('Plano\u0007')).toBe('O título tem caracteres que não são aceitos.');
  });

  it('o texto aceita 100.000 caracteres e recusa 100.001, contando emoji como 1 e dizendo o tamanho', () => {
    expect(contentProblem('a'.repeat(DOC_LIMITS.contentChars))).toBeNull();
    expect(contentProblem('😀'.repeat(DOC_LIMITS.contentChars))).toBeNull();
    expect(contentProblem('a'.repeat(DOC_LIMITS.contentChars + 1))).toBe('O texto passou de 100.000 caracteres (100.001). Reduza o texto para salvar.');
    expect(contentProblem('😀'.repeat(DOC_LIMITS.contentChars + 1))).not.toBeNull();
  });

  it('o texto vazio é válido e o caractere de controle (fora tab e quebras) é recusado', () => {
    expect(contentProblem('')).toBeNull();
    expect(contentProblem('linha\tcom tab\r\nfim')).toBeNull();
    expect(contentProblem('ruim\u0007')).toBe('O texto tem caracteres que não são aceitos.');
  });

  it('draftProblem aponta o campo: o título primeiro, depois o texto, e nada quando os dois servem', () => {
    expect(draftProblem('', 'x')).toEqual({ field: 'title', message: 'Dê um título ao doc.' });
    expect(draftProblem('Plano', 'a'.repeat(DOC_LIMITS.contentChars + 1))?.field).toBe('content');
    expect(draftProblem('', 'a'.repeat(DOC_LIMITS.contentChars + 1))?.field).toBe('title');
    expect(draftProblem('Plano', 'ok')).toBeNull();
  });
});

describe('A17: o que conta como alteração do dono', () => {
  it('abrir o editor não é alteração, e alternar "Ver Markdown" e voltar sem digitar também não', () => {
    let session = startEditing(SAVED);
    expect(hasChanges(SAVED, session)).toBe(false);
    // Editor visual sem edição: o texto atual é o gravado, byte a byte (o editor não serializa sem alteração).
    session = showMarkdown(session, currentText(session, () => SAVED.content));
    expect(session.mode).toBe('markdown');
    expect(hasChanges(SAVED, session)).toBe(false);
    session = showVisual(session);
    expect(session.mode).toBe('visual');
    expect(hasChanges(SAVED, session)).toBe(false);
    expect(session.text).toBe(SAVED.content);
  });

  it('a alternância remonta o campo visual (outra chave) e zera o aviso de edição do editor anterior', () => {
    const first = startEditing(SAVED);
    const dirty = markEditorDirty(first, true);
    expect(dirty.editorDirty).toBe(true);
    const markdown = showMarkdown(dirty, '# Editado\n');
    expect(markdown.editorDirty).toBe(false);
    const back = showVisual(markdown);
    expect(back.fieldKey).toBeGreaterThan(first.fieldKey);
    expect(back.editorDirty).toBe(false);
    // O texto cru que o dono escolheu difere do gravado: continua alteração depois de voltar ao visual.
    expect(hasChanges(SAVED, back)).toBe(true);
  });

  it('editar no visual, no texto cru ou no título é alteração; desfazer no editor volta a "sem alteração"', () => {
    const open = startEditing(SAVED);
    expect(hasChanges(SAVED, markEditorDirty(open, true))).toBe(true);
    expect(hasChanges(SAVED, markEditorDirty(markEditorDirty(open, true), false))).toBe(false);
    expect(hasChanges(SAVED, typeMarkdown(showMarkdown(open, SAVED.content), `${SAVED.content}mais\n`))).toBe(true);
    expect(hasChanges(SAVED, typeMarkdown(typeMarkdown(showMarkdown(open, SAVED.content), 'x'), SAVED.content))).toBe(false);
    expect(hasChanges(SAVED, renameDraft(open, 'Plano 2'))).toBe(true);
    // O espaço nas pontas do título não é mudança: o servidor o apara.
    expect(hasChanges(SAVED, renameDraft(open, '  Plano  '))).toBe(false);
  });

  it('o texto atual vem do editor no modo visual e do campo cru no modo markdown', () => {
    const visual = startEditing(SAVED);
    expect(currentText(visual, () => 'do editor')).toBe('do editor');
    const markdown = typeMarkdown(showMarkdown(visual, SAVED.content), 'do campo cru');
    expect(currentText(markdown, () => 'não deve ser lido')).toBe('do campo cru');
  });

  it('o editor que não monta cai no texto cru com o texto de partida, sem perder nada', () => {
    const session = fallBackToMarkdown(startEditing(SAVED));
    expect(session).toMatchObject({ mode: 'markdown', text: SAVED.content, editorDirty: false });
    expect(hasChanges(SAVED, session)).toBe(false);
  });
});

describe('A17: o corpo da gravação', () => {
  it('sem alteração não há corpo, então Salvar não chama a API e nenhuma versão nova nasce', () => {
    expect(buildUpdate({ ...SAVED, version: 3 }, { title: SAVED.title, content: SAVED.content })).toBeNull();
    expect(buildUpdate({ ...SAVED, version: 3 }, { title: ` ${SAVED.title} `, content: SAVED.content })).toBeNull();
  });

  it('só o texto: reescreve o texto inteiro sobre a versão que a tela leu, sem título', () => {
    expect(buildUpdate({ ...SAVED, version: 3 }, { title: SAVED.title, content: 'novo\n' })).toEqual({
      expectedVersion: 3,
      edit: { operation: 'rewrite', content: 'novo\n' },
    });
  });

  it('só o título: renomeia sem edição de texto (o título não cria versão)', () => {
    expect(buildUpdate({ ...SAVED, version: 3 }, { title: '  Plano novo ', content: SAVED.content })).toEqual({ expectedVersion: 3, title: 'Plano novo' });
  });

  it('título e texto juntos vão no mesmo corpo, e o texto cru nunca é normalizado', () => {
    const content = '* asterisco  \n\n\n***\n';
    expect(buildUpdate({ ...SAVED, version: 7 }, { title: 'Outro', content })).toEqual({ expectedVersion: 7, title: 'Outro', edit: { operation: 'rewrite', content } });
  });

  it('o texto vazio é uma edição válida (esvaziar o doc)', () => {
    expect(buildUpdate({ ...SAVED, version: 1 }, { title: SAVED.title, content: '' })).toEqual({ expectedVersion: 1, edit: { operation: 'rewrite', content: '' } });
  });
});

describe('A11: o que a tela faz com cada falha da gravação', () => {
  it('DOC_CONFLICT é conflito de versão, DOC_NOT_FOUND é doc que sumiu, e os demais viram a mensagem segura da API', () => {
    expect(failureOf(new ApiError(409, 'DOC_CONFLICT', 'O doc mudou. Recarregue antes de salvar.'))).toEqual({ kind: 'conflict' });
    expect(failureOf(new ApiError(404, 'DOC_NOT_FOUND', 'Doc não encontrado.'))).toEqual({ kind: 'gone' });
    expect(failureOf(new ApiError(422, 'DOC_TOO_LARGE', 'O doc passou de 100.000 caracteres.'))).toEqual({ kind: 'message', message: 'O doc passou de 100.000 caracteres.' });
    expect(failureOf(new ApiError(0, 'NETWORK_ERROR', 'Sem conexão com o servidor. Tente novamente.'))).toEqual({
      kind: 'message',
      message: 'Sem conexão com o servidor. Tente novamente.',
    });
    expect(failureOf(new Error('stack interno'))).toEqual({ kind: 'message', message: 'Não foi possível concluir.' });
  });
});

describe('A20: o arquivo baixado', () => {
  it('leva o texto gravado idêntico, byte a byte (marcador, linha em branco, emoji, fim de linha e espaços)', async () => {
    const content = '# Título\r\n\r\n* item  \n\n\n😀 café\t fim\n';
    const file = markdownFile({ title: 'Plano', content });
    expect(await file.text()).toBe(content);
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(new TextEncoder().encode(content));
    expect(file.type).toBe('text/markdown;charset=utf-8');
    expect(file.name).toBe('Plano.md');
  });

  it('o doc de 100.000 caracteres baixa inteiro', async () => {
    const content = 'ç'.repeat(DOC_LIMITS.contentChars);
    expect(await markdownFile({ title: 'Grande', content }).text()).toBe(content);
  });

  it.each([
    ['Plano de ação 2026', 'Plano de ação 2026.md'],
    ['a/b\\c:d*e?f"g<h>i|j', 'a b c d e f g h i j.md'],
    ['  muitos   espaços  ', 'muitos espaços.md'],
    ['termina com ponto...', 'termina com ponto.md'],
    ['\u0007\u0001', 'doc.md'],
    ['', 'doc.md'],
  ])('o nome de arquivo de "%s" é "%s"', (title, name) => {
    expect(fileNameFor(title)).toBe(name);
  });

  it('o nome de arquivo tem no máximo 80 caracteres do título e nunca corta um emoji ao meio', () => {
    const name = fileNameFor('😀'.repeat(200));
    expect(Array.from(name.replace(/\.md$/, ''))).toHaveLength(80);
    expect(name).toBe(`${'😀'.repeat(80)}.md`);
  });
});

describe('operationId: uma por intenção, a mesma nas repetições', () => {
  it('a mesma intenção reaproveita o id (repetição após falha de rede) e outra intenção ganha id novo', () => {
    const ledger = new IntentLedger();
    const first = ledger.stamp({ expectedVersion: 3, edit: { operation: 'rewrite' as const, content: 'x' } });
    const retry = ledger.stamp({ expectedVersion: 3, edit: { operation: 'rewrite' as const, content: 'x' } });
    expect(first.operationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(retry.operationId).toBe(first.operationId);
    const other = ledger.stamp({ expectedVersion: 3, edit: { operation: 'rewrite' as const, content: 'y' } });
    expect(other.operationId).not.toBe(first.operationId);
  });

  it('depois do sucesso a mesma intenção ganha id novo, e o corpo original segue intacto', () => {
    const ledger = new IntentLedger();
    const body = { version: 2, expectedVersion: 4 };
    const stamped = ledger.stamp(body);
    expect(body).toEqual({ version: 2, expectedVersion: 4 });
    ledger.clear();
    expect(ledger.stamp(body).operationId).not.toBe(stamped.operationId);
  });

  it('a exclusão (corpo só com a operação) reaproveita o id até o sucesso', () => {
    const ledger = new IntentLedger();
    expect(ledger.stamp({}).operationId).toBe(ledger.stamp({}).operationId);
  });
});

describe('rótulos', () => {
  it('autor da versão e tamanho', () => {
    expect(authorLabel('owner')).toBe('Você');
    expect(authorLabel('bot')).toBe('Bot');
    expect(sizeLabel(0)).toBe('0 caracteres');
    expect(sizeLabel(1)).toBe('1 caractere');
    expect(sizeLabel(1234)).toBe('1.234 caracteres');
  });
});
