// Da lista de mensagens aos blocos que a tela desenha (função pura, sem React).
//
// Regras do design: o marcador do bot aparece só no PRIMEIRO bloco de cada sequência (tudo que o bot produz em seguida, sem uma
// mensagem do dono ou um cartão no meio); chamadas de ferramenta seguidas se agrupam num bloco só e, na tela, cada execução tem UMA linha de trabalho
// ("Trabalhou por 12 s · 3 ações", `workLinesOf`). O texto que o bot ainda está escrevendo NÃO vira bloco (T19): a resposta surge inteira, de uma vez, quando
// a etapa do modelo termina; enquanto isso a tela mostra a linha da Faísca acima do composer (`workingPhrase`) e as ferramentas, que continuam aparecendo ao vivo.
import type { ActivityView, ArtifactRef, CardView, ConversationAttachment, MessageView, TextMessageView } from '@aion/shared';
import { artifactKey } from '@/components/artifacts/artifact-card';
import { activeRunOf, queuedRunsOf, type ConversationState } from './conversation-state';

export type Block =
  | { type: 'user'; key: string; message: TextMessageView }
  | { type: 'assistant'; key: string; message: TextMessageView; first: boolean }
  | { type: 'activities'; key: string; activities: ActivityView[]; first: boolean }
  | { type: 'card'; key: string; message: CardView };

/** Texto do bot que o servidor ainda está gravando aos poucos (`streaming`): escondido até a etapa terminar. */
const isBeingWritten = (message: MessageView): boolean => message.kind === 'text' && message.role === 'assistant' && message.status === 'streaming';

/** As mensagens que a tela mostra: todas, menos o texto do bot ainda em escrita. Fonte única para os blocos e para o "tem novidade no fim". */
export const visibleItems = (items: readonly MessageView[]): MessageView[] => items.filter((message) => !isBeingWritten(message));

/** A última mensagem que a tela mostra (varre de trás para a frente, sem criar uma lista nova a cada renderização). */
export function lastVisibleItem(items: readonly MessageView[]): MessageView | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const message = items[index] as MessageView;
    if (!isBeingWritten(message)) return message;
  }
  return undefined;
}

export function buildBlocks(items: readonly MessageView[]): Block[] {
  const blocks: Block[] = [];
  let inBotSequence = false;
  for (const message of visibleItems(items)) {
    if (message.kind === 'text' && message.role === 'user') {
      blocks.push({ type: 'user', key: message.id, message });
      inBotSequence = false;
    } else if (message.kind === 'card') {
      blocks.push({ type: 'card', key: message.id, message });
      inBotSequence = false;
    } else if (message.kind === 'text') {
      blocks.push({ type: 'assistant', key: message.id, message, first: !inBotSequence });
      inBotSequence = true;
    } else {
      const last = blocks.at(-1);
      if (last?.type === 'activities') {
        last.activities.push(message);
      } else {
        blocks.push({ type: 'activities', key: message.id, activities: [message], first: !inBotSequence });
        inBotSequence = true;
      }
    }
  }
  return blocks;
}

/** Uma linha de trabalho (phase 18, decisão 5 da spec): as atividades de UMA execução e o intervalo dela, de onde sai "Trabalhou por N s · N ações". */
export interface WorkLine {
  activities: ActivityView[];
  /** Quando a rodada começou: o `createdAt` do item mais antigo da execução (a mensagem do dono que a abre; na rotina, o primeiro item). */
  startedAt: string;
  /** O `createdAt` do último item da execução (resposta, atividade ou cartão). */
  endedAt: string;
}

/**
 * As linhas de trabalho da conversa, uma por execução (decisão do dono de 2026-11-14): a linha fica no PRIMEIRO bloco de atividades da execução e leva as atividades de todos os
 * blocos dela; os blocos seguintes da mesma execução (depois de um texto intermediário) valem `null`, e a tela não desenha linha neles. Execução sem ferramenta não tem bloco de
 * atividades, então não tem linha. O intervalo vem só dos `createdAt` dos itens (o mesmo no ao vivo e depois de recarregar, sem mudar a API): do mais antigo ao mais recente da
 * execução, o que não conta o tempo que a resposta final levou para ser escrita.
 * ponytail: o fim da rodada é o `createdAt` do último item, sem o tempo de escrita da resposta final, e o N inclui a espera na fila e a espera por aprovação; trocar por
 * `runs.finished_at` se o dono notar a diferença.
 */
