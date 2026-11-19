// Orquestrador de `pnpm --filter @aion/sandbox test:container`: constrói a imagem (com cache), sobe numa rede Docker isolada o container
// do sandbox e um canário HTTP, roda as suítes em container (execução, fuga e limites) contra eles e derruba tudo ao final, passe ou
// falhe. As suítes ficam fora do `pnpm test` padrão porque exigem Docker e o Node 26 da imagem (o bloqueio de rede do modelo de
// permissões não existe no Node 24 local).
//
// O token é gerado aqui a cada execução e passado ao container pelo ambiente do `docker run` (nunca na linha de comando nem em arquivo).
import { spawnSync, type SpawnSyncOptions } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(appDir, '..', '..');
const image = 'aion-sandbox:test';
const suffix = randomBytes(4).toString('hex');
const network = `aion-sbx-test-${suffix}`;
const sandbox = `aion-sbx-${suffix}`;
const canary = `aion-sbx-canary-${suffix}`;
const token = randomBytes(32).toString('hex');

/** Canário: conta todo pedido recebido, exceto as rotas de controle do próprio teste (`/__count` e `/__ping`). */
const CANARY_SCRIPT = `
let hits = 0;
require('node:http').createServer((req, res) => {
  if (req.url === '/__count') return res.end(JSON.stringify({ hits }));
  if (req.url !== '/__ping') hits += 1;
  res.end('canario');
}).listen(8080);
`;

/** Reusa o pnpm que iniciou o teste, como no smoke, para não trocar a versão fixada por outra do PATH; demais comandos não usam shell. */
function run(command: string, args: string[], options: SpawnSyncOptions = {}): { status: number; stdout: string } {
  const pnpm = command === 'pnpm' ? process.env.npm_execpath : undefined;
  const result = spawnSync(pnpm ? process.execPath : command, pnpm ? [pnpm, ...args] : args, {
    encoding: 'utf8',
    stdio: options.stdio ?? ['ignore', 'pipe', 'inherit'],
    shell: !pnpm && command === 'pnpm' && process.platform === 'win32',
    ...options,
  });
  return { status: result.status ?? 1, stdout: String(result.stdout ?? '') };
}

function must(command: string, args: string[], options: SpawnSyncOptions = {}): string {
  const result = run(command, args, options);
  if (result.status !== 0) throw new Error(`falhou: ${command} ${args[0] ?? ''}`);
  return result.stdout.trim();
}

/** Endereço publicado no host (só 127.0.0.1) para a porta 8080 de um container. */
function publishedUrl(container: string): string {
  const mapping = must('docker', ['port', container, '8080/tcp']).split('\n')[0] ?? '';
  return `http://${mapping.replace('0.0.0.0', '127.0.0.1')}`;
}

/** Espera o sandbox ficar com as duas vagas aquecidas (o aquecimento leva alguns segundos por processo). */
async function waitReady(url: string): Promise<void> {
  const until = Date.now() + 180_000;
  while (Date.now() < until) {
    try {
      const response = await fetch(`${url}/health`, { headers: { authorization: `Bearer ${token}` } });
      const body = (await response.json()) as { ready?: number };
      if (response.ok && body.ready === 2) return;
    } catch {
      // ainda subindo
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('sandbox não ficou pronto em 180 s');
}

async function main(): Promise<number> {
  must('docker', ['build', '--file', 'apps/sandbox/Dockerfile', '--tag', image, '.'], { cwd: repoRoot, stdio: ['ignore', 'inherit', 'inherit'] });
  try {
    must('docker', ['network', 'create', network]);
    // `--no-healthcheck`: o canário reusa a imagem do sandbox, cujo HEALTHCHECK faria GET /health em 127.0.0.1:8080 a cada 30 s, ou
    // seja, no próprio canário; esse pedido de dentro do canário seria contado como se viesse do sandbox.
    must('docker', [
      'run', '-d', '--name', canary, '--network', network, '-p', '127.0.0.1::8080', '--no-healthcheck', '--entrypoint', 'node', image,
      '-e', CANARY_SCRIPT,
    ]);
    // Limite de memória do container como no Easypanel (teto real); o token entra pelo ambiente herdado (`-e NOME` sem valor).
    must('docker', ['run', '-d', '--name', sandbox, '--network', network, '-p', '127.0.0.1::8080', '--memory', '3g', '-e', 'AION_SANDBOX_TOKEN', image], {
      env: { ...process.env, AION_SANDBOX_TOKEN: token },
    });
    const url = publishedUrl(sandbox);
    await waitReady(url);

    const env = {
      ...process.env,
      AION_SANDBOX_URL: url,
      AION_SANDBOX_TOKEN: token,
      AION_SANDBOX_CONTAINER: sandbox,
      AION_SANDBOX_CANARY_INNER_URL: `http://${canary}:8080`,
      AION_SANDBOX_CANARY_COUNT_URL: `${publishedUrl(canary)}/__count`,
    };
    // Suítes que rodam com o container no ar: as do próprio sandbox (execução, fuga e limites) e, desde a T7, a prova worker -> sandbox real
    // (`packages/core/src/runs/python-sandbox.test.ts`, com PostgreSQL embarcado e o motor de verdade), que lê AION_SANDBOX_URL e AION_SANDBOX_TOKEN
    // deste ambiente e é ignorada no `pnpm test` do gate, onde essas variáveis não existem.
    const suites: { cwd: string; args: string[] }[] = [
      { cwd: appDir, args: ['exec', 'vitest', 'run', '--config', 'vitest.container.config.ts'] },
      { cwd: repoRoot, args: ['test', 'python-sandbox'] },
    ];
    let status = 0;
    for (const suite of suites) {
      const result = run('pnpm', suite.args, { cwd: suite.cwd, env, stdio: 'inherit' });
      if (result.status !== 0) status = result.status;
    }
    return status;
  } finally {
    run('docker', ['rm', '-f', sandbox, canary]);
    run('docker', ['network', 'rm', network]);
  }
}

process.exitCode = await main();
