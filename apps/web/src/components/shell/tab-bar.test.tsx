// Prova da barra inferior do celular (phase 5, T6; spec A5, Suposições 16 e 17): o selo de Aprovações (vazio em 0, número até 9 e "9+" acima), a aba ativa com `aria-current`, o
// nome acessível de cada aba com o sinal (pendentes e não lido) e as bolinhas de Início e Chats. Também a decisão pura de "teclado aberto" (viewport visual menor com campo em foco).
// Renderização no servidor, sem DOM (como os demais testes do web); a barra no navegador, o teclado simulado e o axe são provados no E2E em 375 e 320 px.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TabBarView, type TabBarViewProps } from './tab-bar';
import { KEYBOARD_MIN_SHRINK, keyboardIsOpen } from './use-keyboard-open';

const render = (props: Partial<TabBarViewProps> = {}) => renderToStaticMarkup(<TabBarView active="inicio" approvals={0} unread={{ inicio: false, chats: false }} {...props} />);

/** O texto do selo de Aprovações (`data-testid="tab-approvals-badge"`), ou `null` quando não há selo. */
const badgeOf = (html: string) => html.match(/data-testid="tab-approvals-badge"[^>]*>([^<]*)</)?.[1] ?? null;
/** Os nomes acessíveis (`aria-label`) dos links da barra, na ordem. */
const namesOf = (html: string) => [...html.matchAll(/<a [^>]*aria-label="([^"]*)"/g)].map((match) => match[1]);

describe('barra inferior: selo de Aprovações', () => {
  it('em 0 não há selo, e o nome da aba é só "Aprovações"', () => {
    const html = render({ approvals: 0 });
    expect(badgeOf(html)).toBeNull();
    expect(namesOf(html)).toContain('Aprovações');
  });

  it('de 1 a 9 mostra o número; acima de 9 mostra "9+" (o nome acessível traz o número real)', () => {
    for (const count of [1, 3, 9]) expect(badgeOf(render({ approvals: count })), String(count)).toBe(String(count));
    for (const count of [10, 11, 42]) {
      const html = render({ approvals: count });
      expect(badgeOf(html), String(count)).toBe('9+');
      expect(namesOf(html)).toContain(`Aprovações, ${count} pendentes`);
    }
  });

  it('o nome acessível concorda em número: "1 pendente" e "3 pendentes"', () => {
    expect(namesOf(render({ approvals: 1 }))).toContain('Aprovações, 1 pendente');
    expect(namesOf(render({ approvals: 3 }))).toContain('Aprovações, 3 pendentes');
  });

  it('o selo é decorativo (`aria-hidden`): o leitor de tela ouve o nome da aba', () => {
    expect(render({ approvals: 3 })).toMatch(/aria-hidden="true"[^>]*data-testid="tab-approvals-badge"/);
  });
});

describe('barra inferior: abas, aba ativa e bolinhas', () => {
  it('são quatro links na ordem Início, Chats, Rotinas e Aprovações, com o endereço de cada tela', () => {
    const html = render();
    expect(namesOf(html)).toEqual(['Início', 'Chats', 'Rotinas', 'Aprovações']);
    expect([...html.matchAll(/<a [^>]*href="([^"]*)"/g)].map((match) => match[1])).toEqual(['/', '/chats', '/rotinas', '/aprovacoes']);
  });

  it('só a aba ativa leva `aria-current="page"`', () => {
    const tabs = [
      ['inicio', 'Início'],
      ['chats', 'Chats'],
      ['rotinas', 'Rotinas'],
      ['aprovacoes', 'Aprovações'],
    ] as const;
    for (const [id, name] of tabs) {
      const html = render({ active: id });
      const current = [...html.matchAll(/<a [^>]*aria-current="page"[^>]*aria-label="([^"]*)"|<a [^>]*aria-label="([^"]*)"[^>]*aria-current="page"/g)].map((match) => match[1] ?? match[2]);
      expect(current, id).toEqual([name]);
      expect(html.match(/aria-current="page"/g), id).toHaveLength(1);
    }
  });

  it('a bolinha de não lido aparece em Início ou em Chats conforme o estado, e entra no nome acessível', () => {
    const none = render();
    expect(none).not.toContain('data-testid="unread-dot"');
    expect(namesOf(none)).toEqual(['Início', 'Chats', 'Rotinas', 'Aprovações']);

    const inicio = render({ unread: { inicio: true, chats: false } });
    expect(inicio.match(/data-testid="unread-dot"/g)).toHaveLength(1);
    expect(namesOf(inicio)).toEqual(['Início, há novidades não lidas', 'Chats', 'Rotinas', 'Aprovações']);

    const chats = render({ unread: { inicio: false, chats: true } });
    expect(chats.match(/data-testid="unread-dot"/g)).toHaveLength(1);
    expect(namesOf(chats)).toEqual(['Início', 'Chats, há novidades não lidas', 'Rotinas', 'Aprovações']);

    const both = render({ unread: { inicio: true, chats: true } });
    expect(both.match(/data-testid="unread-dot"/g)).toHaveLength(2);
  });

  it('só existe abaixo de 768 px (`md:hidden`) e as abas têm alvo de 48 px', () => {
    const html = render();
    expect(html).toContain('md:hidden');
    expect(html.match(/min-h-12/g)).toHaveLength(4);
  });
});

describe('teclado aberto', () => {
  const baseline = 812;

  it('com campo em foco e a viewport visual encolhida pelo teclado, a barra some', () => {
    expect(keyboardIsOpen({ baseline, height: 420, editing: true })).toBe(true);
    expect(keyboardIsOpen({ baseline, height: baseline - KEYBOARD_MIN_SHRINK, editing: true })).toBe(true);
  });

  it('campo em foco sem a viewport encolher (teclado físico) não esconde a barra', () => {
    expect(keyboardIsOpen({ baseline, height: baseline, editing: true })).toBe(false);
    expect(keyboardIsOpen({ baseline, height: baseline - KEYBOARD_MIN_SHRINK + 1, editing: true })).toBe(false); // a barra do navegador some e volta, não é teclado
  });

  it('viewport encolhida sem campo em foco (zoom, rotação) não esconde a barra', () => {
    expect(keyboardIsOpen({ baseline, height: 420, editing: false })).toBe(false);
  });
});
