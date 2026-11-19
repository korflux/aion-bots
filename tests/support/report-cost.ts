// CLI `pnpm report:cost`: relatório de custo de tokens a partir do ledger `model_call_usage` (P0 de docs/estudo-custo-tokens.md).
// Conecta no banco indicado por AION_REPORT_DATABASE_URL (pode vir de `.env.report.local`, fora do Git), abre uma transação SOMENTE LEITURA e
// imprime o relatório em Markdown. Não chama o provedor, não grava nada e a saída tem só identificadores e números.
//
// Argumentos (todos opcionais):
//   --days <n>                       período até agora, em dias (padrão 30, de 1 a 3650)
//   --tz <fuso IANA>                 fuso dos dias (padrão America/Sao_Paulo)
//   --price <modelo>=<e>,<c>,<s>     preço em US$/M de entrada, cache e saída; repetível; soma-se aos preços conhecidos
import { parseArgs } from 'node:util';
import { MODEL_PRICES, buildCostReport, createPool, formatCostReport, readCheckpointSizes, readSkippedCalls, readUsageCalls, type ModelPrice } from '@aion/core';

/** Erro de uso da CLI: a mensagem é segura para a saída (não carrega a URL do banco nem a causa externa). */
class UsageError extends Error {}

/** Lê e valida os argumentos na borda: allowlist de opções, faixas numéricas e formato dos preços. */
function parseOptions(argv: string[]): { days: number; timeZone: string; prices: Record<string, ModelPrice> } {
  const { values } = parseArgs({ args: argv, strict: true, options: { days: { type: 'string' }, tz: { type: 'string' }, price: { type: 'string', multiple: true } } });
  const days = values.days === undefined ? 30 : Number(values.days);
  if (!Number.isInteger(days) || days < 1 || days > 3650) throw new UsageError('--days precisa ser um inteiro entre 1 e 3650.');
  const timeZone = values.tz ?? 'America/Sao_Paulo';
  try { new Intl.DateTimeFormat('en', { timeZone }); } catch { throw new UsageError('--tz precisa ser um fuso IANA válido.'); }
  const prices: Record<string, ModelPrice> = { ...MODEL_PRICES };
  for (const raw of values.price ?? []) {
    const match = /^([a-z0-9][a-z0-9._:/-]{0,199})=([0-9.]+),([0-9.]+),([0-9.]+)$/i.exec(raw);
    const [input, cached, output] = (match?.slice(2) ?? []).map(Number);
    if (!match || ![input, cached, output].every((value) => Number.isFinite(value) && value! >= 0)) throw new UsageError('--price precisa do formato modelo=entrada,cache,saída em US$ por milhão.');
    prices[match[1]!] = { input: input!, cached: cached!, output: output! };
  }
  return { days, timeZone, prices };
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const url = process.env.AION_REPORT_DATABASE_URL?.trim();
  if (!url) throw new UsageError('AION_REPORT_DATABASE_URL ausente (ambiente ou .env.report.local).');
  const until = new Date();
  const since = new Date(until.getTime() - options.days * 86_400_000);
  const pool = createPool(url, { applicationName: 'aion-report-cost', max: 1 });
  const client = await pool.connect();
  try {
    // Somente leitura garantida pelo banco, não só pela intenção do script.
    await client.query('BEGIN TRANSACTION READ ONLY');
    const calls = await readUsageCalls(client, { since, until, timeZone: options.timeZone });
    const skippedCalls = await readSkippedCalls(client, { since, until });
    const checkpointChars = await readCheckpointSizes(client);
    await client.query('COMMIT');
    process.stdout.write(formatCostReport(buildCostReport(calls, options.prices), { since, until, timeZone: options.timeZone, skippedCalls, calls, checkpointChars }));
  } finally {
    client.release();
    await pool.end();
  }
}

// Envelope de erro da CLI, com código estável e mensagem segura; detalhes do banco nunca atravessam esta borda.
main().catch((error: unknown) => {
  const message = error instanceof UsageError ? error.message : 'Não foi possível ler o uso de tokens. Confira AION_REPORT_DATABASE_URL e o acesso ao banco.';
  process.stderr.write(JSON.stringify({ code: 'COST_REPORT_FAILED', message, exitCode: 1 }) + '\n');
  process.exitCode = 1;
});
