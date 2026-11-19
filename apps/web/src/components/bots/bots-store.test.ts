// Prova da releitura periódica do estado ao vivo da lista de bots (F10 passo 2, A12), com relógio simulado e `document` simulado (ambiente node, sem DOM):
// a cadência de 5 s (algum bot trabalhando, aguardando ou recém-concluído) e de 15 s, a parada com a aba oculta e a retomada, a falha de fundo que mantém o
// último estado, e um relógio só para vários assinantes (painel e cabeçalho da conversa não duplicam a atualização).
// Cada teste carrega o módulo do zero (`vi.resetModules`): o store é um singleton de módulo.
import type { BotSummary } from '@aion/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const apiFetch = vi.fn();
vi.mock('@/lib/api-client', () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));

type Store = typeof import('./bots-store');
let store: Store;
let visibility: 'visible' | 'hidden';
let visibilityHandlers: Set<() => void>;

beforeEach(async () => {
  vi.useFakeTimers();
  visibility = 'visible';
  visibilityHandlers = new Set();
  vi.stubGlobal('document', {
    get visibilityState() {
      return visibility;
    },
    addEventListener: (type: string, handler: () => void) => {
      if (type === 'visibilitychange') visibilityHandlers.add(handler);
    },
    removeEventListener: (type: string, handler: () => void) => {
      if (type === 'visibilitychange') visibilityHandlers.delete(handler);
    },
  });
  apiFetch.mockReset();
  vi.resetModules();
  store = await import('./bots-store');
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const bot = (id: string, runState: BotSummary['runState']): BotSummary => ({ id, name: `Bot ${id}`, color: '#60A5FA', archivedAt: null, runState, unread: false, preview: 'Nenhuma mensagem ainda' });

/** A API devolve esta lista até o teste trocá-la (`serve`). */
let served: BotSummary[] = [];
const serve = (bots: BotSummary[]): void => {
  served = bots;
  apiFetch.mockImplementation(async () => ({ bots: served }));
};

/** A aba vai para segundo plano ou volta, e os escutadores de `visibilitychange` são avisados (como o navegador faz). */
const setVisibility = (next: 'visible' | 'hidden'): void => {
  visibility = next;
  for (const handler of [...visibilityHandlers]) handler();
};

/** Quantas leituras de `/api/bots` aconteceram até agora (depois de deixar as promessas pendentes resolverem). */
const requests = async (): Promise<number> => {
  await vi.advanceTimersByTimeAsync(0);
  return apiFetch.mock.calls.length;
};

describe('cadência da releitura: 5 s com algum bot em movimento, 15 s sem', () => {
  it('sem nenhum bot em movimento relê a cada 15 s, e relê ao montar', async () => {
    serve([bot('a', 'idle'), bot('b', 'sleep'), bot('c', 'error')]);
    await store.refreshBots(); // a primeira carga (a de `useBots`)
    expect(await requests()).toBe(1);

    const stop = store.watchBots();
    expect(await requests(), 'relê ao montar').toBe(2);

    await vi.advanceTimersByTimeAsync(14_999);
    expect(await requests(), 'antes dos 15 s').toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(await requests(), 'aos 15 s').toBe(3);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await requests()).toBe(4);
    stop();
  });

  it.each(['working', 'waiting', 'done'] as const)('com um bot em "%s" relê a cada 5 s, e volta a 15 s quando ele sai desse estado', async (runState) => {
    serve([bot('a', 'idle'), bot('b', runState)]);
    await store.refreshBots();
    const stop = store.watchBots();
    expect(await requests()).toBe(2);

    await vi.advanceTimersByTimeAsync(4_999);
    expect(await requests(), 'antes dos 5 s').toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(await requests(), 'aos 5 s').toBe(3);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await requests(), 'e de novo aos 10 s').toBe(4);

    // O bot sai do estado: a leitura seguinte (aos 15 s) já enxerga isso, e a cadência volta a ser a longa.
    serve([bot('a', 'idle'), bot('b', 'idle')]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await requests()).toBe(5);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(await requests(), 'sem ninguém em movimento, 15 s').toBe(5);
    await vi.advanceTimersByTimeAsync(1);
    expect(await requests()).toBe(6);
    stop();
  });

  it('um bot que passa a trabalhar encurta a cadência na leitura seguinte, e uma releitura manual reinicia a contagem', async () => {
    serve([bot('a', 'idle')]);
    await store.refreshBots();
    const stop = store.watchBots();
    expect(await requests()).toBe(2);

    serve([bot('a', 'working')]);
    await vi.advanceTimersByTimeAsync(15_000); // lê e vê o bot trabalhando
    expect(await requests()).toBe(3);
    expect(store.getBotsState().bots[0]?.runState).toBe('working');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await requests()).toBe(4);

    // Depois de editar um bot, a tela pede a releitura na hora (`refreshBots`): ela vale como leitura do ciclo e a próxima conta a partir dela.
    await vi.advanceTimersByTimeAsync(3_000);
    await store.refreshBots();
    expect(await requests()).toBe(5);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(await requests()).toBe(5);
    await vi.advanceTimersByTimeAsync(1);
    expect(await requests()).toBe(6);
    stop();
  });
});

