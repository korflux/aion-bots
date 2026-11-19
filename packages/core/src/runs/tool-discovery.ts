// Exposição das ferramentas ao modelo (phase 15): duas variantes, escolhidas pela execução (`ensureTools`, `executor.ts`).
//
// BOT (decisões 3, 23 e 24 da spec; TOOL-01 substituída): a lista `tools` é FIXA dentro da conversa. Ela leva só as portas `abrir_grupo`, `use_tool`, `read_activity` e as duas do conector
// (`composio_search_actions` e `composio_execute_action`, com o contrato da CONN-02 intacto), mais as ferramentas "mais usadas" do bot (`botCatalogNames`), que saem do USO REAL do próprio bot nos
// últimos 30 dias (`selectMostUsed`, `resolveMostUsed`) e só são recalculadas quando o prefixo já se perdeu, nunca com a conversa quente: quando a conversa fica fria (como o bot tem conversa única, "conversa nova"
// é isso: nenhuma chamada ao modelo há mais de 40 minutos e nenhuma execução ativa ou na fila, `readMostUsedAnchor` em `cold-maintenance.ts`) e a cada compactação aplicada. Bot que ainda não teve nenhum dos dois
// publica a lista padrão `DEFAULT_MOST_USED`. TODO o resto do catálogo mora numa ÁRVORE de grupos (`TOOL_TREE`, fonte única do caminho de cada ferramenta): o bot lê o índice dela no turno de sistema
// (`treeIndex`; o índice não marca o que está carregado, então não muda quando a lista das mais usadas muda), abre um galho ou uma folha com `abrir_grupo`, recebe o esquema de cada ferramenta em
// resultado próprio no fim do histórico (`GroupOpening`) e a chama pela porta `use_tool` (`useToolPort`), cujo portão de aprovação é o do ALVO. Como o campo `tools` não muda, abrir um grupo não
// invalida o prefixo em cache (sonda da phase 15: esquema no fim do histórico 92,5% de cache contra 58 a 60,5% de uma ferramenta nova no fim de `tools`). Abrir é sem estado: depois de uma
// compactação ou de uma máscara fria o esquema sai do pedido, e abrir o mesmo caminho de novo devolve os esquemas outra vez (A25).
//
// CHAT GERAL (decisão 26, A46): sem árvore. Segue como antes da phase 15: `discover_tools` seleciona as opcionais (a web), as seleções se acumulam e o campo `tools` só cresce
// (`readToolSelectionHistory`, `selectCatalog`); as ferramentas core dele são `CORE_TOOLS` presentes no registry.
//
// Em ambas, publicar é exposição, nunca permissão: registro, `botOnly`, aprovação e autorização continuam decidindo cada chamada (SEC-03).
//
// Catálogo estável por conversa (phase 12, F2; hoje só o Chat geral): o campo `tools` do pedido só CRESCE dentro da conversa. As seleções de `discover_tools` se acumulam
// (a união delas, na ordem da PRIMEIRA seleção, cada ferramenta nova no FIM) e nada sai até a conversa ser compactada; é o que mantém o prefixo do pedido em cache entre etapas e rodadas. O
// descarte de opcional pelo teto do orçamento (`CATALOG_SHARE`) só vale depois de uma compactação aplicada, quando o prefixo já se perdeu (`selectCatalog`); a única outra saída é a rede de segurança do
// executor, que tira as opcionais só do pedido que não caberia de outra forma (CONTEXT_TOO_LARGE). No bot não há opcional publicada, então nada disso se aplica a ele.
//
// Mapa do arquivo: constantes e nomes reservados; `discover_tools` (Chat geral); árvore (`TOOL_TREE`, caminhos, índice); `abrir_grupo` e o formato do que ela grava; `use_tool`; seleções do
// Chat geral; `selectCatalog` (as duas variantes).
import { z } from 'zod';
import type { Queryable } from '../db/pool';
import { clipText } from './untrusted-content';
import { modelJsonSchema, parseToolArguments } from './tool-arguments';
import { defineTool, ToolFailure, toolFailure, type ToolHandler } from './tools';

export const DISCOVER_TOOLS = 'discover_tools';
/** A porta do BOT que abre um galho ou uma folha da árvore de grupos e devolve o esquema de cada ferramenta (phase 15, passo 11; ver `abrirGrupoTool`). Substitui `discover_tools` no bot. */
export const ABRIR_GRUPO = 'abrir_grupo';
export const READ_ACTIVITY = 'read_activity';
/** A porta genérica que chama pelo nome uma ferramenta do registry da execução (phase 15, passo 9; ver `useToolPort`). */
export const USE_TOOL = 'use_tool';
/** As duas portas do conector (Composio): sempre publicadas no bot (decisão 24). Nomes literais, e não importados de `composio-tools.ts`, para este arquivo seguir livre de ciclos; `tool-discovery.test.ts` confere que são os mesmos. */
export const CONNECTOR_PORTS: readonly string[] = ['composio_search_actions', 'composio_execute_action'];
/** As portas do runtime: nenhum handler fornecido pode usar estes nomes (`assertRuntimeToolNames`) e nenhuma delas entra no catálogo opcional (`selectCatalog`). */
export const RESERVED_RUNTIME_TOOLS = new Set([DISCOVER_TOOLS, ABRIR_GRUPO, READ_ACTIVITY, USE_TOOL]);
/**
 * O que `use_tool` NUNCA alcança (E4 e E6 da decisão 21): as reservadas do runtime (inclusive a própria porta e `abrir_grupo`) e as duas portas do conector. As do conector ficam de fora por lista própria e NÃO
 * entram em `RESERVED_RUNTIME_TOOLS`, porque `assertRuntimeToolNames` aplica essa lista aos handlers do conector (`executor.ts`) e os recusaria, derrubando o conector. A conta do conector
 * segue só pelo parâmetro `account` da CONN-02, na própria porta `composio_execute_action`; passar por `use_tool` abriria um segundo caminho até o Composio.
 */
