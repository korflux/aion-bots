// Prova da configuração como controle de segurança: o serviço falha fechado quando falta algo obrigatório
// e o erro cita só o nome da variável, nunca o valor recebido.
import { describe, expect, it } from 'vitest';
import { ConfigError, loadApiConfig, loadWorkerConfig, type Env } from './config';

const MASTER_BASE64 = Buffer.alloc(32, 9).toString('base64');
const valid: Env = {
  DATABASE_URL: 'postgres://aion:segredo-do-banco@db:5432/aion',
  AION_OWNER_EMAIL: 'dono@aion.test',
  AION_OWNER_PASSWORD: 'senha-de-teste-do-dono-1',
  AION_MASTER_KEY: MASTER_BASE64,
};

function failure(env: Env): ConfigError {
  try {
    loadApiConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) return error;
    throw error;
  }
  throw new Error('esperava ConfigError');
}

describe('configuração da API', () => {
  it('quota de anexos tem padrão1GB e falha fechada para limites inválidos na API e worker', () => {
    expect(loadApiConfig(valid).attachmentsMaxTotalBytes).toBe(1024 * 1024 * 1024);
    expect(loadApiConfig({ ...valid, AION_ATTACHMENTS_MAX_TOTAL_MB: '2' }).attachmentsMaxTotalBytes).toBe(2 * 1024 * 1024);
    for (const value of ['0', '-1', '1.5', 'infinito', '1048577']) {
      expect(() => loadApiConfig({ ...valid, AION_ATTACHMENTS_MAX_TOTAL_MB: value })).toThrow(/AION_ATTACHMENTS_MAX_TOTAL_MB/);
      expect(() => loadWorkerConfig({ ...valid, AION_ATTACHMENTS_MAX_TOTAL_MB: value })).toThrow(/AION_ATTACHMENTS_MAX_TOTAL_MB/);
    }
  });
  it('aplica padrões por ambiente e aceita a chave mestra em base64 ou hex', () => {
    const dev = loadApiConfig(valid);
    expect(dev).toMatchObject({
      nodeEnv: 'development',
      isProduction: false,
      port: 3001,
      publicOrigin: 'http://localhost:3000',
      trustedProxies: [],
      allowDestructiveMigrations: false,
    });
    expect(dev.masterKey).toHaveLength(32);

    const prod = loadApiConfig({
      ...valid,
      NODE_ENV: 'production',
      LOG_LEVEL: 'debug',
      AION_MASTER_KEY: Buffer.alloc(32, 9).toString('hex'),
      AION_PUBLIC_ORIGIN: 'https://aion.exemplo.com',
    });
    expect(prod.publicOrigin).toBe('https://aion.exemplo.com');
    expect(prod.trustedProxies).toEqual(['loopback', 'uniquelocal']);
    // Debug fica desabilitado em produção mesmo se pedido.
    expect(prod.logLevel).toBe('info');
    expect(prod.masterKey.equals(dev.masterKey)).toBe(true);
  });

  it('em produção recusa subir sem AION_PUBLIC_ORIGIN (ausente ou em branco), citando só o nome da variável', () => {
    for (const configured of [undefined, '', '   ']) {
      expect(() => loadApiConfig({ ...valid, NODE_ENV: 'production', AION_PUBLIC_ORIGIN: configured })).toThrow(
        'Configuração inválida: AION_PUBLIC_ORIGIN ausente (obrigatória em produção)',
      );
    }
  });

  it('recusa e-mail, senha ou chave mestra ausentes, sem citar valores', () => {
    for (const variable of ['AION_OWNER_EMAIL', 'AION_OWNER_PASSWORD', 'AION_MASTER_KEY'] as const) {
      const env = { ...valid };
      delete env[variable];
      const error = failure(env);
      expect(error.issues).toEqual([{ variable, problem: 'ausente' }]);
    }
    // Vazias contam como ausentes.
    expect(failure({ ...valid, AION_OWNER_PASSWORD: '   ' }).issues[0]?.problem).toBe('ausente');
  });

  it('recusa valores inválidos e o erro nunca contém o valor recebido', () => {
    const secrets = ['curta', 'chave-mestra-curta-demais', 'nao-e-url-com-segredo-123', 'sem-arroba-segredo'];
    const error = failure({
      DATABASE_URL: secrets[2],
      AION_OWNER_EMAIL: secrets[3],
      AION_OWNER_PASSWORD: secrets[0],
      AION_MASTER_KEY: secrets[1],
      AION_PUBLIC_ORIGIN: 'https://aion.exemplo.com/com-caminho',
      PORT: '99999',
    });
    expect(error.issues.map((i) => i.variable).sort()).toEqual([
      'AION_MASTER_KEY',
      'AION_OWNER_EMAIL',
      'AION_OWNER_PASSWORD',
      'AION_PUBLIC_ORIGIN',
      'DATABASE_URL',
      'PORT',
    ]);
    for (const secret of [...secrets, 'https://aion.exemplo.com/com-caminho', '99999']) {
      expect(error.message).not.toContain(secret);
    }
  });
});

describe('configuração do worker', () => {
  it('exige o banco e a chave mestra (decifra a chave do provedor), mas nunca a credencial do dono (menor privilégio)', () => {
    const worker = loadWorkerConfig({ DATABASE_URL: valid.DATABASE_URL, AION_MASTER_KEY: MASTER_BASE64 });
    expect(worker).toMatchObject({ nodeEnv: 'development', logLevel: 'info', opencodeGoBaseUrl: 'https://opencode.ai/zen/go/v1' });
    expect(worker.masterKey).toHaveLength(32);
    expect(worker).not.toHaveProperty('ownerPassword');
    expect(() => loadWorkerConfig({})).toThrow(/DATABASE_URL ausente; AION_MASTER_KEY ausente/);
    expect(() => loadWorkerConfig({ DATABASE_URL: valid.DATABASE_URL, AION_MASTER_KEY: 'curta' })).toThrow(/AION_MASTER_KEY inválida/);
  });
});
