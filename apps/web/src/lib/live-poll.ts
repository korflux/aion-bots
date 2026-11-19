// Releitura periódica compartilhada de uma lista do cliente (estado ao vivo dos bots, F10; não lido das listas, phase 3 F4). Fonte única do
// relógio dos stores de módulo (`bots-store`, `chat-store`): um relógio por store, contado por assinante, nunca um por componente montado.
//
// Regras (as mesmas que a lista de bots já seguia): o primeiro assinante liga o relógio e a escuta de visibilidade e relê na hora (se a primeira
// carga já terminou); o último desliga tudo. Com a aba oculta não há releitura; ao voltar a ficar visível relê na hora. Há no máximo uma
// releitura pendente, e cada releitura, ao terminar, chama `schedule` para programar a próxima na cadência (`delay`).
// ponytail: uma consulta periódica por lista e por navegador aberto; trocar por um canal de eventos (SSE global) se o número de abas ou de itens pesar.

export interface LivePollOptions {
  /** Relê a lista em segundo plano (sem "carregando" e sem erro visível); ao terminar, deve chamar `schedule`. */
  refresh: () => void;
  /** Intervalo até a próxima releitura, lido a cada programação (a cadência pode depender do estado atual). */
  delay: () => number;
  /** A primeira carga já terminou (com sucesso ou erro)? Antes disso quem relê é a própria primeira carga. */
  settled: () => boolean;
}

export interface LivePoll {
  /** Passa a manter a releitura até a função devolvida ser chamada (idempotente). */
  watch: () => () => void;
  /** Programa a próxima releitura, descartando a pendente. Não programa sem assinantes, com a aba oculta ou antes da primeira carga. */
  schedule: () => void;
}

/** Cria o relógio de releitura de um store. */
export function createLivePoll({ refresh, delay, settled }: LivePollOptions): LivePoll {
  let watchers = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const stop = (): void => {
    clearTimeout(timer);
    timer = undefined;
  };

  const schedule = (): void => {
    stop();
    if (watchers === 0 || document.visibilityState !== 'visible' || !settled()) return;
    timer = setTimeout(refresh, delay());
  };

  /** A aba voltou a ficar visível: relê na hora (o estado pode ter mudado enquanto estava oculta); ao ocultar, para o relógio. */
  const onVisibilityChange = (): void => {
    if (document.visibilityState === 'visible') refresh();
    else stop();
  };

  const watch = (): (() => void) => {
    watchers += 1;
    if (watchers === 1) {
      document.addEventListener('visibilitychange', onVisibilityChange);
      // Relê ao montar. Com a primeira carga ainda por fazer ou em andamento, quem a pede é o hook do store.
      if (settled()) refresh();
    }
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      watchers -= 1;
      if (watchers === 0) {
        document.removeEventListener('visibilitychange', onVisibilityChange);
        stop();
      }
    };
  };

  return { watch, schedule };
}