export const USE_TOOL_UNREACHABLE: ReadonlySet<string> = new Set([...RESERVED_RUNTIME_TOOLS, ...CONNECTOR_PORTS]);
/**
 * Ferramentas CORE do CHAT GERAL (`ToolHandler.core`, marcado pelo motor a partir desta lista quando o catálogo core está ligado): ficam SEMPRE no catálogo publicado, sem depender de `discover_tools`.
 * Só entram as que existem no registry da execução (`run_python` só com o sandbox; as de bot não existem no Chat geral). O bot NÃO usa este conjunto: a lista fixa dele é `botCatalogNames`
 * (portas e as mais usadas), e a marca `core` no registry do bot é ignorada. Fica de fora, para `discover_tools`, a web. Custo: as definições são estáveis, então ficam em cache no provedor;
 * `modelJsonSchema` as enxuga. Os nomes são literais (e não importados) para este arquivo seguir livre de ciclos; um teste confere que cada um existe no registry padrão.
 * O orçamento de contexto NUNCA descarrega uma core (`fitToolCatalog`, regra do dono em 13/10/2026: função antes de custo): só as opcionais selecionadas disputam o espaço restante, e só depois de
 * uma compactação (phase 12, `selectCatalog`); se sistema + core não couberem, quem se compacta é o histórico.
 */
export const CORE_TOOLS: ReadonlySet<string> = new Set(['search_history', 'read_attachment', 'run_python']);
const selectionSchema = z.strictObject({ names: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)).max(8).refine((names) => new Set(names).size === names.length) });
/** Reserva as portas na origem confiável; nenhum handler fornecido pode substituir descoberta/leitura. */
export function assertRuntimeToolNames(tools: readonly ToolHandler[]): void {
  if (tools.some((tool) => RESERVED_RUNTIME_TOOLS.has(tool.definition.name))) throw new Error('Nome de ferramenta reservado pelo runtime.');
}

// ---------------------------------------------------------------------------------------------
// Chat geral: discover_tools
// ---------------------------------------------------------------------------------------------

/** Índice real e compacto do mesmo registry filtrado, sem as ferramentas já carregadas (core); descrições completas/schemas chegam apenas após selecionar. */
export function discoveryTool(registry: ReadonlyMap<string, ToolHandler>): ToolHandler {
  const index = [...registry.values()].filter((tool) => !RESERVED_RUNTIME_TOOLS.has(tool.definition.name) && tool.core !== true).map((tool) => `${tool.definition.name}: ${clipText(tool.definition.description.split(/\.\s/u)[0]!.replace(/\s+/gu, ' '), 140)}`).join('\n');
  const hasCore = [...registry.values()].some((tool) => tool.core === true);
  return defineTool({
    definition: { name: DISCOVER_TOOLS, description: `Seleciona até 8 ferramentas ${hasCore ? 'ADICIONAIS' : 'nativas'} pelo nome${hasCore ? ' (as essenciais já estão sempre disponíveis)' : ''}. A seleção ACRESCENTA às anteriores e nada é descarregado fora da compactação: as selecionadas seguem disponíveis na conversa até o contexto ser compactado (que pode descarregar algumas por espaço, e o aviso de catálogo diz quais), então selecione só o que vai usar. Repetir uma ferramenta ainda publicada não muda nada; selecionar de novo uma que foi descarregada a devolve. Os schemas selecionados estarão disponíveis na PRÓXIMA etapa, sem repetir definições no resultado. Não executa ações nem concede acesso/aprovação. read_activity permanece disponível para recuperar referências. Índice das ${hasCore ? 'ferramentas adicionais' : 'capacidades registradas'} desta execução:\n` + index,
      parameters: z.toJSONSchema(selectionSchema, { io: 'input' }) },
    argsSchema: selectionSchema, replayable: true, label: () => 'Selecionar ferramentas',
    async execute({ names }) {
      if (names.some((name) => name === DISCOVER_TOOLS || !registry.has(name))) throw new ToolFailure('Ferramenta não disponível neste catálogo. A seleção anterior foi preservada.');
      const selected = [...registry.keys()].filter((name) => names.includes(name) && !RESERVED_RUNTIME_TOOLS.has(name));
      return { result: JSON.stringify({ selected, count: selected.length, availableNextStep: true }) };
    },
  });
}

// ---------------------------------------------------------------------------------------------
// Bot: a árvore de grupos
// ---------------------------------------------------------------------------------------------

/** Um galho da árvore: o caminho (`a/b/c`, sem o nome da ferramenta), quando usar e as ferramentas (folhas) dele, na ordem em que o índice e `abrir_grupo` as mostram. */
export interface ToolGroup {
  path: string;
  /** Quando usar o grupo, numa frase curta: é o que o índice da árvore diz ao modelo. */
  when: string;
  tools: readonly string[];
}

/**
 * A ÁRVORE DE GRUPOS (decisão 23 da spec) e a FONTE ÚNICA do caminho de cada ferramenta do bot: ela diz onde cada ferramenta mora, e daqui saem o índice que o modelo lê (`treeIndex`),
 * o que `abrir_grupo` abre e o que `botCatalogNames` sabe separar do que já está publicado. Ferramenta NOVA entra com UMA linha: o nome dela na lista do galho certo (um galho novo é um item novo
 * aqui), mais o handler na lista do motor (`engine.ts`); o portão de aprovação e `use_tool` a enxergam pelo registry da execução, sem outra edição. `engine.ts` recusa, na partida, um handler
 * padrão que não está aqui (`assertToolTree`), e `tool-discovery.test.ts` confere que todo nome daqui existe no catálogo padrão. Um nome pertence a UM galho só.
 * As portas `abrir_grupo` e `use_tool` ficam fora da árvore (decisão 23); `read_activity` e as do conector estão aqui para o modelo achar o assunto, mas são SEMPRE publicadas (`botCatalogNames`).
 * Conector novo entra como irmão de `composio` (`conector/<nome>`). O Chat geral não tem árvore (decisão 26).
 */
