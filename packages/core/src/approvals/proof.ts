// Prova de aprovação: o que uma ferramenta sob aprovação (externa ou destrutiva local) precisa receber para executar (critério C4: nenhuma ação
// executa sem passar pela resolução de regra no servidor).
//
// Como funciona: só `grantApprovalProof` fabrica uma prova, e quem o chama é o portão do executor, DEPOIS de a regra ter sido
// resolvida (allow) ou de o dono ter permitido. Toda ferramenta sob aprovação exige a prova em `execute` (`requireApprovalProof`) e
// recusa executar sem ela. A prova também carrega a AÇÃO para a qual foi emitida, então uma prova de uma ação não serve a outra.
// Não é uma barreira de segurança contra código malicioso no mesmo processo (a marca é só um símbolo), e sim uma trava de
// projeto: esquecer o portão ao criar um novo caminho de execução passa a quebrar um teste, em vez de calar.
const PROOF_MARK = Symbol('aion.approval-proof');

/** Por que a execução foi liberada: regra permissiva já resolvida, ou o dono respondeu ao pedido de aprovação. */
export type ApprovalBasis = 'allow_rule' | 'owner_approved';

export interface ApprovalProof {
  readonly [PROOF_MARK]: true;
  readonly action: string;
  readonly basis: ApprovalBasis;
}

/** Emite a prova de aprovação de UMA ação. Chamada apenas pelo portão do executor, depois da resolução da regra. */
export function grantApprovalProof(action: string, basis: ApprovalBasis): ApprovalProof {
  return { [PROOF_MARK]: true, action, basis };
}

/** Confere a prova de uma ferramenta sob aprovação e devolve por que foi liberada. Lança se faltar ou for de outra ação. */
export function requireApprovalProof(proof: ApprovalProof | undefined, action: string): ApprovalBasis {
  if (!proof || proof[PROOF_MARK] !== true || proof.action !== action) {
    throw new Error(`ação "${action}" sem prova de aprovação`);
  }
  return proof.basis;
}
