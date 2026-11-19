# TabBar

Barra inferior do celular (novo na phase 5, opção B): substitui o menu sanduíche abaixo de 768 px.

- 64 px mais a safe area inferior, bg-panel com fio superior border, quatro abas de 48 px de alvo: Início, Chats, Rotinas, Aprovações.
- Ativa: ícone dentro de uma pílula bg-selected de 52 × 28 e texto em text; inativas em text-muted. `aria-current="page"` na ativa.
- Aprovações leva o selo warning com a contagem (até "9+"), dita também no nome acessível ("Aprovações, 2 pendentes").
- Some quando o teclado está aberto. No desktop não existe.
