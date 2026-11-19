'use client';

// Atividade de ferramenta dentro da resposta do bot (design: "Bloco de atividade"): linha compacta com ícone de estado, nome
// legível e chevron para expandir. Expandida, mostra o nome técnico (slug), os argumentos e o resultado em blocos de até 12 linhas
// com rolagem interna; a busca no histórico mostra até 3 trechos, cada um com a data e o link "ver na conversa".
// A pesquisa na web (T9, design "Atividade de pesquisa na web") mostra a lista dos resultados (título como link e a URL COMPLETA logo abaixo) e a leitura
// de páginas mostra cada URL pedida e se foi lida. As URLs e os títulos vêm da internet (dado NÃO CONFIÁVEL): só uma URL `http` ou `https` vira link, com
// `rel="noopener noreferrer"`, abrindo em nova aba (e o leitor de tela ouve "abre em nova aba"); qualquer outra aparece como texto simples. O servidor já
// descarta os resultados com outro esquema; esta validação é a segunda camada.
// O Python (phase 4, F8; design "Atividade Python") tem rótulo próprio por estado (vaga, execução, sucesso com a duração, falha e indisponível) e,
// expandido, o código no `CodeBlock` da phase 3, a saída, o erro e os arquivos gerados e recusados. O STATUS da atividade é autoritativo: depois de
// um reinício do worker o detalhe pode ter ficado em `running` com a atividade já `failed` (observação da T7), e a tela mostra a falha.
// Cada execução tem UMA linha de trabalho ("Trabalhou por 12 s · 3 ações", `describeWork`) com a Faísca pequena de concluído, expansível no clique e pelo teclado, no lugar do
// grupo "N ações executadas" e da linha isolada (phase 18, decisão 5 da spec); a execução sem ferramenta não tem linha.
import type { ActivityView, Bot, PythonDetail } from '@aion/shared';
import { Check, ChevronRight, Clock, FileText, Globe, LoaderCircle, Paperclip, Search, Terminal, X } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import { BotAvatar } from '@/components/bots/bot-avatar';
import { cn } from '@/lib/cn';
import { AttachmentIcon, attachmentSize } from './attachment-list';
import { CodeBlock } from './code-block';
import { describeWork, type WorkLine } from './timeline';

/** Data e hora do trecho no fuso do navegador. */
const formatWhen = (iso: string): string => new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });

/** Ícone de estado: girando enquanto executa, X se falhou; concluída mostra o ícone da própria ferramenta (lupa na busca, globo na web, página na leitura). */
function StateIcon({ activity }: { activity: ActivityView }) {
  const icon = 'size-4 shrink-0';
  // Esperando a resposta do dono (aprovação pendente): relógio em `--warning`, e não o indicador de execução.
  if (activity.awaitingApproval) return <Clock className={cn(icon, 'text-warning')} strokeWidth={1.5} aria-hidden />;
  if (activity.status === 'running') return <LoaderCircle data-icon="LoaderCircle" className={cn(icon, 'animate-spin')} strokeWidth={1.5} aria-hidden />;
  if (activity.detail?.type === 'attachment_read') return <Paperclip className={icon} strokeWidth={1.5} aria-hidden />;
  if (activity.status === 'failed') return <X className={cn(icon, 'text-danger')} strokeWidth={1.5} aria-hidden />;
  if (activity.detail?.type === 'history_search') return <Search className={icon} strokeWidth={1.5} aria-hidden />;
  if (activity.detail?.type === 'web_search') return <Globe className={icon} strokeWidth={1.5} aria-hidden />;
  if (activity.detail?.type === 'web_fetch') return <FileText className={icon} strokeWidth={1.5} aria-hidden />;
  if (activity.detail?.type === 'python') return <Terminal className={icon} strokeWidth={1.5} aria-hidden />;
  return <Check className={cn(icon, 'text-success')} strokeWidth={1.5} aria-hidden />;
}

/** Duração legível ("1,2 s"), a mesma forma do rótulo que o worker grava. */
const seconds = (ms: number): string => `${(ms / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} s`;

/**
 * Rótulo da linha da atividade. No Python (design "Atividade Python") ele vem do estado: o status da atividade decide entre execução, sucesso e
 * falha, e o detalhe só refina a espera pela vaga e o "indisponível". As demais ferramentas usam o rótulo gravado pelo worker.
 */
export function activityLabel(activity: ActivityView): string {
  const detail = activity.detail;
  if (detail?.type !== 'python') return activity.label;
  if (activity.status === 'running') return detail.state === 'waiting' ? 'Aguardando vaga para o Python…' : 'Executando Python…';
  if (activity.status === 'failed') return detail.outcome === 'PYTHON_UNAVAILABLE' ? 'Python indisponível agora' : 'Python falhou';
  return detail.durationMs === null ? 'Python executado' : `Python executado (${seconds(detail.durationMs)})`;
}