export const TOOL_TREE: readonly ToolGroup[] = [
  { path: 'artefatos/docs', when: 'textos longos em Markdown (plano, roteiro, relatório, ata); excluir pede aprovação', tools: ['doc_list', 'doc_read', 'doc_create', 'doc_append', 'doc_replace', 'doc_rewrite', 'doc_versions', 'doc_restore', 'doc_delete'] },
  { path: 'artefatos/tabelas/dados', when: 'consultar, gravar e importar registros', tools: ['table_list', 'table_get', 'table_query', 'table_write', 'table_import_attachment'] },
  { path: 'artefatos/tabelas/estrutura', when: 'criar tabela, alterar colunas, vistas e fórmulas', tools: ['table_create', 'table_update', 'table_views', 'table_view_create', 'table_view_update', 'table_view_remove', 'table_formula_preview'] },
  { path: 'artefatos/tabelas/exclusao', when: 'apagar registros, colunas e tabelas; pede aprovação', tools: ['table_prepare_operation', 'table_delete_records', 'table_delete_column', 'table_convert_column', 'table_delete_table'] },
  { path: 'conector/composio', when: 'apps conectados (e-mail, agenda, Notion); já estão na sua lista', tools: CONNECTOR_PORTS },
  { path: 'ferramentas/memoria', when: 'preferências e fatos duradouros do agente', tools: ['edit_memory'] },
  { path: 'ferramentas/objetivo', when: 'a meta contínua do seu trabalho', tools: ['update_objective'] },
  { path: 'ferramentas/rotinas', when: 'lembretes e tarefas agendadas ou recorrentes', tools: ['propose_routine', 'propose_routine_change', 'list_routines', 'get_routine'] },
  { path: 'ferramentas/historico', when: 'recuperar o que saiu do contexto: histórico, atividades e anexos', tools: ['search_history', 'read_activity', 'read_attachment'] },
  { path: 'ferramentas/web', when: 'informação atual ou externa da web', tools: ['web_search', 'web_fetch'] },
  { path: 'ferramentas/python', when: 'cálculos e processamento de dados', tools: ['run_python'] },
];

/**
 * A lista padrão das "mais usadas no Aion" (decisão 24): o que um bot sem uso, ou que ainda não teve recálculo (a conversa nunca esfriou nem foi compactada), publica ao lado das portas, e o "titular" que a histerese protege (`selectMostUsed`).
 * Vem do uso medido desde 05/10 (spec, Pontos do projeto), só ferramentas do registry: `table_query` 76, `table_write` 33 e `edit_memory` 30. As seguintes, `propose_routine` e `propose_routine_change` (8 e 8,
 * que entram juntas, `MOST_USED_TOGETHER`), ficam FORA da padrão: pesam 8.567 bytes, mais que as três juntas (7.972), e uma rotina é criada em poucas execuções. No banco de testes com o modelo real (passo 12,
 * 8 casos de otimização, `passo-12.md`) a padrão com o par (16.539 bytes) e sem ele (7.972) acertaram 100% (24 de 24 e 16 de 16); sem o par a abertura fria caiu de 9,85 mil para 6,97 mil tokens sem cache e o custo médio
 * por execução de US$ 0,0061 para US$ 0,0051, e os dois casos de rotina custaram mais (+16% e +39%: o modelo abre `ferramentas/rotinas` antes de criar). O bot que usa rotinas ganha o par pelo próprio uso, no recálculo seguinte (conversa fria ou compactação).
 */
export const DEFAULT_MOST_USED: readonly string[] = ['table_query', 'table_write', 'edit_memory'];

/** Quantas ferramentas, no máximo, a lista das mais usadas publica (decisão 24, "até 5"). Cada ferramenta conta uma, inclusive as de `MOST_USED_TOGETHER`. */
export const MOST_USED_MAX_TOOLS = 5;
/**
 * Teto, em bytes, do JSON das definições do conjunto das mais usadas (`JSON.stringify` da definição, a medida dos relatórios do banco de testes): 12.000, cerca de 3,4 mil tokens, o que cabe o par de rotinas
 * (8.567) com `edit_memory` (1.331), ou as três da lista padrão (7.972) com folga, mas não as cinco mais pesadas do catálogo (cerca de 20 mil). Valor inicial da decisão 24 confirmado no banco de testes com o modelo
 * real (passo 12 da phase 15, `passo-12.md`): a lista padrão, de 7.972 bytes, acertou 100% (16 de 16) com a abertura fria em 6,97 mil tokens; a que tinha 16.539 bytes também acertou 100% (24 de 24) e abriu
 * com 9,85 mil. O banco não varre outros tetos: a lista de um bot novo não depende dele e um bot com histórico semeado não cabe no limite de gasto do modo real.
 * ponytail: o teto é fixo e igual para todo bot; trocar por um valor por bot se alguém precisar de uma lista mais pesada que a do uso medido.
 */
export const MOST_USED_MAX_BYTES = 12_000;
/** Janela do uso que define a lista, em dias (decisão 24: "pelo uso do próprio bot nos últimos 30 dias"). */
export const MOST_USED_WINDOW_DAYS = 30;
/**
 * Ferramentas que entram ou saem da lista JUNTAS (decisão 24 do plano do passo 12, herdada do passo 7): o contorno da agenda de `propose_routine_change` cita o esquema completo de `propose_routine`,
 * então publicar uma sem a outra deixaria o modelo com uma instrução que aponta para um esquema que ele não vê. Contam como uma unidade: o uso é a soma, ocupam duas vagas e pesam a soma dos bytes.
 */
export const MOST_USED_TOGETHER: readonly (readonly string[])[] = [['propose_routine', 'propose_routine_change']];
/**
 * Histerese ("sem troca por diferença pequena", decisão 24): quem está na lista padrão (o "titular") vale `1,5 × usos + 2`, então um desafiante só o desbanca com pelo menos 50% a mais de usos e,
 * no mínimo, 3. É uma regra pura sobre o uso e a lista padrão, sem guardar a lista publicada na época anterior (que exigiria coluna nova): ver o `ponytail:` de `selectMostUsed`.
 */
const HOLDER_FACTOR = 1.5;
const HOLDER_BONUS = 2;
/** As portas que a lista fixa do bot já leva, em qualquer caso: nunca são candidatas a "mais usada". */
const ALWAYS_PUBLISHED: ReadonlySet<string> = new Set([ABRIR_GRUPO, USE_TOOL, READ_ACTIVITY, ...CONNECTOR_PORTS]);

