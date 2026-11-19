// Cliente tipado da API de docs (phase 14, passo 5; rotas em `apps/api/src/routes/docs.ts`). Único lugar da web que conhece esses caminhos; sessão e transporte ficam no
// `apiFetch` comum, que leva o cookie, trata o envelope de erro e vence o prazo.
//
// Toda escrita exige o token CSRF da sessão (`csrfToken`) e uma `operationId`: o chamador gera um UUID por intenção e o reaproveita nas repetições (`IntentLedger`, em
// `doc-state.ts`), inclusive no corpo do DELETE, para o replay depois de uma queda de rede devolver o resultado gravado em vez de gravar de novo. As funções não geram o
// id: quem decide o que é "a mesma intenção" é a tela.
import type {
  BotList,
  Doc,
  DocDeleteInput,
  DocDeleteResult,
  DocList,
  DocRestoreInput,
  DocShareInput,
  DocSummary,
  DocUpdateInput,
  DocVersionDetail,
  DocVersionList,
  DocWriteResult,
} from '@aion/shared';
import { apiFetch } from '@/lib/api-client';

const docPath = (docId: string): string => `/api/docs/${docId}`;

/** Os bots entre os quais o dono escolhe quem acessa o doc (no compartilhamento e na criação). */
export const fetchBots = (): Promise<BotList> => apiFetch<BotList>('/api/bots');

/** Os docs sem o texto, do mais recente ao mais antigo (a lista de Artefatos). */
export const fetchDocs = (): Promise<DocList> => apiFetch<DocList>('/api/docs');

/** O doc com o texto e a versão que a tela passa a usar como "versão esperada". `DOC_NOT_FOUND` se não existe. */
export const fetchDoc = (docId: string): Promise<Doc> => apiFetch<Doc>(docPath(docId));

/** Cria o doc, já com a versão 1 (texto vazio). O dono escolhe os bots; nenhum é permitido. `DOC_LIMIT_EXCEEDED` no 101.º doc. */
export const createDoc = (input: { title: string; botIds: string[]; operationId: string }, csrfToken: string): Promise<DocSummary> =>
  apiFetch<DocSummary>('/api/docs', { method: 'POST', csrfToken, body: { ...input, content: '' } });

/** Grava o texto e/ou o título sobre a versão esperada; `DOC_CONFLICT` se o doc mudou desde a leitura (nada é gravado). */
export const updateDoc = (docId: string, input: DocUpdateInput, csrfToken: string): Promise<DocWriteResult> =>
  apiFetch<DocWriteResult>(docPath(docId), { method: 'PATCH', csrfToken, body: input });

/** As versões do texto, da mais recente à mais antiga: data, autor e tamanho, sem o texto. */
export const fetchDocVersions = (docId: string): Promise<DocVersionList> => apiFetch<DocVersionList>(`${docPath(docId)}/versions`);

export const fetchDocVersion = (docId: string, version: number): Promise<DocVersionDetail> => apiFetch<DocVersionDetail>(`${docPath(docId)}/versions/${version}`);

/** Restaura uma versão antiga COMO VERSÃO NOVA (as posteriores continuam no histórico); `DOC_CONFLICT` com a versão esperada antiga. */
export const restoreDocVersion = (docId: string, input: DocRestoreInput, csrfToken: string): Promise<DocWriteResult> =>
  apiFetch<DocWriteResult>(`${docPath(docId)}/restore`, { method: 'POST', csrfToken, body: input });

/** Troca a lista COMPLETA de bots com acesso (só o dono), sobre a revisão de acesso que a tela leu; `DOC_CONFLICT` se ela mudou. */
export const shareDoc = (docId: string, input: DocShareInput, csrfToken: string): Promise<DocSummary> =>
  apiFetch<DocSummary>(`${docPath(docId)}/access`, { method: 'PUT', csrfToken, body: input });

/** Exclui o doc, as versões e as associações (o dono confirma na tela, sem aprovação). O corpo leva só a `operationId`. */
export const deleteDoc = (docId: string, input: DocDeleteInput, csrfToken: string): Promise<DocDeleteResult> =>
  apiFetch<DocDeleteResult>(docPath(docId), { method: 'DELETE', csrfToken, body: input });
