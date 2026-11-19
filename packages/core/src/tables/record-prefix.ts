// Id curto de registro (TAB-03, phase 11): fonte única do formato aceito, do tamanho mostrado ao modelo e da resolução no servidor.
//
// Fluxo: `table_query` mostra ao modelo só o começo do UUID do registro (`shortRecordIds`, nunca menos de 8 caracteres e o suficiente para ser único
// DENTRO do resultado). Quando o modelo devolve esse id numa ferramenta de tabela (`table_write` em `updates[].id` e nas células de RELAÇÃO de `creates` e
// `updates`, `table_query` em `recordIds`, `table_prepare_operation` em `delete_records`), `recordRefSchema` (ids de registro) ou o serviço (células de
// relação, que dependem da coluna) o valida e `resolveRecordRefs` o troca pelo UUID completo, no servidor, ANTES de a entrada chegar ao serviço de escrita, que
// continua recebendo e gravando só ids completos (o vínculo e o recibo da mutação guardam o id completo).
//
// Segurança: o prefixo vem do modelo, então é dado não confiável. Só passa o que é prefixo canônico de UUID (hexadecimais, hífens nas posições do UUID, 8 a
// 36 caracteres); a busca é parametrizada, limitada à tabela já autorizada e nunca escolhe entre candidatos (ambiguidade é erro com os candidatos).
import { z } from 'zod';
import type { Queryable } from '../db/pool';
import { DomainError } from '../errors';

/** Menor prefixo aceito e mostrado: com 8 hexadecimais a colisão é de cerca de 1 em 870 mil numa tabela de 100 registros. */
export const RECORD_REF_MIN_CHARS = 8;
/** Tamanho do UUID canônico (com hífens): um id desse tamanho já é o id completo e não é resolvido. */
export const RECORD_ID_CHARS = 36;
/** Posições (base 0) dos hífens no UUID canônico. */
const HYPHEN_AT: ReadonlySet<number> = new Set([8, 13, 18, 23]);
/** Candidatos devolvidos ao modelo numa ambiguidade; com 8+ hexadecimais passar de poucos já é um caso patológico. */
export const MAX_AMBIGUITY_CANDIDATES = 10;

/** O texto é prefixo canônico de UUID com 8 a 36 caracteres (hexadecimais, hífens só nas posições 8, 13, 18 e 23)? Maiúsculas valem; `normalizeRecordRef` as baixa. */
export function isRecordRef(value: string): boolean {
  if (value.length < RECORD_REF_MIN_CHARS || value.length > RECORD_ID_CHARS) return false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!;
    if (HYPHEN_AT.has(index) ? char !== '-' : !/[0-9a-fA-F]/.test(char)) return false;
  }
  return true;
}

/** O texto é um UUID completo (prefixo canônico de 36 caracteres)? Esse id já é o do registro e nunca é resolvido. */
export const isFullRecordId = (value: string): boolean => value.length === RECORD_ID_CHARS && isRecordRef(value);

/** Forma canônica comparável (minúsculas), igual à que o PostgreSQL devolve para `uuid`. */
export const normalizeRecordRef = (value: string): string => value.toLowerCase();

/**
 * Id de registro numa ENTRADA de ferramenta: id curto (prefixo do UUID, 8+ caracteres) ou UUID completo. O contrato compartilhado das tabelas e da API não muda
 * (continua `z.uuid()`); só o schema da ferramenta usa este. O refinamento não vira `pattern` no JSON Schema publicado ao modelo (custaria tokens por campo).
 */
export const recordRefSchema = z.string().min(RECORD_REF_MIN_CHARS).max(RECORD_ID_CHARS).refine(isRecordRef).describe('id curto (8+ caracteres de table_query) ou UUID do registro');

/**
 * Tamanho mínimo (a partir de 8) que torna cada id único DENTRO do próprio conjunto, comparando caractere a caractere com os vizinhos na ordem
 * lexicográfica (o vizinho mais parecido de um id é sempre o anterior ou o seguinte). Só usa o conjunto recebido: é a forma estável que o resultado gravado
 * produz sempre igual, sem consultar a tabela. Devolve os prefixos na ordem de entrada.
 */
export function shortRecordIds(ids: readonly string[]): string[] {
  const lower = ids.map(normalizeRecordRef);
  const order = lower.map((_, index) => index).sort((a, b) => (lower[a]! < lower[b]! ? -1 : lower[a]! > lower[b]! ? 1 : 0));
  const common = (a: string, b: string): number => {
    let length = 0;
    while (length < a.length && length < b.length && a[length] === b[length]) length += 1;
    return length;
  };
  const shown: string[] = new Array<string>(ids.length);
  order.forEach((index, position) => {
    const id = lower[index]!;
    const previous = position > 0 ? common(id, lower[order[position - 1]!]!) : 0;
    const next = position < order.length - 1 ? common(id, lower[order[position + 1]!]!) : 0;
    shown[index] = id.slice(0, Math.min(id.length, Math.max(RECORD_REF_MIN_CHARS, previous + 1, next + 1)));
  });
  return shown;
}

