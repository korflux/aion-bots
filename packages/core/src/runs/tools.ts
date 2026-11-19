// Contrato das ferramentas que o motor oferece ao modelo. O motor não conhece nenhuma ferramenta em particular: recebe uma
// lista de `ToolHandler`. A T6 registra só a busca no histórico; a T7 acrescenta as ações do Composio (externas, sob aprovação),
// e T8 (editar memória) e T9 (propor rotina) entraram como novos handlers, sem mexer no motor.
//
// Aprovação e efeito externo são independentes: Composio e mutações destrutivas locais declaram action e
// exigem prova emitida pelo executor. external controla apenas cancelamento e recuperação de efeitos fora do Aion.
//
// Uma chamada passa por duas fases: `prepare` valida os argumentos que o modelo mandou (dado externo e não confiável) e
// devolve o nome legível, que a tela mostra ANTES de executar; `execute` faz o trabalho. Falhas ESPERADAS (argumento
// inválido, nada encontrado, erro da ação) são `ToolFailure` com texto seguro: o bot as recebe como resultado e decide
// continuar ou encerrar (F6, TOOL_FAILED). Qualquer outra exceção é bug, vira falha genérica e vai só para o log.
import { ERROR_CODES, type ActivityDetail, type ApprovalImpact, type ArtifactRef, type ErrorCode } from '@aion/shared';
import { z } from 'zod';
import type { ApprovalProof } from '../approvals/proof';
import type { ActionInfo } from '../approvals/service';
import type { Pool } from '../db/pool';
import { describeArgumentIssues, parseToolArguments } from './tool-arguments';
import type { ChatTool } from '../models/chat-protocols';
import type { EvidenceProvenance } from './evidence-provenance';

/**
 * Falha esperada de uma ferramenta; a mensagem é segura para o modelo e para a tela. `detail` (opcional) é o detalhe estruturado que a atividade
 * falha ainda mostra ao dono (ex.: o `run_python` que estourou o tempo guarda o código e a saída, phase 4 F8).
 *
 * Envelope único (phase 15, A21): o que o modelo lê de QUALQUER falha de ferramenta é `{ "code", "message" }` (+ campos próprios, como `fields` ou os candidatos de um id curto), montado em
 * `failureResult`, o único ponto que o executor usa. Há dois jeitos de lançar: `new ToolFailure(texto)`, a falha em texto (a mensagem é o `message` do envelope e o código é `code`, `TOOL_FAILED`
 * por padrão), e `toolFailure(código, mensagem, extras)`, que já nasce no envelope (`enveloped`) e é o que as ferramentas com código próprio usam; a `message` dessa segunda forma é o JSON pronto.
 */
export class ToolFailure extends Error {
  constructor(
    message: string,
    readonly detail: ActivityDetail | null = null,
    /** Código do envelope quando a mensagem é texto (`TOOL_FAILED` se não houver um mais específico). */
    readonly code: ErrorCode = 'TOOL_FAILED',
    /** A mensagem já é o envelope JSON (fábrica `toolFailure`): `failureResult` a devolve como está. */
    readonly enveloped = false,
  ) {
    super(message);
    this.name = 'ToolFailure';
  }
}

/** O envelope de erro de ferramenta como texto: `{ code, message, ...extras }`. A mensagem padrão é a do registro de códigos (`ERROR_CODES`), a mesma de toda a borda do Aion. */
export function failureEnvelope(code: ErrorCode, message: string = ERROR_CODES[code].message, extras: Record<string, unknown> = {}): string {
  return JSON.stringify({ code, message, ...extras });
}

/** Falha de ferramenta já no envelope (ver `ToolFailure`): código estável, mensagem que diz o que fazer em seguida e, se couber, campos próprios (`fields`, candidatos). Nunca valor nem detalhe interno. */
export function toolFailure(code: ErrorCode, message: string = ERROR_CODES[code].message, extras: Record<string, unknown> = {}, detail: ActivityDetail | null = null): ToolFailure {
  return new ToolFailure(failureEnvelope(code, message, extras), detail, code, true);
}

/** O resultado que o modelo lê de uma falha de ferramenta: o envelope dela, ou o texto embrulhado no envelope com o código da falha. Único ponto de montagem (`executor.ts`). */
export function failureResult(error: ToolFailure): string {
  return error.enveloped ? error.message : failureEnvelope(error.code, error.message);
}

