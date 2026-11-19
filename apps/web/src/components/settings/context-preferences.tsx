'use client';

// Preferências de contexto: campos independentes com feedback existente e retry explícito. O cartão tem três campos que gravam ao mudar, cada um alterando
// SÓ a própria preferência: a janela dos bots, a janela do Chat geral e (phase 9, T4) o "Modelo do resumo", o modelo que compacta conversas longas.
import { CONTEXT_WINDOW_PRESETS, contextWindowLabel, resolveContextWindow, type ContextPreferencesView, type ContextWindowTokens, type ModelEntry } from '@aion/shared';
import { useEffect, useState } from 'react';
import { useModels, type ModelsState } from '@/components/models/use-models';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { ApiError, apiErrorMessage } from '@/lib/api-client';
import { useSession } from '@/lib/session-context';
import { FieldError, SAVE_FAILED_MESSAGE, useFieldFeedback } from './field-feedback';
import { fetchContextPreferences, saveContextPreference } from './settings-api';
import { LabelRow, settingsCardClass } from './settings-save';

/** Indicação comum: a janela escolhida, limitada só por um teto real confirmado do modelo (sem aviso de capacidade desconhecida). */
export function ContextWindowHelp({ preferred, model, capacity }: { preferred: ContextWindowTokens; model: string | null; capacity: Parameters<typeof resolveContextWindow>[3] }) {
  const result = resolveContextWindow(preferred, 'global', model, capacity);
  return <p className="mt-1.5 break-words text-xs text-subtle">{result.effectiveTokens === null ? 'Escolha um modelo para calcular o limite efetivo.' : `Limite efetivo: ${contextWindowLabel(result.effectiveTokens)}.`}</p>;
}

/** Uma escrita altera somente este campo; seleção local continua visível quando o servidor recusa. */
function ContextPreferenceField({ scope, value, onSaved }: { scope: 'bots' | 'general_chat'; value: ContextWindowTokens; onSaved: (saved: ContextPreferencesView) => void }) {
  const [selected, setSelected] = useState(value);
  const { csrfToken } = useSession();
  const { feedback, saved, failed, reset } = useFieldFeedback();
  const id = `contexto-${scope}`;
  /** Envia a escolha exata, preservando o rascunho em falha. */
  async function send(next: ContextWindowTokens) {
    reset();
    try { onSaved(await saveContextPreference({ scope, windowTokens: next }, csrfToken)); saved(); }
    catch { failed(SAVE_FAILED_MESSAGE); }
  }
  return <div>
    <LabelRow htmlFor={id} feedback={feedback}>{scope === 'bots' ? 'Contexto dos bots' : 'Contexto do Chat geral'}</LabelRow>
    <Select id={id} value={selected} onChange={(event) => { const next = Number(event.target.value) as ContextWindowTokens; setSelected(next); void send(next); }}
      aria-invalid={feedback.kind === 'error' || undefined} aria-describedby={`${id}-ajuda ${feedback.kind === 'error' ? `${id}-erro` : ''}`.trim()}>
      {CONTEXT_WINDOW_PRESETS.map((tokens) => <option key={tokens} value={tokens}>{contextWindowLabel(tokens)}</option>)}
    </Select>
    <p id={`${id}-ajuda`} className="mt-1.5 text-xs text-subtle">{scope === 'bots' ? 'Cada bot aplica seu modelo e pode ter uma escolha própria. Rotinas usam a escolha do bot.' : 'Todos os chats usam esta preferência; o modelo de cada conversa pode limitar a janela.'}</p>
    <FieldError id={`${id}-erro`} feedback={feedback} onRetry={() => void send(selected)} />
  </div>;
}

/** Mensagem do campo quando o servidor recusa o modelo (não está mais validado); a escolha local fica na tela. */
const SUMMARY_MODEL_REFUSED_MESSAGE = 'Este modelo não está validado. Escolha outro.';

/**
 * Os modelos que o resumo aceita, em ordem alfabética do nome exibido (o id). Reproduz o critério do servidor (`isValidatedModel`): perfil testado que chegou
 * a um protocolo, ou seja, `Liberado` e `Sem ferramentas` (o resumo não usa ferramentas) e nunca `Falhou` nem o que só foi favoritado. Modelo oculto em Conexões sai das escolhas novas (A7), salvo o
 * `keep` (o modelo já salvo no resumo, que segue valendo e aparece com "(oculto)", A9).
 */
export function summaryModelOptions(models: readonly ModelEntry[], keep: string | null = null): string[] {
  return models
    .filter((entry) => entry.test !== null && entry.test.status !== 'failed' && (entry.hidden !== true || entry.id === keep))
    .map((entry) => entry.id)
    .sort((a, b) => a.localeCompare(b, 'pt-BR', { numeric: true, sensitivity: 'base' }));
}

