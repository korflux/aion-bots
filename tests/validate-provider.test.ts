// Prova do script de validação técnica do provedor (T5): executa `tests/support/validate-provider.ts` como processo real
// contra o OpenCode Go falso e confere o que ele imprime (um resultado por modelo, o JSON final), os códigos de saída
// nas recusas e, acima de tudo, que a chave (que só entra por variável de ambiente) nunca aparece na saída.
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startFakeUpstreams, type FakeUpstreams } from '@aion/core/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SCRIPT = 'tests/support/validate-provider.ts';
const KEY = 'valid-validate-key-XYZ9';

let upstreams: FakeUpstreams;

beforeAll(async () => {
  upstreams = await startFakeUpstreams();
});

afterAll(async () => {
  await upstreams.stop();
});

/** Roda o script com o ambiente dado; devolve saída e código (não rejeita em código diferente de zero). */
function run(env: Record<string, string | undefined>, args: string[] = []): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ['--import', 'tsx', SCRIPT, ...args],
      { cwd: ROOT, env: { ...process.env, AION_VALIDATE_PROVIDER_KEY: undefined, AION_OPENCODE_GO_BASE_URL: undefined, ...env }, timeout: 90_000 },
      (error, stdout, stderr) => resolve({ code: error ? Number((error as { code?: number }).code ?? 1) : 0, stdout, stderr }),
    );
  });
}

describe('validate:provider', () => {
  it('testa os modelos pedidos, imprime o que observou e nunca mostra a chave', async () => {
    const result = await run({ AION_VALIDATE_PROVIDER_KEY: KEY, AION_OPENCODE_GO_BASE_URL: upstreams.opencodeGoBaseUrl }, ['glm-5.1', 'kimi-k2.7-code', 'deepseek-v4-pro', 'broken-model']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Lista do provedor: 14 modelos; testando 4.');
    // `conversa=ok`: o histórico de ferramenta (modelos com ferramenta) e as instruções de sistema (todos os que respondem)
    // foram aceitos no protocolo do modelo; `-` onde nenhum protocolo serve.
    expect(result.stdout).toMatch(/glm-5\.1\s+ok protocolo=chat_completions effort=\[low,medium,high\] conversa=ok/);
    expect(result.stdout).toMatch(/kimi-k2\.7-code\s+ok protocolo=messages effort=\[low,medium,high,xhigh,max\] conversa=ok/);
    expect(result.stdout).toMatch(/deepseek-v4-pro\s+no_tools \(no_tool_call\) protocolo=chat_completions effort=\[\] conversa=ok/);
    expect(result.stdout).toMatch(/broken-model\s+failed \(unsupported\) protocolo=- effort=\[\] conversa=-/);

    const json = JSON.parse(result.stdout.slice(result.stdout.indexOf('\n{\n')));
    expect(json.results.map((item: { model: string }) => item.model)).toEqual(['glm-5.1', 'kimi-k2.7-code', 'deepseek-v4-pro', 'broken-model']);
    expect(json.results[0].outcome).toEqual({ status: 'ok', reason: null, protocol: 'chat_completions', effortLevels: ['low', 'medium', 'high'] });
    expect(json.results.map((item: { conversation: string }) => item.conversation)).toEqual(['ok', 'ok', 'ok', '-']);
    // R8: a listagem é pública (a chave inventada passa por ela) e quem prova a chave é a sonda de chat: recusa a inventada e
    // aceita a informada, que é exatamente o que o script confere antes de testar os modelos.
    expect(json.acceptsAnyKey).toBe(true);
    expect(json.probe).toEqual({ invented: 'recusada', real: 'aceita' });
    expect(result.stdout).toContain('Sonda de chat com a chave inventada: recusada (esperado)');
    expect(result.stdout).toContain('Sonda de chat com a chave informada: aceita (esperado)');
    expect(result.stdout + result.stderr).not.toContain(KEY);
    // A chave chegou ao provedor (era para testar com ela), mas só pelo cabeçalho.
    expect(upstreams.requests.filter((request) => request.method === 'POST' && request.key === KEY).length).toBeGreaterThan(0);
  });

  it('sem chave só confere a recusa da chave inventada (sem gastar a assinatura); chave informada recusada ou modelo fora da lista saem com 1', async () => {
    const before = upstreams.requests.filter((request) => request.method === 'POST').length;
    const noKey = await run({ AION_OPENCODE_GO_BASE_URL: upstreams.opencodeGoBaseUrl });
    expect(noKey.code).toBe(0);
    expect(noKey.stdout).toContain('Sonda de chat com a chave inventada: recusada (esperado)');
    expect(noKey.stdout).toContain('só a recusa da chave inventada foi conferida');
    // Uma única chamada de chat (a sonda da chave inventada) e nenhum teste de modelo.
    expect(upstreams.requests.filter((request) => request.method === 'POST')).toHaveLength(before + 1);

    // A chave que o usuário informa e o provedor recusa derruba o script: a validação da chave falhou.
    const refused = await run({ AION_VALIDATE_PROVIDER_KEY: 'ghost-chave-do-dono-recusada', AION_OPENCODE_GO_BASE_URL: upstreams.opencodeGoBaseUrl });
    expect(refused.code).toBe(1);
    expect(refused.stdout).toContain('Sonda de chat com a chave informada: recusada (ESPERADO: aceita)');
    expect(refused.stdout + refused.stderr).not.toContain('ghost-chave-do-dono-recusada');

    const beforeUnknown = upstreams.requests.filter((request) => request.method === 'POST').length;
    const unknown = await run({ AION_VALIDATE_PROVIDER_KEY: KEY, AION_OPENCODE_GO_BASE_URL: upstreams.opencodeGoBaseUrl }, ['nao-existe']);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain('Modelos fora da lista do provedor: nao-existe');
    expect(unknown.stdout + unknown.stderr).not.toContain(KEY);
    expect(upstreams.requests.filter((request) => request.method === 'POST')).toHaveLength(beforeUnknown);
  });
});

it('opcao --image separa ids e imprime apenas resultado sem chave', async () => {
  const result = await run({ AION_VALIDATE_PROVIDER_KEY: KEY, AION_OPENCODE_GO_BASE_URL: upstreams.opencodeGoBaseUrl }, ['--image', 'vision-model', 'vision-reject']);
  expect(result.code).toBe(0);
  expect(result.stdout).toContain('imagem=enxerga');
  expect(result.stdout).toContain('imagem=não enxerga');
  expect(result.stdout + result.stderr).not.toContain(KEY);
});

it('--image reprova quando nao consegue executar a sonda', async () => {
  const result = await run({ AION_VALIDATE_PROVIDER_KEY: KEY, AION_OPENCODE_GO_BASE_URL: upstreams.opencodeGoBaseUrl }, ['--image', 'broken-model']);
  expect(result.code).toBe(1);
  expect(result.stdout).toContain('imagem=-');
  expect(result.stdout + result.stderr).not.toContain(KEY);
});