/** O caminho normalizado: sem espaço nas pontas de cada trecho, sem barras sobrando e em minúsculas. */
const normalizePath = (raw: string): string => raw.split('/').map((part) => part.trim().toLowerCase()).filter(Boolean).join('/');

/** O que um caminho aponta: um galho (várias ferramentas) ou uma folha (uma). `path` é o caminho completo normalizado. */
export interface TreeTarget {
  kind: 'branch' | 'leaf';
  path: string;
  tools: readonly string[];
}

/**
 * Resolve o caminho que o modelo escreveu. Folha: o nome da ferramenta (`doc_read`) ou o caminho completo dela (`artefatos/docs/doc_read`). Galho: o caminho de um grupo (`artefatos/docs`) ou de qualquer
 * ancestral dele (`artefatos`, `artefatos/tabelas`), que abre todas as ferramentas abaixo. Caixa e espaços nas pontas não importam, porque abrir é só exposição; nada que não esteja na árvore resolve.
 */
export function resolveTreePath(raw: string): TreeTarget | null {
  const path = normalizePath(raw);
  if (path === '') return null;
  for (const group of TOOL_TREE) for (const tool of group.tools) if (path === tool || path === `${group.path}/${tool}`) return { kind: 'leaf', path: `${group.path}/${tool}`, tools: [tool] };
  const tools = TOOL_TREE.filter((group) => group.path === path || group.path.startsWith(`${path}/`)).flatMap((group) => group.tools);
  return tools.length > 0 ? { kind: 'branch', path, tools } : null;
}

/**
 * O índice compacto da árvore como o modelo o lê: uma linha por galho com ferramentas no registry desta execução (`caminho: quando usar (ferramentas)`), sem marcar o que está publicado.
 * Função só do registry e da árvore, então é igual enquanto o registry não muda, e NÃO depende da lista das mais usadas (por isso nada aqui diz o que está carregado): quando essa lista é
 * recalculada (a conversa esfriou ou uma compactação foi aplicada), o índice, e com ele o turno de sistema, ficam byte a byte iguais (A45). Mora na seção "Ferramentas fora da sua lista" do turno de sistema do bot (`buildSystemText`, `context.ts`), montado por
 * `RunExecutor.loadSnapshot`; a descrição de `abrir_grupo` não o repete. Fonte única também do A32: ferramenta nova no galho aparece aqui sem outra edição.
 */
export function treeIndex(registry: ReadonlyMap<string, ToolHandler>): string {
  return TOOL_TREE.flatMap((group) => {
    const names = group.tools.filter((name) => registry.has(name));
    return names.length > 0 ? [`- ${group.path}: ${group.when} (${names.join(', ')})`] : [];
  }).join('\n');
}

/** Os handlers que nenhuma linha de `TOOL_TREE` cita (as portas ficam de fora): não teriam como ser abertos por `abrir_grupo`. Vazio quando a árvore está completa. */
export function ungroupedTools(tools: readonly ToolHandler[]): string[] {
  const grouped = new Set(TOOL_TREE.flatMap((group) => group.tools));
  return tools.map((tool) => tool.definition.name).filter((name) => !grouped.has(name) && !RESERVED_RUNTIME_TOOLS.has(name));
}

/** Falha de partida do motor: um handler padrão sem caminho na árvore ficaria sem como ser aberto por `abrir_grupo`. */
export function assertToolTree(tools: readonly ToolHandler[]): void {
  const missing = ungroupedTools(tools);
  if (missing.length > 0) throw new Error(`Ferramenta sem caminho na árvore de grupos (TOOL_TREE): ${missing.join(', ')}.`);
}

/**
 * Os nomes da lista FIXA do bot, na ordem em que seguem no campo `tools` (decisão 24): `abrir_grupo`, `use_tool`, `read_activity` e as duas portas do conector, depois as "mais usadas"
 * (`mostUsed`, a parte que `resolveMostUsed` recalcula só quando a conversa esfria e numa compactação; vai por último para o começo da lista nunca mudar). Só o que o registry da execução tem: o conector
 * só existe para o bot com conta liberada, e uma "mais usada" fora do registry não aparece. Função pura: o mesmo registry e a mesma lista dão a mesma lista, em toda etapa.
 */
export function botCatalogNames(registry: ReadonlyMap<string, ToolHandler>, mostUsed: readonly string[]): string[] {
  return [...new Set([ABRIR_GRUPO, USE_TOOL, READ_ACTIVITY, ...CONNECTOR_PORTS, ...mostUsed])].filter((name) => registry.has(name));
}

// ---------------------------------------------------------------------------------------------
// Bot: as "mais usadas" (decisão 24)
// ---------------------------------------------------------------------------------------------

/** Os bytes que a definição ocupa no campo `tools` (o JSON da definição, a medida dos relatórios do banco de testes). */
const definitionBytes = (tool: ToolHandler): number => Buffer.byteLength(JSON.stringify(tool.definition), 'utf8');

/**
 * Escolhe as "mais usadas" do bot a partir do uso (`usage`: ferramenta -> chamadas nos últimos 30 dias), entre as ferramentas da árvore que o registry da execução tem. Função PURA do registry e do
 * uso, sem relógio nem banco, então o mesmo uso dá a mesma lista (o que sustenta A42 e A43). Regras:
 * - Candidata é a ferramenta da árvore que o registry tem e que a lista fixa não leva de qualquer jeito (as portas ficam fora). O uso do conector (slugs de ação) e de ferramentas fora da árvore nunca conta.
 * - Unidade é a ferramenta sozinha ou o grupo de `MOST_USED_TOGETHER` (entram ou saem juntas; o uso é a soma e ela ocupa uma vaga por ferramenta e os bytes de todas).
 * - Só entra quem tem uso ou é "titular" (está na lista padrão): bot sem uso fica com a lista padrão; bot com pouco uso completa as vagas com o titular, na ordem da lista padrão.
 * - Ranking: pontuação (uso; o titular vale `1,5 × usos + 2`, a histerese contra troca por diferença pequena), depois mais usos, titular antes de não titular, ordem da lista padrão e ordem da árvore
 *   (desempate determinístico: nunca depende de ordem de leitura do banco).
 * - Preenchimento guloso na ordem do ranking, respeitando `maxTools` e `maxBytes`: a unidade que não cabe é pulada e as seguintes ainda podem entrar.
 * Devolve os nomes na ordem do ranking (a ordem em que seguem no campo `tools`, depois das portas).
 * ponytail: a histerese é contra a LISTA PADRÃO (o titular), e não contra a lista publicada na época anterior, que exigiria guardá-la (coluna nova, fora da phase 15, regra 14); trocar quando a lista
 * oscilar entre recálculos por usos parecidos de duas ferramentas fora do padrão.
 */
