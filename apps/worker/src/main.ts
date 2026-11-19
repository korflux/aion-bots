// Ponto de entrada do serviço `worker` (processo Node do Easypanel).
// Configuração inválida aborta com código 1 e log só com nomes de variáveis (nunca valores).
import { ConfigError, createLogger } from '@aion/core';
import { startWorker } from './bootstrap';

async function main(): Promise<void> {
  const runtime = await startWorker(process.env);
  runtime.logger.info('worker no ar');

  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    runtime.logger.info({ signal }, 'encerrando worker');
    runtime.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((error: unknown) => {
  const logger = createLogger({ level: 'error', name: 'worker' });
  if (error instanceof ConfigError) {
    logger.error({ issues: error.issues }, 'configuração inválida: o worker não iniciou');
  } else {
    logger.error({ err: error }, 'falha ao iniciar o worker');
  }
  process.exit(1);
});
