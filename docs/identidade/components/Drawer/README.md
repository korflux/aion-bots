# Drawer

Drawer lateral (ui/drawer.tsx, Dialog do Radix): navegação no celular pela esquerda e histórico de versões da memória pela direita (`side="right"`).

- Fundo bg-app, até 90 vw, sobre véu preto a 60%; entra por transform em 250 ms com o ease do drawer e respeita a safe area.
- No topo, o logotipo claro a 24 px. Itens de 36 px com raio radius-md; o ativo em bg-selected com text, os demais em text-muted.
- Cada bot aparece com a Faísca de 20 px na cor dele (nível simples, parada); o Chat geral mantém o ícone de conversa, ou a Faísca em faisca se a phase 5 confirmar.
- `title` é obrigatório: vira o nome acessível do diálogo.