/**
 * Conta do conector (Composio) em que uma ação age (phase 13, CONN-02): o `id` é o que a execução e a retomada conferem contra as liberações do bot, e o `label` (nome do dono ou rótulo
 * automático) é o que o cartão de aprovação e a auditoria mostram. Nunca carrega a chave do Composio.
 */
export interface ToolAccount {
  id: string;
  label: string;
}

/**
 * O que a "porta" de um conector precisa para reencontrar o destino (`ToolHandler.target`): o bot dono da execução (nulo no Chat geral, que não tem conector) e a conta. Na execução a
 * conta chega pelo NOME que o modelo escreveu (`accountName`, opcional com uma conta liberada no app); na retomada de uma aprovação chega pelo ID gravado na chamada pendente
 * (`accountId`), então a conta trocada entre o pedido e a aprovação nunca é reinterpretada por nome (A5).
 */
export interface ToolTargetRequest {
  botId: string | null;
  accountName?: string;
  accountId?: string;
}

/**
 * Recusa de conta do conector (phase 13, A3, A4, A5, A17): a chamada NÃO executa, o modelo recebe a mensagem como resultado de ferramenta e o executor a audita. A mensagem nunca revela
 * contas que o bot não pode usar (não liberada e inexistente respondem igual). `reason` é o motivo estável da auditoria; `account` vem preenchida quando a conta é conhecida (a desconectada).
 */
export class AccountRefusal extends ToolFailure {
  constructor(
    message: string,
    readonly reason: 'app_not_connected' | 'account_required' | 'account_not_allowed' | 'account_disconnected',
    readonly account: ToolAccount | null = null,
  ) {
    super(message, null, 'CONNECTOR_ACCOUNT_REFUSED');
    this.name = 'AccountRefusal';
  }
}

/** O que uma ferramenta tem à mão ao executar. */
export interface ToolContext {
  /** Closure confiável dos dados efetivamente enviados ao modelo nesta etapa; nunca vem dos argumentos. */
  evidence?: EvidenceProvenance;
  /** Publica dependências antes de uma operação longa, sob a posse, para remoção concorrente reconhecer uso. */
  recordEvidence?(evidence: EvidenceProvenance): Promise<void>;
  /** Collector síncrono de autorização no snapshot de serviços locais, sem I/O nem locks cruzados. */
  captureEvidence?(evidence: EvidenceProvenance): void;
  /** Folga calculada pelo motor para paginação; ferramenta não pode aumentá-la por argumento. */
  resultPageBytes?: number;
  pool: Pool;
  conversationId: string;
  /** Bot dono da conversa; nulo numa sessão do chat geral (as ferramentas `botOnly` nem são oferecidas lá). */
  botId: string | null;
  runId: string;
  /** Identidade da posse atual; guards locais impedem commit de um worker cuja posse expirou. */
  leaseOwner?: string;
  /** Dispara quando a execução é parada, estoura o tempo ou o worker encerra. */
  signal: AbortSignal;
  /** Relógio da execução (injetável nos testes): as ferramentas que dependem da data de hoje a leem daqui. */
  now(): Date;
  /** Prova de que a regra de aprovação foi resolvida (ou o dono permitiu). Existe para ações externas e destrutivas locais. */
  approval?: ApprovalProof;
  /**
   * A atividade desta chamada, já gravada como `running` (o executor sempre a passa): o id liga o que a ferramenta grava à atividade (os arquivos
   * gerados pelo `run_python`) e `report` troca o detalhe mostrado AO VIVO (ex.: "aguardando vaga" e depois "executando"), sob a posse da execução.
   * Opcional só para os testes que chamam uma ferramenta isolada.
   */
  activity?: { id: string; report(detail: ActivityDetail): Promise<void> };
}

