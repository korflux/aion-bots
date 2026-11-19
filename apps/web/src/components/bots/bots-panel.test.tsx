// Prova da lista de bots de uma linha (phase 18, A25): o HTML de `BotsPanel` no servidor, com o store trocado por bots fixos. Cada bot é UM link com a Faísca, o nome e a bolinha de não
// lido; o texto de estado só fica à vista com o bot aguardando ou com erro, e nos demais estados é só do leitor de tela (`sr-only`). O desenho em 1440 e 375 px e o ao vivo são do E2E
// (`e2e/bots.spec.ts`). Renderização no servidor, sem DOM.
import type { BotSummary } from '@aion/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { BotsPanel } from './bots-panel';

const state = vi.hoisted(() => ({ bots: [] as unknown[] }));
vi.mock('next/navigation', () => ({ usePathname: () => '/bots/zz' }));
vi.mock('./bots-store', async (importOriginal) => ({ ...(await importOriginal<typeof import('./bots-store')>()), useLiveBots: () => ({ status: 'ready', bots: state.bots }) }));

const bot = (id: string, name: string, runState: BotSummary['runState'], color: string): BotSummary => ({ id, name, color, runState, archivedAt: null, unread: false, preview: '' }) as unknown as BotSummary;

describe('lista de bots (A25)', () => {
  state.bots = [bot('1', 'Ocioso', 'idle', '#4ADE80'), bot('2', 'Trabalhador', 'working', '#60A5FA'), bot('3', 'Aguardador', 'waiting', '#FB923C'), bot('4', 'Falhou', 'error', '#F87171'), bot('5', 'Concluiu', 'done', '#FBBF24')];
  const html = renderToStaticMarkup(<BotsPanel />);
  const rows = [...html.matchAll(/<li><a [^>]*>(.*?)<\/a><\/li>/g)].map((match) => match[1] ?? '');

  it('uma linha por bot, cada uma com a Faísca na cor dele e o nome', () => {
    expect(rows).toHaveLength(5);
    for (const [index, color] of ['#4ADE80', '#60A5FA', '#FB923C', '#F87171', '#FBBF24'].entries()) {
      expect(rows[index]).toContain('class="faisca');
      expect(rows[index]).toContain(color);
    }
    expect(rows[0]).toContain('>Ocioso<');
  });

  it('o estado de atenção vai para uma segunda linha abaixo do nome, que fica inteiro; sem atenção a linha segue única', () => {
    // Nome e estado são irmãos numa coluna (`flex-col`): o estado não divide a linha com o nome, então não o trunca.
    const stacked = (row: string, name: string, text: string) => new RegExp(`flex-col"><span class="truncate[^"]*">${name}</span><span class="[^"]*text-xs/4[^"]*">${text}</span>`).test(row);
    expect(stacked(rows[2] ?? '', 'Aguardador', 'Aguardando aprovação')).toBe(true);
    expect(stacked(rows[3] ?? '', 'Falhou', 'Última execução falhou')).toBe(true);
    expect(rows[0]).not.toContain('text-xs/4');
  });

  it('o texto de estado fica à vista só quando o bot aguarda o dono ou está com erro; nos outros é só do leitor de tela', () => {
    const visibleState = (row: string, text: string) => new RegExp(`<span class="(?![^"]*sr-only)[^"]*">${text}</span>`).test(row);
    expect(visibleState(rows[2] ?? '', 'Aguardando aprovação')).toBe(true);
    expect(visibleState(rows[3] ?? '', 'Última execução falhou')).toBe(true);
    for (const [index, text] of [[0, 'Livre'], [1, 'Trabalhando…'], [4, 'Concluiu agora']] as const) {
      expect(visibleState(rows[index] ?? '', text), text).toBe(false);
      expect(new RegExp(`<span class="[^"]*sr-only[^"]*">${text}</span>`).test(rows[index] ?? ''), text).toBe(true);
    }
  });
});
