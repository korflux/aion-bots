// Posse de uma execução: quem a está executando agora.
//
// Reivindicar uma execução (iniciar ou retomar) grava em `runs.lease_owner` um token novo (UUID) e dá ao executor o mesmo
// token. A posse vence se o executor parar de batê-la (`lease_until`); outro worker então a reivindica e troca o token. Um
// executor que só TRAVOU (pausa longa, rede perdida) e volta depois do vencimento não pode continuar escrevendo ao lado do
// novo dono: cada escrita relevante confere o token dentro da própria transação e, se já não é o dono, falha com
// `LeaseLostError`; o executor então para sem registrar nada (não é dele). `FOR UPDATE` (e não `FOR SHARE`) serializa a
// conferência com a troca de dono e com o batimento, sem brecha entre "conferi" e "escrevi" e sem impasse entre transações.
import type { Queryable } from '../db/pool';

/** Esta execução já pertence a outro worker. */
export class LeaseLostError extends Error {
  constructor() {
    super('a posse da execução foi perdida');
    this.name = 'LeaseLostError';
  }
}

/**
 * Confere, dentro de uma transação, que `owner` ainda é o dono da execução (que segue `running`) e trava a linha até o fim da
 * transação. Lança `LeaseLostError` se não for.
 */
export async function holdLease(tx: Queryable, runId: string, owner: string): Promise<void> {
  const held = await tx.query("SELECT 1 FROM runs WHERE id = $1 AND lease_owner = $2 AND status = 'running' FOR UPDATE", [runId, owner]);
  if (held.rowCount === 0) throw new LeaseLostError();
}
