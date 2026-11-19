// Validação técnica REAL do OpenCode Go (T5, aceite 3 e validações 2 e 3 da interview): roda o mesmo teste de modelo
// que o Aion executa na primeira seleção (`runModelTest`), só que contra o provedor de verdade e com a chave do dono, e
// imprime o que foi observado: protocolo de cada modelo, ferramenta com streaming e níveis de effort aceitos.
// Antes disso confere a VALIDAÇÃO DA CHAVE salva em Configurações (R8): `GET /models` não exige chave, então o Aion a valida
// pela sonda de chat (`probeProviderKey`). O script prova que uma chave inventada é recusada e que a chave informada é aceita.
// Desde a T6 confere ainda a CONVERSA do motor de execução (`conversa=`): instruções de sistema e, para modelo que chama
// ferramenta, o histórico de uma chamada mais o resultado dela no formato do protocolo em que o modelo respondeu. É o formato
// que o teste de modelo não exercita e que só o provedor real confirma.
//
// Uso (a chave vem SÓ do ambiente; nunca por argumento, e nunca é impressa nem gravada):
//   pnpm validate:provider                                                 # sem chave: só confere que a chave inventada é recusada
//   AION_VALIDATE_PROVIDER_KEY=<chave> pnpm validate:provider              # confere a sonda e testa todos os modelos da lista
//   AION_VALIDATE_PROVIDER_KEY=<chave> pnpm validate:provider glm-5.1 kimi-k3   # confere a sonda e testa só os modelos citados
// Custo: cada modelo faz de 3 a 9 chamadas curtas (no máximo 1024 tokens de saída) na assinatura do dono.
// O resultado resumido é o que deve ser registrado na T5 do plan.md; uma discrepância (ex.: modelo de um protocolo que o
// teste não reconhece) se corrige só em `packages/core/src/models/chat-protocols.ts`.
import { randomUUID } from 'node:crypto';
import {
  TEST_TOOL,
  createOpenCodeGoClient,
  createLogger,
  probeProviderKey,
  runModelTest,
  runImageTest,
  type ChatProtocol,
  type ChatTurn,
  type ModelTestOutcome,
} from '@aion/core';

const DEFAULT_BASE_URL = 'https://opencode.ai/zen/go/v1';