export function workLinesOf(blocks: readonly Block[], items: readonly MessageView[]): Map<string, WorkLine | null> {
  const span = new Map<string, { from: number; to: number; fromIso: string; toIso: string }>();
  for (const item of visibleItems(items)) {
    if (item.runId === null) continue;
    const at = Date.parse(item.createdAt);
    const known = span.get(item.runId);
    if (known === undefined) span.set(item.runId, { from: at, to: at, fromIso: item.createdAt, toIso: item.createdAt });
    else {
      if (at < known.from) Object.assign(known, { from: at, fromIso: item.createdAt });
      if (at > known.to) Object.assign(known, { to: at, toIso: item.createdAt });
    }
  }
  const lines = new Map<string, WorkLine | null>();
  const firstOfRun = new Map<string, WorkLine>();
  for (const block of blocks) {
    if (block.type !== 'activities') continue;
    // Atividade sem execução (não acontece no servidor) vira a própria linha, com o intervalo das atividades dela.
    const runId = block.activities[0]?.runId ?? null;
    const key = runId ?? `bloco:${block.key}`;
    const known = firstOfRun.get(key);
    if (known !== undefined) {
      known.activities.push(...block.activities);
      lines.set(block.key, null);
      continue;
    }
    const range = runId === null ? undefined : span.get(runId);
    const created = block.activities.map((activity) => activity.createdAt);
    const line: WorkLine = { activities: [...block.activities], startedAt: range?.fromIso ?? created[0] ?? '', endedAt: range?.toIso ?? created.at(-1) ?? '' };
    firstOfRun.set(key, line);
    lines.set(block.key, line);
  }
  return lines;
}

/** Duração legível: segundos até 60 s ("12 s") e, acima disso, minutos e segundos ("1 min 5 s"). Nunca menos de 1 s: uma rodada que levou meio segundo não "trabalhou por 0 s". */
export function elapsedLabel(startedAt: string, endedAt: string): string {
  const seconds = Math.max(1, Math.ceil((Date.parse(endedAt) - Date.parse(startedAt)) / 1000));
  if (seconds <= 60) return `${seconds} s`;
  const rest = seconds % 60;
  return rest === 0 ? `${Math.floor(seconds / 60)} min` : `${Math.floor(seconds / 60)} min ${rest} s`;
}

/**
 * Texto da linha de trabalho de uma execução. Concluída: "Trabalhou por 12 s · 3 ações" ("1 ação"), com ", N com falha" quando alguma ferramenta falhou. Em andamento
 * (`live`, a execução ainda está aberta) não há duração a dizer: "Executando 2 ações", ou "Aguardando aprovação" quando uma ação espera o dono.
 */
export function describeWork(line: WorkLine, live: boolean): string {
  const total = line.activities.length;
  const noun = total === 1 ? 'ação' : 'ações';
  if (line.activities.some((activity) => activity.awaitingApproval)) return 'Aguardando aprovação';
  if (live || line.activities.some((activity) => activity.status === 'running')) return `Executando ${total} ${noun}`;
  const failed = line.activities.filter((activity) => activity.status === 'failed').length;
  const base = `Trabalhou por ${elapsedLabel(line.startedAt, line.endedAt)} · ${total} ${noun}`;
  return failed > 0 ? `${base}, ${failed} com falha` : base;
}

/**
 * Frase da linha da Faísca acima do composer (phase 18, ID-04): o que o bot está fazendo agora, em PT-BR e no presente. Fonte única das frases: a tela só as mostra.
 * Vem do que a execução ativa tem em curso (`activities` são as atividades dela): aprovação pendente vence; depois a ÚLTIMA ferramenta em andamento. O texto de `label` do
 * worker fica no passado ("Buscou e-mails") e o do Composio é o slug, então a frase sai de `activity.tool` (o slug da ação ou o alvo do `use_tool`) e dos argumentos.
 * Só há frase própria para o que o dono entende de relance (busca de e-mails no Gmail e leitura de doc); o resto é "Trabalhando…", que é também o que vale entre ferramentas.
 * `docTitleOf` resolve o título pela lista de docs que a web já lê; doc fora dela (sem acesso ou excluído) cai em "Trabalhando…", nunca em id nem em erro.
 */
