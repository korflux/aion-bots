// Migration 0052: hash por bloco do pedido ao modelo e effort, por chamada (phase 15, passo 2; spec decisão 10, A5 e A6).
//
// Para que serve: as aberturas recentes de rodada (rotina fria, primeira mensagem depois de um intervalo) perdem o cache do provedor e o relatório de custo só mostra QUE
// o cache caiu, não ONDE o prefixo mudou. Cada linha de `model_call_usage` passa a guardar uma impressão digital de cada bloco que compõe o prefixo do pedido, na ordem em que
// o provedor o lê: sistema, objetivo, lista de ferramentas e histórico. Comparando duas chamadas seguidas da MESMA conversa, o primeiro bloco cujo hash difere é a causa da
// quebra (candidatos da spec: texto do sistema, objetivo, ordem ou definição das ferramentas, histórico reescrito, effort). Sem isso os candidatos não se separam.
//
// O que cada coluna guarda (todas anuláveis; linha anterior à migration e chamada sem o bloco ficam NULL, sem preenchimento retroativo, que seria palpite):
//   - `system_hash`, `objective_hash`, `tools_hash`: sha256 hex (mesmo cálculo de `contextFingerprint`) do turno de sistema, do turno de objetivo do bot e da lista `tools` enviada.
//     NULL = o pedido não tinha o bloco (Chat geral sem objetivo, chamada sem ferramentas).
//   - `history_hash` e `history_turns`: hash e contagem de turnos do histórico inteiro (tudo que não é sistema nem objetivo, na ordem do pedido).
//   - `history_round_hashes`: hash do histórico até ANTES do turno que abre cada rodada (o que leva o bloco `# Dados`), em ordem. É o que localiza o ponto de quebra DENTRO do
//     histórico: se a chamada B estende a chamada A, `A.history_hash` aparece em `B.history_round_hashes` (ou é o próprio `B.history_hash`); se não aparece, a quebra está
//     antes, e comparar os vetores elemento a elemento diz em qual rodada. `history_prior_hash` é o último elemento (o histórico até o início da rodada atual), guardado à
//     parte só para consulta simples.
//   - `effort`: nível de effort enviado (vocabulário fechado de `EFFORT_LEVELS`, não é conteúdo da conversa); NULL = o modelo não recebeu effort.
//
// Só hash e contagem, nunca texto, e os CHECKs de formato impedem que conteúdo da conversa entre por engano (64 caracteres hex por elemento). Os hashes não reconstroem o texto.
//
// Aditiva: só cria colunas anuláveis, então roda no deploy sem pedido explícito do dono; o worker antigo, durante o deploy, não as escreve e a linha fica NULL. O CHECK é de
// coluna (e some junto com ela). Rollback: remove só as colunas novas. É telemetria derivada, então descartá-la só perde o diagnóstico da queda de cache; chamadas, usos,
// checkpoints e conversas ficam intactos. Idempotente (`IF [NOT] EXISTS`), como pede a prova de rollback das migrations.
import type { Migration } from '../migrator';

/** Coluna de hash sha256 em hex (64 caracteres); o CHECK é a garantia de que só hash entra. */
const hashColumn = (name: string): string => `ADD COLUMN IF NOT EXISTS ${name} text CHECK (${name} ~ '^[0-9a-f]{64}$')`;

export const requestBlockHashesMigration: Migration = {
  id: '0052_request_block_hashes',
  description: 'Hash por bloco do pedido (sistema, objetivo, ferramentas, histórico e rodadas) e effort por chamada ao modelo (anuláveis)',
  up: `ALTER TABLE model_call_usage
    ${hashColumn('system_hash')},
    ${hashColumn('objective_hash')},
    ${hashColumn('tools_hash')},
    ${hashColumn('history_hash')},
    ADD COLUMN IF NOT EXISTS history_turns integer CHECK (history_turns >= 0),
    ADD COLUMN IF NOT EXISTS history_round_hashes text[] CHECK (array_to_string(history_round_hashes, ',') ~ '^([0-9a-f]{64}(,[0-9a-f]{64})*)?$'),
    ${hashColumn('history_prior_hash')},
    ADD COLUMN IF NOT EXISTS effort text CHECK (char_length(effort) BETWEEN 1 AND 64);`,
  rollback: `ALTER TABLE model_call_usage
    DROP COLUMN IF EXISTS system_hash,
    DROP COLUMN IF EXISTS objective_hash,
    DROP COLUMN IF EXISTS tools_hash,
    DROP COLUMN IF EXISTS history_hash,
    DROP COLUMN IF EXISTS history_turns,
    DROP COLUMN IF EXISTS history_round_hashes,
    DROP COLUMN IF EXISTS history_prior_hash,
    DROP COLUMN IF EXISTS effort;`,
};
