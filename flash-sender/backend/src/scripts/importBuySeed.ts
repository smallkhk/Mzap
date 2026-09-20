/**
 * Sets up the buy-wallet seed — the one secret that every customer's
 * per-client deposit address is derived from.
 *
 *   npm run import-buy-seed -- --out /home/USER/secure/buy-seed.vault
 *
 * By default this GENERATES a brand-new 24-word recovery phrase and shows it
 * to you once, because there is nothing to import yet — this is a purpose-
 * built seed for the buy feature, not an existing wallet. Pass --import to
 * paste in an existing phrase instead (for recovery, or moving to a new
 * server).
 *
 * The passphrase is read interactively and never taken from argv, so it
 * never lands in shell history or the process table.
 *
 * Run this ONCE, on the server. Afterwards set in .env:
 *
 *   BUY_WALLET_VAULT_PATH=/home/USER/secure/buy-seed.vault
 *   BUY_WALLET_PASSPHRASE=<the passphrase you chose>
 *
 * If you write down the recovery phrase this script prints, store it exactly
 * as carefully as you would a wallet holding real funds — because within a
 * few "Generate tokens" clicks, it will be one.
 */
import path from 'node:path';
import readline from 'node:readline';
import { randomBytes } from 'node:crypto';
import { Mnemonic } from 'ethers';
import { writeVault } from '../services/buyWallet';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  const value = index === -1 ? undefined : process.argv[index + 1];
  return value?.startsWith('--') ? undefined : value;
}
const has = (name: string) => process.argv.includes(`--${name}`);

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

async function main() {
  const out = arg('out') ?? (await askVisible('Vault file path: '));
  const resolved = path.resolve(out);

  if (/public_html|\/public\//.test(resolved)) {
    throw new Error(
      `${resolved} is inside a web-served directory. Choose a path outside the document root — ` +
        'a vault the web server can hand out is a vault you have given away.',
    );
  }

  let phrase: string;

  if (has('import')) {
    phrase = await askSecret('Recovery phrase to import (12/15/18/21/24 words, hidden): ');
  } else {
    const mnemonic = Mnemonic.fromEntropy(randomBytes(32));
    phrase = mnemonic.phrase;

    // eslint-disable-next-line no-console
    console.log(
      [
        '',
        '✓ Generated a new 24-word recovery phrase:',
        '',
        `    ${phrase}`,
        '',
        '  Write this down and store it somewhere offline and secure — the same',
        '  way you would a wallet holding real funds, because every customer',
        '  deposit address this feature ever creates is derived from it. It is',
        '  shown once, here, and never written to disk in plaintext.',
        '',
      ].join('\n'),
    );
  }

  // eslint-disable-next-line no-console
  console.log(
    [
      'This seed derives one deposit address per portal-enabled customer for',
      'the "Generate tokens" buy feature. Anyone who compromises this machine',
      'and this vault\'s passphrase can derive every customer\'s key.',
      '',
    ].join('\n'),
  );

  const passphrase = await askSecret('Vault passphrase (16+ chars, hidden): ');
  const confirm = await askSecret('Confirm passphrase: ');

  if (passphrase !== confirm) {
    throw new Error(
      `Passphrases do not match (${passphrase.length} vs ${confirm.length} characters). ` +
        'Nothing was written.',
    );
  }

  await writeVault(phrase, passphrase, resolved);

  // eslint-disable-next-line no-console
  console.log(
    [
      '',
      `✓ Vault written: ${resolved}`,
      '',
      '  Add to .env:',
      `    BUY_WALLET_VAULT_PATH=${resolved}`,
      '    BUY_WALLET_PASSPHRASE=<the passphrase you just chose>',
      '',
      '  Then restart the application. Set a markup and profit address under',
      '  Admin → Buy settings before any customer uses "Generate tokens" —',
      '  markup does nothing until a profit address is set.',
      '',
    ].join('\n'),
  );
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(`\n✗ ${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
});
