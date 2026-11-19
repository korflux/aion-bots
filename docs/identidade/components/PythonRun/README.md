# PythonRun

Execução de código no bloco de atividade (phase 4, EXEC-01 e EXEC-02): só Python (Pyodide em WASM no worker), sem rede, sem disco e sem banco do Aion, isento de aprovação (SEC-05).

- Estados: "Python na fila" (há 2 execuções rodando), "Executando Python…" (LoaderCircle), "Python executado (tempo)" (Check success), "Python falhou (tempo)" (Ban danger), "passou de 60 s" (Timer warning), "interrompido por você" (Parar encerra na hora) e aviso de limite.
- Expandido: o código no CodeBlockCard da phase 3 (rótulo "python", Copiar e Quebrar linhas), a saída truncada em mono e a lista de arquivos gerados. Erro: traceback em danger, que o modelo também recebe.
- Cada chamada começa do zero (sem estado). O modelo recebe a saída truncada e a lista de arquivos, não a imagem.
