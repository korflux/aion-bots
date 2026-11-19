// Contrato que cada arquivo de conector da limpeza de resultados (CTX-12, phase 11) cumpre para entrar no índice (`index.ts`).
// Existe como arquivo próprio para os conectores (`gmail.ts`, `notion.ts`, os próximos) e o índice não dependerem uns dos outros.

/**
 * Regras de limpeza de um conector. O índice escolhe o conector pelo PREFIXO do slug da ação (por exemplo `GMAIL_FETCH_EMAILS` pertence a quem declara
 * `GMAIL_`), porque a atividade grava o slug da ação mas não o do app.
 */
export interface ConnectorShaper {
  /** Nome do conector, só para identificação em testes e mensagens (por exemplo `gmail`). */
  readonly connector: string;
  /** Prefixos do slug da ação, em maiúsculas, que pertencem a este conector (por exemplo `GMAIL_`). */
  readonly actionPrefixes: readonly string[];
  /**
   * Remove o que o modelo não precisa do resultado JSON já lido (`data` do Composio), sem escrever texto: quem escreve é a camada genérica, depois.
   * Função pura e textual: nunca executa nem interpreta o conteúdo como código. Pode lançar; o índice captura e segue só pela genérica.
   * `actionSlug` chega como o Composio o nomeia (`GMAIL_FETCH_EMAILS`), em maiúsculas e sem espaços nas pontas, para regras por ação.
   */
  shape(actionSlug: string, data: unknown): unknown;
}
