// Vistas são só definições compartilhadas, sem cópia de linhas ou concessão própria de acesso.
import type { Migration } from '../migrator';
export const tableViewsMigration: Migration = {
  id: '0031_table_views', description: 'Vistas revisadas das tabelas',
  up: `CREATE TABLE table_views (
    table_id uuid NOT NULL REFERENCES data_tables(id) ON DELETE CASCADE,
    id uuid NOT NULL, name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
    version integer NOT NULL DEFAULT 1 CHECK (version > 0), definition jsonb NOT NULL,
    PRIMARY KEY (table_id, id)
  );`,
  rollback: `DO $$ BEGIN
    IF to_regclass('public.table_views') IS NOT NULL THEN
      IF EXISTS (SELECT 1 FROM table_views) THEN
        RAISE EXCEPTION 'Rollback de vistas exige banco vazio; preserve as vistas no rollback de aplicação';
      END IF;
    END IF;
  END $$; DROP TABLE IF EXISTS table_views;`,
};
