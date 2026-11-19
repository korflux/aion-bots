// Sandbox FALSO do Python na pilha do E2E (phase 4, T8): o mesmo servidor de `@aion/core/testing` (HTTP e quadro binário do serviço real, token
// Bearer), com um comportamento fixo para as telas. A pilha passa o endereço e o token à API (estado em Configurações → Python) e ao worker (a
// ferramenta `run_python`), como o Easypanel faria com o sandbox de verdade. Nada é executado: o código só escolhe o cenário.
//
// Cenários, pelo código que o modelo falso manda (o spec monta o marcador `[python:...]` com os códigos de `e2e-env.ts`):
// - `E2E_CHART_CODE`: desfecho ok em 1,2 s, saída de texto e dois arquivos em /out/: um gráfico de barras PNG de verdade e um CSV.
// - `E2E_TIMEOUT_CODE`: o tempo de 60 s esgotado (`PYTHON_TIMEOUT`), sem arquivos.
// - qualquer outro: o padrão do sandbox falso (ok, saída com os arquivos de /data/).
// A saúde (`GET /health`) responde 200; o controle da pilha a troca por 503 para o estado "Indisponível agora" (`POST /sandbox-health`).
import { crc32, deflateSync } from 'node:zlib';
import { startFakeSandbox, type FakeSandbox } from '@aion/core/testing';
import { E2E_CHART_CODE, E2E_CHART_CSV, E2E_TIMEOUT_CODE } from './e2e-env';

/** Um bloco do PNG: tamanho, tipo, dados e o CRC de tipo e dados. */
function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

/**
 * Gráfico de barras PNG (RGB, 480 x 280) desenhado pixel a pixel: fundo branco, eixo cinza e quatro barras azuis com as alturas do CSV. É o que o
 * matplotlib gravaria em formato de teste, e passa pela conferência de conteúdo real do worker (assinatura, IHDR e IEND).
 */
export function chartPng(): Buffer {
  const width = 480;
  const height = 280;
  const values = [12, 30, 21, 42];
  const raw = Buffer.alloc(height * (1 + width * 3), 0xff);
  const paint = (x: number, y: number, [r, g, b]: readonly [number, number, number]) => raw.set([r, g, b], y * (1 + width * 3) + 1 + x * 3);
  for (let y = 0; y < height; y += 1) raw[y * (1 + width * 3)] = 0; // filtro "nenhum" em cada linha
  for (let x = 40; x < width - 20; x += 1) paint(x, height - 30, [120, 120, 120]);
  for (let y = 20; y < height - 30; y += 1) paint(40, y, [120, 120, 120]);
  values.forEach((value, index) => {
    const left = 70 + index * 100;
    const top = height - 30 - Math.round((value / 42) * 210);
    for (let x = left; x < left + 60; x += 1) for (let y = top; y < height - 30; y += 1) paint(x, y, [37, 99, 235]);
  });
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8); // 8 bits por canal, RGB, sem entrelaçamento
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** Sobe o sandbox falso da pilha com os cenários acima. */
export async function startE2eSandbox(): Promise<FakeSandbox> {
  const sandbox = await startFakeSandbox();
  const fallback = sandbox.handler;
  sandbox.handler = (request, signal) => {
    if (request.code === E2E_CHART_CODE) {
      return {
        output: 'Total: 105',
        durationMs: 1_234,
        files: [
          { name: 'grafico.png', data: chartPng() },
          { name: 'dados.csv', data: Buffer.from(E2E_CHART_CSV, 'utf8') },
        ],
      };
    }
    if (request.code === E2E_TIMEOUT_CODE) return { outcome: 'PYTHON_TIMEOUT', output: '', error: null, durationMs: 60_000 };
    return fallback(request, signal);
  };
  return sandbox;
}
