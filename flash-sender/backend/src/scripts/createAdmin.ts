/**
 * Creates (or resets) an administrator account.
 *
 *   npm run create-admin -- --email you@example.com --role ADMIN
 *
 * The password is read interactively and never taken from argv, so it does not
 * land in your shell history or the process table.
 */
import readline from 'node:readline';
import { AdminRole } from '@prisma/client';
import { prisma } from '../lib/db';
import { hashPassword } from '../lib/crypto';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  const value = index === -1 ? undefined : process.argv[index + 1];
  // A missing space ("--email a@b.com--role ADMIN") makes the next flag part of
  // the value; catching it here beats creating an account with a junk email.
  if (value?.startsWith('--')) return undefined;
  return value;
}

/** Plain, echoed prompt. Uses one interface and closes it immediately. */
function askVisible(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * Reads a secret without echoing it.
 *
 * This drives stdin directly in raw mode rather than going through readline.
 * The previous implementation overrode readline's private `_writeToOutput` and
 * built a new interface per prompt, which could drop or misattribute keystrokes
 * between the two password prompts — producing a "passwords do not match" error
 * even when the same thing was typed twice.
 *
 * Each character echoes as `*` so the length is visible while the value is not.
 */
function askSecret(question: string): Promise<string> {
  const stdin = process.stdin;

  // Not a terminal (piped input, some CI shells): fall back to a visible read
  // rather than hanging, and say so.
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
            // Ignore other control characters (arrow keys arrive as escapes).
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

function assertStrong(password: string) {
  const problems: string[] = [];
  if (password.length < 12) problems.push('be at least 12 characters long');
  if (!/[a-z]/.test(password)) problems.push('include a lowercase letter');
  if (!/[A-Z]/.test(password)) problems.push('include an uppercase letter');
  if (!/[0-9]/.test(password)) problems.push('include a digit');

  if (problems.length) {
    throw new Error(`Password must ${problems.join(', ')}.`);
  }
}

async function main() {
  const email = (arg('email') ?? (await askVisible('Admin email: '))).trim().toLowerCase();

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new Error(
      `"${email}" is not a valid email address. If you passed --email, check there is a space ` +
        'before the next option.',
    );
  }

  const roleInput = (arg('role') ?? 'ADMIN').toUpperCase();
  if (!Object.values(AdminRole).includes(roleInput as AdminRole)) {
    throw new Error(`Role must be one of: ${Object.values(AdminRole).join(', ')}`);
  }

  const password = await askSecret('Password (hidden, shown as *): ');
  assertStrong(password);

  const confirm = await askSecret('Confirm password: ');

  if (password !== confirm) {
    throw new Error(
      `Passwords do not match (${password.length} vs ${confirm.length} characters). ` +
        'Nothing was changed — run the command again.',
    );
  }

  const passwordHash = await hashPassword(password);

  const user = await prisma.adminUser.upsert({
    where: { email },
    update: { passwordHash, role: roleInput as AdminRole, isActive: true },
    create: { email, passwordHash, role: roleInput as AdminRole },
  });

  // eslint-disable-next-line no-console
  console.log(`\n✓ Administrator ready: ${user.email} (${user.role})`);
}

main()
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error(`\n✗ ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
