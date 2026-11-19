// Prova da linha fixa da Faísca acima do composer (phase 18, ID-04; A6, A7, A9): o HTML que `WorkingLine` renderiza no servidor, para o bot (Faísca na cor dele) e para o Chat geral
// (em `--faisca`). A Faísca de 24 px trabalhando, ou aguardando com aprovação pendente, e a frase numa região `polite`. A busca do título do doc é um efeito (só roda montada), então
// aqui entra a frase sem título; a troca de frases, o título e o movimento no navegador real são do E2E. Renderização no servidor, sem DOM.
import type { ActivityView, Bot } from '@aion/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { WorkingLine } from './working-line';

const NOW = '2026-11-14T12:00:00.000Z';
const BOT: Bot = { id: '7c1b0b9e-3b7a-4a4e-9a55-0d8f0f5a1e01', name: 'Financeiro', color: '#FBBF24', archivedAt: null, instructions: '', model: null, effort: null, stepLimit: 50, contextWindowTokens: null, createdAt: NOW, updatedAt: NOW };
const running = (tool: string, awaitingApproval = false): ActivityView => ({ id: '9', runId: '1', createdAt: NOW, kind: 'activity', status: 'running', step: 1, tool, label: tool, arguments: '{}', result: null, detail: null, awaitingApproval });

/** O que o HTML guarda da Faísca da linha (atributos do `<svg class="faisca">`). */
function faiscas(html: string) {
  return [...html.matchAll(/<svg[^>]*class="faisca[^"]*"[^>]*>/g)].map((match) => ({
    body: /--faisca-body:([^;"]+)/.exec(match[0])?.[1],
    state: /data-state="(\w+)"/.exec(match[0])?.[1],
    size: Number(/width="(\d+)"/.exec(match[0])?.[1]),
    still: match[0].includes('data-still'),
    decorative: match[0].includes('aria-hidden="true"'),
  }));
}

describe('linha da Faísca', () => {
  it.each([
    ['o bot', BOT, '#FBBF24'],
    ['o Chat geral', null, 'var(--faisca)'],
  ] as const)('%s: a Faísca de 24 px trabalhando e a frase "Trabalhando…" numa região educada, sem spinner', (_name, bot, body) => {
    const html = renderToStaticMarkup(<WorkingLine bot={bot} activities={[running('table_write')]} runStatus="running" />);
    expect(faiscas(html)).toEqual([{ body, state: 'working', size: 24, still: false, decorative: true }]);
    expect(html).toContain('data-working-line');
    expect(html).toMatch(/<p role="status" aria-live="polite"[^>]*>Trabalhando…<\/p>/);
    expect(html).not.toContain('animate-spin');
  });

  it('aprovação pendente: a Faísca aguarda e a frase diz isso, venha a marca da execução ou da atividade', () => {
    for (const html of [
      renderToStaticMarkup(<WorkingLine bot={BOT} activities={[]} runStatus="waiting_approval" />),
      renderToStaticMarkup(<WorkingLine bot={BOT} activities={[running('GMAIL_SEND_EMAIL', true)]} runStatus="running" />),
    ]) {
      expect(faiscas(html).map((faisca) => faisca.state)).toEqual(['waiting']);
      expect(html).toContain('Aguardando sua aprovação');
    }
  });

  it('busca de e-mails no Gmail muda a frase; a Faísca segue trabalhando', () => {
    const html = renderToStaticMarkup(<WorkingLine bot={BOT} activities={[running('GMAIL_FETCH_EMAILS')]} runStatus="running" />);
    expect(html).toContain('Procurando e-mails no Gmail…');
    expect(faiscas(html).map((faisca) => faisca.state)).toEqual(['working']);
  });
});