/**
 * "Modelo do resumo" (phase 9, T4; spec Decisão 6): a primeira opção, o padrão, é "Mesmo modelo da conversa" (valor vazio = nulo no servidor); depois vêm os
 * modelos validados. Um modelo salvo que não está na lista (removido ou invalidado depois) continua visível, rotulado "(indisponível)" assim que a lista é
 * conhecida, para o dono ver o que está salvo; no uso o motor já cai no modelo da conversa. Grava ao mudar; se o servidor recusa, a escolha fica na tela.
 */
function SummaryModelField({ value, models, onSaved }: { value: string | null; models: ModelsState; onSaved: (saved: ContextPreferencesView) => void }) {
  const [selected, setSelected] = useState(value ?? '');
  const { csrfToken } = useSession();
  const { feedback, saved, failed, reset } = useFieldFeedback();
  const id = 'contexto-resumo';
  const options = models.status === 'ready' ? summaryModelOptions(models.models, selected === '' ? null : selected) : [];
  const hiddenIds = new Set(models.status === 'ready' ? models.models.filter((entry) => entry.hidden === true).map((entry) => entry.id) : []);
  // Fora da lista validada: só vira "(indisponível)" com a lista conhecida (pronta ou com erro); enquanto carrega, o id aparece sem o aviso, sem piscar.
  const orphan = selected !== '' && !options.includes(selected) ? selected : null;
  /** Envia a escolha exata (vazio vira nulo), preservando-a na tela quando a gravação falha. */
  async function send(next: string) {
    reset();
    try { onSaved(await saveContextPreference({ scope: 'summary_model', summaryModel: next === '' ? null : next }, csrfToken)); saved(); }
    catch (error) { failed(error instanceof ApiError && error.code === 'VALIDATION_FAILED' ? SUMMARY_MODEL_REFUSED_MESSAGE : SAVE_FAILED_MESSAGE); }
  }
  return <div>
    <LabelRow htmlFor={id} feedback={feedback}>Modelo do resumo</LabelRow>
    <Select id={id} value={selected} onChange={(event) => { setSelected(event.target.value); void send(event.target.value); }}
      aria-invalid={feedback.kind === 'error' || undefined} aria-describedby={`${id}-ajuda ${feedback.kind === 'error' ? `${id}-erro` : ''}`.trim()}>
      <option value="">Mesmo modelo da conversa</option>
      {orphan !== null ? <option value={orphan}>{models.status === 'loading' ? orphan : `${orphan} (indisponível)`}</option> : null}
      {options.map((model) => <option key={model} value={model}>{hiddenIds.has(model) ? `${model} (oculto)` : model}</option>)}
    </Select>
    <p id={`${id}-ajuda`} className="mt-1.5 text-xs text-subtle">Usado só para compactar conversas longas. Vazio usa o modelo de cada conversa, com o menor effort que ele aceita.</p>
    <FieldError id={`${id}-erro`} feedback={feedback} onRetry={() => void send(selected)} />
  </div>;
}

/** Carrega o cartão sem criar conversa nem chamar inferência. */
export function ContextPreferencesCard({ model }: { model: string | null }) {
  const [load, setLoad] = useState<{ saved: ContextPreferencesView } | { error: string } | null>(null);
  const [attempt, setAttempt] = useState(0);
  // Perfis persistidos (sem descobrir o catálogo no provedor): servem à capacidade do modelo do Chat geral e à lista do "Modelo do resumo".
  const models = useModels(true, 'profiles');
  useEffect(() => {
    let cancelled = false;
    fetchContextPreferences().then((saved) => { if (!cancelled) setLoad({ saved }); }, (error: unknown) => { if (!cancelled) setLoad({ error: apiErrorMessage(error) }); });
    return () => { cancelled = true; };
  }, [attempt]);
  return <section aria-labelledby="preferencias-contexto" className={settingsCardClass}>
    <h2 id="preferencias-contexto" className="text-sm font-semibold text-fg">Contexto</h2>
    <p className="mb-4 mt-1 text-sm text-muted">Escolha quanto contexto o Aion pode usar. Esse limite inclui a resposta.</p>
    {load === null ? <p aria-busy="true" className="text-sm text-muted">Carregando…</p> : 'error' in load ? <div><p role="alert" className="text-sm text-danger">{load.error}</p><Button onClick={() => { setLoad(null); setAttempt((value) => value + 1); }}>Tentar novamente</Button></div> : <>
      <div className="grid gap-4 md:grid-cols-2">
        <ContextPreferenceField scope="bots" value={load.saved.bots} onSaved={(saved) => setLoad({ saved })} />
        <ContextPreferenceField scope="general_chat" value={load.saved.generalChat} onSaved={(saved) => setLoad({ saved })} />
        <SummaryModelField value={load.saved.summaryModel} models={models.state} onSaved={(saved) => setLoad({ saved })} />
      </div>
      <ContextWindowHelp preferred={load.saved.generalChat} model={model} capacity={models.state.status === 'ready' ? models.state.models.find((entry) => entry.id === model)?.contextCapacity ?? null : null} />
    </>}
  </section>;
}
