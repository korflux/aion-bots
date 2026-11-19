// Migration 0048: manutenção de contexto sem sessão do dono (phase 11, T8; F5, decisões 18 a 22; CTX-07 substituída parcialmente).
//
// O que muda: `context_maintenance.session_id` deixa de ser obrigatório. Até aqui toda linha da tabela nascia de um clique do dono em "Compactar agora" e guardava a sessão que o
// pediu (base do limite de pedidos por sessão). A compactação fria (`enqueueColdCompaction`, `runs/cold-maintenance.ts`) é enfileirada pelo worker quando a conversa esfria, sem
// nenhum gesto do dono e sem sessão: a linha dela é a ÚNICA com `session_id` nulo, e é por isso que o nulo basta como marca de "manutenção fria" (o executor a trata sem expor
// operação manual que o dono não pediu: o painel de contexto, `readContextState`, não a mostra, e a execução termina sempre concluída, nunca falha para o dono). Nenhuma coluna
// nova de "gatilho": a ausência de sessão já diz que não foi o dono.
//
// Aditiva: só afrouxa uma restrição, então roda no deploy sem pedido explícito do dono. O código anterior, durante o deploy, continua gravando `session_id` em toda linha dele
// e nunca lê a coluna, então a mistura de versões não quebra nada; as linhas já gravadas ficam como estão (todas com sessão). O índice `context_maintenance_session` continua
// valendo (as linhas frias simplesmente não entram nele pela chave nula).
//
// Rollback: devolve o NOT NULL SÓ se não existir linha fria, no padrão de guarda das migrations 0036 a 0038. Com manutenção fria gravada o rollback recusa: preencher uma sessão
// inventada falsearia o registro de quem pediu a operação, e apagar a linha perderia o recibo que impede pagar duas vezes o mesmo resumo para a mesma revisão. Quem precisa
// voltar o código mantém a coluna anulável (o código anterior a ignora). Nada é apagado, e o rollback é repetível (a segunda execução não encontra nada a mudar).
import type { Migration } from '../migrator';

export const coldCompactionMigration: Migration = {
  id: '0048_cold_compaction',
  description: 'Manutenção de contexto sem sessão do dono: session_id anulável para a compactação fria enfileirada pelo worker',
  up: `ALTER TABLE context_maintenance ALTER COLUMN session_id DROP NOT NULL;`,
  rollback: `DO $$ BEGIN
      IF to_regclass('public.context_maintenance') IS NOT NULL THEN
        IF EXISTS(SELECT 1 FROM context_maintenance WHERE session_id IS NULL) THEN RAISE EXCEPTION 'Preserve a manutencao fria gravada no rollback de aplicacao'; END IF;
        ALTER TABLE context_maintenance ALTER COLUMN session_id SET NOT NULL;
      END IF;
    END $$;`,
};
