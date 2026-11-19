// Persistência independente dos bots: somente a associação aponta para bots; células escalares são JSONB.
// Vínculos são separados e têm FKs compostas para impedir IDs de coluna/registro de outra tabela.
import type { Migration } from '../migrator';

export const botTablesMigration: Migration = {
  id: '0030_bot_tables', description: 'Tabelas compartilhadas, registros, vínculos e recibos de mutações',
  up: `
    CREATE TABLE data_tables (
      id uuid PRIMARY KEY, name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
      description text NOT NULL DEFAULT '' CHECK (char_length(description) <= 1000),
      version integer NOT NULL DEFAULT 1 CHECK (version > 0), schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version > 0),
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE table_bot_access (
      table_id uuid NOT NULL REFERENCES data_tables(id) ON DELETE CASCADE,
      bot_id uuid NOT NULL REFERENCES bots(id) ON DELETE CASCADE, PRIMARY KEY (table_id, bot_id)
    );
    CREATE INDEX table_bot_access_bot ON table_bot_access(bot_id);
    CREATE TABLE table_columns (
      table_id uuid NOT NULL REFERENCES data_tables(id) ON DELETE CASCADE, id uuid NOT NULL,
      position integer NOT NULL CHECK (position >= 0), definition jsonb NOT NULL CHECK (jsonb_typeof(definition) = 'object'),
      target_table_id uuid REFERENCES data_tables(id) ON DELETE RESTRICT,
      PRIMARY KEY (table_id, id), UNIQUE (table_id, id, target_table_id)
    );
    CREATE INDEX table_columns_target ON table_columns(target_table_id);
    CREATE TABLE table_records (
      table_id uuid NOT NULL REFERENCES data_tables(id) ON DELETE CASCADE, id uuid NOT NULL,
      version integer NOT NULL DEFAULT 1 CHECK (version > 0), values jsonb NOT NULL CHECK (jsonb_typeof(values) = 'object'),
      PRIMARY KEY (table_id, id)
    );
    CREATE TABLE table_links (
      table_id uuid NOT NULL, record_id uuid NOT NULL, column_id uuid NOT NULL, target_table_id uuid NOT NULL, target_record_id uuid NOT NULL,
      PRIMARY KEY (table_id, record_id, column_id, target_record_id),
      FOREIGN KEY (table_id, record_id) REFERENCES table_records(table_id, id) ON DELETE CASCADE,
      FOREIGN KEY (table_id, column_id, target_table_id) REFERENCES table_columns(table_id, id, target_table_id) ON DELETE RESTRICT,
      FOREIGN KEY (target_table_id, target_record_id) REFERENCES table_records(table_id, id) ON DELETE RESTRICT
    );
    CREATE INDEX table_links_column ON table_links(table_id, column_id, target_table_id);
    CREATE INDEX table_links_target ON table_links(target_table_id, target_record_id);
    CREATE TABLE table_deduplication (
      table_id uuid NOT NULL REFERENCES data_tables(id) ON DELETE CASCADE, key text NOT NULL CHECK (char_length(key) BETWEEN 1 AND 200),
      payload_hash text NOT NULL, record_id uuid NOT NULL, PRIMARY KEY (table_id, key)
    );
    CREATE TABLE table_mutation_receipts (
      actor text NOT NULL, operation_id uuid NOT NULL, table_id uuid NOT NULL, action text NOT NULL,
      payload_hash text NOT NULL, result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (actor, operation_id)
    );
    CREATE INDEX table_mutation_receipts_table ON table_mutation_receipts(table_id);
  `,
  // Rollback de aplicação mantém as relações com dados. Só o banco vazio pode remover o schema pelo SQL abaixo;
  // dados existentes exigem backup/autorização e mantêm a migration registrada para a reaplicação não colidir.
  rollback: `
    DO $$ BEGIN
      IF to_regclass('public.data_tables') IS NOT NULL THEN
        IF EXISTS (SELECT 1 FROM data_tables) OR EXISTS (SELECT 1 FROM table_mutation_receipts) THEN
          RAISE EXCEPTION 'Rollback de tabelas exige banco vazio; preserve os dados no rollback de aplicação';
        END IF;
      END IF;
    END $$;
    DROP TABLE IF EXISTS table_mutation_receipts, table_deduplication, table_links, table_records, table_columns, table_bot_access, data_tables;
  `,
};