export interface ToolOutcome {
  /** Metadado server-only, revalidado contra recibo durável antes de retirar a dependência auto-removida. */
  confirmedTableRemoval?: { tableId: string; operationId: string };
  /**
   * O mesmo para um doc excluído (phase 14): a exclusão que o recibo de `doc_mutation_receipts` confirma. A evidência da atividade de exclusão herda a do contexto, que pode citar o doc lido antes;
   * o executor a fecha SEM o doc excluído (`settleActivity`), para o resultado da exclusão continuar visível ao modelo em vez de a validação da evidência falhar.
   */
  confirmedDocRemoval?: { docId: string; operationId: string };
  /** Proveniência interna persistida separadamente de conteúdo público e logs. */
  evidence?: EvidenceProvenance;
  /** Rótulo final da atividade, após resolver o recurso autorizado. Nunca enviado ao logger. */
  label?: string;
  /**
   * Os artefatos (tabela ou doc) que esta chamada criou ou alterou, com o título LIDO NO SERVIDOR (phase 14, A4). Só as ferramentas que mudam um artefato o preenchem, e só quando mudaram
   * de fato; o executor o grava no dado da atividade, no mesmo fechamento do `label` (`settleActivity`), sem cartão de sistema. Nunca vem dos argumentos do modelo.
   */
  artifacts?: ArtifactRef[];
  /** Texto devolvido ao modelo (e mostrado resumido na tela). */
  result: string;
  /** Dados estruturados para a tela (ex.: os trechos achados na busca). */
  detail?: ActivityDetail;
}

export interface PreparedCall {
  /** Nome legível da chamada, como aparece na atividade. */
  label: string;
  /**
   * Confere o que o portão de aprovação precisa saber ANTES de resolver a regra: o acesso do bot ao recurso (falhar aqui, com `ToolFailure`, nunca chega à aprovação, ao cartão nem à pausa) e o
   * impacto que o cartão mostra, lido no servidor depois dessa checagem (tabelas: `TableImpact`; doc: `DocImpact`, com o título, decisão 23). `undefined` quando a ação não tem impacto a mostrar.
   * A execução revalida no commit.
   */
  inspect?(context: ToolContext): Promise<ApprovalImpact | undefined>;
  execute(context: ToolContext): Promise<ToolOutcome>;
}

export interface ToolHandler {
  /** Definição enviada ao modelo (nome, descrição e JSON Schema dos argumentos). */
  definition: ChatTool;
  /**
   * Tem efeito fora do Aion (ação do Composio)? Uma parada do dono durante uma ferramenta externa não a desfaz nem a
   * espera: o cartão de interrupção avisa que ela pode ter sido concluída (spec decisão 13).
   */
  external: boolean;
  /** Aprovação é independente do efeito externo: mutações destrutivas locais também passam pelo portão. */
  approvalRequired?: boolean;
  /** Operação local com recibo durável: retomada pode reaplicar a chamada sem duplicar o efeito. */
  replayable?: boolean;
  /**
   * Ferramenta CORE DO CHAT GERAL: sempre publicada no catálogo do modelo, sem depender de `discover_tools` (ver `CORE_TOOLS` em `tool-discovery.ts`). O bot ignora a marca: a lista fixa dele é `botCatalogNames`. Quem marca é o
   * motor, na montagem do registry, e só entra no catálogo; aprovação, `botOnly` e validação não mudam.
   */
  core?: boolean;
  /** Envelope íntegro já limitado pela ferramenta; impede corte textual que destruiria JSON/células. */
  resultLimitBytes?: number;
  /**
   * Só faz sentido numa conversa de bot (grava na memória do bot, propõe rotina do bot). O motor não a oferece ao modelo numa sessão do
   * chat geral, e se ela for chamada assim mesmo (nome inventado pelo modelo) a chamada falha como "ferramenta desconhecida".
   */
  botOnly?: boolean;
  /** Categoria identificada da operação, externa ou destrutiva local. */
  action?: ActionInfo;
  /**
   * Valida os argumentos como o modelo os enviou (JSON em texto). Lança `ToolFailure` se inválidos, com o que se esperava de cada campo.
   * Campo de objeto/lista que chega como texto contendo esse JSON é decodificado e revalidado (`tool-arguments.ts`).
   */
  prepare(rawArguments: string): PreparedCall;
  /**
   * Só nas ferramentas que são a "porta" de outra (o conector Composio, T29, e a `use_tool`, phase 15): o modelo chama a porta, mas quem executa é uma ferramenta de DESTINO.
   * `unwrap` lê a chamada da porta e devolve o nome e os argumentos (JSON em texto) do destino, ou nulo se os argumentos da porta não servem (a
   * própria porta então os recusa em `prepare`; a `use_tool` também devolve nulo para os nomes que nunca alcança, e o `execute` dela os recusa). O executor passa a tratar a chamada como
   * se fosse do destino: o portão de aprovação (pelas flags e pela `action` do DESTINO), a atividade, o cartão e a auditoria são os dele, e a atividade guarda o nome da porta em `via`.
   */
  unwrap?(rawArguments: string): { name: string; arguments: string; account?: string } | null;
  /**
   * O handler do destino pelo nome que `unwrap` devolveu. Lança `ToolFailure` (texto seguro) se o destino não existe ou não pode ser usado (`AccountRefusal` quando a conta do conector é
   * recusada ao bot); a `use_tool` devolve `undefined` para um destino que o mapa filtrado da execução não tem. É chamado também ao retomar uma aprovação (o destino é reencontrado pelo nome gravado no pedido, não guardado em memória), e a cada chamada: a conta do `request` é
   * conferida contra as liberações do bot no banco, nunca contra um cache.
   */
  target?(name: string, request: ToolTargetRequest): Promise<ToolHandler | undefined>;
  /** Só na ação de destino de um conector: a conta em que ELA foi ligada para este bot (o executor a grava na chamada pendente, na auditoria e no cartão de aprovação). */
  account?: ToolAccount;
}

