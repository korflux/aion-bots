// Ponto de entrada do serviço `api` (processo Node do Easypanel).
//
// Falha de configuração NÃO derruba com stack: registra quais variáveis faltam ou estão inválidas (só nomes,
// nunca valores) e sai com código 1, para o Easypanel mostrar o motivo e não subir uma API insegura.
import { ConfigError, createLogger } from '@aion/core';
import { startApi } from './bootstrap';

async function main(): Promise<void> {
  // Cópia do ambiente para a subida; a senha do dono sai de process.env logo em seguida, para não ficar
  // disponível a código posterior (ex.: dump de env em erro). Melhor esforço: AUTH-02 aceita a senha em
  // texto no ambiente do container.
  const env = { ...process.env };
  delete process.env.AION_OWNER_PASSWORD;

  const runtime = await startApi(env);
  runtime.logger.info({ port: runtime.port }, 'api no ar');

  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    runtime.logger.info({ signal }, 'encerrando api');
    runtime.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((error: unknown) => {
  const logger = createLogger({ level: 'error', name: 'api' });
  if (error instanceof ConfigError) {
    logger.error({ issues: error.issues }, 'configuração inválida: a api não iniciou');
  } else {
    logger.error({ err: error }, 'falha ao iniciar a api');
  }
  process.exit(1);
});