/** Menor e maior UUID que começam por `prefix`: completa com `0` e com `f`. Permite busca por faixa no índice (table_id, id) em vez de varrer a tabela. */
export function prefixBounds(prefix: string): { lo: string; hi: string } {
  return { lo: prefix + '00000000-0000-0000-0000-000000000000'.slice(prefix.length), hi: prefix + 'ffffffff-ffff-ffff-ffff-ffffffffffff'.slice(prefix.length) };
}

/** Registro candidato de uma ambiguidade: id completo e o nome (a célula que identifica o registro) para o modelo escolher. */
export interface RecordCandidate { id: string; name: string }

/**
 * Prefixo que coincide com mais de um registro da tabela. Carrega os candidatos para o resultado da ferramenta: a borda de erros comum (`safe()` das
 * ferramentas de tabela e o handler da API) só devolve `code` e mensagem, então este erro tem caminho próprio até o modelo (`table-tools.ts`).
 * `moreCandidates` é quantos registros além dos listados também começam pelo prefixo (0 quando a lista é completa): sem ele o modelo leria a lista cortada
 * em `MAX_AMBIGUITY_CANDIDATES` como o conjunto inteiro.
 */
export class AmbiguousRecordError extends DomainError {
  constructor(readonly prefix: string, readonly candidates: RecordCandidate[], readonly moreCandidates: number) {
    super('TABLE_RECORD_AMBIGUOUS');
    this.name = 'AmbiguousRecordError';
  }
}

/**
 * Troca cada id curto pelo UUID completo, dentro de `tableId`. DEVE rodar depois da checagem de acesso à tabela (o serviço chama `authorize` antes) e na mesma
 * transação de leitura. UUID completo passa como está (inclusive o que não existe: quem o usa decide, como sempre); prefixo sem registro é
 * `TABLE_NOT_FOUND`, formato inválido é `VALIDATION_FAILED` e prefixo com mais de um registro é `AmbiguousRecordError` (nunca se escolhe um). `nameOf`
 * só é chamada na ambiguidade, para dar nome aos candidatos (candidato sem nome devolvido fica com o id completo). A ordem e o tamanho da lista de entrada
 * são preservados.
 * ponytail: a contagem total de candidatos (`moreCandidates`) lê todas as linhas da faixa do prefixo; com no mínimo 8 hexadecimais a faixa tem 1/2^32 dos ids,
 * então só uma tabela com milhares de ids de prefixo igual (só forjável pelo dono) a tornaria cara, limitar a contagem se isso aparecer.
 */
export async function resolveRecordRefs(tx: Queryable, tableId: string, refs: readonly string[], nameOf: (ids: string[]) => Promise<Map<string, string>>): Promise<string[]> {
  const normalized = refs.map(normalizeRecordRef);
  if (!normalized.every(isRecordRef)) throw new DomainError('VALIDATION_FAILED');
  const prefixes = [...new Set(normalized.filter((ref) => ref.length < RECORD_ID_CHARS))];
  const matches = new Map<string, string[]>();
  /** Registros que começam pelo prefixo, além dos que a consulta devolveu (que traz no máximo candidatos + 1 linhas). */
  const totals = new Map<string, number>();
  if (prefixes.length) {
    // Uma consulta para o lote inteiro, com no máximo (candidatos + 1) linhas por prefixo; faixa de uuid usa a chave primária (table_id, id). A janela conta a
    // faixa inteira antes do LIMIT, para o erro dizer quantos candidatos ficaram de fora.
    const ranges = prefixes.map((prefix) => ({ ref: prefix, ...prefixBounds(prefix) }));
    const found = await tx.query<{ ref: string; id: string; total: number }>(
      `SELECT x.ref, m.id::text AS id, m.total::int AS total
         FROM jsonb_to_recordset($2::jsonb) AS x(ref text, lo uuid, hi uuid)
        CROSS JOIN LATERAL (SELECT r.id, count(*) OVER () AS total FROM table_records r WHERE r.table_id = $1 AND r.id BETWEEN x.lo AND x.hi ORDER BY r.id LIMIT $3) m`,
      [tableId, JSON.stringify(ranges), MAX_AMBIGUITY_CANDIDATES + 1],
    );
    for (const row of found.rows) { matches.set(row.ref, [...(matches.get(row.ref) ?? []), row.id]); totals.set(row.ref, row.total); }
  }
  const resolved: string[] = [];
  for (const ref of normalized) {
    if (ref.length === RECORD_ID_CHARS) { resolved.push(ref); continue; }
    const ids = matches.get(ref) ?? [];
    if (ids.length === 0) throw new DomainError('TABLE_NOT_FOUND');
    if (ids.length > 1) {
      const candidates = ids.slice(0, MAX_AMBIGUITY_CANDIDATES);
      const names = await nameOf(candidates);
      throw new AmbiguousRecordError(ref, candidates.map((id) => ({ id, name: names.get(id) ?? id })), (totals.get(ref) ?? candidates.length) - candidates.length);
    }
    resolved.push(ids[0]!);
  }
  return resolved;
}
