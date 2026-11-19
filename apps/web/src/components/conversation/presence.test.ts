// Prova da regra de presença no cliente (phase 3, T2; A2) com relógio falso: informa ao ficar visível e em foco, renova a cada 20 s levando a
// leitura mais recente, encerra uma vez ao perder visibilidade ou foco, ao fechar ou ao trocar de conversa, e para de vez depois de NOT_FOUND.
// Também a leitura informada, que para antes do texto ainda em escrita.
import type { MessageView, TextMessageView } from '@aion/shared';
import { PRESENCE_RENEW_MS } from '@aion/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPresenceReporter, readThroughOf, type PresenceOutcome } from './presence';

const AT = '2026-10-08T12:00:00.000Z';
const text = (id: string, status: TextMessageView['status'] = 'done'): TextMessageView => ({
  id, runId: '1', createdAt: AT, kind: 'text', role: 'assistant', status, content: 'oi',
});

describe('informante de presença', () => {
  let active = true;
  let read: string | null = '10';
  let outcome: PresenceOutcome = 'ok';
  let calls: [boolean, string | null][] = [];
  const reporter = () =>
    createPresenceReporter({
      report: async (present, readThrough) => {
        calls.push([present, readThrough]);
        return outcome;
      },
      isActive: () => active,
      readThrough: () => read,
    });

  beforeEach(() => {
    vi.useFakeTimers();
    active = true;
    read = '10';
    outcome = 'ok';
    calls = [];
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('informa ao ficar ativa, renova a cada 20 s com a leitura atual, encerra uma vez ao perder o foco e volta ao recuperá-lo', async () => {
    const presence = reporter();
    presence.sync();
    presence.sync(); // reconferir sem mudança não repete
    expect(calls).toEqual([[true, '10']]);

    read = '12';
    await vi.advanceTimersByTimeAsync(PRESENCE_RENEW_MS);
    expect(calls).toEqual([[true, '10'], [true, '12']]);

    active = false;
    presence.sync();
    presence.sync();
    await vi.advanceTimersByTimeAsync(3 * PRESENCE_RENEW_MS); // sem renovação depois do término
    expect(calls).toEqual([[true, '10'], [true, '12'], [false, '12']]);

    active = true;
    presence.sync();
    expect(calls.at(-1)).toEqual([true, '12']);

    // Fechar a página encerra na hora; trocar de conversa encerra e desliga de vez.
    presence.leave();
    expect(calls.at(-1)).toEqual([false, '12']);
    presence.sync();
    presence.stop();
    presence.sync();
    await vi.advanceTimersByTimeAsync(PRESENCE_RENEW_MS);
    expect(calls.slice(-2)).toEqual([[true, '12'], [false, '12']]);
  });

  it('a renovação que encontra a página inativa encerra, e NOT_FOUND desliga sem término nem novas tentativas', async () => {
    const presence = reporter();
    presence.sync();
    active = false; // perdeu o foco sem o evento chegar
    await vi.advanceTimersByTimeAsync(PRESENCE_RENEW_MS);
    expect(calls).toEqual([[true, '10'], [false, '10']]);

    const gone = reporter();
    calls = [];
    active = true;
    outcome = 'not-found';
    gone.sync();
    await vi.advanceTimersByTimeAsync(2 * PRESENCE_RENEW_MS);
    gone.sync();
    gone.stop();
    expect(calls).toEqual([[true, '10']]);
  });
});

describe('leitura informada', () => {
  it('é a mensagem mais recente, parando antes do primeiro texto em escrita', () => {
    expect(readThroughOf([])).toBeNull();
    expect(readThroughOf([text('1'), text('2')])).toBe('2');
    const items: MessageView[] = [text('1'), text('2', 'streaming'), text('3')];
    expect(readThroughOf(items)).toBe('1');
    expect(readThroughOf([text('5', 'streaming')])).toBeNull();
  });
});