export function selectMostUsed(registry: ReadonlyMap<string, ToolHandler>, usage: ReadonlyMap<string, number>, { maxTools = MOST_USED_MAX_TOOLS, maxBytes = MOST_USED_MAX_BYTES }: { maxTools?: number; maxBytes?: number } = {}): string[] {
  const candidates = TOOL_TREE.flatMap((group) => group.tools).filter((name) => registry.has(name) && !ALWAYS_PUBLISHED.has(name));
  const together = MOST_USED_TOGETHER.map((names) => names.filter((name) => candidates.includes(name))).filter((names) => names.length > 0);
  const grouped = new Set(together.flat());
  const units = [...together, ...candidates.filter((name) => !grouped.has(name)).map((name) => [name])].map((names, order) => {
    const count = names.reduce((sum, name) => sum + (usage.get(name) ?? 0), 0);
    const holder = names.every((name) => DEFAULT_MOST_USED.includes(name));
    return {
      names, count, holder,
      score: holder ? count * HOLDER_FACTOR + HOLDER_BONUS : count,
      // Ordem da lista padrão para o titular; para os demais, depois dele, a ordem da árvore.
      rank: holder ? DEFAULT_MOST_USED.indexOf(names[0]!) : DEFAULT_MOST_USED.length + order,
      bytes: names.reduce((sum, name) => sum + definitionBytes(registry.get(name)!), 0),
    };
  }).filter((unit) => unit.holder || unit.count > 0)
    .sort((a, b) => b.score - a.score || b.count - a.count || Number(b.holder) - Number(a.holder) || a.rank - b.rank);
  const chosen: string[] = [];
  let bytes = 0;
  for (const unit of units) {
    if (chosen.length + unit.names.length > maxTools || bytes + unit.bytes > maxBytes) continue;
    chosen.push(...unit.names);
    bytes += unit.bytes;
  }
  return chosen;
}

/**
 * A lista das "mais usadas" VIGENTE na conversa (decisão 24 revisada em 2026-11-08, A42 a A44). `anchorAt` é o instante do último recálculo (`readMostUsedAnchor`, `cold-maintenance.ts`: a conversa que esfriou ou a
 * última compactação aplicada; nulo = nunca recalculada) e a lista é função só dele e do que já estava gravado nele, e não do "agora": o uso conta as atividades das execuções ENCERRADAS até esse instante, nos 30 dias
 * que o antecedem (concluídas ou com falha, pelo nome gravado em `data.tool`, que na chamada por `use_tool` é o do alvo). A contagem fica congelada no instante do recálculo: uma execução que ainda estava aberta
 * nele (`finished_at` depois dele ou nulo) não entra, nem depois de encerrar, e por isso uma atividade nascida antes do instante e concluída depois não muda a lista. Como o que foi encerrado antes de um
 * instante nunca muda, a lista é a mesma em toda etapa, rodada e execução até o recálculo seguinte (A43), dispensa guardar a lista, e o uso novo só vale no recálculo seguinte. Sem recálculo ainda (bot novo) ou sem
 * uso, vale a lista padrão (A44). Só as ferramentas do registry contam: os slugs de ação do conector, que a porta grava em `data.tool`, ficam de fora porque não estão na árvore.
 * O instante de encerramento é o da EXECUÇÃO: a atividade não guarda o dela (coluna nova pede migration), e uma execução encerrada tem todas as atividades fechadas.
 * ponytail: o uso da execução que estava em curso quando a compactação foi aplicada (as atividades dela anteriores à compactação, já fechadas) só entra no recálculo seguinte, porque o encerramento é o da execução;
 * gravar o instante em que a atividade fecha (`messages`, migration aprovada pelo dono) se isso fizer falta para o bot de uma execução muito longa.
 * ponytail: lê as atividades da conversa na janela de 30 dias uma vez por execução e por recálculo (índice `messages_timeline`); medir e materializar a contagem se um bot passar de dezenas de milhares de atividades por mês.
 */
export async function resolveMostUsed(db: Queryable, conversationId: string, registry: ReadonlyMap<string, ToolHandler>, anchorAt: Date | null): Promise<string[]> {
  if (anchorAt === null) return selectMostUsed(registry, new Map());
  const names = TOOL_TREE.flatMap((group) => group.tools).filter((name) => registry.has(name) && !ALWAYS_PUBLISHED.has(name));
  const found = await db.query<{ tool: string; total: number }>(
    `SELECT m.data->>'tool' AS tool, count(*)::int AS total FROM messages m JOIN runs r ON r.id = m.run_id
     WHERE m.conversation_id = $1 AND m.kind = 'activity' AND m.status IN ('completed', 'failed') AND m.data->>'tool' = ANY($2::text[])
       AND r.finished_at <= $3::timestamptz AND r.finished_at > $3::timestamptz - make_interval(days => $4::int)
     GROUP BY 1`,
    [conversationId, names, anchorAt, MOST_USED_WINDOW_DAYS],
  );
  return selectMostUsed(registry, new Map(found.rows.map((row) => [row.tool, row.total])));
}

// ---------------------------------------------------------------------------------------------
// Bot: abrir_grupo e o formato do que ela grava
// ---------------------------------------------------------------------------------------------

const openSchema = z.strictObject({
  path: z.string().min(1).max(128).regex(/^[A-Za-z0-9_/ -]+$/u).describe('O galho (artefatos, artefatos/tabelas, artefatos/docs) ou a folha (artefatos/docs/doc_read, ou só doc_read) a abrir.'),
});

