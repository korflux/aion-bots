// Prova da forma do composer (phase 18, A18 e A29): o HTML que `Composer` renderiza no servidor, para ler a ORDEM e o AGRUPAMENTO dos controles. Anexar fica sozinho à esquerda e, no
// grupo da direita, vêm modelo, effort, contexto, ditado e enviar, todos na MESMA linha embaixo do campo; o campo é uma pílula lisa (sem degradê nem brilho). O que a ordem não prova, que
// em 390 px nada some nem se sobrepõe, é medido no navegador real (`e2e/conversation.spec.ts`, A18). Renderização no servidor, sem DOM; o ditado é suposto suportado (no servidor ele nunca é).
import type { ModelChoiceView } from '@aion/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { SessionProvider } from '@/lib/session-context';
import { Composer } from './composer';

vi.mock('./use-dictation', () => ({ useDictation: () => ({ supported: true, listening: false, error: null, toggle: () => undefined, cancel: () => undefined }) }));
vi.mock('@/components/settings/settings-provider', () => ({ useAppSettings: () => ({ load: { status: 'ready', saved: { language: 'pt-BR' } } }) }));

const SESSION = { csrfToken: 'csrf', sessionId: 's1', expiresAt: '2030-01-01T00:00:00.000Z' } as unknown as Parameters<typeof SessionProvider>[0]['session'];
const MODEL: ModelChoiceView = { model: 'opencode/glm-5.1', effort: null, effortLevels: ['low', 'high'] };

function render(overrides: Partial<Parameters<typeof Composer>[0]> = {}): string {
  return renderToStaticMarkup(
    <SessionProvider session={SESSION}>
      <TooltipProvider>
        <Composer
          disabled={false}
          disabledReason="Configure um provedor."
          model={MODEL}
          onModelChange={() => undefined}
          source={{ kind: 'session', id: 's1' }}
          onSend={async () => ({ ok: true })}
          onSent={() => undefined}
          contextPanel={<button type="button" aria-label="Contexto: 12%" />}
          {...overrides}
        />
      </TooltipProvider>
    </SessionProvider>,
  );
}

/** Posição de cada controle (nome acessível ou texto do modelo) dentro do HTML, na ordem em que aparecem. */
const order = (html: string, names: string[]): number[] => names.map((name) => html.indexOf(name));

describe('composer (phase 18, A18)', () => {
  const html = render();

  it('anexar fica à esquerda e modelo, effort, contexto, ditado e enviar vêm depois, nessa ordem', () => {
    const positions = order(html, ['aria-label="Anexar arquivo"', 'opencode/glm-5.1', 'aria-label="Effort: Padrão"', 'aria-label="Contexto: 12%"', 'aria-label="Ditar"', 'aria-label="Enviar mensagem"']);
    expect(positions.every((position) => position > -1)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it('todos os controles estão na mesma linha, abaixo do campo: o anexar e o grupo da direita são filhos da mesma linha', () => {
    const row = /<div class="flex min-w-0 items-center gap-1 md:gap-2">(.*)<\/div><\/form>/s.exec(html)?.[1] ?? '';
    expect(row, 'a linha dos controles').not.toBe('');
    expect(html.indexOf('<textarea')).toBeLessThan(html.indexOf(row.slice(0, 40)));
    const right = /<div class="ml-auto flex min-w-0 items-center justify-end gap-1 md:gap-2">(.*)$/s.exec(row)?.[1] ?? '';
    for (const name of ['opencode/glm-5.1', 'aria-label="Effort: Padrão"', 'aria-label="Contexto: 12%"', 'aria-label="Ditar"', 'aria-label="Enviar mensagem"']) expect(right, name).toContain(name);
    expect(right).not.toContain('Anexar arquivo');
  });

  it('o campo é uma pílula lisa, sem degradê nem brilho', () => {
    const form = /<form[^>]*class="([^"]*)"/.exec(html)?.[1] ?? '';
    expect(form).toContain('rounded-[1.75rem]');
    expect(html).not.toMatch(/grad-/);
  });

  it('desabilitado (sem provedor): sem anexar, modelo, effort nem ditado, e o enviar continua à direita, desabilitado', () => {
    const off = render({ disabled: true });
    for (const name of ['Anexar arquivo', 'Effort:', 'Ditar', 'opencode/glm-5.1']) expect(off, name).not.toContain(name);
    expect(off).toMatch(/aria-label="Enviar mensagem"[^>]*disabled/);
  });
});
