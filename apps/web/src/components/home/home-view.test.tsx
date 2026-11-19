// Prova da forma do Início (phase 18, A19 e A20): o HTML de `HomeView` no servidor, com os dados lidos trocados por valores fixos. A Faísca, a pergunta e o campo vêm primeiro e
// centrados; depois, só quando há pendência, a linha dela; depois "Seus bots". Sem "Chats recentes" nem atalho de Artefatos. A saudação por hora só aparece depois da hidratação (aqui
// vazia); o texto dela, o relógio e o envio que cria a sessão (A21) são do E2E (`e2e/home.spec.ts`). Renderização no servidor, sem DOM.
import type { BotSummary, PendingActivity } from '@aion/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HomeView } from './home-view';

const state = vi.hoisted(() => ({ bots: [] as unknown[], pending: [] as unknown[] }));

vi.mock('@/components/bots/bots-store', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/components/bots/bots-store')>()), useLiveBots: () => ({ status: 'ready', bots: state.bots }) }));
vi.mock('@/components/activities/use-pending-activities', () => ({ usePendingActivities: () => ({ load: { status: 'ready', pending: state.pending } }) }));
vi.mock('@/components/activities/activity-rows', () => ({ PendingRow: () => <li>pendência</li> }));
vi.mock('@/components/settings/settings-provider', () => ({ useAppSettings: () => ({ load: { status: 'ready', saved: { timeZone: 'America/Sao_Paulo', ownerName: '' } } }) }));
vi.mock('./home-composer', () => ({ HomeComposer: () => <div data-testid="campo" /> }));
vi.mock('@/components/brand/logo', () => ({ Logo: () => <span /> }));

const BOT = { id: '7c1b0b9e-3b7a-4a4e-9a55-0d8f0f5a1e01', name: 'Financeiro', color: '#FBBF24', archivedAt: null, runState: 'idle', preview: 'Nenhuma mensagem ainda', unread: false } as unknown as BotSummary;
const PENDING = { runId: '1' } as unknown as PendingActivity;

const html = (): string => renderToStaticMarkup(<HomeView />);

describe('Início (A19, A20)', () => {
  beforeEach(() => {
    state.bots = [BOT];
    state.pending = [PENDING];
  });

  it('a Faísca, a pergunta e o campo vêm antes da pendência e dos bots, que seguem nessa ordem', () => {
    const out = html();
    const positions = [out.indexOf('class="faisca'), out.indexOf('Como posso ajudar?'), out.indexOf('data-testid="campo"'), out.indexOf('Aguardando você'), out.indexOf('Seus bots')];
    expect(positions.every((position) => position > -1)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it('não mostra "Chats recentes" nem o atalho de Artefatos', () => {
    const out = html();
    expect(out).not.toContain('Chats recentes');
    expect(out).not.toContain('Artefatos');
    expect(out).not.toContain('Ver todos');
  });

  it('sem pendência aberta a linha de pendência não existe, e os bots seguem (A20)', () => {
    state.pending = [];
    const out = html();
    expect(out).not.toContain('Aguardando você');
    expect(out).toContain('Seus bots');
  });

  it('sem bots, o convite do primeiro bot fica acima do campo', () => {
    state.bots = [];
    const out = html();
    expect(out.indexOf('Seus bots começam aqui')).toBeLessThan(out.indexOf('data-testid="campo"'));
    expect(out).not.toContain('Aguardando você');
  });
});