/** Chave do dono (opcional: sem ela o script só confere a recusa da chave inventada). */
const apiKey = process.env.AION_VALIDATE_PROVIDER_KEY?.trim() || undefined;
/** Chave que não existe no provedor: a listagem pública a aceita, e a sonda de chat tem de recusá-la. */
// O prefixo `ghost` só significa algo para o provedor FALSO (listagem pública aceita, chat recusa 401); o real recusa qualquer texto.
const INVENTED_KEY = 'ghost-aion-chave-inventada';
const baseUrl = (process.env.AION_OPENCODE_GO_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
const logger = createLogger({ level: 'warn', name: 'validate-provider' });
const provider = createOpenCodeGoClient({ baseUrl, logger, chatTimeoutMs: 60_000 });

/**
 * Descrição curta de uma falha: o código estável de um erro de domínio (`PROVIDER_KEY_INVALID`...) ou a mensagem. Nunca
 * repete a chave (os erros do cliente já não a carregam; o `split` é só garantia).
 */
const describeError = (error: unknown): string => {
  const code = (error as { code?: unknown } | null)?.code;
  const text = typeof code === 'string' ? code : error instanceof Error ? error.message : String(error);
  return apiKey ? text.split(apiKey).join('***') : text;
};

/**
 * A conversa do motor em miniatura, no protocolo em que o modelo respondeu: turno de sistema e, se o modelo chama ferramentas,
 * o histórico "o assistente chamou a ferramenta, eis o resultado" seguido do pedido de resposta. Devolve `ok` se o modelo
 * respondeu com texto, ou o motivo curto da falha.
 */
async function probeConversation(model: string, protocol: ChatProtocol, withTools: boolean): Promise<string> {
  const turns: ChatTurn[] = withTools
    ? [
        { role: 'system', text: 'Responda sempre com uma palavra.' },
        { role: 'user', text: 'Chame a ferramenta aion_echo com o texto "ok" e depois responda pronto.' },
        { role: 'assistant', text: '', toolCalls: [{ id: 'call_aion_1', name: TEST_TOOL.name, arguments: '{"text":"ok"}' }] },
        { role: 'tool', callId: 'call_aion_1', name: TEST_TOOL.name, text: 'ok' },
      ]
    : [
        { role: 'system', text: 'Responda sempre com uma palavra.' },
        { role: 'user', text: 'Responda apenas com a palavra: ok' },
      ];
  try {
    let text = '';
    const stream = provider.streamChat(
      apiKey as string,
      protocol,
      { model, sessionId: randomUUID(), turns, ...(withTools ? { tools: [TEST_TOOL] } : {}), maxTokens: 1024 },
      AbortSignal.timeout(90_000),
    );
    for await (const event of stream) if (event.type === 'text') text += event.text;
    return text.trim() === '' ? 'falhou (resposta sem texto)' : 'ok';
  } catch (error) {
    return `falhou (${describeError(error)})`;
  }
}

/**
 * Valida a validação: roda a sonda que o Aion usa ao salvar a chave e descreve o resultado. `recusada` (401/403) é o esperado
 * para a chave inventada; `aceita` é o esperado para a chave informada. `aceita sem prova` significa que nenhum modelo tentado
 * deu resposta decisiva (motivo do modelo): a chave não é recusada, mas também não foi provada.
 */
async function describeProbe(key: string, models: string[]): Promise<string> {
  try {
    const result = await probeProviderKey({ provider, apiKey: key, models, signal: AbortSignal.timeout(60_000) });
    return result === 'verified' ? 'aceita' : 'aceita sem prova';
  } catch (error) {
    return (error as { code?: unknown } | null)?.code === 'PROVIDER_KEY_INVALID' ? 'recusada' : `erro (${describeError(error)})`;
  }
}

async function main(): Promise<void> {
  const catalog = (await provider.listModels(apiKey ?? INVENTED_KEY)).map((model) => model.id);
  // Falha cedo, antes de qualquer chamada de chat (e de gastar a assinatura), se o usuário citou um modelo que não existe.
  const image = process.argv.includes('--image');
  const requested = process.argv.slice(2).filter((arg) => arg !== '--image');
  if (image && requested.length === 0) throw new Error('Informe os modelos da sonda --image.');
  const unknown = requested.filter((id) => !catalog.includes(id));
  if (unknown.length > 0) throw new Error(`Modelos fora da lista do provedor: ${unknown.join(', ')}`);

  // 1. A validação da chave. A listagem é pública (uma chave inventada passa por ela), então quem prova a chave é a sonda de chat.
  const acceptsAnyKey = await provider.listModels(INVENTED_KEY).then(
    () => true,
    () => false,
  );
  process.stdout.write(`GET /models aceita uma chave inventada: ${acceptsAnyKey ? 'SIM (a listagem é pública e não valida a chave)' : 'não'}\n`);
  const invented = await describeProbe(INVENTED_KEY, requested.length ? requested : catalog);
  process.stdout.write(`Sonda de chat com a chave inventada: ${invented}${invented === 'recusada' ? ' (esperado)' : ' (ESPERADO: recusada)'}\n`);
  if (invented !== 'recusada') process.exitCode = 1;
  if (!apiKey) {
    process.stdout.write('AION_VALIDATE_PROVIDER_KEY não definida: só a recusa da chave inventada foi conferida.\n');
    return;
  }
  const real = await describeProbe(apiKey, requested.length ? requested : catalog);
  process.stdout.write(`Sonda de chat com a chave informada: ${real}${real === 'aceita' ? ' (esperado)' : ' (ESPERADO: aceita)'}\n`);
  // Chave recusada (ou erro na sonda): não adianta testar os modelos com ela. `aceita sem prova` segue: os testes de modelo dizem mais.
  if (real === 'recusada' || real.startsWith('erro')) {
    process.exitCode = 1;
    return;
  }

  // 2. Escolhe os modelos.
  const models = requested.length > 0 ? requested : catalog;
  process.stdout.write(`Lista do provedor: ${catalog.length} modelos; testando ${models.length}.\n\n`);

  // 3. Testa um por vez (respeita o provedor e mantém a saída legível).
  const results: { model: string; seconds: number; outcome: ModelTestOutcome | { error: string }; conversation: string; vision?: string }[] = [];
  for (const model of models) {
    const started = Date.now();
    const outcome = await runModelTest({ provider, apiKey: apiKey as string, model, signal: AbortSignal.timeout(180_000) }).catch((error: unknown) => ({
      error: describeError(error),
    }));
    // Só há conversa a provar onde o modelo respondeu em algum protocolo; um modelo "sem ferramentas" vai sem ferramentas.
    const conversation =
      'error' in outcome || outcome.protocol === null ? '-' : await probeConversation(model, outcome.protocol, outcome.status === 'ok');
    const vision = !image || 'error' in outcome || !outcome.protocol ? '-' : await runImageTest({ provider, apiKey, model, protocol: outcome.protocol, signal: AbortSignal.timeout(90_000) }).then((accepts) => accepts ? 'enxerga' : 'não enxerga', (error: unknown) => `falhou (${describeError(error)})`);
    if (image && (vision === '-' || vision.startsWith('falhou'))) process.exitCode = 1;
    const seconds = Math.round((Date.now() - started) / 100) / 10;
    results.push({ model, seconds, outcome, conversation, ...(image ? { vision } : {}) });
    const line =
      'error' in outcome
        ? `ERRO ${outcome.error}`
        : `${outcome.status}${outcome.reason ? ` (${outcome.reason})` : ''} protocolo=${outcome.protocol ?? '-'} effort=[${outcome.effortLevels.join(',')}] conversa=${conversation}${image ? ` imagem=${vision}` : ''}`;
    process.stdout.write(`${model.padEnd(32)} ${line} (${seconds}s)\n`);
  }

  process.stdout.write(`\n${JSON.stringify({ baseUrl, acceptsAnyKey, probe: { invented, real }, results }, null, 2)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`Falha: ${describeError(error)}\n`);
  // `exitCode` em vez de `process.exit()`: sair à força com conexões do fetch ainda fechando derruba o Node no Windows.
  process.exitCode = 1;
});
