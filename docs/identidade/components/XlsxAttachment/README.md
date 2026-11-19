# XlsxAttachment

Anexo de planilha (phase 4, ATT-01): novo tipo aceito no composer, com o original guardado.

- Ícone de planilha em success; sublinha "Planilha · N abas · tamanho". Enquanto valida: LoaderCircle e "Validando planilha…".
- Recusa (formato inválido, zip bomb ou acima do limite próprio): borda e texto em danger, "Planilha inválida ou grande demais".
- Na mensagem: chip com nome e tamanho; o código lê a planilha somente leitura, pela regra do `read_attachment`.
- Conta no limite global `AION_ATTACHMENTS_MAX_TOTAL_MB`.
