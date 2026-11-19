// Migration 0014: modelo padrão do Chat geral (T23, F16; F8).
//
// Modelagem: `general_chat_settings` guarda UMA linha (o dono é único): o modelo e o effort com que toda sessão nova do chat geral começa.
// Sem a linha, o padrão "não foi definido" e o chat geral não deixa conversar (o composer pede o padrão em Configurações). A linha só nasce
// no primeiro "salvar" do dono, por isso a migration não insere nada.
// - singleton: chave primária booleana presa em `true` (CHECK), o jeito de o banco garantir "no máximo uma linha" sem uma coluna de id.
// - model e effort: os mesmos limites das colunas do bot (`bots.model`, `bots.effort`); a autoridade sobre o modelo existir na lista do
//   provedor e aceitar o effort é do serviço, na hora de gravar (`ModelService.validateSelection`).
// Quem lê é a resolução do modelo de uma conversa (`resolveModelChoice`, só para sessões, entre a preferência da conversa e "nenhum
// modelo"); quem altera é só o dono, pela API.
// Aditiva: só cria uma tabela, então roda no deploy sem pedido explícito do dono. Durante o deploy, a API e o worker antigos ignoram a
// tabela e continuam resolvendo o modelo das sessões pelo primeiro favorito, como antes da T23.
import type { Migration } from '../migrator';

export const generalChatSettingsMigration: Migration = {
  id: '0014_general_chat_settings',
  description: 'Modelo e effort padrão do Chat geral',
  up: `
    CREATE TABLE general_chat_settings (
      singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
      model text NOT NULL CHECK (char_length(model) BETWEEN 1 AND 200),
      effort text CHECK (effort IS NULL OR char_length(effort) BETWEEN 1 AND 32),
      updated_at timestamptz NOT NULL
    );
  `,
  // Rollback: apaga o padrão do Chat geral (o chat volta a exigir a escolha do modelo, ou o primeiro favorito na versão anterior). Nada de
  // sessões, mensagens, bots ou preferências de conversa é tocado.
  rollback: `
    DROP TABLE general_chat_settings;
  `,
};
