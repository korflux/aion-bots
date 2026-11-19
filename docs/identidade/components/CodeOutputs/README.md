# CodeOutputs

Saídas da execução de Python dentro da resposta do bot (phase 4, ATT-01).

- PNG: inline, até 420 px, fundo claro do próprio gráfico, abre o visualizador de imagem já existente.
- CSV, XLSX, JSON e TXT: cartão de 48 px com ícone, nome, "TIPO · tamanho · gerado pelo bot" e "Baixar".
- Viram anexos produzidos pelo bot: mesmo ciclo de vida, exclusão ("Arquivo removido: nome") e regras de log dos anexos; aparecem em Atividade e arquivos com a origem do bot.
- Excedentes de quantidade ou tamanho são recusados e o modelo recebe o aviso.