export function workingPhrase(
  activities: readonly ActivityView[],
  waitingApproval: boolean,
  docTitleOf: (docId: string) => string | null,
): string {
  if (waitingApproval) return 'Aguardando sua aprovação';
  const current = runningActivity(activities);
  if (current !== undefined && EMAIL_SEARCH_TOOLS.has(current.tool)) return 'Procurando e-mails no Gmail…';
  const docId = workingDocId(activities);
  if (docId !== null) {
    const title = docTitleOf(docId);
    if (title !== null) return `Lendo o doc ${title}…`;
  }
  return 'Trabalhando…';
}

/** O bot parou esperando o dono: a execução está em `waiting_approval` ou uma das atividades em andamento espera a resposta (as duas marcas chegam por caminhos diferentes, snapshot e SSE). */
export const isWaitingApproval = (runStatus: string | undefined, activities: readonly ActivityView[]): boolean =>
  runStatus === 'waiting_approval' || activities.some((activity) => activity.status === 'running' && activity.awaitingApproval);

/** Ações do Composio que buscam e-mails no Gmail (o slug chega em `activity.tool`, também quando a chamada passou pela porta do conector). */
const EMAIL_SEARCH_TOOLS: ReadonlySet<string> = new Set(['GMAIL_FETCH_EMAILS', 'GMAIL_LIST_MESSAGES']);

/** A última atividade ainda em andamento (a que o bot está executando agora). */
const runningActivity = (activities: readonly ActivityView[]): ActivityView | undefined => activities.findLast((activity) => activity.status === 'running');

/**
 * O doc que a ferramenta em andamento está lendo (`doc_read`), pelo `docId` dos argumentos, ou nulo. A tela usa para buscar a lista de docs só quando precisa do título.
 * Argumento truncado ou que não é JSON (o servidor trunca o texto) não tem doc: devolve nulo em vez de lançar.
 */
export function workingDocId(activities: readonly ActivityView[]): string | null {
  const current = runningActivity(activities);
  if (current?.tool !== 'doc_read') return null;
  try {
    const docId = (JSON.parse(current.arguments) as { docId?: unknown } | null)?.docId;
    return typeof docId === 'string' ? docId : null;
  } catch {
    return null;
  }
}

/**
 * A conversa está trabalhando (a linha da Faísca aparece): há execução ativa (rodando ou aguardando aprovação) ou, no Chat geral, uma execução na fila cuja mensagem já está no caminho
 * (edição ou outra resposta). A execução na fila de um bot, ou de uma rotina, não conta: ela aparece como bolha ou cartão "Na fila" e a linha esperaria o que ainda não começou.
 */
export const isWorking = (state: ConversationState): boolean =>
  activeRunOf(state) !== null || queuedRunsOf(state).some((run) => state.rounds?.some((round) => round.runId === run.id) === true);

/**
 * Onde vai a barra de ações das respostas (phase 4, design "Barra de ações da mensagem"): só abaixo da ÚLTIMA bolha de texto de cada resposta (a
 * execução, `runId`), nunca de cada bloco intermediário dela; texto sem execução conta como uma resposta própria. `pinned` é a barra da última
 * resposta da conversa, a que fica sempre visível no desktop. Enquanto a execução escreve, a barra fica na última bolha já exibida e passa para a
 * seguinte quando ela aparece.
 */
export function answerBarsOf(blocks: readonly Block[]): { withBar: ReadonlySet<string>; pinned: string | null } {
  const lastOfRun = new Map<string, string>();
  for (const block of blocks) {
    if (block.type === 'assistant') lastOfRun.set(block.message.runId ?? `texto:${block.key}`, block.key);
  }
  const withBar = new Set(lastOfRun.values());
  const pinned = blocks.findLast((block) => block.type === 'assistant' && withBar.has(block.key))?.key ?? null;
  return { withBar, pinned };
}

/**
 * Onde vão os controles de versão de uma resposta que não tem texto visível (phase 4, Chat geral): uma falha, uma parada ou só atividades. Sem isso
 * a resposta que falhou numa versão nova esconderia o seletor e o caminho de volta à versão anterior. Para cada execução do caminho (`runIds`) sem
 * bolha de texto, a barra vai no ÚLTIMO bloco dela (cartão ou grupo de atividades). Devolve chave do bloco -> execução; as respostas com texto
 * continuam com a barra de `answerBarsOf`.
 */
