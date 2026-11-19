# Modal

Modal do kit (ui/modal.tsx, Dialog do Radix): até 440 px, gutter de 16 px no celular, bg-surface, raio radius-lg, padding 24 px, sombra shadow-float sobre véu preto a 60%.

- Título em page-title 18/26; descrição em text-muted, ligada como descrição acessível.
- `leading` aceita a Faísca do bot (dormindo, 40 px) ao lado do título no popup de exclusão; ela não entra no nome acessível.
- Ações à direita, a principal por último (no celular, empilhadas com Cancelar primeiro). Em exclusão, o botão perigo descreve a ação ("Excluir bot") e leva a borda danger a 40%, como em todo diálogo destrutivo.
- Foco preso; ao fechar volta a quem abriu, mesmo com o modal controlado.
