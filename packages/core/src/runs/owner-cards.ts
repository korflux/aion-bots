// Cartões que existem só para o dono (módulo folha, sem imports do motor): o conjunto de tipos que NUNCA chega ao modelo.
//
// Por que é um módulo à parte: três lugares precisam da mesma lista, `context.ts` (monta o pedido e pula esses cartões), `context-collapse.ts` (o índice
// do colapso não os lista) e `activity-read.ts` (a leitura os recusa). `activity-read.ts` e `context.ts` já dependem um do outro por outros motivos
// (schema da leitura e texto da chamada interrompida); com a lista dentro de `context.ts` isso virava um ciclo de importação. Aqui ela não depende de ninguém.
// Ponto de extensão: um tipo novo de cartão que o bot não deve ver entra neste conjunto, e as três pontas passam a tratá-lo igual.

/**
 * Tipos de cartão que ficam fora do contexto do modelo (o bot sabe da edição de memória e da rotina que criou ou alterou pelo resultado da própria ferramenta).
 * `routine_proposal` e `routine_change` valem nos dois fluxos (proposta antiga pendente e rotina aplicada pelo bot, phase 10) e seguem só do dono. FICAM DE FORA
 * de propósito `routine_refused` e `routine_edited`: são os avisos de que o dono recusou ou editou o que o bot aplicou, e chegam ao modelo como `routine_confirmed`
 * chega (um turno `[Sistema]` com o `content` do aviso), para ele saber que a rotina voltou ao que era ou como ficou.
 * `objective_updated` (decisão do dono em 15/10/2026, phase 9): o bot escreveu o objetivo pela própria `update_objective` e o objetivo vigente já vai em todo
 * pedido (`# Objetivo do bot`); o cartão grava o texto só em `data` e deixa `content` vazio, então no pedido virava um turno `[Sistema] ` sem informação e, no
 * índice do colapso e em `read_activity`, um id que não levava a nada. Também o mantém fora de qualquer cobertura (o "Desfazer" do dono altera o `data` dele).
 */
export const OWNER_ONLY_CARDS: ReadonlySet<string> = new Set(['approval', 'model_without_tools', 'memory_updated', 'routine_proposal', 'routine_change', 'routine_missed', 'objective_updated']);
