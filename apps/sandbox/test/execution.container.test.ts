// Suíte de execução (A14) contra o container real: o roteiro com pandas, gráfico Agg, openpyxl e sqlite3 funciona lendo /data/ e
// gravando /out/, com o `fetch` instrumentado do processo filho em zero chamadas (inclusive na carga) e o canário de rede sem nenhum
// pedido. Também cobre o contrato de saída: traceback sem o quadro interno, corte da saída e chamada sem estado da anterior.
import { beforeEach, describe, expect, it } from 'vitest';
import { LIMITS } from '../src/protocol.js';
import { asRun, canaryHits, runPython, waitHealth } from './client.js';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ZIP_SIGNATURE = Buffer.from('PK\u0003\u0004', 'latin1');

const SALES_CSV = 'regiao,mes,valor\nSul,1,100\nSul,2,150\nNorte,1,80\nNorte,2,120\nLeste,1,60\n';

const ROTEIRO = `
import io, sqlite3
import numpy as np
from scipy.integrate import quad
import pandas as pd
import matplotlib
import matplotlib.pyplot as plt
from openpyxl import Workbook

df = pd.read_csv("/data/vendas.csv")
por_regiao = df.groupby("regiao")["valor"].sum().sort_index()
print("total", int(df["valor"].sum()))
print("media", float(np.mean(df["valor"])))
integral, erro = quad(lambda x: np.exp(-x*x), -np.inf, np.inf)
assert abs(integral - np.sqrt(np.pi)) < 1e-12
print("gaussiana", integral)
print("backend", matplotlib.get_backend())

con = sqlite3.connect(":memory:")
df.to_sql("vendas", con, index=False)
maior = con.execute("SELECT regiao, SUM(valor) AS s FROM vendas GROUP BY regiao ORDER BY s DESC LIMIT 1").fetchone()
print("maior", maior[0], maior[1])

fig, ax = plt.subplots()
por_regiao.plot.bar(ax=ax)
fig.savefig("grafico.png")

wb = Workbook()
ws = wb.active
ws.append(["regiao", "total"])
for regiao, total in por_regiao.items():
    ws.append([regiao, int(total)])
wb.save("/out/resumo.xlsx")
por_regiao.to_csv("/out/resumo.csv")
`;

describe('execução de Python no sandbox (A14)', () => {
  beforeEach(async () => {
    await waitHealth((body) => body.ready === 2);
  });

  it('roda scipy, pandas, numpy, gráfico Agg, openpyxl e sqlite3 sem nenhuma chamada de rede', async () => {
    const hitsBefore = await canaryHits();
    const result = asRun(await runPython(ROTEIRO, [{ name: 'vendas.csv', data: Buffer.from(SALES_CSV) }]));

    expect(result.outcome).toBe('ok');
    expect(result.error).toBeNull();
    expect(result.output).toContain('total 510');
    expect(result.output).toContain('media 102.0');
    expect(result.output).toContain('gaussiana 1.772453850905');
    expect(result.output.toLowerCase()).toContain('backend agg');
    expect(result.output).toContain('maior Sul 250');
    expect(result.files.map((file) => file.name)).toEqual(['grafico.png', 'resumo.csv', 'resumo.xlsx']);
    expect(result.contents.get('grafico.png')?.subarray(0, 8)).toEqual(PNG_SIGNATURE);
    expect(result.contents.get('resumo.xlsx')?.subarray(0, 4)).toEqual(ZIP_SIGNATURE);
    expect(result.contents.get('resumo.csv')?.toString('utf8')).toContain('Sul,250');
    // fetch instrumentado: zero tentativas da carga do Pyodide até o fim da chamada; canário fora do container sem nenhum pedido.
    expect(result.networkCalls).toBe(0);
    expect(await canaryHits()).toBe(hitsBefore);
  });

  it('lê com openpyxl uma planilha recebida em /data/', async () => {
    const created = asRun(await runPython(ROTEIRO, [{ name: 'vendas.csv', data: Buffer.from(SALES_CSV) }]));
    const workbook = created.contents.get('resumo.xlsx');
    expect(workbook).toBeDefined();

    const read = asRun(await runPython(
      'from openpyxl import load_workbook\nws = load_workbook("/data/resumo.xlsx").active\nprint([[c.value for c in row] for row in ws.iter_rows()])',
      [{ name: 'resumo.xlsx', data: workbook as Buffer }],
    ));
    expect(read.outcome).toBe('ok');
    expect(read.output).toContain("['Sul', 250]");
  });

  it('devolve o traceback do erro do Python sem o quadro interno do executor', async () => {
    const result = asRun(await runPython('def dividir(a, b):\n    return a / b\n\nprint("antes")\ndividir(1, 0)\n'));
    expect(result.outcome).toBe('PYTHON_ERROR');
    expect(result.output).toContain('antes');
    expect(result.error).toContain('ZeroDivisionError');
    expect(result.error).toContain('File "<python>", line 5');
    expect(result.error).not.toContain('_aion_run');
    expect(result.files).toEqual([]);
  });

  it('corta a saída no limite e avisa', async () => {
    const result = asRun(await runPython('print("x" * 50000)'));
    expect(result.outcome).toBe('ok');
    expect(result.outputTruncated).toBe(true);
    expect(result.output).toHaveLength(LIMITS.outputMaxChars);
  });

  it('começa cada chamada do zero, sem estado da anterior', async () => {
    const first = asRun(await runPython('import builtins\nbuiltins.MARCA = 1\nopen("/tmp/marca.txt", "w").write("1")\nopen("/out/marca.txt", "w").write("1")'));
    expect(first.outcome).toBe('ok');
    const second = asRun(await runPython(
      'import builtins, os\nprint(hasattr(builtins, "MARCA"), os.path.exists("/tmp/marca.txt"), os.listdir("/out"), os.listdir("/data"))',
    ));
    expect(second.output.trim()).toBe('False False [] []');
  });
});
