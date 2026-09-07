import { createApp } from './app';
import { config } from './config';
import { logger } from './lib/logger';
import { prisma } from './lib/db';
import * as serverWallet from './services/serverWallet';
import { resumePending } from './services/sendService';

async function main() {
  await prisma.$connect();

  // Unlock the custodial wallet before serving. A misconfigured vault is a
  // hard failure: better to refuse to start than to run a sending service
  // that cannot sign.
  await serverWallet.initialise();

  const app = createApp();
  const server = app.listen(config.PORT, config.HOST, () => {
    logger.info(
      { port: config.PORT, env: config.NODE_ENV, testnetOnly: config.TESTNET_ONLY },
      'Flash Sender backend listening',
    );
    if (config.TESTNET_ONLY) {
      logger.warn('TESTNET_ONLY is enabled — mainnet networks will not be served.');
    }
    if (serverWallet.isCustodial()) {
      logger.warn(
        { address: serverWallet.address() },
        'Custodial mode: this server holds the sending key and signs for clients.',
      );
    }
  });

  // Passenger recycles idle applications, so pick up anything that was still
  // pending when the previous process stopped.
  void resumePending().catch((err) => logger.error({ err }, 'Failed to resume pending watchers'));

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down');
    server.close(() => undefined);
    serverWallet.lock();
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
