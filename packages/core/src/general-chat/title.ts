// Título automático de uma sessão do chat geral (F16: "gerado pela primeira mensagem, até 80 caracteres"). Função pura, usada pelo
// `ConversationService` ao enfileirar a primeira mensagem; sem chamada ao modelo (o título não pode custar uma execução nem falhar).
import { CHAT_SESSION_TITLE_MAX } from '@aion/shared';

/**
 * Primeira mensagem reduzida a uma linha: espaços e quebras viram um espaço só e o que passar de 80 caracteres é cortado com
 * reticências (o total, com elas, continua em 80). A contagem é por caractere (e não por unidade UTF-16), como o `char_length` do banco,
 * então um emoji no corte nunca é partido ao meio.
 */
export function titleFromMessage(message: string): string {
  const oneLine = message.replace(/\s+/g, ' ').trim();
  const characters = Array.from(oneLine);
  if (characters.length <= CHAT_SESSION_TITLE_MAX) return oneLine;
  return `${characters.slice(0, CHAT_SESSION_TITLE_MAX - 1).join('').trimEnd()}…`;
}
