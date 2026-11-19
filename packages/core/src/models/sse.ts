// Leitor de Server-Sent Events sobre o corpo de uma resposta `fetch`. Os três formatos de chat do OpenCode Go
// (chat/completions, responses e messages) transmitem por SSE; este módulo só separa os eventos, e cada protocolo
// (chat-protocols.ts) interpreta o JSON de dentro.
//
// Decisões:
// - O corpo é lido em pedaços e nunca inteiro na memória: o limite de bytes aborta um provedor que não para de enviar.
// - Segue o formato do padrão SSE: eventos separados por linha em branco, `data:` pode se repetir (juntado por \n),
//   linhas iniciadas por `:` são comentários (keep-alive) e CRLF, LF e CR valem como quebra de linha.

export interface SseEvent {
  /** Campo `event:` quando presente; os protocolos aqui também trazem o tipo no JSON, então não dependem dele. */
  event: string | null;
  data: string;
}

/** O corpo passou do limite de bytes antes de terminar. */
export class SseLimitError extends Error {
  constructor() {
    super('stream maior que o limite');
    this.name = 'SseLimitError';
  }
}

/** Lê o corpo e entrega um evento por vez. Lança `SseLimitError` acima de `maxBytes`; erros de rede seguem como vieram. */
export async function* readSse(body: ReadableStream<Uint8Array>, maxBytes: number): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let received = 0;
  let event: string | null = null;
  let data: string[] = [];

  /** Fecha o evento em montagem: sem `data:` não há nada a entregar (ex.: só comentários). */
  const flush = (): SseEvent | null => {
    const result = data.length > 0 ? { event, data: data.join('\n') } : null;
    event = null;
    data = [];
    return result;
  };

  /** Interpreta uma linha completa; devolve um evento quando a linha em branco o fecha. */
  const consumeLine = (line: string): SseEvent | null => {
    if (line === '') return flush();
    if (line.startsWith(':')) return null;
    const separator = line.indexOf(':');
    const field = separator === -1 ? line : line.slice(0, separator);
    let value = separator === -1 ? '' : line.slice(separator + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') data.push(value);
    else if (field === 'event') event = value;
    return null;
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) throw new SseLimitError();
      buffer += decoder.decode(value, { stream: true });
      // Linhas completas terminam em \n, \r\n ou \r; o resto fica no buffer para o próximo pedaço.
      let match: RegExpExecArray | null;
      const lineEnd = /\r\n|\n|\r(?!$)/g;
      let start = 0;
      while ((match = lineEnd.exec(buffer)) !== null) {
        const parsed = consumeLine(buffer.slice(start, match.index));
        start = match.index + match[0].length;
        if (parsed) yield parsed;
      }
      buffer = buffer.slice(start);
    }
    buffer += decoder.decode();
    // Fim do corpo sem linha em branco final: o que sobrou ainda conta como o último evento.
    if (buffer !== '') consumeLine(buffer.replace(/\r$/, ''));
    const last = flush();
    if (last) yield last;
  } finally {
    // Sai de um `for await` antes do fim (ou com erro): libera a conexão em vez de deixá-la aberta.
    await reader.cancel().catch(() => undefined);
  }
}
