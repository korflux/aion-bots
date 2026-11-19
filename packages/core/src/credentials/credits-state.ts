// Estado de saldo da chave da Anthropic (phase 17, A20 e A21): `credentials.credits_exhausted_at` guarda QUANDO a última chamada de chat com a chave salva foi recusada por saldo
// esgotado, e fica nulo quando uma chamada passa (ou quando o dono salva uma chave nova, ver `CredentialService.save`). É a única fonte do "indisponível" do seletor: o catálogo
// (`ModelService.list`) o lê, e o roteador de chat (`createProviderRouter`) o atualiza a cada chamada, então a execução, o resumo e o teste do modelo o mantêm sem cada um saber dele.
//
// O estado fica no banco (e não na memória do processo) porque a API mostra o catálogo e o worker faz as chamadas: são processos diferentes. Só a chamada com a chave SALVA o atualiza (a
// prova de uma chave candidata, em `CredentialService`, usa o cliente sem o roteador e nunca marca nem limpa o estado da chave anterior).
// ponytail: um UPDATE barato por chamada boa (a tabela tem no máximo 4 linhas); trocar por cache com TTL se a latência dessa escrita aparecer nas medições.
import type { Pool } from '../db/pool';
import type { Logger } from '../logging';

/** O que o roteador de chat precisa para registrar o saldo da Anthropic. Ambas nunca lançam: contabilidade não pode derrubar uma chamada. */
export interface CreditsState {
  /** A chamada foi recusada por saldo esgotado: marca (mantém o primeiro instante enquanto a marca durar). */
  exhausted(): Promise<void>;
  /** Uma chamada passou (2xx e o stream começou): limpa a marca, se houver. */
  recovered(): Promise<void>;
}

/** `CreditsState` sobre `credentials.credits_exhausted_at` da chave `anthropic`; sem a linha (chave removida ou nunca salva) os dois são no-ops. */
export function createCreditsState(pool: Pool, logger?: Logger, now: () => Date = () => new Date()): CreditsState {
  const run = async (sql: string, params: unknown[], what: string): Promise<void> => {
    try {
      await pool.query(sql, params);
    } catch (error) {
      logger?.warn({ errorName: error instanceof Error ? error.name : typeof error }, `estado de saldo da Anthropic não ${what}`);
    }
  };
  return {
    exhausted: () => run("UPDATE credentials SET credits_exhausted_at = $1 WHERE kind = 'anthropic' AND credits_exhausted_at IS NULL", [now()], 'marcado'),
    recovered: () => run("UPDATE credentials SET credits_exhausted_at = NULL WHERE kind = 'anthropic' AND credits_exhausted_at IS NOT NULL", [], 'limpo'),
  };
}
