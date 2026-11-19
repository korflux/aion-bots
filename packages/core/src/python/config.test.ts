// Configuração opcional do sandbox do Python (phase 4, F8 e F11, Suposição 22a): as duas variáveis andam juntas, o endereço é uma origem da rede
// interna (http aceito, sem caminho, credenciais nem consulta) e nada inválido derruba a API ou o worker; o aviso cita só o nome da variável.
import { describe, expect, it } from 'vitest';
import { loadApiConfig, loadWorkerConfig } from '../config';

const BASE = { DATABASE_URL: 'postgres://aion:aion@localhost:5432/aion', AION_MASTER_KEY: Buffer.alloc(32, 1).toString('base64') };
const API = { ...BASE, AION_OWNER_EMAIL: 'dono@aion.test', AION_OWNER_PASSWORD: 'senha-de-teste-do-dono' };
const TOKEN = 'a'.repeat(32);

describe('configuração do sandbox', () => {
  it('ausente: nulo e sem aviso, na API e no worker', () => {
    expect(loadWorkerConfig(BASE)).toMatchObject({ sandbox: null, warnings: [] });
    expect(loadApiConfig(API)).toMatchObject({ sandbox: null, warnings: [] });
  });

  it('as duas válidas: origem da rede interna (http, nome com sublinhado) e o token', () => {
    expect(loadWorkerConfig({ ...BASE, AION_SANDBOX_URL: 'http://aion_sandbox:8080', AION_SANDBOX_TOKEN: TOKEN }).sandbox).toEqual({ url: 'http://aion_sandbox:8080', token: TOKEN });
    expect(loadApiConfig({ ...API, AION_SANDBOX_URL: 'https://sandbox.interno/', AION_SANDBOX_TOKEN: TOKEN }).sandbox).toEqual({ url: 'https://sandbox.interno', token: TOKEN });
  });

  it('inválida ou só uma: Python desligado, sem derrubar a subida, e o aviso cita só o nome', () => {
    const cases: [Record<string, string>, string][] = [
      [{ AION_SANDBOX_URL: 'http://aion_sandbox:8080' }, 'AION_SANDBOX_TOKEN'],
      [{ AION_SANDBOX_TOKEN: TOKEN }, 'AION_SANDBOX_URL'],
      [{ AION_SANDBOX_URL: 'http://usuario:senha@aion_sandbox:8080', AION_SANDBOX_TOKEN: TOKEN }, 'AION_SANDBOX_URL'],
      [{ AION_SANDBOX_URL: 'http://aion_sandbox:8080/run', AION_SANDBOX_TOKEN: TOKEN }, 'AION_SANDBOX_URL'],
      [{ AION_SANDBOX_URL: 'ftp://aion_sandbox', AION_SANDBOX_TOKEN: TOKEN }, 'AION_SANDBOX_URL'],
      [{ AION_SANDBOX_URL: 'http://aion_sandbox:8080', AION_SANDBOX_TOKEN: 'curto-demais' }, 'AION_SANDBOX_TOKEN'],
    ];
    for (const [env, variable] of cases) {
      const config = loadWorkerConfig({ ...BASE, ...env });
      expect(config.sandbox).toBeNull();
      expect(config.warnings.map((issue) => issue.variable)).toEqual([variable]);
      expect(config.warnings[0]!.problem).toContain('o Python fica desligado');
      expect(JSON.stringify(config.warnings)).not.toMatch(/senha|curto-demais|aaaaaaaa/);
    }
  });
});
