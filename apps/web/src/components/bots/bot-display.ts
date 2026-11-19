// Regras de exibição do bot (funções puras, sem React): inicial do marcador, cor segura para o nome destacado e o texto do estado ao vivo.
import { APP_BACKGROUND, TEXT_MIN_CONTRAST, contrastRatio, type BotSummary } from '@aion/shared';

/** Primeira letra do nome (por ponto de código, para emoji não virar meio caractere), em maiúscula. */
export function initialOf(name: string): string {
  const first = Array.from(name.trim())[0];
  return first ? first.toLocaleUpperCase('pt-BR') : '?';
}

/**
 * Cor do nome do bot no cabeçalho e na saudação (design: "destaque de nome"). Usa a cor do bot só quando ela
 * tem contraste de texto (4,5:1) sobre o fundo; uma cor personalizada mais fraca, aceita pelo editor com aviso,
 * cai para o texto padrão, para o nome nunca ficar ilegível.
 */
export function readableNameColor(botColor: string): string {
  return contrastRatio(botColor, APP_BACKGROUND) >= TEXT_MIN_CONTRAST ? botColor : 'var(--text)';
}

/** O texto que diz o estado ao vivo de um bot na lista (e a classe de cor dele). O estado nunca depende só da Faísca nem só da cor: o texto o diz sozinho. */
export interface LiveStateLine {
  text: string;
  /** Classe de cor do design (kit de tokens): nunca `text-subtle`, que reprova o contraste sobre `--bg-selected`. */
  className: string;
}

/**
 * Texto de estado do item da lista de bots (design "Lista de bots"): "Livre", "Trabalhando…", "Aguardando aprovação", "Concluiu agora", "Última execução
 * falhou", e, para o bot que dorme, o MOTIVO: "Arquivado" ou "Rotinas pausadas" (a Faísca dormindo sozinha não o diz). Sem horário: o estado vem sem
 * data e o "concluído" dura só 60 s.
 */
export function liveStateLine({ runState, archivedAt }: Pick<BotSummary, 'runState' | 'archivedAt'>): LiveStateLine {
  switch (runState) {
    case 'working':
      return { text: 'Trabalhando…', className: 'text-fg' };
    case 'waiting':
      return { text: 'Aguardando aprovação', className: 'text-warning' };
    case 'done':
      return { text: 'Concluiu agora', className: 'text-success' };
    case 'error':
      return { text: 'Última execução falhou', className: 'text-danger' };
    case 'sleep':
      return { text: archivedAt !== null ? 'Arquivado' : 'Rotinas pausadas', className: 'text-muted' };
    case 'idle':
      return { text: 'Livre', className: 'text-muted' };
  }
}
