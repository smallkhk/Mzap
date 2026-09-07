import { createApp } from './app';
import { config } from './config';
import { logger } from './lib/logger';
import { prisma } from './lib/db';

async function main() {
  await prisma.$connect();

  const app = createApp();
  const server = app.listen(config.PORT, config.HOST, () => {
    logger.info(
      { port: config.PORT, env: config.NODE_ENV, testnetOnly: config.TESTNET_ONLY },
      'Flash Sender backend listening',
    );
    if (config.TESTNET_ONLY) {
      logger.warn('TESTNET_ONLY is enabled — mainnet networks will not be served.');
    }
  });

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down');
    server.close(() => undefined);
    await prisma.$disconnect();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  logger.fatal({ err }, 'Failed to start server');
  process.exit(1);
});
