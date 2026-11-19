// Prova da configuração do push (T10) como controle de segurança E de disponibilidade. O push é OPCIONAL: um valor inválido (ou uma variável
// sozinha) NUNCA impede a subida da API nem do worker (que executa os bots), só desliga o push e vira um aviso que cita o NOME da variável,
// jamais o valor (que, na conta de serviço, contém a chave privada). Foi o que faltou no primeiro deploy: o Easypanel estragou as aspas do
// JSON, a API recusou iniciar e, sem ela, o worker novo ficou esperando a migration e os bots pararam. O JSON também pode vir em base64,
// que não tem aspas para estragar. Os destinos de saída do FCM são fixos: só https, ou http em loopback para os servidores falsos.
import { describe, expect, it } from 'vitest';
import { loadApiConfig, loadWorkerConfig, parseFcmServiceAccount, type Env } from '../config';

const MASTER = Buffer.alloc(32, 9).toString('base64');
const API_ENV: Env = {
  DATABASE_URL: 'postgres://aion:x@db:5432/aion',
  AION_OWNER_EMAIL: 'dono@aion.test',
  AION_OWNER_PASSWORD: 'senha-de-teste-do-dono-1',
  AION_MASTER_KEY: MASTER,
};
const WORKER_ENV: Env = { DATABASE_URL: 'postgres://aion:x@db:5432/aion', AION_MASTER_KEY: MASTER };

const WEB_CONFIG = { apiKey: 'AIza-public-key', projectId: 'aion-test', messagingSenderId: '1234567890', appId: '1:1234567890:web:abc', authDomain: 'ignorado.firebaseapp.com' };
const PUBLIC_FIELDS = { apiKey: 'AIza-public-key', projectId: 'aion-test', messagingSenderId: '1234567890', appId: '1:1234567890:web:abc' }; // authDomain descartado
const VAPID = 'B'.repeat(87);
const PRIVATE_KEY = '-----BEGIN PRIVATE KEY-----\nSEGREDO-DA-CHAVE-PRIVADA\n-----END PRIVATE KEY-----\n';
const ACCOUNT_JSON = JSON.stringify({ type: 'service_account', project_id: 'aion-test', client_email: 'push@aion-test.iam.gserviceaccount.com', private_key: PRIVATE_KEY });
const toBase64 = (text: string) => Buffer.from(text).toString('base64');

describe('configuração do push na API', () => {
  it('sem as variáveis o push fica desligado; com as duas, em JSON ou em base64, entrega só os quatro campos públicos e a chave VAPID', () => {
    const off = loadApiConfig(API_ENV);
    expect([off.push, off.warnings]).toEqual([{ enabled: false }, []]);

    const expected = { enabled: true, firebase: PUBLIC_FIELDS, vapidKey: VAPID };
    for (const webConfig of [JSON.stringify(WEB_CONFIG), toBase64(JSON.stringify(WEB_CONFIG))]) {
      const on = loadApiConfig({ ...API_ENV, AION_FCM_WEB_CONFIG: webConfig, AION_FCM_VAPID_KEY: VAPID });
      expect([on.push, on.warnings]).toEqual([expected, []]);
    }
  });

  it('o caso real do Easypanel: JSON sem as aspas, uma variável sozinha ou um valor inválido NÃO derrubam a API; o push fica desligado e o aviso cita só o nome', () => {
    const mangled = '{apiKey:AIza-public-key,projectId:aion-test,messagingSenderId:1234567890,appId:1:1234567890:web:abc}'; // as aspas se perderam
    const cases: [string, Env, string][] = [
      ['JSON com as aspas estragadas', { AION_FCM_WEB_CONFIG: mangled, AION_FCM_VAPID_KEY: VAPID }, 'AION_FCM_WEB_CONFIG'],
      ['JSON sem campo obrigatório', { AION_FCM_WEB_CONFIG: JSON.stringify({ apiKey: 'x' }), AION_FCM_VAPID_KEY: VAPID }, 'AION_FCM_WEB_CONFIG'],
      ['chave VAPID com espaço', { AION_FCM_WEB_CONFIG: JSON.stringify(WEB_CONFIG), AION_FCM_VAPID_KEY: 'chave com espaço' }, 'AION_FCM_VAPID_KEY'],
      ['só a configuração, sem a chave VAPID', { AION_FCM_WEB_CONFIG: JSON.stringify(WEB_CONFIG) }, 'AION_FCM_VAPID_KEY'],
      ['só a chave VAPID, sem a configuração', { AION_FCM_VAPID_KEY: VAPID }, 'AION_FCM_WEB_CONFIG'],
    ];
    for (const [description, extra, variable] of cases) {
      const config = loadApiConfig({ ...API_ENV, ...extra });
      expect(config.push, description).toEqual({ enabled: false });
      expect(config.warnings.map((warning) => warning.variable), description).toEqual([variable]);
      // O aviso nunca ecoa o valor recebido.
      expect(JSON.stringify(config.warnings), description).not.toContain('AIza-public-key');
      expect(JSON.stringify(config.warnings), description).not.toContain('chave com espaço');
    }
    // O resto da configuração segue válido: o push desligado não afeta mais nada.
    expect(loadApiConfig({ ...API_ENV, AION_FCM_WEB_CONFIG: mangled }).databaseUrl).toBe(API_ENV.DATABASE_URL);
  });
});

