// Cartão do artefato na conversa e o endereço do painel (phase 14, passo 7; ART-01 e UI-04, A4, A5 e A7). Dois assuntos que andam juntos porque são os dois lados do mesmo link:
//
//   1. O CONTRATO DO ENDEREÇO (puro): o artefato aberto no painel vive na URL da conversa, em `?artefato=<tipo>:<id>` (`doc:<uuid>` ou `table:<uuid>`), para o "Voltar" do navegador
//      e o link colado funcionarem. O cartão ESCREVE esse valor (`artifactKey`) e a conversa o LÊ (`parseArtifactKey`). O valor vem da URL, que o dono pode digitar ou colar, e vira
//      caminho de API dentro do painel: por isso só o formato exato passa (tipo em minúsculas e id que seja UUID); qualquer outra coisa fecha o painel em vez de abrir. `artifactPageHref`
//      é a página própria de cada tipo (`/artefatos/tabelas/[id]` e `/artefatos/docs/[id]`), destino do "Abrir em tela inteira".
//   2. `ArtifactCards`: a lista de LINHAS (phase 18, A13: ícone, tipo e título, sem moldura nem fundo; o nome do componente ficou) sob a resposta do bot, UM POR ARTEFATO criado ou alterado na resposta (`artifactsOf`, em `timeline.ts`, agrupa por execução, tipo e id). É a
//      referência da atividade (`activity.artifacts`, passo 4) desenhada como link, nunca um cartão de sistema gravado: por isso não gera push nem bolinha de não lido.
//
// Cada linha é um LINK para a própria conversa com o `?artefato=` (sem `scroll`: a conversa não pula), então abre no painel com um clique, em nova aba com o botão do meio e continua
// um link para leitor de tela. O nome acessível é "Abrir <tipo> <título>"; o "Abrir" é só para leitor de tela e a linha do artefato que está no painel leva `aria-current`.
import { docIdSchema, tableIdSchema, type ArtifactRef } from '@aion/shared';
import { ChevronRight, FileText, Table2 } from 'lucide-react';
import Link from 'next/link';
import type { MouseEvent } from 'react';
import { cn } from '@/lib/cn';

/** Qual artefato: o tipo e o id, o que basta para abri-lo (o título vem da própria tela do artefato). */
export type ArtifactTarget = Pick<ArtifactRef, 'type' | 'id'>;

/** Nome do parâmetro de URL do artefato aberto no painel. */
export const ARTIFACT_PARAM = 'artefato';

/** O valor do `?artefato=` do artefato, e também a chave que distingue uma tabela de um doc de mesmo id. */
export const artifactKey = ({ type, id }: ArtifactTarget): string => `${type}:${id}`;

/** Lê o `?artefato=`: o alvo, ou `null` se o valor está ausente ou fora do formato exato (tipo em minúsculas e id UUID). */
export function parseArtifactKey(value: string | null): ArtifactTarget | null {
  const match = /^(table|doc):([^:]+)$/.exec(value ?? '');
  if (!match) return null;
  const type = match[1] as ArtifactTarget['type'];
  const id = match[2] as string;
  return (type === 'table' ? tableIdSchema : docIdSchema).safeParse(id).success ? { type, id } : null;
}

/** A página própria do artefato, para link direto e para o "Abrir em tela inteira" do painel. */
export const artifactPageHref = ({ type, id }: ArtifactTarget): string => (type === 'table' ? `/artefatos/tabelas/${id}` : `/artefatos/docs/${id}`);

/** Como o tipo aparece escrito, no cartão e no painel. */
export const KIND_LABEL: Record<ArtifactTarget['type'], string> = { table: 'Tabela', doc: 'Doc' };

/** Como a conversa liga os cartões ao painel. Quem conhece o caminho da conversa e controla o painel é `useArtifactPanel` (`artifact-panel.tsx`). */
export interface ArtifactLinks {
  /** O endereço da conversa com o artefato aberto no painel (`?artefato=<tipo>:<id>`). */
  hrefOf: (ref: ArtifactRef) => string;
  /** O `?artefato=` atual, o artefato que está no painel, ou `null`: o cartão dele leva `aria-current`. */
  openKey: string | null;
  /** Clique no cartão. Quem controla o painel pode segurar a navegação (`event.preventDefault()`) para perguntar antes de descartar texto não salvo. */
  onOpen?: (event: MouseEvent<HTMLAnchorElement>, ref: ArtifactRef) => void;
}

/**
 * Os cartões de artefato sob a resposta. O título vem do servidor e do texto do artefato, então só entra como texto.
 */
export function ArtifactCards({ artifacts, links }: { artifacts: readonly ArtifactRef[]; links: ArtifactLinks }) {
  return (
    <ul aria-label="Artefatos desta resposta" className="mt-1 flex flex-col items-start gap-0.5">
      {artifacts.map((artifact) => {
        const open = artifactKey(artifact) === links.openKey;
        const Icon = artifact.type === 'table' ? Table2 : FileText;
        return (
          <li key={artifactKey(artifact)}>
            <Link
              href={links.hrefOf(artifact)}
              onClick={(event) => links.onOpen?.(event, artifact)}
              scroll={false}
              prefetch={false}
              aria-current={open ? 'true' : undefined}
              className={cn(
                'inline-flex max-w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-sm text-muted transition-colors hover:text-fg',
                open && 'bg-selected text-fg',
              )}
            >
              <Icon className="size-4 shrink-0" strokeWidth={1.5} aria-hidden />
              <span className="min-w-0 truncate" title={artifact.title}>
                <span className="sr-only">Abrir </span>
                {KIND_LABEL[artifact.type]}{' '}
                <span className="font-medium text-fg">{artifact.title}</span>
              </span>
              <ChevronRight className="size-3.5 shrink-0" strokeWidth={1.5} aria-hidden />
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