/**
 * O que define uma ferramenta. A parte externa é uma união: `external: true` EXIGE a `action` (é ela que liga a ferramenta ao
 * portão de aprovação), então esquecê-la deixa de compilar; internas destrutivas declaram `approvalRequired` e `action`. O portão ainda
 * recusa, em tempo de execução, um handler externo sem `action` montado por outro caminho (falha fechada, critério C4).
 */
export type ToolSpec<Schema extends z.ZodType> = {
  definition: ChatTool;
  /** Ver `ToolHandler.botOnly`. Padrão: falso (a ferramenta vale em qualquer conversa). */
  botOnly?: boolean;
  replayable?: boolean;
  resultLimitBytes?: number;
  argsSchema: Schema;
  label(args: z.output<Schema>): string;
  execute(args: z.output<Schema>, context: ToolContext): Promise<ToolOutcome>;
  inspect?(args: z.output<Schema>, context: ToolContext): Promise<ApprovalImpact | undefined>;
} & ({ external?: false; approvalRequired?: false; action?: undefined } | { external: true; approvalRequired?: true; action: ActionInfo } | { external?: false; approvalRequired: true; action: ActionInfo });

/**
 * Monta um `ToolHandler` com a validação de argumentos por um schema Zod (campos extras e tipos errados são recusados). A leitura dos
 * argumentos é a de `parseToolArguments`, a mesma que a "porta" do conector e a releitura de `discover_tools` usam.
 */
export function defineTool<Schema extends z.ZodType>(spec: ToolSpec<Schema>): ToolHandler {
  return {
    definition: spec.definition,
    external: spec.external ?? false,
    approvalRequired: spec.external === true || spec.approvalRequired === true,
    ...(spec.replayable ? { replayable: true } : {}),
    ...(spec.resultLimitBytes ? { resultLimitBytes: spec.resultLimitBytes } : {}),
    ...(spec.botOnly ? { botOnly: true } : {}),
    ...(spec.action ? { action: spec.action } : {}),
    prepare(rawArguments) {
      /** Toda recusa de argumentos de toda ferramenta é o mesmo envelope (A21), sem expor o valor inválido. */
      const invalid = (message: string) => toolFailure('VALIDATION_FAILED', message);
      // Fonte única do JSON -> valor (limite de corpo, campos de objeto/lista enviados como texto JSON e a mensagem de erro): `tool-arguments.ts`.
      const parsed = parseToolArguments(spec.argsSchema, rawArguments);
      if (!parsed.ok) {
        if (parsed.reason === 'too_large') throw toolFailure('PAYLOAD_TOO_LARGE', 'Os argumentos excedem o limite permitido.');
        if (parsed.reason === 'invalid_json') throw invalid('Os argumentos não são um JSON válido.');
        throw invalid(describeArgumentIssues(parsed.issues, parsed.value, spec.definition.parameters));
      }
      const args = parsed.data as z.output<Schema>;
      return { label: spec.label(args), execute: (context) => spec.execute(args, context), ...(spec.inspect ? { inspect: (context: ToolContext) => spec.inspect!(args, context) } : {}) };
    },
  };
}