/** Texto técnico (argumentos, resultado) em até 12 linhas; acima disso rola por dentro, sem alargar a página. `danger` pinta o título (o erro do Python). */
function Code({ title, children, danger = false }: { title: string; children: string; danger?: boolean }) {
  return (
    <div>
      <p className={cn('mb-1 text-xs font-medium', danger ? 'text-danger' : 'text-subtle')}>{title}</p>
      <pre tabIndex={0} className="max-h-[17rem] overflow-auto whitespace-pre-wrap rounded-sm bg-surface p-2 font-mono text-[13px]/5 text-muted [overflow-wrap:anywhere]">
        {children}
      </pre>
    </div>
  );
}

/**
 * O endereço de link de uma URL que veio da internet, ou nulo se ela não pode virar link: só `http` e `https`, e sem usuário e senha. Fonte única da
 * regra "nunca criar link com outro esquema" (a URL é dado não confiável: `javascript:` e similares ficam como texto).
 */
export function webLinkHref(raw: string): string | null {
  try {
    const url = new URL(raw);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.username === '' && url.password === '' ? url.href : null;
  } catch {
    return null;
  }
}

/** Link para fora do app: nova aba, sem `opener` nem `referrer`, e o texto oculto que avisa o leitor de tela. */
function ExternalLink({ href, className, children }: { href: string; className: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={className}>
      {children}
      <span className="sr-only"> (abre em nova aba)</span>
    </a>
  );
}

/** Lista da atividade da web: no celular mostra até 12 linhas e rola por dentro (focável pelo teclado); URLs longas quebram em qualquer ponto. */
function WebList({ label, children }: { label: string; children: ReactNode }) {
  return (
    <ul tabIndex={0} aria-label={label} className="flex max-h-60 flex-col gap-2 overflow-y-auto sm:max-h-none sm:overflow-visible">
      {children}
    </ul>
  );
}

/** Aviso fixo de que o texto da web não é instrução (o bot o trata como dado). */
function UntrustedNote() {
  return <p className="text-xs text-subtle">Conteúdo da web: o bot o trata como dado, não como instrução.</p>;
}

/** Detalhe de `web_search`: as consultas enviadas e um item por resultado, com o título (link se a URL for http ou https) e a URL completa abaixo. */
function WebSearchDetail({ detail }: { detail: Extract<NonNullable<ActivityView['detail']>, { type: 'web_search' }> }) {
  return (
    <>
      <p className="text-xs text-subtle [overflow-wrap:anywhere]">
        {detail.queries.length === 1 ? 'Consulta' : 'Consultas'}: {detail.queries.join(' · ')}
      </p>
      {detail.results.length > 0 ? (
        <WebList label="Resultados da pesquisa">
          {detail.results.map((result, index) => {
            const href = webLinkHref(result.url);
            return (
              <li key={`${index}-${result.url}`} className="min-w-0 rounded-sm bg-surface p-2">
                {href ? (
                  <ExternalLink href={href} className="text-sm text-info underline underline-offset-4 [overflow-wrap:anywhere]">
                    {result.title}
                  </ExternalLink>
                ) : (
                  <p className="text-sm text-muted [overflow-wrap:anywhere]">{result.title}</p>
                )}
                <p className="font-mono text-xs text-subtle [overflow-wrap:anywhere]">{result.url}</p>
              </li>
            );
          })}
        </WebList>
      ) : (
        <p className="text-sm text-muted">Nenhum resultado encontrado.</p>
      )}
      <UntrustedNote />
    </>
  );
}

/** Detalhe de `web_fetch`: uma linha por URL pedida, com a URL completa (link se for http ou https) e "Lida" ou "Não lida". */
function WebFetchDetail({ detail }: { detail: Extract<NonNullable<ActivityView['detail']>, { type: 'web_fetch' }> }) {
  return (
    <>
      <WebList label="Páginas pedidas">
        {detail.pages.map((page, index) => {
          const href = webLinkHref(page.url);
          return (
            <li key={`${index}-${page.url}`} className="flex items-start gap-2 rounded-sm bg-surface p-2">
              {href ? (
                <ExternalLink href={href} className="min-w-0 flex-1 font-mono text-xs text-info underline underline-offset-4 [overflow-wrap:anywhere]">
                  {page.url}
                </ExternalLink>
              ) : (
                <p className="min-w-0 flex-1 font-mono text-xs text-subtle [overflow-wrap:anywhere]">{page.url}</p>
              )}
              <span className={cn('flex shrink-0 items-center gap-1 text-xs', page.read ? 'text-success' : 'text-danger')}>
                {page.read ? <Check className="size-3.5" strokeWidth={1.5} aria-hidden /> : <X className="size-3.5" strokeWidth={1.5} aria-hidden />}
                {page.read ? 'Lida' : 'Não lida'}
              </span>
            </li>
          );
        })}
      </WebList>
      <UntrustedNote />
    </>
  );
}