describe('aba oculta', () => {
  it('para de reler com a aba oculta e, ao voltar, relê na hora e retoma a cadência', async () => {
    serve([bot('a', 'working')]);
    await store.refreshBots();
    const stop = store.watchBots();
    expect(await requests()).toBe(2);

    setVisibility('hidden');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(await requests(), 'oculta por 2 minutos: nenhuma leitura').toBe(2);
    expect(vi.getTimerCount(), 'nenhum relógio pendente enquanto oculta').toBe(0);

    serve([bot('a', 'done')]);
    setVisibility('visible');
    expect(await requests(), 'ao voltar, relê na hora').toBe(3);
    expect(store.getBotsState().bots[0]?.runState).toBe('done');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await requests(), 'e a cadência (5 s, o bot acabou de concluir) segue').toBe(4);
    stop();
  });

  it('uma leitura que termina com a aba já oculta não programa a próxima', async () => {
    serve([bot('a', 'idle')]);
    await store.refreshBots();
    const stop = store.watchBots();
    await requests();
    await vi.advanceTimersByTimeAsync(15_000); // a leitura de fundo começa
    visibility = 'hidden';
    await store.refreshBots({ background: true });
    expect(vi.getTimerCount()).toBe(0);
    stop();
  });
});

describe('falha de fundo', () => {
  it('é silenciosa: mantém o último estado (mesma lista, status pronto) e a releitura continua; ao voltar a rede, atualiza', async () => {
    serve([bot('a', 'working')]);
    await store.refreshBots();
    const stop = store.watchBots();
    await requests();
    const before = store.getBotsState();
    expect(before.status).toBe('ready');

    apiFetch.mockRejectedValue(new Error('sem rede'));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(apiFetch.mock.calls.length, 'a leitura de fundo foi tentada').toBe(3);
    expect(store.getBotsState(), 'o último estado continua, o mesmo objeto').toBe(before);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(apiFetch.mock.calls.length, 'e tenta de novo no ciclo seguinte').toBe(4);
    expect(store.getBotsState()).toBe(before);

    serve([bot('a', 'done')]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(store.getBotsState().bots[0]?.runState).toBe('done');
    stop();
  });

  it('já a releitura pedida pela tela (foreground) que falha vira erro, com a lista anterior à vista (o aviso do painel só aparece sem lista)', async () => {
    serve([bot('a', 'idle')]);
    await store.refreshBots();
    apiFetch.mockRejectedValue(new Error('sem rede'));
    await store.refreshBots();
    expect(store.getBotsState()).toMatchObject({ status: 'error', bots: [{ id: 'a' }] });
  });

  it('com a primeira carga falha, o fundo recupera sem mostrar "carregando" de novo', async () => {
    apiFetch.mockRejectedValue(new Error('sem rede'));
    await store.refreshBots();
    expect(store.getBotsState().status).toBe('error');
    const stop = store.watchBots(); // relê ao montar, em segundo plano: continua "error" enquanto falha
    await requests();
    expect(store.getBotsState().status).toBe('error');
    serve([bot('a', 'idle')]);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(store.getBotsState()).toMatchObject({ status: 'ready', bots: [{ id: 'a' }] });
    stop();
  });
});

describe('um relógio só para vários assinantes', () => {
  it('o painel e o cabeçalho da conversa não duplicam as leituras; o relógio só para quando o último sai', async () => {
    serve([bot('a', 'working')]);
    await store.refreshBots();
    const desktopPanel = store.watchBots();
    expect(await requests(), 'o primeiro assinante relê ao montar').toBe(2);
    const conversationHeader = store.watchBots();
    expect(await requests(), 'o segundo só se soma: nenhuma leitura nova').toBe(2);
    expect(visibilityHandlers.size, 'um escutador de visibilidade só').toBe(1);
    expect(vi.getTimerCount(), 'um relógio só').toBe(1);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(await requests(), 'uma leitura por ciclo, não duas').toBe(3);

    conversationHeader(); // o cabeçalho sai: o painel do desktop segue assinando
    conversationHeader(); // sair duas vezes não tira o outro assinante
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await requests()).toBe(4);

    desktopPanel();
    expect(vi.getTimerCount(), 'sem assinantes não há relógio').toBe(0);
    expect(visibilityHandlers.size, 'nem escutador de visibilidade').toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await requests(), 'e nenhuma leitura').toBe(4);

    // Um assinante novo (o painel volta a montar) relê na hora e religa o relógio.
    const again = store.watchBots();
    expect(await requests()).toBe(5);
    expect(vi.getTimerCount()).toBe(1);
    again();
  });

  it('uma leitura que termina depois de o último assinante sair não programa a próxima (nenhum relógio sobra)', async () => {
    serve([bot('a', 'working')]);
    await store.refreshBots();
    let finish: (value: { bots: BotSummary[] }) => void = () => undefined;
    apiFetch.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    const stop = store.watchBots(); // relê ao montar: a leitura fica pendente
    expect(await requests()).toBe(2);
    stop();
    finish({ bots: served });
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await requests()).toBe(2);
  });

  it('a primeira carga em andamento não é duplicada pelo assinante, e a cadência só começa quando ela termina', async () => {
    let finish: (value: { bots: BotSummary[] }) => void = () => undefined;
    apiFetch.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    const first = store.refreshBots();
    const stop = store.watchBots();
    expect(await requests(), 'só a carga inicial').toBe(1);
    expect(vi.getTimerCount(), 'sem relógio enquanto carrega').toBe(0);

    serve([bot('a', 'idle')]);
    finish({ bots: served });
    await first;
    expect(vi.getTimerCount(), 'terminou a carga: o relógio é programado').toBe(1);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await requests()).toBe(2);
    stop();
  });

  it('uma leitura que não mudou nada não troca o estado (nenhuma tela acorda à toa), e uma que mudou troca', async () => {
    serve([bot('a', 'working')]);
    await store.refreshBots();
    const stop = store.watchBots();
    await requests();
    const before = store.getBotsState();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(await requests()).toBe(3);
    expect(store.getBotsState(), 'mesmos dados, mesmo objeto').toBe(before);

    serve([bot('a', 'done')]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(store.getBotsState()).not.toBe(before);
    expect(store.getBotsState().bots[0]?.runState).toBe('done');
    stop();
  });
});
