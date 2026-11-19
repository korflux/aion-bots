// Constantes da pilha de E2E, compartilhadas pela pilha (e2e-stack.ts) e pelos specs do Playwright.
// Credenciais de TESTE, válidas só na pilha local descartável que o próprio E2E sobe; nunca são as reais.
export const E2E_OWNER = { email: 'dono@aion.test', password: 'senha-de-teste-e2e-1' };
/** Chave mestra de teste (32 bytes em base64). */
export const E2E_MASTER_KEY = Buffer.alloc(32, 11).toString('base64');

/**
 * Porta pública (proxy reverso que imita o Traefik do Easypanel), da API, do Next standalone e dos servidores falsos (OpenCode Go,
 * Composio, Parallel e FCM: um só servidor, um caminho por serviço; a porta é fixa para os specs lerem as mensagens recebidas pelo FCM, em
 * `GET /fcm/__messages`) e do controle de teste (`control`, só nesta pilha descartável: roda a retenção do chat geral com o relógio adiantado
 * e prepara o banco com reset SQL exclusivo de testes, sem usar o limite da exclusão do produto; ver `e2e-stack.ts`).
 * `AION_E2E_PORT_BASE` desloca o grupo: execuções paralelas (worktrees) usam bases diferentes e não colidem.
 * Playwright e a pilha leem a mesma variável porque o processo filho herda o ambiente.
 */
const portBase = Number(process.env.AION_E2E_PORT_BASE ?? 3100);
export const E2E_PORTS = { proxy: portBase, api: portBase + 1, web: portBase + 2, fakes: portBase + 3, control: portBase + 4 } as const;
export const E2E_ORIGIN = `http://127.0.0.1:${E2E_PORTS.proxy}`;

/** Cabeçalho que os testes usam para escolher o "IP do cliente" que o proxy repassa à API em X-Forwarded-For. */
export const E2E_CLIENT_IP_HEADER = 'x-e2e-client-ip';

/** Configuração PÚBLICA do app web do Firebase e chave VAPID que a API entrega ao navegador na pilha (valores de teste, sem projeto real). */
export const E2E_FIREBASE_WEB_CONFIG = { apiKey: 'AIza-e2e-public-key', projectId: 'aion-e2e', messagingSenderId: '1234567890', appId: '1:1234567890:web:e2e' };
export const E2E_VAPID_KEY = 'B'.repeat(86);

// Sandbox falso do Python (phase 4, T8; ver `e2e-sandbox.ts`): o código que o spec manda escolhe o cenário do sandbox.
/** Código que gera o gráfico e o CSV (o conteúdo é o de um script real, para a atividade expandida mostrar algo crível). */
export const E2E_CHART_CODE = [
  'import pandas as pd',
  'import matplotlib.pyplot as plt',
  "dados = pd.DataFrame({'mes': ['jan', 'fev', 'mar', 'abr'], 'vendas': [12, 30, 21, 42]})",
  "dados.plot.bar(x='mes', y='vendas', legend=False)",
  "plt.savefig('grafico.png')",
  "dados.to_csv('dados.csv', index=False)",
  "print('Total:', dados['vendas'].sum())",
].join('\n');
/** Código que esgota o tempo. */
export const E2E_TIMEOUT_CODE = 'import time\nwhile True:\n    time.sleep(1)';
/** Conteúdo do CSV gerado, conferido no download. */
export const E2E_CHART_CSV = 'mes,vendas\njan,12\nfev,30\nmar,21\nabr,42\n';