/**
 * O que `abrir_grupo` GRAVA como resultado (`messages.content`): o caminho aberto, as ferramentas cujos esquemas vêm junto (`opened`), as que já estão na lista do modelo e por isso não vêm de novo
 * (`inYourList`) e as definições (`schemas`: nome, descrição e parâmetros, como o provedor as receberia em `tools`). Guarda TUDO numa linha só (até o teto de gravação de 256 KiB); quem monta o
 * pedido (`buildTurns`, `context.ts`) transforma essa linha em um resultado para a chamada e um resultado PRÓPRIO por esquema (`groupOpeningResults`).
 */
const groupOpeningSchema = z.object({
  path: z.string(),
  opened: z.array(z.string()),
  inYourList: z.array(z.string()),
  schemas: z.array(z.object({ name: z.string(), description: z.string(), parameters: z.record(z.string(), z.unknown()) })),
});
export type GroupOpening = z.infer<typeof groupOpeningSchema>;

/** Lê o que `abrir_grupo` gravou; nulo para qualquer outra coisa (falha, resultado cortado na gravação, forma antiga), que então segue como um resultado comum. */
export function parseGroupOpening(content: string): GroupOpening | null {
  try {
    const parsed = groupOpeningSchema.safeParse(JSON.parse(content));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Os resultados que o modelo recebe de uma abertura (A24): `summary` é o resultado da chamada `abrir_grupo` que ele fez, e cada ferramenta aberta tem o seu, ÍNTEGRO, em `schemas` (o
 * esquema como JSON). Um esquema nunca passa pelo teto de 12.000 caracteres de CTX-10 junto de outro: o maior medido tem cerca de 4,3 KB (`table_prepare_operation`) e cada um vai num resultado
 * seu, então abrir `artefatos` inteiro não corta nenhum. Função só da linha gravada, igual em toda etapa e rodada.
 * ponytail: cada esquema vai íntegro, sem teto; os das ferramentas internas pesam até ~4,3 KB e `tool-discovery.test.ts` prende que ficam abaixo de 12.000 caracteres. Aplicar o teto de CTX-10 ao esquema quando uma ferramenta passar disso.
 */
export function groupOpeningResults(opening: GroupOpening): { summary: string; schemas: { name: string; text: string }[] } {
  const note = opening.opened.length === 0 && opening.inYourList.length > 0 ? { note: 'Todas já estão na sua lista: chame direto.' } : {};
  return {
    summary: JSON.stringify({ path: opening.path, opened: opening.opened, inYourList: opening.inYourList, ...note }),
    schemas: opening.schemas.map((schema) => ({ name: schema.name, text: JSON.stringify(schema) })),
  };
}

/**
 * A porta `abrir_grupo` do BOT (phase 15, passo 11; decisões 3, 23 e 24): abre um galho ou uma folha da árvore (`resolveTreePath`) e devolve o esquema de cada ferramenta aberta, para o modelo
 * chamá-la depois por `use_tool`. Não executa nada, não concede acesso nem aprovação: só EXPÕE definições que o registry desta execução já tem (o mesmo mapa filtrado que `use_tool` usa, então um
 * galho do Chat geral ou uma conta não liberada nunca aparece). O que já está na lista fixa (`botCatalogNames`) não vem de novo; o que o registry não tem (web desligada, sem Python, sem conta
 * liberada) é omitido, e um caminho sem nenhuma ferramenta disponível responde com a lista dos caminhos que existem. `mostUsed` é a parte variável da lista fixa (`resolveMostUsed`): o executor refaz esta
 * porta quando a lista é recalculada (conversa fria ou compactação).
 * Sem estado: abrir de novo o mesmo caminho devolve os mesmos esquemas, que é como o modelo os recupera depois de uma compactação ou de uma máscara fria (A25). O índice da árvore NÃO está na descrição
 * (phase 15, passo 12): mora no turno de sistema do bot (`treeIndex`, `buildSystemText`), para a descrição, que vai em `tools`, não mudar com a composição da árvore nem repetir o que o sistema já diz.
 */
export function abrirGrupoTool(registry: ReadonlyMap<string, ToolHandler>, mostUsed: readonly string[] = []): ToolHandler {
  const paths = TOOL_TREE.filter((group) => group.tools.some((name) => registry.has(name))).map((group) => group.path);
  return defineTool({
    definition: {
      name: ABRIR_GRUPO,
      description:
        'Abre um galho (várias ferramentas) ou uma folha (uma ferramenta) da árvore de ferramentas: cada ferramenta aberta chega com o esquema completo em resultado próprio, e você a chama com ' +
        'use_tool({"name":"<ferramenta>","arguments":{...}}), com arguments como objeto JSON. As que já estão na sua lista são chamadas direto, sem abrir. Abrir não executa nada nem concede acesso ou aprovação. ' +
        'path aceita o galho (artefatos/tabelas), a folha (artefatos/docs/doc_read) ou o nome da ferramenta; os caminhos estão em "Ferramentas fora da sua lista", no seu sistema. ' +
        'Se o esquema já saiu do histórico (resumo ou resultado antigo), abra o caminho de novo.',
      parameters: modelJsonSchema(openSchema),
    },
    argsSchema: openSchema,
    label: ({ path }) => `Abrir ${path.trim()}`,
    async execute({ path }) {
      const target = resolveTreePath(path);
      if (!target) throw toolFailure('TOOL_NOT_FOUND', `Grupo desconhecido: "${path.trim()}". Caminhos que existem: ${paths.join(', ')}. Aceita também um galho inteiro (artefatos, artefatos/tabelas) ou o nome de uma ferramenta.`);
      const available = target.tools.filter((name) => registry.has(name));
      if (available.length === 0) throw toolFailure('TOOL_NOT_FOUND', `Nenhuma ferramenta de "${target.path}" está disponível agora (por exemplo, pesquisa na web desligada, sem Python ou sem conta do conector liberada). Caminhos disponíveis: ${paths.join(', ')}.`);
      const published = new Set(botCatalogNames(registry, mostUsed));
      const opened = available.filter((name) => !published.has(name));
      const opening: GroupOpening = {
        path: target.path,
        opened,
        inYourList: available.filter((name) => published.has(name)),
        schemas: opened.map((name) => registry.get(name)!.definition),
      };
      return { result: JSON.stringify(opening) };
    },
  });
}

// ---------------------------------------------------------------------------------------------
// Bot: use_tool
// ---------------------------------------------------------------------------------------------

const useToolSchema = z.strictObject({
  name: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).describe('O nome exato da ferramenta a chamar.'),
  arguments: z.record(z.string(), z.unknown()).default({}).describe('Os argumentos da ferramenta, como o esquema dela os define (objeto JSON, não texto).'),
});

/**
 * A porta `use_tool` (phase 15, passo 9; spec decisões 3, 14, 21 e 30): o modelo chama pelo nome uma ferramenta do registry da execução cujo esquema não está na lista `tools` do pedido
 * (a lista fica fixa na conversa, para o cache do provedor). É uma PORTA, como `composio_execute_action`: o modelo a chama, mas quem executa, e quem passa pelo portão de aprovação, é a
 * ferramenta de DESTINO. O executor traduz a chamada logo no começo de `executeCall` (`unwrap`: nome e argumentos do alvo, `via` = `use_tool`), e dali em diante tudo é por ferramenta, como se o
 * modelo a tivesse chamado: `prepare` (o `argsSchema` do ALVO valida os argumentos), `inspect` (acesso ao recurso, DOC-01), portão de aprovação pelas flags e pela `action` do ALVO (E1),
 * atividade, cartão e retomada. A porta em si não tem `action`, não é externa e não pede aprovação: não decide nada, só repassa.
 *
 * Controles (cada risco da decisão 21 tem teste próprio em `tool-discovery.test.ts` e nos arquivos de aprovação):
 * - E2, alvo vem do mapa FILTRADO da execução (`registry`): o mesmo que a execução inteira usa, sem as `botOnly` no Chat geral, sem outro bot e sem conta do conector. Um alvo que o mapa não tem
 *   (inexistente ou filtrado) devolve `undefined` e o executor responde "ferramenta desconhecida", igual para os dois, sem revelar qual.
 * - E3/E5, a retomada de uma aprovação reencontra o alvo por `target` neste mesmo mapa (`resumedTarget`, `executor.ts`) e confere a ação resolvida contra a gravada no pedido; `unwrap` devolve
 *   os argumentos do alvo já como objeto, e o `via` da atividade é `use_tool` (a auditoria da aprovação chama o dela de `basis`).
 * - E4/E6, `USE_TOOL_UNREACHABLE`: para esses nomes `unwrap` devolve nulo, o executor trata a chamada como da própria porta (atividade `use_tool`, sem alvo) e `execute` recusa sem executar nada.
 *   Argumentos da própria porta que não servem (`unwrap` nulo) caem no `prepare` dela e recusam pelo mesmo caminho.
 * Selecionar/chamar é exposição, não permissão (SEC-03): a regra de aprovação do alvo decide cada chamada.
 * Publicação: o BOT a leva na lista fixa, ao lado de `abrir_grupo` (`botCatalogNames`, passo 11). O Chat geral a tem no registry mas não a publica (decisão 26): lá ela só existe para recusar
 * `botOnly` por nome (A29).
 */
export function useToolPort(registry: ReadonlyMap<string, ToolHandler>): ToolHandler {
  const gate = defineTool({
    definition: {
      name: USE_TOOL,
      description:
        'Chama pelo nome uma ferramenta do catálogo do Aion que não está na sua lista, com os argumentos do esquema dela (arguments é um objeto JSON, não texto). ' +
        'A ferramenta chamada segue as próprias regras: se pedir aprovação do dono, a execução pausa e retoma nela, e se negarem ela não executa. ' +
        'Não chama read_activity, abrir_grupo, esta porta nem as do conector (composio_*): essas se chamam direto. Exemplo: {"name":"doc_list","arguments":{}}.',
      parameters: modelJsonSchema(useToolSchema),
    },
    argsSchema: useToolSchema,
    label: ({ name }) => `Chamar ${name}`,
    async execute({ name }) {
      // Só chega aqui o que `unwrap` não traduziu: as portas que a `use_tool` nunca alcança.
      throw toolFailure('VALIDATION_FAILED', `A use_tool não chama "${name}": abrir_grupo, discover_tools, read_activity, use_tool e as portas do conector (composio_*) se chamam direto, pelo nome. Nada foi executado.`);
    },
  });
  return {
    ...gate,
    unwrap(rawArguments) {
      const parsed = parseToolArguments(useToolSchema, rawArguments);
      if (!parsed.ok || USE_TOOL_UNREACHABLE.has(parsed.data.name)) return null;
      return { name: parsed.data.name, arguments: JSON.stringify(parsed.data.arguments) };
    },
    target: async (name) => (USE_TOOL_UNREACHABLE.has(name) ? undefined : registry.get(name)),
  };
}

// ---------------------------------------------------------------------------------------------
// Chat geral: as seleções de discover_tools
// ---------------------------------------------------------------------------------------------

/**
 * As seleções de `discover_tools` da CONVERSA da execução (phase 12, F2): `names` na ordem da PRIMEIRA seleção, sem repetição (a ordem em que as opcionais ficam no campo `tools`), e
 * `lastSelectedId`, o id (`messages.id`) da seleção mais recente que incluiu cada nome. Só o último id decide se uma opcional pode sair numa compactação (`selectCatalog`): selecionar de
 * novo uma ferramenta a protege até a compactação seguinte, sem mudar o lugar dela na lista. Só o Chat geral as usa; o bot abre grupos (`abrir_grupo`) e linhas antigas de `discover_tools` no
 * histórico dele seguem como atividade comum.
 */
export interface ToolSelectionHistory {
  names: string[];
  lastSelectedId: Map<string, string>;
}

/**
 * Lê as seleções concluídas da conversa da execução, da mais antiga à mais nova; falha não conta (não substitui nem acrescenta) e a ordem numérica não depende do alias id::text.
 * Custo: a seleção valia só para a execução, então toda execução nova gastava uma chamada inteira (contexto completo) só para recarregar os mesmos schemas; depois valia só a última,
 * e cada troca do campo `tools` no meio invalidava o cache do prefixo. Acumular na conversa mantém o catálogo estável entre etapas e execuções, e só cresce no fim.
 * Exposição de schema não é permissão: aprovação, botOnly e registry continuam decidindo cada chamada. O histórico das atividades NUNCA é alterado: quem sai de um catálogo continua
 * registrado como selecionado, e a conta que o motor faz sobre ele é pura (mesma conversa e mesma cobertura dão o mesmo catálogo).
 * ponytail: lê todas as seleções da conversa a cada preparação; trocar por uma leitura incremental se uma conversa passar de alguns milhares de chamadas de `discover_tools`.
 */
export async function readToolSelectionHistory(db: Queryable, runId: string): Promise<ToolSelectionHistory> {
  const result = await db.query<{ id: string; tool_arguments: string | null }>("SELECT m.id::text AS id, m.tool_arguments FROM messages m WHERE m.conversation_id=(SELECT conversation_id FROM runs WHERE id=$1) AND m.kind='activity' AND m.status='completed' AND m.data->>'tool'=$2 AND NOT (m.data ? 'via') ORDER BY m.id ASC", [runId, DISCOVER_TOOLS]);
  const history: ToolSelectionHistory = { names: [], lastSelectedId: new Map() };
  for (const row of result.rows) {
    // Mesma leitura da chamada (`parseToolArguments`): `names` enviado como texto com o JSON da lista foi aceito ao selecionar, então vale ao reler.
    const parsed = parseToolArguments(selectionSchema, row.tool_arguments ?? '');
    if (!parsed.ok) continue;
    for (const name of parsed.data.names) {
      if (!history.lastSelectedId.has(name)) history.names.push(name);
      history.lastSelectedId.set(name, row.id);
    }
  }
  return history;
}

/**
 * Quem pode sair do catálogo numa compactação, dado até onde o checkpoint vigente cobre (`coveredThrough`, o maior `messages.id` coberto, nulo sem checkpoint válido): a opcional cuja
 * seleção mais recente é anterior ou igual ao corte. Sem checkpoint nada pode sair; o que foi selecionado DEPOIS do corte (ou selecionado de novo) fica protegido até a compactação seguinte.
 */
export function selectedBeforeCut(coveredThrough: string | null): (lastSelectedId: string) => boolean {
  return (lastSelectedId) => coveredThrough !== null && BigInt(lastSelectedId) <= BigInt(coveredThrough);
}

// ---------------------------------------------------------------------------------------------
// O catálogo publicado
// ---------------------------------------------------------------------------------------------

/** O catálogo que a conversa tem direito a publicar nesta preparação, antes do teto do orçamento (ver `selectCatalog`). */
export interface CatalogPlan {
  /** Sempre publicadas, nunca candidatas a sair. Bot: a lista fixa (`botCatalogNames`). Chat geral: as duas portas e, depois delas, as core presentes no registry (na ordem do registry). */
  fixed: ToolHandler['definition'][];
  /** As opcionais selecionadas que o registry ainda tem, na ordem da primeira seleção: a ordem em que seguem no campo `tools`, depois de `fixed`. Sempre vazia no bot. */
  optional: ToolHandler['definition'][];
  /** As opcionais que podem sair nesta preparação, da seleção mais antiga à mais nova: a ordem em que o orçamento as retira (`fitToolCatalog`). Subconjunto de `optional`; vazia no bot. */
  droppable: ToolHandler['definition'][];
}

/**
 * Monta o catálogo da conversa. É puro (registry, histórico e corte entram, o mesmo catálogo sai), por isso é o MESMO em toda etapa e rodada enquanto nada novo chega.
 * - BOT (o registry tem `abrir_grupo`): a lista fixa de `botCatalogNames`, sem opcional publicada; `history`, `droppable` e o corte da compactação não se aplicam. `mostUsed` é a parte variável.
 * - CHAT GERAL (phase 12, F2): as portas, as core e a união das seleções de `discover_tools`; uma ferramenta nova entra sempre no fim; `names` fora do registry (pesquisa na web desligada) não aparecem e voltam
 *   ao lugar de origem se o registry voltar a ter a ferramenta. `droppable` diz, por ferramenta, se o orçamento pode retirá-la nesta preparação: ver `selectedBeforeCut` (só o que a compactação já deixou
 *   para trás) ou `() => true` na recarga depois da recusa do provedor e nas redes de segurança contra CONTEXT_TOO_LARGE (exceção aceita pelo dono em 18/10/2026), que descarregam todas as opcionais só daquele
 *   pedido. Core e portas nunca são candidatas.
 * Handlers originais continuam registrados: a publicação é exposição, não permissão.
 */
export function selectCatalog(registry: ReadonlyMap<string, ToolHandler>, history: ToolSelectionHistory, droppable: (lastSelectedId: string) => boolean, mostUsed: readonly string[] = []): CatalogPlan {
  if (registry.has(ABRIR_GRUPO)) return { fixed: botCatalogNames(registry, mostUsed).map((name) => registry.get(name)!.definition), optional: [], droppable: [] };
  const bootstrap = [registry.get(DISCOVER_TOOLS), registry.get(READ_ACTIVITY)].filter((tool): tool is ToolHandler => tool !== undefined);
  const core = [...registry.values()].filter((tool) => !RESERVED_RUNTIME_TOOLS.has(tool.definition.name) && tool.core === true);
  const optional = history.names.flatMap((name) => {
    const tool = registry.get(name);
    return tool && !RESERVED_RUNTIME_TOOLS.has(name) && tool.core !== true ? [{ definition: tool.definition, id: history.lastSelectedId.get(name)! }] : [];
  });
  return {
    fixed: [...bootstrap, ...core].map((tool) => tool.definition),
    optional: optional.map((entry) => entry.definition),
    droppable: optional.filter((entry) => droppable(entry.id)).sort((a, b) => Number(BigInt(a.id) - BigInt(b.id))).map((entry) => entry.definition),
  };
}
