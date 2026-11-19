// Migration 0044: bloco `# Dados` do pedido gravado por execução (phase 10, T1; PERF-01 substituída; spec decisões 1 a 7).
//
// Modelagem: `runs.request_data` guarda o texto do cabeçalho `# Dados` (modelo desta resposta, "Agora" até o minuto e fuso) mais o título `# Mensagem`, exatamente
// como `currentDataBlock` (`runs/context.ts`) o monta. É escrito UMA vez, na primeira preparação da execução que responde a rodada (`UPDATE ... WHERE request_data IS
// NULL`, sob a posse), e depois só lido: toda etapa, retomada (aprovação, reinício) e rodada seguinte reenvia o mesmo texto, byte a byte, no turno que abre a rodada,
// para o provedor reaproveitar o prefixo em cache. Antes, só a rodada atual levava o bloco e a hora era lida de novo a cada posse, o que quebrava o cache.
// Fica na execução e NÃO em `messages` de propósito: o bloco é contexto do pedido, não conteúdo da conversa, então nunca aparece na tela, em `search_history`, em
// `read_activity` nem na entrada do resumo da compactação (todos leem `messages`).
// Execuções anteriores a esta migration ficam com NULL e continuam entrando sem bloco (sem preenchimento retroativo, que seria um palpite); a execução em andamento no
// deploy recebe o bloco na próxima preparação.
// Aditiva: só cria uma coluna anulável, então roda no deploy sem pedido explícito do dono; o worker antigo, durante o deploy, a ignora.
// O CHECK limita o tamanho (o bloco real tem poucas centenas de caracteres: modelo de até 200, fuso IANA e a hora por extenso); mudar o formato do bloco não exige migration.
//
// Rollback: remove só a coluna. As rodadas voltam a entrar sem bloco, exceto a da execução em curso, que volta a ganhá-lo na hora (comportamento da phase 3); execuções,
// mensagens e conversas ficam intactas. Idempotente (`IF EXISTS`), como pede a prova de rollback das migrations.
import type { Migration } from '../migrator';

export const runRequestDataMigration: Migration = {
  id: '0044_run_request_data',
  description: 'Bloco "# Dados" do pedido gravado uma vez por execução (modelo, hora e fuso da primeira preparação)',
  up: 'ALTER TABLE runs ADD COLUMN IF NOT EXISTS request_data text CHECK (request_data IS NULL OR char_length(request_data) BETWEEN 1 AND 2000);',
  rollback: 'ALTER TABLE runs DROP COLUMN IF EXISTS request_data;',
};
