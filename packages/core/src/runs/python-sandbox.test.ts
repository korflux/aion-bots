// Prova worker → sandbox REAL (phase 4, T7; A14, A16, A17, A18, C3): o motor de verdade, com o cliente do worker, contra o container do serviço `sandbox`
// (Pyodide, pandas, matplotlib e openpyxl de verdade). Só roda por `pnpm --filter @aion/sandbox test:container`, que sobe o container e passa o endereço
// e o token pelo ambiente (`AION_SANDBOX_URL` e `AION_SANDBOX_TOKEN`); sem eles (o `pnpm test` do gate, que não tem Docker) a suíte é ignorada.
import { createHash } from 'node:crypto';
import type { Bot, PythonDetail } from '@aion/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AttachmentService } from '../attachments/service';
import { xlsxFixture } from '../testing/attachment-fixtures';
import { pythonMarker } from '../testing/fake-upstreams';
import { createRunsWorld, waitFor, type RunsWorld } from './test-support';

const url = process.env.AION_SANDBOX_URL;
const token = process.env.AION_SANDBOX_TOKEN;

/** Lê e grava como o modelo faria: CSV pelo pandas, a planilha pelo openpyxl, um gráfico Agg e um CSV de resumo em /out/. */
const ANALYSIS = [
  'import pandas as pd',
  'import matplotlib',
  "matplotlib.use('Agg')",
  'import matplotlib.pyplot as plt',
  'import openpyxl',
  'import hashlib',
  'from scipy.integrate import quad',
  'import math',
  'integral, erro = quad(lambda x: math.exp(-x*x), -math.inf, math.inf)',
  'assert abs(integral - math.sqrt(math.pi)) < 1e-12',
  "print('gaussiana', integral)",
  "df = pd.read_csv('/data/dados.csv')",
  "celula = openpyxl.load_workbook('/data/vendas.xlsx').active['A1'].value",
  "print('soma', int(df['valor'].sum()), 'celula', celula)",
  'fig, ax = plt.subplots()',
  "ax.bar(df['mes'], df['valor'])",
  "fig.savefig('grafico.png')",
  "df.assign(total=df['valor'].cumsum()).to_csv('resumo.csv', index=False)",
  'wb = openpyxl.Workbook()',
  'ws = wb.active',
  "ws.append(['Produto', 'Preço (R$)'])",
  "ws.append(['Produto A', 150.00])",
  "ws.append(['Produto B', 89.90])",
  "ws.append(['Produto C', 249.00])",
  "ws['B2'].number_format = '\"R$\" #,##0.00'",
  "wb.save('/out/produtos_precos.xlsx')",
  "print('xlsx_sha256', hashlib.sha256(open('/out/produtos_precos.xlsx', 'rb').read()).hexdigest())",
].join('\n');

describe.skipIf(!url || !token)('run_python contra o sandbox real (container)', () => {
  let world: RunsWorld;
  let files: AttachmentService;
  beforeAll(async () => {
    world = await createRunsWorld({ python: { url: url!, token: token! }, engine: { maxActiveMs: 5 * 60_000 } });
    files = new AttachmentService({ pool: world.pool, conversations: world.conversations });
    world.engine.start();
  });
  afterAll(async () => {
    await world.cleanup();
  });

  const activityOf = async (runId: string) =>
    (await world.pool.query<{ status: string; content: string; detail: PythonDetail | null }>(
      "SELECT status, content, data->'detail' AS detail FROM messages WHERE run_id = $1 AND kind = 'activity' AND data->>'tool' = 'run_python'",
      [runId],
    )).rows[0]!;

  async function botWithFiles(): Promise<{ bot: Bot; ids: string[] }> {
    const bot = await world.createBot();
    const ids = [
      (await files.upload(bot.id, 'dados.csv', Buffer.from('mes,valor\njan,10\nfev,32\n'))).id,
      (await files.upload(bot.id, 'vendas.xlsx', xlsxFixture())).id,
    ];
    const sent = (await world.conversations.send(bot.id, 'Seguem os arquivos', ids)).id;
    await world.waitForStatus(sent, 'completed');
    return { bot, ids };
  }

  it('integra com scipy, lê /data/ e persiste PNG, CSV e XLSX real recuperável sem alterar os bytes', async () => {
    const { bot, ids } = await botWithFiles();
    const run = await world.send(bot, pythonMarker({ code: ANALYSIS, attachments: ids }));
    await world.waitForStatus(run, 'completed', 120_000);
    const activity = await activityOf(run);
    expect(activity.status).toBe('completed');
    expect(activity.detail).toMatchObject({ type: 'python', state: 'done', outcome: 'ok', error: null, rejected: [] });
    expect(activity.detail!.output).toContain('soma 42 celula 42');
    expect(activity.detail!.output).toContain('gaussiana 1.772453850905');
    const generated = await world.pool.query<{ id: string; name: string; format: string; file_bytes: Buffer }>(
      "SELECT id::text AS id, name, format, file_bytes FROM attachments WHERE run_id = $1 AND kind = 'generated' ORDER BY name",
      [run],
    );
    expect(generated.rows.map((row) => [row.name, row.format])).toEqual([['grafico.png', 'png'], ['produtos_precos.xlsx', 'xlsx'], ['resumo.csv', 'csv']]);
    expect(generated.rows[0]!.file_bytes.subarray(1, 4).toString('latin1')).toBe('PNG');
    const workbook = generated.rows[1]!;
    const downloaded = await files.content(bot.id, workbook.id);
    expect(downloaded.bytes).toEqual(workbook.file_bytes);
    expect(activity.detail!.output).toContain(`xlsx_sha256 ${createHash('sha256').update(downloaded.bytes).digest('hex')}`);
    expect(generated.rows[2]!.file_bytes.toString('utf8')).toBe('mes,valor,total\njan,10,10\nfev,32,42\n');
    expect(activity.content).toContain('tipo=png');
  }, 180_000);

  it('erro do Python volta como traceback e "Parar" encerra um laço infinito na hora, com o sandbox seguindo de pé', async () => {
    const bot = await world.createBot();
    const failed = await world.send(bot, pythonMarker({ code: "raise ValueError('ruim')" }));
    await world.waitForStatus(failed, 'completed', 120_000);
    expect((await activityOf(failed)).detail).toMatchObject({ outcome: 'PYTHON_ERROR' });
    expect((await activityOf(failed)).detail!.error).toContain('ValueError: ruim');

    const looping = await world.send(bot, pythonMarker({ code: 'while True:\n    pass' }));
    await waitFor('executando no sandbox', async () => (await world.pool.query("SELECT 1 FROM messages WHERE run_id = $1 AND data->'detail'->>'state' = 'running'", [looping])).rowCount, 60_000);
    const stoppedAt = Date.now();
    await world.conversations.stop(bot.id);
    await world.waitForStatus(looping, 'interrupted', 30_000);
    expect(Date.now() - stoppedAt).toBeLessThan(10_000);
    expect((await activityOf(looping)).content).toBe('Execução de Python interrompida.');

    const after = await world.send(bot, pythonMarker({ code: 'print(6 * 7)' }));
    await world.waitForStatus(after, 'completed', 120_000);
    expect((await activityOf(after)).detail!.output).toContain('42');
  }, 300_000);
});
