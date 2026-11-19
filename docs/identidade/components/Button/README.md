# Button

Botão do kit (apps/web/src/components/ui/button.tsx): primário, secundário (padrão), ghost e perigo, em md 36 px, sm 32 px e ícone 32 px (40 px de toque no celular).

- Uma ação primária por tela; o primário usa action e action-fg, não a cor faisca. O azul da marca fica para a Faísca e os links (faisca-claro), para o app continuar calmo.
- Botão só de ícone exige `aria-label`.
- Perigo é texto danger sem fundo; o fundo danger-soft só aparece no hover.
- Rótulos começam por verbo e não levam ponto: "Salvar alterações", "Excluir bot".
