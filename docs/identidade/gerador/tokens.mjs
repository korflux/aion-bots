// Tokens do design system do Aion: fonte única para tokens.json, previews e checagem de contraste.
// Tema escuro primeiro (o app é só escuro); o claro serve a materiais fora do app (README, divulgação, impressos).

export const color = [
  // Fundos
  ['bg-app', '#0e0e13', '#f6f5fa', 'Fundo da página. Base de todo o app; no claro, fundo de materiais.'],
  ['bg-panel', '#15151b', '#ffffff', 'Barra lateral, drawer e painéis fixos sobre bg-app.'],
  ['bg-surface', '#1b1b22', '#ffffff', 'Cartões, inputs, popovers e o composer.'],
  ['bg-surface-hover', '#23232b', '#efeef5', 'Hover de linhas, cartões e botões secundários.'],
  ['bg-selected', '#2a2a33', '#e6e4ef', 'Item ativo de navegação e pressionado. Nunca text-subtle sobre ele.'],
  // Bordas
  ['border', '#2e2e38', '#dddbe7', 'Divisórias e borda de cartões e inputs (fio de 1 px).'],
  ['border-strong', '#6a6a80', '#8a879c', 'Borda de controle em foco de hover, separadores enfáticos.'],
  // Texto
  ['text', '#ececf1', '#1b1530', 'Texto principal sobre bg-app, bg-panel, bg-surface e bg-selected.'],
  ['text-muted', '#a3a3b0', '#4e4a60', 'Texto secundário e metadados sobre qualquer fundo, inclusive bg-selected.'],
  ['text-subtle', '#8b8b99', '#625e78', 'Dicas e placeholders sobre bg-app, bg-panel e bg-surface. Proibido sobre bg-selected.'],
  // Ação e foco
  ['action', '#ececf1', '#1b1530', 'Fundo do botão primário (uma ação principal por tela).'],
  ['action-fg', '#0e0e13', '#ffffff', 'Texto e ícone sobre action.'],
  ['focus', '#8db6fa', '#1d4ed8', 'Anel de foco de 2 px com afastamento de 2 px em todo controle.'],
  // Marca
  ['faisca', '#3b82f6', '#3b82f6', 'Azul Faísca: corpo da Faísca quando ela representa o próprio Aion (logo, ícone, login, Chat geral). Não é cor de texto.'],
  ['faisca-claro', '#8db6fa', '#1d4ed8', 'Azul da marca como texto e link, sobre bg-app, bg-panel e bg-surface.'],
  ['faisca-suave', '#172340', '#e3edfd', 'Fundo tingido de marca: destaque de item novo, faixa de boas-vindas.'],
  ['brilho', '#facc15', '#facc15', 'Amarelo da faísca. Só na estrela da Faísca, no pingo do i e em conquistas. Nunca em texto ou botão.'],
  ['brilho-miolo', '#fef3c7', '#fef3c7', 'Miolo claro da estrela em tamanho >= 48 px.'],
  ['brilho-traco', '#a16207', '#a16207', 'Contorno da estrela; garante 3:1 da estrela sobre fundos claros.'],
  ['bochecha', '#ff7aa8', '#ff7aa8', 'Bochechas da Faísca e a língua no estado concluído. Uso raro fora do mascote.'],
  ['tinta', '#1b1530', '#1b1530', 'Rosto da Faísca (olhos, boca, sobrancelhas) e fundo do ícone do app. Fixa nos dois temas.'],
  // Estados
  ['success', '#4ade80', '#15803d', 'Concluído: texto e ícone sobre os fundos do tema.'],
  ['success-soft', '#4ade801f', '#15803d1a', 'Fundo de selo e cartão de sucesso.'],
  ['warning', '#fbbf24', '#a16207', 'Aguardando aprovação e avisos.'],
  ['warning-soft', '#fbbf241f', '#a162071a', 'Fundo de selo e cartão de aviso.'],
  ['danger', '#f87171', '#b91c1c', 'Erro e ações destrutivas (texto do botão perigo).'],
  ['danger-soft', '#f871711f', '#dc26261a', 'Fundo de selo de erro e hover do botão perigo.'],
  ['info', '#8db6fa', '#1d4ed8', 'Informação neutra, trabalhando.'],
  ['info-soft', '#8db6fa1f', '#2563eb1a', 'Fundo de selo informativo.'],
  // Paleta dos bots (corpo da Faísca de cada bot; mesmas cores nos dois temas)
  ['bot-vermelho', '#f87171', null, 'Cor de bot.'],
  ['bot-laranja', '#fb923c', null, 'Cor de bot.'],
  ['bot-ambar', '#fbbf24', null, 'Cor de bot. A estrela amarela some no corpo: o contorno brilho-traco é obrigatório.'],
  ['bot-lima', '#a3e635', null, 'Cor de bot.'],
  ['bot-verde', '#4ade80', null, 'Cor de bot.'],
  ['bot-turquesa', '#2dd4bf', null, 'Cor de bot.'],
  ['bot-ciano', '#22d3ee', null, 'Cor de bot.'],
  ['bot-azul', '#60a5fa', null, 'Cor de bot e cor padrão de bot novo (BOT_DEFAULT_COLOR).'],
  ['bot-indigo', '#818cf8', null, 'Cor de bot.'],
  ['bot-violeta', '#a78bfa', null, 'Cor de bot.'],
  ['bot-rosa', '#f472b6', null, 'Cor de bot.'],
  ['bot-cinza', '#9ca3af', null, 'Cor de bot.'],
];

