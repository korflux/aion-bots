// Contrato observável da linha da gestão: tamanho original, origem e proteção contra seleção em uso.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FileRow } from './file-row';
describe('linha de arquivos', () => {
  it('mostra documento original e origem, com seleção bloqueada e download privado', () => {
    const html = renderToStaticMarkup(<FileRow file={{ id: '2', kind: 'document', name: 'nota.pdf', originalBytes: 2048, storedBytes: 20, truncated: false, createdAt: '2026-10-06T12:00:00Z', removedAt: null, inUse: true, bot: null, sessionId: 'session', sessionTitle: 'Notas' }} selected={false} pending={false} now={Date.parse('2026-10-06T12:00:00Z')} onSelect={() => undefined} onDelete={() => undefined} />);
    expect(html).toContain('Documento · 2 KB'); expect(html).toContain('Chat geral · Notas'); expect(html).toContain('Em uso');
    expect(html).toContain('disabled'); expect(html).toContain('/api/attachments/2/content'); expect(html).toContain('Mais ações de nota.pdf');
  });
  it('reutiliza miniatura de 40 px e identifica bot arquivado', () => {
    const html = renderToStaticMarkup(<FileRow file={{ id: '3', kind: 'image', name: 'foto.jpg', originalBytes: 1000, storedBytes: 1000, truncated: false, createdAt: '2026-10-06T12:00:00Z', removedAt: null, inUse: false, bot: { id: 'bot', name: 'Alfa', color: '#60A5FA', archived: true }, sessionId: null, sessionTitle: null }} selected={true} pending={false} now={Date.parse('2026-10-06T12:00:00Z')} onSelect={() => undefined} onDelete={() => undefined} />);
    expect(html).toContain('Abrir imagem foto.jpg'); expect(html).toContain('size-10'); expect(html).toContain('Alfa (arquivado)'); expect(html).toContain('checked');
  });
  it('arquivo gerado pelo Python: origem "Gerado pelo Python", tipo pelo formato e o PNG com miniatura (phase 4)', () => {
    const row = (format: 'png' | 'csv', name: string) => renderToStaticMarkup(<FileRow file={{ id: '4', kind: 'generated', format, name, originalBytes: 2048, storedBytes: 2048, truncated: false, createdAt: '2026-10-06T12:00:00Z', removedAt: null, inUse: false, bot: null, sessionId: 'session', sessionTitle: 'Vendas' }} selected={false} pending={false} now={Date.parse('2026-10-06T12:00:00Z')} onSelect={() => undefined} onDelete={() => undefined} />);
    const chart = row('png', 'grafico.png');
    expect(chart).toContain('Gerado pelo Python · Chat geral · Vendas'); expect(chart).toContain('lucide-terminal'); expect(chart).toContain('Imagem · 2 KB'); expect(chart).toContain('Abrir imagem grafico.png');
    const csv = row('csv', 'dados.csv');
    expect(csv).toContain('Gerado pelo Python · Chat geral · Vendas'); expect(csv).toContain('Documento · 2 KB'); expect(csv).toContain('aria-label="Baixar dados.csv"');
  });
});
