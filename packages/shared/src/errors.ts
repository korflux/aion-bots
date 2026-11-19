// Registro único dos códigos de erro públicos do Aion.
//
// Fonte de verdade compartilhada: o core lança `DomainError(code)`, o handler central da API traduz o código
// em status HTTP + mensagem segura, e a web usa o mesmo `ErrorCode` para reagir (ex.: AUTH_SESSION_EXPIRED
// redireciona ao login). Mensagens ficam aqui, nunca no ponto de lançamento, para que nenhum detalhe interno
// (SQL, caminho, stack) consiga vazar por acidente.
import { z } from 'zod';

export const ERROR_CODES = {
  CONTEXT_ESTIMATE_UNAVAILABLE: { status: 422, message: 'Não há estimativa fundamentada do espaço necessário para estas imagens. O pedido e os anexos foram preservados; a tarefa não foi concluída.' },
  CONTEXT_TOO_LARGE: { status: 422, message: 'O contexto obrigatório excede a janela configurada. O histórico foi preservado e a tarefa não foi concluída.' },
  CONTEXT_COMPACTION_FAILED: { status: 503, message: 'Não foi possível preparar um resumo seguro. O histórico foi preservado.' },
  // A15: a etapa prepara de novo UMA vez quando o modelo, a janela ou o effort mudam no meio da preparação; só a segunda mudança na mesma etapa chega aqui.
  // Sem a evidência das fontes enviadas, ou com uma fonte removida ou revogada depois da preparação, não há como reservar nem registrar a chamada. Nenhum dos dois envolve
  // resumo (o código da compactação é o de cima).
  CONTEXT_CONFIGURATION_CHANGED: { status: 409, message: 'O modelo ou a configuração do contexto continuou mudando durante a preparação da etapa. O histórico foi preservado e a tarefa não foi concluída. Tente de novo.' },
  CONTEXT_EVIDENCE_UNAVAILABLE: { status: 503, message: 'Não foi possível confirmar as fontes do contexto desta etapa. O histórico foi preservado e a tarefa não foi concluída.' },
  CONTEXT_CONFLICT: { status: 409, message: 'O contexto mudou. Atualize os dados antes de compactar.' },
  CONTEXT_BUSY: { status: 409, message: 'A conversa tem trabalho ou aprovação pendente. Aguarde antes de compactar.' },
  // Tabelas: erros estáveis do serviço compartilhado, sem nomes ou conteúdo dos dados.
  TABLE_NOT_FOUND: { status: 404, message: 'Tabela ou registro não encontrado.' },
  // Phase 11 (TAB-03): o id curto de registro que o modelo copia de `table_query` coincide com mais de um registro da tabela (colisão fora do resultado ou registro criado
  // depois). Só as ferramentas de tabela o lançam; o resultado delas traz, ao lado deste código e da mensagem (fonte única), os ids completos candidatos e o nome de cada
  // registro, para o modelo refazer a chamada sem o dono. O serviço nunca escolhe um dos candidatos.
  TABLE_RECORD_AMBIGUOUS: { status: 422, message: 'Mais de um registro começa com este id. Use o id completo.' },
  TABLE_IMPORT_INVALID: { status: 422, message: 'Arquivo de importação inválido, truncado ou ambíguo. Use JSON versionado com IDs, colunas e valores completos; não foram importadas células deste lote.' },
  TABLE_IMPORT_SOURCE_CHANGED: { status: 409, message: 'O hash do arquivo não corresponde à inspeção. Inspecione novamente antes de continuar.' },
  TABLE_IMPORT_BINDING: { status: 422, message: 'Mapeamento de importação incompleto ou incompatível. Crie as tabelas base, informe seus IDs e aplique a estrutura antes dos registros e vínculos.' },
  TABLE_IMPORT_PARTIAL: { status: 409, message: 'Grupo interrompido após confirmar uma parte. Cada suboperação é atômica (lote de registros por tabela, estrutura por tabela ou vista individual), mas o grupo pode ter progresso. Retome a mesma operação com o mesmo operationId, hash, offset e bindings; recibos e dedup preservam o que já foi confirmado.' },
  TABLE_ACCESS_DENIED: { status: 403, message: 'Acesso à tabela não permitido.' },
  TABLE_CONFLICT: { status: 409, message: 'Os dados mudaram. Recarregue antes de salvar.' },
  APPROVAL_REQUIRED: { status: 403, message: 'Esta operação exige aprovação antes de executar.' },
  TABLE_INVALID_SCHEMA: { status: 422, message: 'Estrutura de tabela inválida.' },
  TABLE_INVALID_FORMULA: { status: 422, message: 'Fórmula inválida ou incompatível com as colunas.' },
  TABLE_CELL_ERROR: { status: 422, message: 'A consulta ou agregação depende de uma célula com erro. Corrija a fórmula ou os dados.' },
  TABLE_INVALID_VALUE: { status: 422, message: 'Valor inválido para a coluna.' },
  TABLE_LIMIT_EXCEEDED: { status: 409, message: 'O limite de tabelas ou registros foi atingido.' },
  TABLE_QUERY_LIMIT: { status: 422, message: 'Consulta excede os limites permitidos.' },
  TABLE_COLUMNS_INCOMPLETE: { status: 409, message: 'columns exige a lista completa de colunas visíveis. Releia table_get, preserve IDs e definições existentes e acrescente as novas. Omissão não exclui coluna; exclusões usam a operação destrutiva.' },
  TABLE_DEPENDENCY: { status: 409, message: 'Esta alteração exige ajustar dependências e confirmar seu impacto.' },
  TABLE_RESOURCE_REMOVED: { status: 409, message: 'O recurso desta operação foi removido.' },
  // Docs (phase 14, DOC-01 a DOC-03): erros estáveis do serviço de docs, sem título nem texto. `DOC_NOT_FOUND` é a resposta única de um id que não existe e de um doc que o bot
  // não acessa (a recusa não revela se o doc existe, A13). `DOC_CONFLICT` cobre a versão esperada (ou a revisão de acesso) antiga, a mesma operação repetida com outro conteúdo
  // e a execução que perdeu a posse. `DOC_TEXT_NOT_FOUND` e `DOC_TEXT_AMBIGUOUS` são do "substituir trecho exato": viram resultado de ferramenta que o modelo lê e corrige.
  DOC_NOT_FOUND: { status: 404, message: 'Doc não encontrado.' },
  DOC_ACCESS_DENIED: { status: 403, message: 'Acesso ao doc não permitido.' },
  DOC_CONFLICT: { status: 409, message: 'O doc mudou. Recarregue antes de salvar.' },
  DOC_TOO_LARGE: { status: 422, message: 'O doc passou de 100.000 caracteres.' },
  DOC_LIMIT_EXCEEDED: { status: 409, message: 'O limite de 100 docs foi atingido.' },
  DOC_VERSION_NOT_FOUND: { status: 404, message: 'Versão do doc não encontrada.' },
  DOC_TEXT_NOT_FOUND: { status: 422, message: 'O trecho a substituir não existe exatamente no doc. Leia o doc de novo e copie o trecho como está.' },
  DOC_TEXT_AMBIGUOUS: { status: 422, message: 'O trecho a substituir aparece mais de uma vez no doc. Inclua mais texto ao redor para ele ser único.' },
  MODEL_NO_IMAGE_SUPPORT: { status: 422, message: 'Este modelo não aceita imagens. Escolha outro modelo.' },
  MODEL_IMAGE_CHECK_FAILED: { status: 503, message: 'Não consegui verificar o modelo agora. Tente de novo.' },
  OBJECTIVE_CONFLICT: { status: 409, message: 'O objetivo mudou depois desta atualização. Oriente o bot na conversa.' },
  OBJECTIVE_UPDATE_NOT_FOUND: { status: 404, message: 'Atualização de objetivo não encontrada.' },
  // Genéricos da borda HTTP
  VALIDATION_FAILED: { status: 422, message: 'Dados inválidos.' },
  BAD_REQUEST: { status: 400, message: 'Requisição malformada.' },
  PAYLOAD_TOO_LARGE: { status: 413, message: 'Corpo da requisição grande demais.' },
  UNSUPPORTED_MEDIA_TYPE: { status: 415, message: 'Tipo de conteúdo não suportado.' },
  NOT_FOUND: { status: 404, message: 'Não encontrado.' },
  INTERNAL_ERROR: { status: 500, message: 'Erro interno. Tente novamente.' },
  SERVICE_UNAVAILABLE: { status: 503, message: 'Serviço indisponível. Tente novamente.' },
  // Autenticação e sessão (F1)
  AUTH_INVALID_CREDENTIALS: { status: 401, message: 'E-mail ou senha incorretos.' },
  AUTH_LOCKED: { status: 429, message: 'Muitas tentativas. Tente novamente em alguns minutos.' },
  AUTH_SESSION_EXPIRED: { status: 401, message: 'Sessão expirada. Entre novamente.' },
  AUTH_SESSION_NOT_FOUND: { status: 404, message: 'Sessão não encontrada.' },
  // Autenticador TOTP (F1 segundo passo, F2 ativar e desativar)
  AUTH_TOTP_INVALID: { status: 401, message: 'Código inválido.' },
  AUTH_TOTP_EXPIRED: { status: 401, message: 'O tempo expirou. Entre novamente.' },
  TOTP_ALREADY_ENABLED: { status: 409, message: 'O autenticador já está ativo.' },
  TOTP_NOT_ENABLED: { status: 409, message: 'O autenticador não está ativo.' },
  TOTP_SETUP_EXPIRED: { status: 410, message: 'A ativação expirou. Feche e tente novamente.' },
  // Proteção CSRF (origem e token vinculado à sessão)
  CSRF_ORIGIN_INVALID: { status: 403, message: 'Origem da requisição não permitida.' },
  CSRF_TOKEN_INVALID: { status: 403, message: 'Token de segurança inválido. Recarregue a página.' },
  // Chaves de terceiros (F3 OpenCode Go e F4 Composio). `*_UNAVAILABLE` é 503 (e não 502) para nenhum proxy
  // na frente da API trocar o corpo do erro por uma página própria de "bad gateway".
  PROVIDER_KEY_INVALID: { status: 422, message: 'Chave recusada pelo provedor.' },
  PROVIDER_UNAVAILABLE: { status: 503, message: 'Provedor indisponível. Tente novamente.' },
  PROVIDER_NOT_CONFIGURED: { status: 409, message: 'Configure um provedor.' },
  // Saldo da Anthropic esgotado (phase 17, A20): a chamada de chat que recebe a recusa de cobrança (HTTP 402 `billing_error`, ou a mensagem de saldo baixo) para a execução, o resumo e o teste do
  // modelo com este código, sem nova tentativa nem outro provedor; é também o que a sonda de salvar a chave devolve (a chave não é gravada) e o `failure_code` do cartão de falha, que o push mostra.
  PROVIDER_CREDITS_EXHAUSTED: { status: 402, message: 'Créditos da Anthropic esgotados.' },
  CONNECTOR_KEY_INVALID: { status: 422, message: 'Chave recusada pelo Composio.' },
  CONNECTOR_UNAVAILABLE: { status: 503, message: 'Composio indisponível. Tente novamente.' },
  CONNECTOR_NOT_CONFIGURED: { status: 409, message: 'Conecte o Composio.' },
  // Contas do conector por bot (phase 13, CONN-02): só os dois erros de borda da tela de Conexões, nome repetido dentro do mesmo app e versão esperada antiga ao renomear ou liberar
  // (as contas mudaram em outra aba; `TABLE_CONFLICT` não é reaproveitado porque a tela recarrega as contas, não uma tabela). A recusa de uma conta na execução (não liberada ao bot,
  // desconectada do Composio, ausente ou ambígua) NÃO é erro de borda: é o resultado de ferramenta que o modelo lê (`AccountRefusal`, em `runs/tools.ts`), então não tem código aqui.
  CONNECTOR_ACCOUNT_NAME_TAKEN: { status: 409, message: 'Já existe uma conta com esse nome neste app.' },
  CONNECTOR_ACCOUNT_CONFLICT: { status: 409, message: 'As contas mudaram. Recarregue antes de salvar.' },
  // Chave opcional da pesquisa na web (Parallel, phase 1 T8). Só a validação ao salvar a lança: a pesquisa em si (T9) devolve ao modelo um
  // resultado de ferramenta seguro, nunca estes códigos. Sem `*_NOT_CONFIGURED`: a pesquisa funciona sem chave (nível anônimo).
  WEB_SEARCH_KEY_INVALID: { status: 422, message: 'Chave recusada pela Parallel.' },
  WEB_SEARCH_UNAVAILABLE: { status: 503, message: 'Não foi possível validar agora.' },
  RATE_LIMITED: { status: 429, message: 'Muitas solicitações. Aguarde um instante e tente novamente.' },
  // Anexos: mensagens públicas sem conteúdo externo.
  ATTACHMENT_TYPE_UNSUPPORTED: { status: 422, message: 'Este tipo de arquivo não é aceito.' },
  ATTACHMENT_TOO_LARGE: { status: 413, message: 'O arquivo passa do tamanho permitido.' },
  ATTACHMENT_LIMIT_REACHED: { status: 422, message: 'Uma mensagem aceita até 5 arquivos.' },
  ATTACHMENT_NO_TEXT: { status: 422, message: 'Não encontrei texto neste documento (talvez seja escaneado).' },
  ATTACHMENT_UNREADABLE: { status: 422, message: 'Não consegui ler este arquivo.' },
  ATTACHMENT_QUOTA_EXCEEDED: { status: 409, message: 'O espaço para arquivos acabou. Exclua arquivos em Configurações → Arquivos.' },
  ATTACHMENT_NOT_FOUND: { status: 404, message: 'Arquivo não encontrado.' },
  ATTACHMENT_IN_USE: { status: 409, message: 'O arquivo está em uso por uma execução. Tente de novo quando ela terminar.' },
  // Bots (F5)
  BOT_NOT_FOUND: { status: 404, message: 'Bot não encontrado.' },
  BOT_NAME_TAKEN: { status: 409, message: 'Já existe um bot ativo com esse nome.' },
  // Exclusão definitiva (DATA-01, F6): só vale para bot arquivado e sem execução em andamento ou na fila (nada é cancelado sozinho). Nome
  // digitado que não confere NÃO tem código próprio: é `VALIDATION_FAILED` com o campo `confirmName` (a tela mostra o motivo no campo).
  BOT_NOT_ARCHIVED: { status: 409, message: 'Arquive o bot antes de excluir.' },
  BOT_HAS_OPEN_RUN: { status: 409, message: 'O bot tem execuções em andamento ou na fila. Aguarde terminarem ou pare-as e tente de novo.' },
  // Modelos (F8): o modelo pedido não consta na lista atual do provedor (ou não há modelo para usar).
  MODEL_UNAVAILABLE: { status: 422, message: 'Modelo indisponível. Escolha outro modelo.' },
  // Conversa e execuções (F6, F7). `PROVIDER_ERROR` também é gravado no cartão de falha (a execução falha sem resposta HTTP),
  // por isso vive no mesmo registro de mensagens seguras. A falha de uma ferramenta é o estado `failed` da atividade, com o texto seguro no resultado (o bot o recebe e decide), como
  // `MODEL_TEST_FAILED` na T5; desde a phase 15 (A21) esse resultado é sempre o envelope `{ code, message }`, e os códigos `TOOL_*`, `ACTION_NOT_FOUND` e `CONNECTOR_ACCOUNT_REFUSED` abaixo
  // são os que o executor e o conector dão quando a ferramenta não traz um código próprio. A mensagem fixa do registro é o padrão; o ponto que lança pode dar outra, com o que fazer em seguida.
  BOT_ARCHIVED: { status: 409, message: 'Este bot está arquivado. Desarquive para continuar.' },
  QUEUE_FULL: { status: 429, message: 'A fila desta conversa está cheia. Aguarde as mensagens em andamento.' },
  RUN_NOT_ACTIVE: { status: 409, message: 'Não há execução ativa para parar.' },
  RUN_NOT_RETRYABLE: { status: 409, message: 'Esta execução não pode ser repetida.' },
  // Complemento durante a execução (phase 4, F5, CONV-03): teto de pendentes por execução, complemento que já foi lido, promovido ou
  // cancelado (o cancelamento chegou tarde) e rascunho devolvido que outro aparelho já usou, descartou ou que venceu (24 horas).
  COMPLEMENT_LIMIT_REACHED: { status: 429, message: 'Muitos complementos aguardando. Espere o assistente ler os anteriores.' },
  COMPLEMENT_NOT_FOUND: { status: 404, message: 'Este complemento já foi lido pelo assistente.' },
  DRAFT_NOT_FOUND: { status: 404, message: 'Este rascunho já foi usado em outro aparelho.' },
  // Versões do Chat geral (phase 4, F1 a F4): toda troca de caminho espera a sessão parada (sem execução aberta nem complemento pendente), e a
  // versão pedida precisa existir no caminho ativo da sessão (ou ser irmã dele, na troca de versão).
  CONVERSATION_BUSY: { status: 409, message: 'Pare a execução para editar.' },
  VERSION_NOT_FOUND: { status: 404, message: 'Esta versão não existe mais.' },
  PROVIDER_ERROR: { status: 503, message: 'O provedor falhou ao responder. Tente novamente.' },
  // Falhas de ferramenta que o MODELO lê (phase 15, A16 e A21; não saem pela API HTTP). Cada mensagem diz o que fazer em seguida e nunca carrega detalhe interno (caminho, consulta, pilha):
  // `TOOL_FAILED` é a falha esperada em texto e a inesperada (bug), `TOOL_NOT_FOUND` e `ACTION_NOT_FOUND` a chamada a algo que não existe, `TOOL_RESULT_TOO_LARGE` o limite de tamanho do resultado de uma
  // ferramenta (o genérico; `TABLE_QUERY_LIMIT` segue sendo o da consulta de tabelas) e `CONNECTOR_ACCOUNT_REFUSED` a conta do conector que o bot não pode usar.
  TOOL_FAILED: { status: 500, message: 'A ferramenta falhou. Tente de novo; se repetir, siga sem ela e avise o dono.' },
  TOOL_NOT_FOUND: { status: 404, message: 'Ferramenta desconhecida. Use só as ferramentas da sua lista.' },
  ACTION_NOT_FOUND: { status: 404, message: 'Ação desconhecida. Busque com composio_search_actions e use o slug exato.' },
  TOOL_RESULT_TOO_LARGE: { status: 422, message: 'O resultado passou do limite desta ferramenta. Repita pedindo menos itens ou com um filtro mais estreito.' },
  CONNECTOR_ACCOUNT_REFUSED: { status: 403, message: 'Conta do conector não permitida a este bot. A ação não foi executada.' },
  // Aprovações (F9, T7): só uma aprovação pendente aceita resposta; depois de respondida, repetir a MESMA decisão é inofensivo
  // (idempotente) e outra decisão é recusada; depois do prazo de 24 horas a resposta é recusada.
  APPROVAL_NOT_PENDING: { status: 409, message: 'Esta aprovação já foi respondida.' },
  APPROVAL_EXPIRED: { status: 410, message: 'Esta aprovação expirou.' },
  // Memória (F11, T8): limite de 8.000 caracteres, salvamento com versão esperada (conflito preserva o texto digitado na tela) e
  // versão inexistente (restaurar uma que a retenção já apagou, ou que nunca existiu).
  MEMORY_TOO_LARGE: { status: 422, message: 'A memória passou de 8.000 caracteres.' },
  MEMORY_CONFLICT: { status: 409, message: 'A memória mudou enquanto você editava. Recarregue para ver a versão atual.' },
  MEMORY_VERSION_NOT_FOUND: { status: 404, message: 'Versão da memória não encontrada.' },
  // Rotinas (F12, T9): `SCHEDULE_INVALID` leva o motivo legível em `fields` (a tela o mostra no campo e na prévia); a data única no
  // passado é um código à parte porque a tela a trata como estado próprio ("data no passado").
  SCHEDULE_INVALID: { status: 422, message: 'Agenda inválida.' },
  SCHEDULE_IN_PAST: { status: 422, message: 'A data e a hora da execução já passaram.' },
  ROUTINE_NOT_FOUND: { status: 404, message: 'Rotina não encontrada.' },
  // T21: a proposta de alteração de um bot ficou desatualizada (a rotina mudou ou foi excluída depois); nada foi aplicado.
  // Phase 10 (A15): o mesmo código cobre o cartão do que o bot aplicou que o dono já resolveu (editar um cartão já recusado ou editado, ou recusar um já editado) e o que ficou para
  // trás porque a rotina mudou. A mensagem única (fonte única, o ponto de lançamento nunca a repete) diz os dois motivos: "a rotina mudou" sozinho não descreve um cartão já resolvido.
  // Não manda pedir nova proposta ao bot: no fluxo novo o bot já aplicou e o dono resolve pela rotina; no antigo, o cartão "Desatualizada" traz esse conselho sozinho.
  ROUTINE_CHANGED: { status: 409, message: 'A rotina mudou depois desta proposta, ou o cartão já foi resolvido.' },
  // Chat geral (F16, T12): a sessão não existe mais (apagada pela retenção de 7 dias) ou nunca existiu; a tela mostra "Esta sessão expirou".
  SESSION_NOT_FOUND: { status: 404, message: 'Esta sessão não existe mais. Ela pode ter expirado.' },
  // Notificações (F14, T10): a permissão é do navegador, então este código nunca sai da API; a web o usa para mostrar a instrução
  // inline (faixa de aviso) com a mesma mensagem e o mesmo código estável da spec.
  PUSH_PERMISSION_DENIED: { status: 403, message: 'As notificações estão bloqueadas neste navegador. Libere nas configurações do site e tente de novo.' },
} as const satisfies Record<string, { status: number; message: string }>;

export type ErrorCode = keyof typeof ERROR_CODES;

/** Campo e motivo de uma falha de validação (F5: "VALIDATION_FAILED (campo e motivo)"). */
export const fieldErrorSchema = z.object({ field: z.string(), reason: z.string() });
export type FieldError = z.infer<typeof fieldErrorSchema>;

/** Envelope padrão de erro de toda resposta não-2xx: `{ code, message }` (+ `fields` só na validação). */
export const errorEnvelopeSchema = z.object({
  code: z.string(),
  message: z.string(),
  fields: z.array(fieldErrorSchema).optional(),
});
export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;

/** Monta o envelope público de um código, sempre com a mensagem segura do registro. */
export function toErrorEnvelope(code: ErrorCode, fields?: FieldError[]): ErrorEnvelope {
  const envelope: ErrorEnvelope = { code, message: ERROR_CODES[code].message };
  if (fields && fields.length > 0) envelope.fields = fields;
  return envelope;
}

/** Type guard para o cliente: o corpo de erro veio no formato do envelope? */
export function isErrorEnvelope(value: unknown): value is ErrorEnvelope {
  return errorEnvelopeSchema.safeParse(value).success;
}
