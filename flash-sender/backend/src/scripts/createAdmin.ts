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
  return index === -1 ? undefined : process.argv[index + 1];
}

function prompt(question: string, mask = false): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });

  return new Promise((resolve) => {
    if (mask) {
      const stdout = process.stdout as NodeJS.WriteStream & { muted?: boolean };
      // Suppress echo while the password is typed.
      const originalWrite = stdout.write.bind(stdout);
      (rl as any)._writeToOutput = (str: string) => {
        if (str.includes(question)) originalWrite(str);
      };
      rl.question(question, (answer) => {
        originalWrite('\n');
        rl.close();
        resolve(answer);
      });
      return;
    }
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
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
  const email = (arg('email') ?? (await prompt('Admin email: '))).trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error(`"${email}" is not a valid email.`);

  const roleInput = (arg('role') ?? 'ADMIN').toUpperCase();
  if (!Object.values(AdminRole).includes(roleInput as AdminRole)) {
    throw new Error(`Role must be one of: ${Object.values(AdminRole).join(', ')}`);
  }

  const password = await prompt('Password (input hidden): ', true);
  const confirm = await prompt('Confirm password: ', true);

  if (password !== confirm) throw new Error('Passwords do not match.');
  assertStrong(password);

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
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