/**
 * O que mostrar em "Erro" do Python: a frase fixa dos desfechos sem traceback útil (tempo, memória, indisponível, entrada recusada, sem espaço, parada)
 * ou o traceback devolvido pelo sandbox. Nulo quando não houve erro.
 */
function pythonError(activity: ActivityView, detail: PythonDetail): string | null {
  switch (detail.outcome) {
    case 'PYTHON_TIMEOUT':
      return 'Tempo esgotado (60 s).';
    case 'PYTHON_MEMORY_LIMIT':
      return 'Memória esgotada (512 MB).';
    case 'PYTHON_UNAVAILABLE':
      return 'Python indisponível agora.';
    case 'PYTHON_INPUT_INVALID':
      return 'Anexo de entrada inexistente, removido ou acima de 50 MB. Nada foi executado.';
    case 'ATTACHMENT_QUOTA_EXCEEDED':
      return 'O espaço para arquivos acabou e nenhum arquivo foi gravado. Libere espaço em Configurações → Arquivos.';
    default:
      if (detail.error) return detail.error;
      // Sem desfecho e com a atividade falha: a execução foi parada (ou o worker reiniciou) antes de o sandbox responder.
      return activity.status === 'failed' && detail.outcome === null ? 'Execução interrompida antes de terminar.' : null;
  }
}

/**
 * Detalhe do `run_python`: o código (`CodeBlock` com Copiar e Quebrar linhas), a saída (com a nota de corte), o erro e os arquivos gerados (os anexos
 * da atividade, com ícone, nome e tamanho) e recusados (com o motivo curto). Enquanto a chamada roda, só o código.
 */
