/**
 * Imports the custodial sending wallet into an encrypted vault file.
 *
 *   npm run import-wallet -- --out /home/USER/secure/wallet.vault
 *
 * The private key and passphrase are read interactively and never taken from
 * argv, so neither lands in your shell history or the process table.
 *
 * Run this ONCE, on the server. Afterwards set in .env:
 *
 *   WALLET_VAULT_PATH=/home/USER/secure/wallet.vault
 *   WALLET_PASSPHRASE=<the passphrase you chose>
 *
 * Read docs/CUSTODIAL.md first — this mode puts a spendable key on the
 * server, and there are things you should decide before doing that.
 */
import path from 'node:path';
import readline from 'node:readline';
import { writeVault } from '../services/serverWallet';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  const value = index === -1 ? undefined : process.argv[index + 1];
  return value?.startsWith('--') ? undefined : value;
}

function askVisible(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/** Reads a secret without echoing it; each character shows as `*`. */
function askSecret(question: string): Promise<string> {
  const stdin = process.stdin;

  if (!stdin.isTTY) {
    process.stdout.write('(input will be visible: not running in a terminal)\n');
    return askVisible(question);
  }

  return new Promise((resolve, reject) => {
    process.stdout.write(question);

    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    let value = '';

    const cleanup = () => {
      stdin.removeListener('data', onData);
      stdin.setRawMode(wasRaw);
      stdin.pause();
    };

    const onData = (chunk: string) => {
      for (const char of chunk) {
        switch (char) {
          case '\r':
          case '\n':
          case '\u0004': // Ctrl-D
            cleanup();
            process.stdout.write('\n');
            resolve(value);
            return;
          case '\u0003': // Ctrl-C
            cleanup();
            process.stdout.write('\n');
            reject(new Error('Cancelled.'));
            return;
          case '\u007f': // Backspace
          case '\b':
            if (value.length > 0) {
              value = value.slice(0, -1);
              process.stdout.write('\b \b');
            }
            break;
          default:
            if (char >= ' ') {
              value += char;
              process.stdout.write('*');
            }
        }
      }
    };

    stdin.on('data', onData);
  });
}

function normalisePrivateKey(input: string): string {
  const raw = input.trim();

  if (raw.split(/\s+/).length >= 12) {
    throw new Error(
      'That looks like a recovery phrase. This script takes a private key — derive the key for ' +
        'the account you want to send from and paste that instead.',
    );
  }

  const hex = raw.replace(/^0x/i, '');

  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(
      `A private key is 64 hexadecimal characters, optionally 0x-prefixed. This input is ` +
        `${hex.length} characters.`,
    );
  }
  if (/^0+$/.test(hex)) throw new Error('That is not a usable private key.');

  return `0x${hex.toLowerCase()}`;
}

async function main() {
  const out = arg('out') ?? (await askVisible('Vault file path: '));
  const resolved = path.resolve(out);

  if (/public_html|\/public\//.test(resolved)) {
    throw new Error(
      `${resolved} is inside a web-served directory. Choose a path outside the document root — ` +
        'a vault the web server can hand out is a vault you have given away.',
    );
  }

  // eslint-disable-next-line no-console
  console.log(
    [
      '',
      'This stores a spendable private key on this server so the backend can',
      'sign for desktop clients. Anyone who compromises this machine can move',
      'the funds. Keep only what you are willing to lose here.',
      '',
    ].join('\n'),
  );

  const privateKey = normalisePrivateKey(await askSecret('Private key (hidden): '));

  const passphrase = await askSecret('Vault passphrase (16+ chars, hidden): ');
  const confirm = await askSecret('Confirm passphrase: ');

  if (passphrase !== confirm) {
    throw new Error(
      `Passphrases do not match (${passphrase.length} vs ${confirm.length} characters). ` +
        'Nothing was written.',
    );
  }

  const address = await writeVault(privateKey, passphrase, resolved);

  // eslint-disable-next-line no-console
  console.log(
    [
      '',
      `✓ Vault written: ${resolved}`,
      `  Sending address: ${address}`,
      '',
      '  Add to .env:',
      `    WALLET_VAULT_PATH=${resolved}`,
      '    WALLET_PASSPHRASE=<the passphrase you just chose>',
      '',
      '  Then restart the application. Grant each installation a spending limit',
      '  in the dashboard — a client with no limit cannot send at all.',
      '',
    ].join('\n'),
  );
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(`\n✗ ${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
});
