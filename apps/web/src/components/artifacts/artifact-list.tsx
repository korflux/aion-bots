'use client';

// Área Artefatos (phase 14, passo 6; ART-01, A1, A2, A3, A29, A31): a lista ÚNICA de tabelas e docs do dono, em `/artefatos`. Substitui as duas listas antigas de tabelas (por bot, em
// `bots/[id]/tabelas`, e geral, em `configuracoes/tabelas`) sem perder nada do que elas faziam (A29): "Sem bot", "Compartilhar" por item, "Nova tabela" com o teto de 100 e, agora,
// "Novo doc". É a tela a que as entradas novas levam (ícone e menu da conversa, atalho do Início e Configurações → Atividade e arquivos) e para onde as listas antigas redirecionam.
//
// SEÇÕES
//   1. Modelo e filtros (puros): `Artifact`, `buildArtifacts`, `filterArtifacts`. A lista junta as duas fontes numa forma só, ordenada pelo título; o filtro por tipo, o filtro por bot (com
//      "Sem bot") e a busca pelo título combinam. É o que `artifact-list.test.tsx` prova sem depender da tela.
//   2. `ArtifactList`: lê `/api/tables`, `/api/docs` e `/api/bots` juntos (uma falha em qualquer uma mostra o erro e "Tentar novamente": nunca uma lista pela metade) e desenha
//      cabeçalho, ações de criação, filtros e linhas.
//   3. `NewTableDialog`: "Nova tabela". A API cria a tabela sempre ASSOCIADA A UM BOT (`POST /api/bots/:botId/tables`, TAB-01), então o diálogo pede o bot; os demais se escolhem depois
//      em "Compartilhar". O "Novo doc" é o `NewDocDialog` do passo 5 (aceita vários bots ou nenhum).
//
// TÍTULO E LINK: o nome acessível do link é só o título; a descrição da tabela e o tipo ficam ao lado, fora do link, para o leitor de tela e a busca por papel acharem o artefato pelo nome.
// Cada título leva à PÁGINA PRÓPRIA (`/artefatos/tabelas/[id]` e `/artefatos/docs/[id]`, A7); o painel ao lado da conversa é do passo 7.
//
// ponytail: a lista junta as três leituras no cliente, com filtro e busca no cliente e sem paginação no servidor; vale enquanto os tetos de 100 tabelas e 100 docs valerem (no máximo 200
// itens), a paginar se os tetos subirem.
import { TABLE_LIMITS, DOC_LIMITS, type BotList, type DataTable, type DocSummary } from '@aion/shared';
import { FileText, Plus, Shapes, SearchX, Table2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { BotAvatar } from '@/components/bots/bot-avatar';
import { NewDocDialog } from '@/components/docs/new-doc';
import { fetchBots, fetchDocs } from '@/components/docs/api';
import { EmptyState, PageHeader } from '@/components/page';
import { SharingEditor } from '@/components/tables/sharing-editor';
import { DocSharing } from '@/components/docs/doc-sharing';
import { loadTableCatalog } from '@/components/tables/api';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/input';
import { Modal, ModalActions, ModalContent } from '@/components/ui/modal';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { ApiError, apiErrorMessage, apiFetch } from '@/lib/api-client';
import { cn } from '@/lib/cn';
import { useSession } from '@/lib/session-context';

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
// 1. Modelo e filtros (A1)
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------

export type ArtifactKind = 'table' | 'doc';

/** Um item da lista, na forma comum às duas fontes. `source` é o dado original, que o "Compartilhar" devolve ao editor de acesso do tipo certo. */
export type Artifact =
  | { kind: 'table'; id: string; title: string; description: string; botIds: string[]; href: string; source: DataTable }
  | { kind: 'doc'; id: string; title: string; description: string; botIds: string[]; href: string; source: DocSummary };

/** O que a lista mostra: o tipo, o bot (`'all'`, `'none'` para "Sem bot" ou o id do bot) e o texto da busca pelo título. */
export interface ArtifactFilters {
  kind: 'all' | ArtifactKind;
  bot: 'all' | 'none' | string;
  query: string;
}

export const NO_FILTERS: ArtifactFilters = { kind: 'all', bot: 'all', query: '' };

/** Minúsculas e sem acento, para "relatorio" achar "Relatório". O caso é o do português do Brasil. */
const fold = (text: string): string => text.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('pt-BR');

/**
 * Junta tabelas e docs numa lista só, do título A a Z (sem distinguir caixa e acento). Só o doc tem data de alteração, então não há uma ordem por recência comum aos dois tipos; o título
 * é o que o dono procura. Títulos iguais ficam em ordem estável: a tabela antes do doc, depois pelo id.
 */
export function buildArtifacts(tables: readonly DataTable[], docs: readonly DocSummary[]): Artifact[] {
  const items: Artifact[] = [
    ...tables.map((source): Artifact => ({ kind: 'table', id: source.id, title: source.name, description: source.description, botIds: source.botIds, href: `/artefatos/tabelas/${source.id}`, source })),
    ...docs.map((source): Artifact => ({ kind: 'doc', id: source.id, title: source.title, description: '', botIds: source.botIds, href: `/artefatos/docs/${source.id}`, source })),
  ];
  return items.sort(
    (a, b) => a.title.localeCompare(b.title, 'pt-BR', { sensitivity: 'base' }) || (a.kind === b.kind ? 0 : a.kind === 'table' ? -1 : 1) || a.id.localeCompare(b.id),
  );
}

/** Aplica os três filtros juntos. A busca olha só o título (não a descrição da tabela) e uma busca em branco não filtra. */
export function filterArtifacts(items: readonly Artifact[], filters: ArtifactFilters): Artifact[] {
  const query = fold(filters.query.trim());
  return items.filter((item) => {
    if (filters.kind !== 'all' && item.kind !== filters.kind) return false;
    if (filters.bot === 'none' ? item.botIds.length > 0 : filters.bot !== 'all' && !item.botIds.includes(filters.bot)) return false;
    return query === '' || fold(item.title).includes(query);
  });
}

const KIND_LABEL: Record<ArtifactKind, string> = { table: 'Tabela', doc: 'Doc' };

const TYPE_OPTIONS: readonly { id: ArtifactFilters['kind']; label: string }[] = [
  { id: 'all', label: 'Todos' },
  { id: 'table', label: 'Tabelas' },
  { id: 'doc', label: 'Docs' },
];

/** `1 artefato`, `6 artefatos`, `2 de 6 artefatos` (com filtro): o resultado que o leitor de tela ouve a cada filtro. */
function countLabel(shown: number, total: number): string {
  const noun = total === 1 ? 'artefato' : 'artefatos';
  return shown === total ? `${total} ${noun}` : `${shown} de ${total} ${noun}`;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
// 2. A tela
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------

type Bots = BotList['bots'];

type Load =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; tables: DataTable[]; docs: DocSummary[]; bots: Bots };

export function ArtifactList() {
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  /** Incrementar refaz a leitura ("Tentar novamente"). */
  const [attempt, setAttempt] = useState(0);
  const [filters, setFilters] = useState<ArtifactFilters>(NO_FILTERS);
  const [sharing, setSharing] = useState<Artifact | null>(null);
  const [creating, setCreating] = useState<ArtifactKind | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([loadTableCatalog(), fetchDocs(), fetchBots()]).then(
      ([tables, docList, botList]) => {
        if (!cancelled) setLoad({ status: 'ready', tables, docs: docList.docs, bots: botList.bots });
      },
      (cause: unknown) => {
        if (!cancelled) setLoad({ status: 'error', message: cause instanceof ApiError ? cause.message : 'Não foi possível carregar os artefatos.' });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const ready = load.status === 'ready' ? load : null;
  const items = useMemo(() => (ready ? buildArtifacts(ready.tables, ready.docs) : []), [ready]);
  const shown = useMemo(() => filterArtifacts(items, filters), [items, filters]);

  /** O compartilhamento salvo devolve o item atualizado: a linha e os filtros passam a usar a lista nova de bots sem reler tudo. */
  function applyShared(next: DataTable | DocSummary, kind: ArtifactKind) {
    setLoad((current) => {
      if (current.status !== 'ready') return current;
      return kind === 'table'
        ? { ...current, tables: current.tables.map((item) => (item.id === next.id ? (next as DataTable) : item)) }
        : { ...current, docs: current.docs.map((item) => (item.id === next.id ? (next as DocSummary) : item)) };
    });
  }

  const tablesFull = ready !== null && ready.tables.length >= TABLE_LIMITS.tables;
  const docsFull = ready !== null && ready.docs.length >= DOC_LIMITS.docs;

  return (
    <div className="mx-auto w-full max-w-[760px] px-4 pb-6 md:px-6">
      <PageHeader title="Artefatos" padded={false} />
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" disabled={ready === null || tablesFull} onClick={() => setCreating('table')}>
          <Plus className="size-4" strokeWidth={1.5} aria-hidden />
          Nova tabela
        </Button>
        <Button variant="secondary" disabled={ready === null || docsFull} onClick={() => setCreating('doc')}>
          <Plus className="size-4" strokeWidth={1.5} aria-hidden />
          Novo doc
        </Button>
      </div>
      {tablesFull ? <p className="mt-2 text-xs text-muted">Limite de {TABLE_LIMITS.tables} tabelas atingido. Exclua uma tabela para criar outra.</p> : null}
      {docsFull ? <p className="mt-2 text-xs text-muted">Limite de {DOC_LIMITS.docs} docs atingido. Exclua um doc para criar outro.</p> : null}

      {load.status === 'loading' ? (
        <div role="status" aria-busy="true" aria-label="Carregando artefatos" className="mt-6 flex flex-col gap-3">
          {[0, 1, 2].map((row) => (
            <div key={row} className="h-14 animate-pulse rounded-md bg-surface" />
          ))}
        </div>
      ) : load.status === 'error' ? (
        <EmptyState
          icon={SearchX}
          action={
            <Button
              variant="secondary"
              onClick={() => {
                setLoad({ status: 'loading' });
                setAttempt((value) => value + 1);
              }}
            >
              Tentar novamente
            </Button>
          }
        >
          <span role="alert">{load.message}</span>
        </EmptyState>
      ) : items.length === 0 ? (
        <EmptyState icon={Shapes}>Artefatos são as tabelas e os docs que os bots criam e mantêm para você. Peça a um bot para criar um ou comece por aqui.</EmptyState>
      ) : (
        <>
          <Filters filters={filters} bots={load.bots} onChange={setFilters} />
          <p aria-live="polite" className="mt-3 text-xs text-muted">
            {countLabel(shown.length, items.length)}
          </p>
          {shown.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-12 text-center">
              <p className="text-sm text-muted">Nenhum artefato com estes filtros.</p>
              <Button variant="secondary" onClick={() => setFilters(NO_FILTERS)}>
                Limpar filtros
              </Button>
            </div>
          ) : (
            <ul aria-label="Artefatos" className="divide-y divide-line">
              {shown.map((item) => (
                <ArtifactRow key={`${item.kind}:${item.id}`} artifact={item} bots={load.bots} onShare={() => setSharing(item)} />
              ))}
            </ul>
          )}
        </>
      )}

      {sharing?.kind === 'table' ? (
        <SharingEditor table={sharing.source} onClose={() => setSharing(null)} onSaved={(table) => applyShared(table, 'table')} />
      ) : null}
      {sharing?.kind === 'doc' ? <DocSharing doc={sharing.source} onClose={() => setSharing(null)} onSaved={(doc) => applyShared(doc, 'doc')} /> : null}
      {creating === 'doc' ? <NewDocDialog onClose={() => setCreating(null)} /> : null}
      {creating === 'table' && ready ? <NewTableDialog bots={ready.bots} defaultBotId={filters.bot} onClose={() => setCreating(null)} /> : null}
    </div>
  );
}

/** Os três filtros numa linha (empilhados no celular): tipo (controle segmentado com `aria-pressed`, como "Todos | Salvos" de Chats), bot (seletor nativo) e busca pelo título. */
function Filters({ filters, bots, onChange }: { filters: ArtifactFilters; bots: Bots; onChange: (next: ArtifactFilters) => void }) {
  return (
    <div className="mt-4 flex flex-col gap-3 md:flex-row md:items-center">
      <div role="group" aria-label="Tipo de artefato" className="inline-flex self-start rounded-lg border border-line bg-surface p-0.5">
        {TYPE_OPTIONS.map((option) => (
          <Button
            key={option.id}
            variant="ghost"
            size="sm"
            aria-pressed={filters.kind === option.id}
            onClick={() => onChange({ ...filters, kind: option.id })}
            className={cn('min-w-20 rounded-md px-3 text-muted', filters.kind === option.id && 'bg-selected font-medium text-fg')}
          >
            {option.label}
          </Button>
        ))}
      </div>
      <Select aria-label="Filtrar por bot" value={filters.bot} onChange={(event) => onChange({ ...filters, bot: event.target.value })} className="md:w-52">
        <option value="all">Todos os bots</option>
        <option value="none">Sem bot</option>
        {bots.map((bot) => (
          <option key={bot.id} value={bot.id}>
            {bot.name}
            {bot.archivedAt ? ' · Arquivado' : ''}
          </option>
        ))}
      </Select>
      <Input
        type="search"
        aria-label="Buscar pelo título"
        placeholder="Buscar pelo título"
        autoComplete="off"
        value={filters.query}
        onChange={(event) => onChange({ ...filters, query: event.target.value })}
        className="md:flex-1"
      />
    </div>
  );
}

/**
 * Uma linha: ícone do tipo, título (o link), a descrição da tabela, o tipo em texto (o ícone é só decoração) e os bots com acesso ou "Sem bot", e o "Compartilhar" do item. O nome acessível
 * do botão leva o título, porque a lista tem um por linha. Um bot que a lista de bots já não traz (corrida com a exclusão) simplesmente não aparece.
 */
function ArtifactRow({ artifact, bots, onShare }: { artifact: Artifact; bots: Bots; onShare: () => void }) {
  const Icon = artifact.kind === 'table' ? Table2 : FileText;
  const owners = artifact.botIds.flatMap((id) => bots.find((bot) => bot.id === id) ?? []);
  return (
    <li className="flex flex-col gap-3 py-4 sm:flex-row sm:items-start sm:gap-4">
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <Icon className="mt-0.5 size-5 shrink-0 text-subtle" strokeWidth={1.5} aria-hidden />
        <div className="min-w-0 flex-1">
          <Link href={artifact.href} prefetch={false} className="block break-words rounded font-medium text-fg hover:underline focus-visible:outline-2 focus-visible:outline-focus">
            {artifact.title}
          </Link>
          {artifact.description ? <p className="mt-1 whitespace-pre-wrap break-words text-sm text-muted">{artifact.description}</p> : null}
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-muted">
            <span className="font-medium">{KIND_LABEL[artifact.kind]}</span>
            {artifact.botIds.length === 0 ? <span>Sem bot</span> : null}
            {owners.map((bot) => (
              <span key={bot.id} className="flex min-w-0 items-center gap-1.5">
                <BotAvatar owner={bot} size={24} still />
                <span className="break-words">
                  {bot.name}
                  {bot.archivedAt ? ' · Arquivado' : ''}
                </span>
              </span>
            ))}
          </div>
        </div>
      </div>
      <Button variant="secondary" size="sm" className="self-start sm:self-center" aria-label={`Compartilhar ${artifact.title}`} onClick={onShare}>
        Compartilhar
      </Button>
    </li>
  );
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
// 3. Nova tabela
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------

/**
 * "Nova tabela": nome (obrigatório), descrição e o bot a que a tabela nasce associada (a API exige um, TAB-01; o dono compartilha com os outros depois). O bot de partida é o do filtro, se
 * ele for um bot ativo, ou o único bot ativo; senão o dono escolhe. Bot arquivado não ganha tabela nova. Sem nenhum bot ativo o diálogo diz para criar um bot e não deixa criar.
 *
 * Idempotência: a `operationId` vale enquanto nome, descrição e bot não mudam, então repetir depois de uma resposta perdida devolve a tabela já criada em vez de criar outra. Fechar com texto
 * digitado pede confirmação de descarte (a mesma proteção para o botão, o Escape e o clique fora); durante a criação nada fecha o diálogo.
 */
function NewTableDialog({ bots, defaultBotId, onClose }: { bots: Bots; defaultBotId: ArtifactFilters['bot']; onClose: () => void }) {
  const { csrfToken } = useSession();
  const router = useRouter();
  const active = bots.filter((bot) => bot.archivedAt === null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [botId, setBotId] = useState(() => active.find((bot) => bot.id === defaultBotId)?.id ?? (active.length === 1 ? active[0]!.id : ''));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [discard, setDiscard] = useState(false);
  const busy = useRef(false);
  const attempt = useRef<{ signature: string; id: string } | null>(null);

  async function create() {
    if (busy.current || !name.trim() || !botId) return;
    const signature = JSON.stringify({ name: name.trim(), description, botId });
    if (attempt.current?.signature !== signature) attempt.current = { signature, id: crypto.randomUUID() };
    busy.current = true;
    setSaving(true);
    setError('');
    try {
      const table = await apiFetch<DataTable>(`/api/bots/${botId}/tables`, {
        method: 'POST',
        csrfToken,
        body: { name: name.trim(), description, columns: [], operationId: attempt.current.id },
      });
      router.push(`/artefatos/tabelas/${table.id}`);
    } catch (cause) {
      setError(apiErrorMessage(cause));
      busy.current = false;
      setSaving(false);
    }
  }

  function close() {
    if (busy.current) return;
    if (name || description) setDiscard(true);
    else onClose();
  }

  return (
    <>
      <Modal
        open
        onOpenChange={(open) => {
          if (!open) close();
        }}
      >
        <ModalContent title="Nova tabela">
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void create();
            }}
            className="mt-4 space-y-4"
          >
            <div>
              <Label htmlFor="nova-tabela-nome">Nome</Label>
              <Input id="nova-tabela-nome" value={name} maxLength={80} required disabled={saving} autoComplete="off" onChange={(event) => setName(event.target.value)} />
            </div>
            <div>
              <Label htmlFor="nova-tabela-descricao">Descrição (opcional)</Label>
              <Textarea id="nova-tabela-descricao" value={description} maxLength={1000} disabled={saving} onChange={(event) => setDescription(event.target.value)} />
            </div>
            <div>
              <Label htmlFor="nova-tabela-bot">Bot</Label>
              {active.length === 0 ? (
                <p className="text-sm text-muted">
                  Toda tabela nasce associada a um bot. Crie um bot para começar.{' '}
                  <Link href="/bots/novo" className="underline">
                    Criar bot
                  </Link>
                </p>
              ) : (
                <>
                  <Select id="nova-tabela-bot" value={botId} required disabled={saving} onChange={(event) => setBotId(event.target.value)}>
                    {botId === '' ? <option value="">Escolha um bot</option> : null}
                    {active.map((bot) => (
                      <option key={bot.id} value={bot.id}>
                        {bot.name}
                      </option>
                    ))}
                  </Select>
                  <p className="mt-1.5 text-xs text-subtle">A tabela nasce com acesso só deste bot. Compartilhe com outros depois.</p>
                </>
              )}
            </div>
            {error ? (
              <p role="alert" className="text-sm text-danger">
                {error}
              </p>
            ) : null}
            <ModalActions>
              <Button variant="secondary" disabled={saving} onClick={close}>
                Cancelar
              </Button>
              <Button type="submit" disabled={saving || !name.trim() || !botId} aria-busy={saving}>
                {saving ? 'Criando…' : 'Criar tabela'}
              </Button>
            </ModalActions>
          </form>
        </ModalContent>
      </Modal>
      <Modal open={discard} onOpenChange={setDiscard}>
        <ModalContent title="Descartar alterações?">
          <ModalActions>
            <Button variant="secondary" onClick={() => setDiscard(false)}>
              Continuar editando
            </Button>
            <Button variant="danger" onClick={onClose}>
              Descartar alterações
            </Button>
          </ModalActions>
        </ModalContent>
      </Modal>
    </>
  );
}