export const tokens = {
  name: 'Aion',
  version: 1,
  color: {
    themes: [
      { id: 'dark', name: 'Escuro (app)' },
      { id: 'light', name: 'Claro (materiais)' },
    ],
    tokens: color.map(([name, dark, light, usage]) => ({ name, value: light ? { dark, light } : { dark }, usage })),
  },
  type: {
    fonts: [],
    families: {
      display: '"Fredoka", "Nunito", ui-rounded, system-ui, sans-serif',
      sans: '"Inter Variable", "Inter", ui-sans-serif, system-ui, sans-serif',
      mono: '"JetBrains Mono Variable", "JetBrains Mono", ui-monospace, SFMono-Regular, monospace',
    },
    groups: [
      {
        name: 'Marca',
        family: 'display',
        styles: [
          { name: 'display', fontSize: '40px', lineHeight: '44px', fontWeight: 600, letterSpacing: '-0.01em', sample: 'Seus bots, trabalhando', usage: 'Materiais de divulgação (README, imagens). Uma vez por peça.' },
          { name: 'display-sm', fontSize: '24px', lineHeight: '30px', fontWeight: 600, sample: 'Nenhum bot ainda', usage: 'Saudação e estado vazio do Início, ao lado da Faísca.' },
        ],
      },
      {
        name: 'Interface',
        family: 'sans',
        styles: [
          { name: 'page-title', fontSize: '18px', lineHeight: '26px', fontWeight: 600, sample: 'Aprovações', usage: 'Título de página (h1 do componente Page).' },
          { name: 'section-title', fontSize: '15px', lineHeight: '24px', fontWeight: 600, sample: 'Regras globais', usage: 'Título de seção e de cartão.' },
          { name: 'body', fontSize: '15px', lineHeight: '24px', fontWeight: 400, sample: 'O bot terminou a rotina das 9h e deixou o resumo na conversa.', usage: 'Texto corrido, mensagens e formulários.' },
          { name: 'label', fontSize: '14px', lineHeight: '20px', fontWeight: 500, sample: 'Salvar alterações', usage: 'Botões, abas e rótulos de campo.' },
          { name: 'small', fontSize: '13px', lineHeight: '20px', fontWeight: 400, sample: 'Atualizado há 3 min', usage: 'Metadados, legendas de cartão, ajuda de campo.' },
          { name: 'caption', fontSize: '12px', lineHeight: '16px', fontWeight: 500, sample: 'Aguardando', usage: 'Selos e contadores. Mínimo da interface.' },
        ],
      },
      {
        name: 'Código',
        family: 'mono',
        styles: [{ name: 'code', fontSize: '13px', lineHeight: '20px', fontWeight: 400, sample: 'composio_execute_action', usage: 'Slugs, nomes de ferramenta e blocos de código.' }],
      },
    ],
  },
  spacing: {
    tokens: [
      ['space-1', '4px', 'Ícone e rótulo dentro de selo.'],
      ['space-2', '8px', 'Gap entre ícone e texto em botões; entre itens de lista densa.'],
      ['space-3', '12px', 'Padding de item de menu e de selo.'],
      ['space-4', '16px', 'Padding de cartão e margem lateral no celular.'],
      ['space-6', '24px', 'Separação entre seções de uma página.'],
      ['space-8', '32px', 'Margem de página no desktop; respiro ao redor da Faísca em estado vazio.'],
    ].map(([name, value, usage]) => ({ name, value, usage })),
  },
  radius: {
    tokens: [
      ['radius-sm', '6px', 'Selo e item de menu.'],
      ['radius-md', '10px', 'Input, botão e cartão.'],
      ['radius-lg', '16px', 'Popover e modal.'],
      ['radius-xl', '24px', 'Composer e ícone do app (22% do lado).'],
      ['radius-full', '9999px', 'Pílulas, avatares e o ícone de push.'],
    ].map(([name, value, usage]) => ({ name, value, usage })),
  },
  shadow: {
    note: 'O app separa camadas por cor de fundo e borda; sombra só em camadas flutuantes.',
    tokens: [{ name: 'shadow-float', value: { dark: '0 8px 24px rgba(0,0,0,0.4)', light: '0 8px 24px rgba(27,21,48,0.12)' }, usage: 'Popover, menu e modal.' }],
  },
};

/** Contraste WCAG entre duas cores #rrggbb. */
export function contrast(a, b) {
  const lum = (h) => {
    const v = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
  };
  const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
}