export function bareAnswerAnchorsOf(blocks: readonly Block[], runIds: ReadonlySet<string>): Map<string, string> {
  const withText = new Set<string>();
  const last = new Map<string, string>();
  for (const block of blocks) {
    const runId = block.type === 'activities' ? (block.activities.at(-1)?.runId ?? null) : block.type === 'user' ? null : block.message.runId;
    if (runId === null || !runIds.has(runId)) continue;
    if (block.type === 'assistant') withText.add(runId);
    else last.set(runId, block.key);
  }
  return new Map([...last].filter(([runId]) => !withText.has(runId)).map(([runId, key]) => [key, runId]));
}

/**
 * Onde "mora" a resposta de cada execução (`runId`): a ÚLTIMA bolha de texto dela ou, sem texto (falha, parada), o ÚLTIMO grupo de atividades dela. É o ponto em que o que a
 * execução produziu (os arquivos gerados e os cartões de artefato) aparece sob a resposta, sem nunca sumir quando não há texto. Devolve execução -> chave do bloco.
 */
function answerAnchorsOf(blocks: readonly Block[]): Map<string, string> {
  const anchor = new Map<string, { key: string; text: boolean }>();
  for (const block of blocks) {
    if (block.type === 'assistant' && block.message.runId !== null) anchor.set(block.message.runId, { key: block.key, text: true });
    if (block.type !== 'activities') continue;
    for (const activity of block.activities) {
      if (activity.runId !== null && !anchor.get(activity.runId)?.text) anchor.set(activity.runId, { key: block.key, text: false });
    }
  }
  return new Map([...anchor].map(([runId, { key }]) => [runId, key]));
}

/**
 * Onde vão os arquivos gerados pelo Python (phase 4, F10; design "Arquivos gerados na resposta"): os anexos `generated` das atividades de cada
 * execução saem da atividade e aparecem sob a resposta dela (`answerAnchorsOf`). Devolve chave do bloco -> arquivos, na ordem de gravação.
 */
export function generatedFilesOf(blocks: readonly Block[]): Map<string, ConversationAttachment[]> {
  const anchors = answerAnchorsOf(blocks);
  const files = new Map<string, ConversationAttachment[]>();
  for (const block of blocks) {
    if (block.type !== 'activities') continue;
    for (const activity of block.activities) {
      const generated = (activity.attachments ?? []).filter((file) => file.kind === 'generated');
      const key = activity.runId === null ? undefined : anchors.get(activity.runId);
      if (key !== undefined && generated.length) files.set(key, [...(files.get(key) ?? []), ...generated]);
    }
  }
  return files;
}

/**
 * Onde vão os cartões de artefato (phase 14, A4; decisão 14): UM POR ARTEFATO criado ou alterado em cada resposta, sob a resposta (`answerAnchorsOf`, o mesmo lugar dos arquivos
 * gerados). A referência vem da atividade (`activity.artifacts`, passo 4), que uma chamada preenche só quando conclui; a resposta que altera a mesma tabela duas vezes tem um
 * cartão só. O agrupamento é por execução, tipo e id: ordem da primeira vez que o artefato apareceu e título do último fechamento (uma renomeação dentro da resposta vale). Devolve
 * chave do bloco -> artefatos.
 */
export function artifactsOf(blocks: readonly Block[]): Map<string, ArtifactRef[]> {
  const anchors = answerAnchorsOf(blocks);
  // Um `Map.set` numa chave que já existe troca o valor e mantém a posição: é a regra "ordem da primeira vez, título do último".
  const byRun = new Map<string, Map<string, ArtifactRef>>();
  for (const block of blocks) {
    if (block.type !== 'activities') continue;
    for (const activity of block.activities) {
      if (activity.runId === null) continue;
      const refs = byRun.get(activity.runId) ?? new Map<string, ArtifactRef>();
      for (const ref of activity.artifacts ?? []) refs.set(artifactKey(ref), ref);
      if (refs.size > 0) byRun.set(activity.runId, refs);
    }
  }
  const cards = new Map<string, ArtifactRef[]>();
  for (const [runId, refs] of byRun) {
    const key = anchors.get(runId);
    if (key !== undefined) cards.set(key, [...(cards.get(key) ?? []), ...refs.values()]);
  }
  return cards;
}
