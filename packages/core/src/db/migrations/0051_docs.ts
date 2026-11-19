// Migration 0051: docs em Markdown, versões, associação doc-bot e recibos de escrita (phase 14, passo 2; DOC-01 a DOC-03; spec decisões 2, 4, 12 e 17; A8, A15, A16, A25, A27).
//
// O que modela:
// - `docs`: um doc por linha, do DONO (sem chave estrangeira para bot: a exclusão do bot apaga só a associação, A25). Guarda o título (1 a 120 caracteres), o texto atual (até 100.000)
//   e duas revisões independentes: `version` (do TEXTO; sobe a cada alteração do texto, é a versão esperada de toda escrita e a mais recente do histórico) e `access_version` (da LISTA DE
//   BOTS; sobe a cada compartilhamento e a cada exclusão de bot com acesso, e é o que a proveniência das leituras do bot confere ao revogar, A33). `size` é gerada: conta CARACTERES (pontos de
//   código, como o contador da tela), sem o serviço ter de recalculá-la e sem a lista de docs ler o texto. Os limites de tamanho também são CHECK, última defesa se um caminho esquecer a
//   regra do serviço (`char_length` conta pontos de código).
// - `doc_versions`: uma linha IMUTÁVEL por alteração do texto (versão, texto inteiro, autor dono ou bot, de qual versão veio se foi restauração). Sem chave estrangeira para bot: o autor é
//   só "dono" ou "bot", então a exclusão do bot não toca no histórico. O texto inteiro é guardado (e não só o diff) porque restaurar precisa dele. Some com o doc (cascata). O índice por data
//   serve à retenção diária (90 dias, as 50 mais recentes de cada doc ficam: `DocService.purgeExpiredVersions`).
// - `doc_bot_access`: a associação, uma linha por par doc e bot, escolhida só pelo dono (molde de `table_bot_access`). Só ela depende do bot (cascata na exclusão); o doc fica.
// - `doc_mutation_receipts`: recibo idempotente por (ator, operação) de toda escrita (molde de `table_mutation_receipts`), para a repetição de uma escrita, como o replay de uma execução
//   abandonada, devolver o resultado gravado. SEM chave estrangeira para o doc: o recibo da exclusão tem de sobreviver a ela, para a retomada após reinício devolver o resultado gravado
//   em vez de "doc inexistente". O ator é texto (`owner` ou `bot:<id>`), também sem chave para o bot. O resultado guarda só metadados, nunca o texto do doc, e o TÍTULO sai de todos os recibos do doc quando ele é excluído (o serviço troca o resultado por `{"resourceRemoved":true}`; o da própria exclusão nasce sem título).
//
// Aditiva: só cria tabelas e índices; nenhuma tabela existente é alterada (as tabelas de dados, `data_tables` e as demais, ficam como estão), então roda no deploy sem pedido explícito do dono.
//
// Rollback (decisão do dono, spec 17): apaga as QUATRO tabelas MESMO com dados, sem a recusa com dados da 0030: os docs, as versões e as associações se perdem (o dono pode baixar os `.md` antes).
// O que NÃO volta atrás: o job de retenção dos docs fica agendado no pg-boss (fila e agendamento ficam no PostgreSQL, fora do schema do app) e, sem a tabela, falha a cada execução até
// a fila ser removida ou a migration reaplicada. Idempotente (`IF EXISTS`): roda de novo sem erro. Subir de novo recria as tabelas vazias.
import type { Migration } from '../migrator';

export const docsMigration: Migration = {
  id: '0051_docs',
  description: 'Docs em Markdown, versões imutáveis, associação doc-bot e recibos de escrita',
  up: `CREATE TABLE IF NOT EXISTS docs (
      id uuid PRIMARY KEY,
      title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
      content text NOT NULL DEFAULT '' CHECK (char_length(content) <= 100000),
      size integer GENERATED ALWAYS AS (char_length(content)) STORED,
      version integer NOT NULL DEFAULT 1 CHECK (version > 0),
      access_version integer NOT NULL DEFAULT 1 CHECK (access_version > 0),
      updated_by text NOT NULL CHECK (updated_by IN ('owner', 'bot')),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS doc_versions (
      doc_id uuid NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
      version integer NOT NULL CHECK (version > 0),
      content text NOT NULL CHECK (char_length(content) <= 100000),
      size integer GENERATED ALWAYS AS (char_length(content)) STORED,
      author text NOT NULL CHECK (author IN ('owner', 'bot')),
      restored_from integer CHECK (restored_from IS NULL OR restored_from > 0),
      created_at timestamptz NOT NULL,
      PRIMARY KEY (doc_id, version)
    );
    CREATE INDEX IF NOT EXISTS doc_versions_by_age ON doc_versions(created_at);
    CREATE TABLE IF NOT EXISTS doc_bot_access (
      doc_id uuid NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
      bot_id uuid NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
      PRIMARY KEY (doc_id, bot_id)
    );
    CREATE INDEX IF NOT EXISTS doc_bot_access_bot ON doc_bot_access(bot_id);
    CREATE TABLE IF NOT EXISTS doc_mutation_receipts (
      actor text NOT NULL,
      operation_id uuid NOT NULL,
      doc_id uuid NOT NULL,
      action text NOT NULL,
      payload_hash text NOT NULL,
      result jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (actor, operation_id)
    );
    CREATE INDEX IF NOT EXISTS doc_mutation_receipts_doc ON doc_mutation_receipts(doc_id);`,
  rollback: 'DROP TABLE IF EXISTS doc_mutation_receipts, doc_bot_access, doc_versions, docs;',
};
