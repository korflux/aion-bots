'use client';

// Linhas da tela Atividades (F15; design "Tela: Atividades"): o cartão compacto de uma aprovação pendente e a linha de uma execução
// recente. As duas são LINKS para a conversa do dono (o bot ou a sessão do chat geral), já apontando para o cartão (`?mensagem=`): a
// aprovação NÃO é respondida aqui, para o dono ver o contexto antes de decidir. Uma execução do chat geral mostra a Faísca do Aion e o nome
// "Chat geral" no lugar do avatar e do nome do bot. O botão "Parar" da execução ativa fica FORA do link (um botão dentro de um link é
// interativo aninhado, inválido e confuso para teclado e leitores de tela).
//
// Faísca (F1 e F7 da phase 5): o avatar é a Faísca de 24 px, na cor do bot ou, no Chat geral, em `--faisca`, sempre PARADA (uma lista não anima: só o que
// está em foco se mexe) e no estado da execução da linha, convertido pela função única `mascotStateOfRunStatus`. A Faísca é decorativa: o estado continua dito
// em texto (o selo "Concluída", "Falhou"... e, nas pendências, a seção "Aguardando você").
import { RUN_STATUS_LABELS, mascotStateOfRunStatus, type PendingActivity, type RecentActivity, type RunStatus } from '@aion/shared';
import { Square } from 'lucide-react';
import Link from 'next/link';
import { formatTimeLeft } from '@/components/approvals/approvals-state';
import { BotAvatar } from '@/components/bots/bot-avatar';
import { StatusBadge } from '@/components/settings/status-badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';
import { formatRelativeTime } from '@/lib/format';
import { STATUS_TONE, canStop, conversationHref, originLabel, ownerName, type ActivityOwner } from './activities-state';

/** Avatar do dono: a Faísca parada (24 px), na cor do bot ou do Aion (chat geral), no estado da execução da linha. */
function OwnerAvatar({ owner, status, className }: { owner: ActivityOwner; status: RunStatus; className?: string }) {
  return <BotAvatar owner={owner.bot} size={24} state={mascotStateOfRunStatus(status)} still className={className} />;
}

/** Nome do dono com o aviso de arquivado (o histórico do bot continua visível). */
function OwnerName({ owner }: { owner: ActivityOwner }) {
  return (
    <span className="block truncate text-sm font-medium text-fg">
      {ownerName(owner)}
      {owner.bot?.archived ? <span className="font-normal text-subtle"> (arquivado)</span> : null}
    </span>
  );
}

/**
 * Aprovação aguardando o dono: bot (ou chat geral), ação, a conta do conector (quando a ação tem), o título do doc que a exclusão apagaria (decisão 23, A35: o mesmo do cartão da conversa, pronto do servidor)
 * e quanto falta. O clique abre o cartão da aprovação na conversa.
 */
export function PendingRow({ item, now }: { item: PendingActivity; now: number }) {
  return (
    <li>
      <Link
        href={conversationHref(item, item.messageId)}
        className="flex items-center gap-3 rounded-md border border-warning bg-surface grad-sheen px-3 py-2.5 transition-colors hover:bg-surface-hover"
      >
        <OwnerAvatar owner={item} status="waiting_approval" />
        <span className="min-w-0 flex-1">
          <OwnerName owner={item} />
          <span className="block truncate text-[13px]/5 text-muted">{item.actionLabel}</span>
          {/* Phase 13: a conta do conector em que a ação executaria, como no cartão da conversa; sem conta (tabelas, pendência antiga), nenhuma linha. */}
          {item.accountLabel === undefined ? null : <span className="block truncate text-xs text-muted">{`Conta: ${item.accountLabel}`}</span>}
          {/* Decisão 23 (dono, 29/10/2026): o doc que a exclusão pedida apagaria, na linha abaixo da ação, como a conta da phase 13 (no cartão de aprovação ele segue na mesma linha da ação); sem título (conector, tabelas, pendência antiga), nenhuma linha. */}
          {item.docTitle === undefined ? null : <span className="block truncate text-[13px]/5 text-fg">{`Doc: ${item.docTitle}`}</span>}
        </span>
        <span className="shrink-0 text-xs text-muted">Expira em {formatTimeLeft(item.expiresAt, now)}</span>
      </Link>
    </li>
  );
}

/** Largura da coluna do botão "Parar" no desktop: reservada também nas linhas sem botão, para selo e horário alinharem em todas. */
const STOP_COLUMN = 'md:w-[104px] md:shrink-0';

/**
 * Execução recente: avatar e nome do dono (bot ou chat geral), origem, selo de estado e horário relativo. Em 375 px o horário desce para
 * a segunda linha (design) e o botão "Parar", se houver, vai para uma linha própria (ao lado ele deixaria o nome sem espaço). A execução
 * ativa mostra "Parar"; `stopping` desabilita o botão enquanto o pedido já foi aceito e o worker ainda não encerrou (a parada é
 * assíncrona).
 */
export function RecentRow({
  item,
  now,
  stopping,
  onStop,
}: {
  item: RecentActivity;
  now: number;
  stopping: boolean;
  onStop: (item: RecentActivity) => void;
}) {
  return (
    <li className="flex flex-wrap items-center gap-x-2 border-b border-line md:flex-nowrap">
      <Link
        href={conversationHref(item, item.messageId, item.offPath)}
        className="grid min-w-0 basis-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 py-3 md:flex-1 md:basis-0 md:grid-cols-[auto_minmax(0,1fr)_minmax(0,auto)_auto_auto]"
      >
        <OwnerAvatar owner={item} status={item.status} className="row-span-2 md:row-span-1" />
        <OwnerName owner={item} />
        <span className="col-start-2 row-start-2 truncate text-xs text-muted md:col-start-3 md:row-start-1 md:text-[13px]/5">{originLabel(item)}</span>
        <span className="col-start-3 row-start-1 md:col-start-4">
          <StatusBadge tone={STATUS_TONE[item.status]}>{RUN_STATUS_LABELS[item.status]}</StatusBadge>
        </span>
        <time
          dateTime={item.createdAt}
          className="col-start-3 row-start-2 justify-self-end text-xs text-subtle md:col-start-5 md:row-start-1 md:w-20 md:text-right"
        >
          {formatRelativeTime(item.createdAt, new Date(now))}
        </time>
      </Link>
      {canStop(item.status) ? (
        <Button
          variant="secondary"
          size="sm"
          disabled={stopping}
          onClick={() => onStop(item)}
          aria-label={`Parar a execução de ${ownerName(item)}`}
          className={cn(STOP_COLUMN, 'max-md:mb-3 max-md:ml-auto')}
        >
          <Square className="size-3.5" strokeWidth={1.5} aria-hidden />
          {stopping ? 'Parando…' : 'Parar'}
        </Button>
      ) : (
        <span aria-hidden className={cn(STOP_COLUMN, 'max-md:hidden')} />
      )}
    </li>
  );
}
