// Lógica da presença e leitura no cliente (phase 3, T2; F1/A2), sem React nem DOM: quando informar ao servidor que o dono está olhando esta
// conversa e até onde ela foi lida. O hook `use-presence.ts` liga isto aos eventos da página; aqui fica só a regra, testável com relógio falso.
//
// Regra (Suposições 3 e 4 da spec): presente = página visível E janela com foco. Ao ficar presente informa na hora e renova a cada
// `PRESENCE_RENEW_MS`; ao deixar de estar (ocultar, perder o foco, trocar de conversa, fechar) informa o término uma vez. A leitura vai junto
// em toda informação. Se o servidor diz que a conversa não existe (NOT_FOUND), para de informar de vez. Falha de rede ou limite não mostram
// nada ao dono: a próxima renovação tenta de novo, e o servidor vence a presença sozinho em 45 s se o término se perder.
import { PRESENCE_RENEW_MS, type MessageView } from '@aion/shared';

/** Resultado de uma informação ao servidor, do ponto de vista da presença: só NOT_FOUND muda o comportamento. */
export type PresenceOutcome = 'ok' | 'not-found' | 'failed';

export interface PresenceReporterDeps {
  /** Envia presença (ou término) e a leitura atual. Nunca lança: devolve o resultado. */
  report(present: boolean, readThrough: string | null): Promise<PresenceOutcome>;
  /** A página está visível e com foco agora? */
  isActive(): boolean;
  /** Leitura atual (id da mensagem mais recente mostrada), lida na hora de cada envio. */
  readThrough(): string | null;
}

export interface PresenceReporter {
  /** Reconfere visibilidade e foco: inicia a presença se ficou ativa, encerra se deixou de estar. */
  sync(): void;
  /** Encerra a presença agora (página sendo escondida ou descarregada), sem impedir que volte num `sync` seguinte. */
  leave(): void;
  /** Encerra e desliga de vez (troca de conversa, tela desmontada). */
  stop(): void;
}

/** Cria o informante de presença de UMA conversa. */
export function createPresenceReporter({ report, isActive, readThrough }: PresenceReporterDeps): PresenceReporter {
  let present = false;
  let disabled = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  const halt = (): void => {
    clearInterval(timer);
    timer = undefined;
    present = false;
  };

  const send = (value: boolean): void => {
    void report(value, readThrough()).then((outcome) => {
      // Conversa apagada (bot excluído, sessão vencida): a tela já mostra o estado dela; aqui só deixa de informar.
      if (outcome === 'not-found') {
        disabled = true;
        halt();
      }
    });
  };

  const leave = (): void => {
    if (!present) return;
    halt();
    send(false);
  };

  const sync = (): void => {
    if (disabled) return;
    if (!isActive()) return leave();
    if (present) return;
    present = true;
    send(true);
    timer = setInterval(() => (isActive() ? send(true) : leave()), PRESENCE_RENEW_MS);
  };

  return {
    sync,
    leave,
    stop() {
      leave();
      disabled = true;
    },
  };
}

/**
 * Leitura a informar: o id da mensagem mais recente mostrada, parando antes do primeiro texto ainda em escrita (Suposição 5: texto em
 * escrita só conta quando termina; marcá-lo lido agora esconderia a resposta final se o dono sair antes dela). Nulo sem mensagens.
 */
export function readThroughOf(items: readonly MessageView[]): string | null {
  let last: string | null = null;
  for (const item of items) {
    if (item.kind === 'text' && item.status === 'streaming') break;
    last = item.id;
  }
  return last;
}
