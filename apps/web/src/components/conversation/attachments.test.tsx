// Renderização observável dos anexos da conversa, inclusive estado removido antes da API de exclusão T10.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AttachmentList, GeneratedFiles, attachmentSize } from './attachment-list';
describe('anexos da bolha', () => {
  it('a quota conserva zero e gigabytes sem alterar o mínimo dos chips', () => {
    expect(attachmentSize(0, true)).toBe('0 KB'); expect(attachmentSize(1073741824, true)).toBe('1 GB'); expect(attachmentSize(0)).toBe('1 KB');
  });
  it('separa ações de imagem e texto, reserva a caixa e mantém removidos sem link', () => {
    const html = renderToStaticMarkup(<AttachmentList source={{ kind: 'session', id: 'sessao' }} files={[
      { id: '1', kind: 'image', name: 'foto.jpg', sizeBytes: 1024, removed: false },
      { id: '2', kind: 'document', name: 'relatório.pdf', sizeBytes: 2048, removed: false },
      { id: '3', kind: 'image', name: 'antiga.jpg', sizeBytes: 1024, removed: true },
    ]} />);
    expect(html).toContain('Abrir imagem foto.jpg');
    expect(html).toContain('size-[72px]');
    expect(html).toContain('Baixar texto de relatório.pdf');
    expect(html).toContain('/api/chat/sessions/sessao/attachments/2/content');
    expect(html).toContain('Arquivo removido: antiga.jpg');
    expect(html).not.toContain('/attachments/3/content');
  });
  it('planilha baixa o original com o rótulo "Planilha" e JSON segue como texto (phase 4, F9)', () => {
    const html = renderToStaticMarkup(<AttachmentList source={{ kind: 'bot', id: 'bot' }} files={[
      { id: '4', kind: 'spreadsheet', name: 'vendas.xlsx', sizeBytes: 4096, removed: false },
      { id: '5', kind: 'document', name: 'dados.json', sizeBytes: 100, removed: false },
    ]} />);
    expect(html).toContain('aria-label="Baixar vendas.xlsx"');
    expect(html).toContain('Planilha · 4 KB');
    expect(html).toContain('data-file-icon="spreadsheet"');
    expect(html).toContain('aria-label="Baixar texto de dados.json"');
    expect(html).toContain('JSON · 1 KB');
    expect(html).toContain('data-file-icon="json"');
  });
});

describe('arquivos gerados sob a resposta (phase 4, F10)', () => {
  it('PNG em prévia grande que abre o visualizador; os demais como chip de download do original; o removido sem link', () => {
    const html = renderToStaticMarkup(<GeneratedFiles source={{ kind: 'bot', id: 'bot' }} files={[
      { id: '7', kind: 'generated', format: 'png', name: 'grafico.png', sizeBytes: 3000, removed: false },
      { id: '8', kind: 'generated', format: 'csv', name: 'dados.csv', sizeBytes: 40, removed: false },
      { id: '9', kind: 'generated', format: 'json', name: 'antigo.json', sizeBytes: 40, removed: true },
    ]} />);
    expect(html).toContain('aria-label="Abrir imagem grafico.png"');
    expect(html).toContain('max-w-[480px]');
    expect(html).toContain('max-h-[360px]');
    expect(html).toContain('/api/bots/bot/attachments/7/content');
    expect(html).toContain('aria-label="Baixar dados.csv"');
    expect(html).toContain('CSV · 1 KB');
    expect(html).toContain('Arquivo removido: antigo.json');
    expect(html).not.toContain('/attachments/9/content');
    expect(renderToStaticMarkup(<GeneratedFiles source={{ kind: 'bot', id: 'bot' }} files={[]} />)).toBe('');
  });
});