function PythonDetails({ activity, detail }: { activity: ActivityView; detail: PythonDetail }) {
  const finished = activity.status !== 'running';
  const error = finished ? pythonError(activity, detail) : null;
  const files = (activity.attachments ?? []).filter((file) => file.kind === 'generated');
  return (
    <>
      <div>
        <p className="mb-1 text-xs font-medium text-subtle">Código</p>
        <CodeBlock language="python" content={detail.code} />
      </div>
      {finished && detail.state === 'done' ? (
        <div>
          {detail.output ? (
            <Code title="Saída">{detail.output}</Code>
          ) : (
            <>
              <p className="mb-1 text-xs font-medium text-subtle">Saída</p>
              <p className="text-sm text-muted">Sem saída de texto.</p>
            </>
          )}
          {detail.outputTruncated ? <p className="mt-1 text-xs text-subtle">Saída cortada em 20.000 caracteres.</p> : null}
        </div>
      ) : null}
      {error ? (
        <Code title="Erro" danger>
          {error}
        </Code>
      ) : null}
      {files.length > 0 || detail.rejected.length > 0 ? (
        <div>
          <p className="mb-1 text-xs font-medium text-subtle">Arquivos gerados</p>
          <ul className="flex flex-col gap-1 text-xs text-muted">
            {files.map((file) => (
              <li key={file.id} className="flex min-w-0 items-center gap-2">
                <AttachmentIcon name={file.name} className="size-4 shrink-0" />
                <span className="min-w-0 truncate" title={file.name}>
                  {file.name}
                </span>
                <span className="shrink-0 text-subtle">{file.removed ? 'removido' : attachmentSize(file.sizeBytes)}</span>
              </li>
            ))}
            {detail.rejected.map((file, index) => (
              <li key={`recusado-${index}`} className="flex min-w-0 items-center gap-2">
                <X className="size-4 shrink-0 text-danger" strokeWidth={1.5} aria-hidden />
                <span className="min-w-0 truncate" title={file.name}>
                  {file.name}
                </span>
                <span className="shrink-0 text-danger">{file.reason === 'format' ? 'formato não aceito' : 'acima de 5 MB'}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </>
  );
}

/**
 * O texto do bloco "Resultado". Toda falha de ferramenta é gravada no envelope `{ code, message, ... }` que o modelo lê (phase 15, A21); o dono lê só a `message`, como texto (nunca o JSON cru, o código
 * nem os campos técnicos). Só vale para atividade que falhou e para um objeto com `code` e `message` em texto; qualquer outro resultado aparece como foi gravado.
 */
export function resultText(activity: Pick<ActivityView, 'status' | 'result'>): string {
  if (activity.result === null || activity.status !== 'failed' || !activity.result.startsWith('{')) return activity.result ?? '';
  try {
    const envelope: unknown = JSON.parse(activity.result);
    if (envelope !== null && typeof envelope === 'object' && typeof (envelope as { code?: unknown }).code === 'string' && typeof (envelope as { message?: unknown }).message === 'string') return (envelope as { message: string }).message;
  } catch {
    // não é JSON: aparece como foi gravado
  }
  return activity.result;
}

/** O conteúdo expandido de uma atividade: o slug, o detalhe próprio da ferramenta (busca no histórico, pesquisa ou leitura na web) ou os argumentos e o resultado. */
export function ActivityDetails({ activity, onJump }: { activity: ActivityView; onJump: (messageId: string) => void }) {
  const detail = activity.detail;
  return (
    <div className="mt-1.5 flex flex-col gap-2 pb-1 pl-6">
      <p className="font-mono text-[13px]/5 text-subtle">{activity.tool}</p>
      {detail?.type === 'history_search' ? (
        detail.hits.length > 0 ? (
          <ul className="flex flex-col gap-2">
            {detail.hits.map((hit) => (
              <li key={hit.messageId} className="rounded-sm bg-surface p-2 text-sm text-muted">
                <p className="text-xs text-subtle">{formatWhen(hit.createdAt)}</p>
                <p className="[overflow-wrap:anywhere]">{hit.snippet}</p>
                <button type="button" onClick={() => onJump(hit.messageId)} className="mt-1 rounded-sm text-xs font-medium text-fg underline underline-offset-4">
                  ver na conversa
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted">Nenhum trecho encontrado.</p>
        )
      ) : detail?.type === 'web_search' ? (
        <WebSearchDetail detail={detail} />
      ) : detail?.type === 'web_fetch' ? (
        <WebFetchDetail detail={detail} />
      ) : detail?.type === 'python' ? (
        <PythonDetails activity={activity} detail={detail} />
      ) : (
        <>
          {activity.arguments !== '' && activity.arguments !== '{}' ? <Code title="Argumentos">{activity.arguments}</Code> : null}
          {activity.result ? <Code title="Resultado">{resultText(activity)}</Code> : null}
        </>
      )}
    </div>
  );
}

function ActivityRow({ activity, onJump }: { activity: ActivityView; onJump: (messageId: string) => void }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  return (
    <li>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
        className="flex min-h-7 w-full items-center gap-2 rounded-sm text-left text-sm text-muted hover:text-fg"
      >
        <StateIcon activity={activity} />
        <span className="min-w-0 flex-1 truncate" title={activityLabel(activity)}>
          {activityLabel(activity)}
          {activity.awaitingApproval ? <span className="ml-2 text-xs text-warning">Aguardando aprovação</span> : null}
        </span>
        <ChevronRight className={cn('size-4 shrink-0 transition-transform duration-150', open && 'rotate-90')} strokeWidth={1.5} aria-hidden />
      </button>
      <div id={panelId} hidden={!open}>
        {open ? <ActivityDetails activity={activity} onJump={onJump} /> : null}
      </div>
    </li>
  );
}

/**
 * A linha de trabalho de uma execução (phase 18, decisão 5 da spec): a Faísca pequena e parada (concluído, ou trabalhando/aguardando enquanto a execução está aberta), o resumo de
 * `describeWork` e o chevron. É um botão: abre e fecha a lista das ferramentas no clique, no Enter e no Espaço. Fechada, a lista não está no DOM (nem os resultados, que
 * podem ser grandes). `live` diz que a execução ainda está aberta; `bot` escolhe a cor da Faísca (nulo, o Aion do Chat geral).
 */
export function ActivityGroup({ line, bot, live, onJump }: { line: WorkLine; bot: Bot | null; live: boolean; onJump: (messageId: string) => void }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const waiting = line.activities.some((activity) => activity.awaitingApproval);
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
        className="flex min-h-7 w-full items-center gap-2 rounded-sm text-left text-sm text-muted hover:text-fg"
      >
        <BotAvatar owner={bot} size={24} state={waiting ? 'waiting' : live ? 'working' : 'done'} still />
        <span className="min-w-0 flex-1 truncate">{describeWork(line, live)}</span>
        <ChevronRight className={cn('size-4 shrink-0 transition-transform duration-150', open && 'rotate-90')} strokeWidth={1.5} aria-hidden />
      </button>
      <ul id={panelId} hidden={!open} className="flex flex-col border-l border-line pl-3">
        {open ? line.activities.map((activity) => <ActivityRow key={activity.id} activity={activity} onJump={onJump} />) : null}
      </ul>
    </div>
  );
}
