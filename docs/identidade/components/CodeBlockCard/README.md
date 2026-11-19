# CodeBlockCard

Bloco cercado dentro da resposta do bot (phase 3, design aprovado): cartão bg-surface, borda border, radius-md.

- Cabeçalho de 32 px: rótulo em mono 12 px text-muted ("Texto", o identificador da linguagem como veio, ou "Código"), ações ghost à direita.
- Código: mono 13/20, `white-space: pre`, rola só por dentro (`tabIndex=0`); "Quebrar linhas" (`aria-pressed`) troca para `pre-wrap` e tira o `tabIndex`.
- Texto: sans 15/24, quebra sempre, sem rolagem, só "Copiar".
- Copiar: ícone Copy e "Copiar"; por 2 s Check e "Copiado", com `role="status"` "Conteúdo copiado". Falha: toast de erro que só some ao fechar.
- Abaixo de 300 px úteis os botões viram só ícone, com `aria-label` e tooltip. Nenhum bloco cria rolagem horizontal na página. Código inline não ganha cartão.
