// Preparações guardam a revisão e o impacto confiáveis. Argumentos do motor ficam separados do resumo visual.
import type { Migration } from '../migrator';

export const tableOperationsMigration: Migration = {
  id: '0032_table_operations', description: 'Preparações destrutivas e argumentos íntegros de ferramentas',
  up: `
    ALTER TABLE messages ADD COLUMN tool_arguments text;
    CREATE TABLE table_operation_preparations (
      id uuid PRIMARY KEY, actor text NOT NULL, table_id uuid NOT NULL,
      definition jsonb NOT NULL, impact jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
    );
  `,
  // O rollback da aplicação mantém preparações e chamadas; remoção do schema só cabe sem esses dados.
  rollback: `
    DO $$ BEGIN
      IF to_regclass('public.table_operation_preparations') IS NOT NULL THEN
        IF EXISTS (SELECT 1 FROM table_operation_preparations) OR EXISTS (SELECT 1 FROM messages WHERE tool_arguments IS NOT NULL) THEN
          RAISE EXCEPTION 'Preserve preparações e argumentos no rollback de aplicação';
        END IF;
      END IF;
    END $$;
    DROP TABLE IF EXISTS table_operation_preparations;
    ALTER TABLE messages DROP COLUMN IF EXISTS tool_arguments;
  `,
};
