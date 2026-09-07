/**
 * Entry point for Passenger-based hosts (cPanel "Setup Node.js App").
 *
 * cPanel asks for an "Application startup file" at the project root and starts
 * it with Passenger, which supplies its own listening socket — so the PORT in
 * .env is ignored there, which is expected and fine.
 *
 * Run `npm run build` before starting: this only loads the compiled output.
 */
const path = require('node:path');
const fs = require('node:fs');

const entry = path.join(__dirname, 'dist', 'index.js');

if (!fs.existsSync(entry)) {
  // eslint-disable-next-line no-console
  console.error(
    'dist/index.js is missing. Run "npm run build" (which compiles TypeScript) ' +
      'before starting the application.',
  );
  process.exit(1);
}

require(entry);
