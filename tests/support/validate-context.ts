// CLI de T5. Deterministic é offline; paired exige adaptador operacional explícito e nunca seleciona credencial/runtime implicitamente.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { LIMITS, WINDOWS, ValidationError, campaignAttempts, isPartialNegative, compareCampaign, runDeterministic, summarizeLedger, type CallEvent, type ContextAdapter, type Window } from './context-validation';

/** Allowlist da avaliação autorizada. Erro não inclui argumento recebido, que pode carregar conteúdo privado. */
export function parseOptions(args: string[]) {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index], value = args[index + 1];
    if (!key || !['--mode', '--model', '--effort', '--window'].includes(key) || !value || values.has(key)) throw new ValidationError('CLI_ARGUMENT_INVALID');
    values.set(key, value);
  }
  const mode = values.get('--mode') ?? 'deterministic';
  const model = values.get('--model') ?? 'deepseek-v4.1-flash';
  const effort = values.get('--effort') ?? 'default';
  const window = Number(values.get('--window') ?? 32768);
  if (!['deterministic', 'paired'].includes(mode) || model !== 'deepseek-v4.1-flash' || effort !== 'default' || !WINDOWS.includes(window as Window)) throw new ValidationError('CLI_ARGUMENT_INVALID');
  // A matriz ampliada foi adiada pelo dono; esta invocação não autoriza chamadas novas em64k/128k.
  if (mode === 'paired' && window !== 32768) throw new ValidationError('CLI_WINDOW_OUT_OF_SCOPE');
  return { mode: mode as 'deterministic' | 'paired', model: model as 'deepseek-v4.1-flash', effort: effort as 'default', window: window as Window };
}

/** Carregamento explícito não busca módulo/segredo em diretório pessoal e não invoca provedor de fallback. */
async function loadAdapter(modulePath: string | undefined): Promise<ContextAdapter> {
  if (!modulePath?.trim()) throw new ValidationError('CONTEXT_ADAPTER_REQUIRED');
  try {
    const adapter: ContextAdapter = await import(pathToFileURL(resolve(modulePath)).href);
    if (typeof adapter.executePaired !== 'function') throw new ValidationError('CONTEXT_ADAPTER_INVALID');
    return adapter;
  } catch { throw new ValidationError('CONTEXT_ADAPTER_INVALID'); }
}

/** Observer não é autorização de rede: guarda pre-dispatch e execução isolada são responsabilidade do adaptador externo. */
export async function runValidation(args: string[], environment: { AION_CONTEXT_ADAPTER_MODULE?: string } = process.env, providedAdapter?: ContextAdapter) {
  const options = parseOptions(args);
  if (options.mode === 'deterministic') return runDeterministic();
  const adapter = providedAdapter ?? await loadAdapter(environment.AION_CONTEXT_ADAPTER_MODULE);
  const observed: CallEvent[] = [];
  const evidence = await adapter.executePaired({ ...options, limits: LIMITS, onCallLedger(event) {
    observed.push(structuredClone(event));
    // Aceita prefixo com chamada em voo; IDs/status/usage já disponíveis são validados imediatamente.
    summarizeLedger(observed);
  } });
  const pairs = campaignAttempts(evidence);
  const returned = pairs.flatMap((pair) => [...(pair.baseline?.ledger ?? []), ...(pair.after?.ledger ?? [])]);
  /** Ordem de chegada externa pode diferir entre braços; identidade e conteúdo de cada evento não podem diferir. */
  const sortEvents = (events: CallEvent[]) => [...events].sort((a, b) => a.callId.localeCompare(b.callId) || a.type.localeCompare(b.type));
  if (!isDeepStrictEqual(sortEvents(observed), sortEvents(returned))) throw new ValidationError('ADAPTER_LEDGER_DIVERGENT');
  if (pairs.some((pair) => pair.historical !== true && (isPartialNegative(pair) ? pair.requestedWindow : pair.after.window) !== options.window)) throw new ValidationError('ADAPTER_WINDOW_DIVERGENT');
  return { ...compareCampaign(evidence), requestedExecutionWindow: options.window, newPairIds: pairs.filter((pair) => pair.historical !== true).map((pair) => pair.pairId), historicalPairIds: pairs.filter((pair) => pair.historical === true).map((pair) => pair.pairId) };
}

/** Borda CLI imprime somente métricas/códigos seguros; falhas de módulo/provedor jamais imprimem stack ou mensagem externa. */
async function main() {
  try {
    const result = await runValidation(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.mode === 'paired' && result.status === 'stopped') process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ code: error instanceof ValidationError ? error.code : 'CONTEXT_VALIDATION_FAILED', message: 'Validação não concluída; confira o checkpoint operacional privado.' })}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) void main();