describe('configuração do push no worker', () => {
  it('lê a conta de serviço em JSON ou em base64 (só projeto, e-mail e chave) e aplica os destinos padrão do Google', () => {
    expect(loadWorkerConfig(WORKER_ENV)).toMatchObject({
      fcmServiceAccount: null,
      fcmBaseUrl: 'https://fcm.googleapis.com',
      fcmTokenUrl: 'https://oauth2.googleapis.com/token',
      warnings: [],
    });
    const expected = { projectId: 'aion-test', clientEmail: 'push@aion-test.iam.gserviceaccount.com', privateKey: PRIVATE_KEY };
    for (const value of [ACCOUNT_JSON, toBase64(ACCOUNT_JSON)]) {
      const config = loadWorkerConfig({ ...WORKER_ENV, AION_FCM_SERVICE_ACCOUNT: value });
      expect([config.fcmServiceAccount, config.warnings]).toEqual([expected, []]);
    }
  });

  it('uma conta de serviço inválida NÃO derruba o worker (os bots seguem executando): o envio fica desligado e o aviso não repete o conteúdo', () => {
    const invalid = ['isto não é json nem base64 de json', JSON.stringify({ project_id: 'x', client_email: 'a@b.c', private_key: 'não é uma chave' }), JSON.stringify({ project_id: 'x' })];
    for (const bad of invalid) {
      const config = loadWorkerConfig({ ...WORKER_ENV, AION_FCM_SERVICE_ACCOUNT: bad });
      expect(config.fcmServiceAccount).toBeNull();
      expect(config.warnings.map((warning) => warning.variable)).toEqual(['AION_FCM_SERVICE_ACCOUNT']);
      expect(JSON.stringify(config.warnings)).not.toContain('não é uma chave');
    }
    expect(parseFcmServiceAccount(ACCOUNT_JSON.replace('SEGREDO-DA-CHAVE-PRIVADA', 'outra'))?.projectId).toBe('aion-test');
  });

  it('os destinos do FCM só aceitam https (ou http em loopback); um valor inválido volta ao padrão do Google com aviso, e um válido perde a barra final', () => {
    const insecure = loadWorkerConfig({ ...WORKER_ENV, AION_FCM_BASE_URL: 'http://fcm.exemplo.com' });
    expect([insecure.fcmBaseUrl, insecure.warnings.map((warning) => warning.variable)]).toEqual(['https://fcm.googleapis.com', ['AION_FCM_BASE_URL']]);
    const credentials = loadWorkerConfig({ ...WORKER_ENV, AION_FCM_TOKEN_URL: 'https://user:senha@oauth.exemplo.com/token' });
    expect([credentials.fcmTokenUrl, credentials.warnings.map((warning) => warning.variable)]).toEqual(['https://oauth2.googleapis.com/token', ['AION_FCM_TOKEN_URL']]);
    expect(JSON.stringify(credentials.warnings)).not.toContain('senha');
    expect(loadWorkerConfig({ ...WORKER_ENV, AION_FCM_BASE_URL: 'http://127.0.0.1:9999/fcm/' }).fcmBaseUrl).toBe('http://127.0.0.1:9999/fcm');
  });
});
