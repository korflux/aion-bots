// Prova do índice de Configurações em linhas (phase 18, A26): cada área é UMA linha-link com nome, descrição e valor, sem cartão com moldura nem brilho em volta da lista; sem valor (leitura
// que falhou) a linha segue com nome e descrição. Os 308 das rotas antigas com a query string são do E2E (`e2e/shell.spec.ts`). Renderização no servidor, sem DOM.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AreaRow } from './settings-index';
import { SETTINGS_AREAS } from './settings-areas';

describe('linha do índice de Configurações (A26)', () => {
  const area = SETTINGS_AREAS[0]!;

  it('a linha é um link com o nome, a descrição e o valor da área', () => {
    const html = renderToStaticMarkup(<ul><AreaRow area={area} state="Tudo conectado" /></ul>);
    expect(html).toContain(`href="${area.href}"`);
    expect(html).toContain(area.label);
    expect(html).toContain(area.description);
    expect(html.indexOf(area.description)).toBeLessThan(html.indexOf('Tudo conectado'));
  });

  it('o valor só quebra entre as partes separadas por " · ": o id do modelo é indivisível', () => {
    const html = renderToStaticMarkup(<ul><AreaRow area={area} state="Português (Brasil) · opencode/glm-5.1" /></ul>);
    expect(html).toContain('<span class="whitespace-nowrap">Português (Brasil)</span> · <span class="whitespace-nowrap">opencode/glm-5.1</span>');
  });

  it('sem valor a linha mostra só o nome e a descrição', () => {
    const html = renderToStaticMarkup(<ul><AreaRow area={area} state={null} /></ul>);
    expect(html).toContain(area.label);
    expect(html).not.toContain('Tudo conectado');
  });

  it('não há cartão nem brilho: nenhuma moldura, fundo de superfície ou degradê na linha', () => {
    const html = renderToStaticMarkup(<ul>{SETTINGS_AREAS.map((item) => <AreaRow key={item.id} area={item} state="valor" />)}</ul>);
    expect(html.match(/<li /g)).toHaveLength(6);
    expect(html).not.toMatch(/grad-|bg-surface"|rounded-lg|border border-line/);
  });
});
