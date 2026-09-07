# Deploying to cPanel

Written for **`send.eclipselivecam.online`** — substitute your own subdomain if
it differs.

When you finish, that one URL serves both:

- `https://send.eclipselivecam.online/` — the admin dashboard
- `https://send.eclipselivecam.online/api/...` — the API the desktop app calls

Serving both from one origin is deliberate: one certificate, no CORS to
configure, and one thing to keep running.

---

## What you need

- cPanel with **Setup Node.js App** (Software section). Node 20 if offered.
- **MySQL Databases** (MariaDB is what most hosts run; both work).
- **SSL/TLS Status** with AutoSSL — the desktop app refuses a plain-HTTP
  backend, so this is required, not optional.

---

## 1. Create the subdomain

**Domains → Create A New Domain**

| Field | Value |
|---|---|
| Domain | `send.eclipselivecam.online` |
| Document Root | `/home/USER/send.eclipselivecam.online` |

Note the document root — you need it in step 4.

## 2. Issue the certificate

**SSL/TLS Status** → tick the new subdomain → **Run AutoSSL**.

Wait until it shows a valid certificate before continuing. Confirm
`https://send.eclipselivecam.online` loads without a browser warning.

## 3. Create the database

**Databases → MySQL Database Wizard**

1. Database name: `flashsender` → cPanel prefixes it, giving something like
   `eclipse_flashsender`
2. Username: `flashuser` → becomes `eclipse_flashuser`
3. Use a long generated password. **Write down all three values.**
4. Privileges: **ALL PRIVILEGES**

> Note the real names cPanel gives you — they include the account prefix, and
> the connection string needs the prefixed versions.

## 4. Upload the code

Via **Git Version Control** (Files section) if your host offers it:

- Clone URL: `https://github.com/smallkhk/Mzap.git`
- Repository Path: `/home/USER/flash-sender-src`

Then check out the branch in **Terminal**:

```bash
cd ~/flash-sender-src
git checkout claude/flash-sender-windows-app-zu3zmm
```

No Git in cPanel? Download the repo as a ZIP, upload it via **File Manager**,
and extract it to `~/flash-sender-src`.

## 5. Build the admin dashboard

In **Terminal**:

```bash
cd ~/flash-sender-src/flash-sender/admin

# --production=false is required: cPanel's npm config forces production mode,
# which omits devDependencies — and vite lives there.
npm install --prefix "$PWD" --production=false
npm run build --prefix "$PWD"
```

`build` runs Vite only. Typechecking is a separate `npm run typecheck`, because
Vite strips types with esbuild and never needs them — tying the two together
would mean a host that declines to install devDependencies could not build at
all.

This produces `admin/dist/`, which the backend serves in step 8. Nothing needs
to go into `public_html`.

> No Terminal on your plan? Build it on your Windows PC (`npm install && npm run
> build` in `flash-sender\admin`) and upload the resulting `dist` folder to
> `~/flash-sender-src/flash-sender/admin/dist`.

## 6. Create the Node.js application

**Software → Setup Node.js App → Create Application**

| Field | Value |
|---|---|
| Node.js version | 20.x (highest available) |
| Application mode | Production |
| Application root | `flash-sender-src/flash-sender/backend` |
| Application URL | `send.eclipselivecam.online` |
| Application startup file | `app.js` |

Click **Create**. Leave the page open — you need it again in step 9.

## 7. Configure the environment

In **Terminal**:

```bash
cd ~/flash-sender-src/flash-sender/backend
cp .env.example .env

# Generate a real signing secret:
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

Edit `.env` (File Manager → Edit, or `nano .env`):

```bash
NODE_ENV=production
PORT=4000                       # ignored by Passenger; harmless

DATABASE_URL="mysql://eclipse_flashuser:YOUR_PASSWORD@localhost:3306/eclipse_flashsender"

JWT_SECRET=<the string you just generated>

# Serve the dashboard from this process, at the site root.
ADMIN_DIST_PATH=../admin/dist

# Passenger terminates TLS in front of the app.
REQUIRE_HTTPS=true
TRUST_PROXY=true

LOG_LEVEL=info

# Keep this true until you have tested end-to-end on a testnet.
TESTNET_ONLY=true
```

> If your database password contains `@ : / ? #` or `%`, URL-encode it in
> `DATABASE_URL` — `@` becomes `%40`. An un-encoded `@` silently breaks the
> connection string in a way whose error message won't point you here.

Because the dashboard is same-origin, `ADMIN_ORIGINS` is irrelevant — leave it.

## 8. Install, migrate, build

Still in Terminal:

```bash
cd ~/flash-sender-src/flash-sender/backend

# Use the Node from your cPanel app, not the system one. The exact command is
# shown at the top of the Setup Node.js App page — it looks like:
source /home/USER/nodevenv/flash-sender-src/flash-sender/backend/20/bin/activate

npm install                 # runs `prisma generate` automatically
npx prisma migrate deploy   # creates the tables
npm run build               # compiles TypeScript to dist/
npm run seed                # testnet networks + their native coins
```

`migrate deploy` is used rather than `migrate dev` on purpose: `dev` needs
permission to create a shadow database, which cPanel accounts do not have.
The migration file is committed to the repo, so `deploy` just applies it.

Then create your login and your app key:

```bash
npm run create-admin -- --email you@eclipselivecam.online --role ADMIN
npm run create-api-key -- --name "My Windows PC"
```

**Copy the `fsk_...` key now — it is shown once.**

## 9. Start it

Back on the **Setup Node.js App** page: **Restart**.

Check it:

```
https://send.eclipselivecam.online/health
```

You should see `{"status":"ok","version":...}`. Then open
`https://send.eclipselivecam.online/` and sign in with the admin account.

## 10. Point the desktop app at it

In Flash Sender → **Settings → Backend**:

| Field | Value |
|---|---|
| API base URL | `https://send.eclipselivecam.online` |
| API key | the `fsk_...` key from step 8 |

**Save**, then **Test connection**. It should report the configuration version.

---

## Updating later

```bash
cd ~/flash-sender-src
git pull
source /home/USER/nodevenv/.../20/bin/activate
cd flash-sender/admin && npm install && npm run build
cd ../backend && npm install && npx prisma migrate deploy && npm run build
```

Then **Restart** in Setup Node.js App.

Adding a *token* needs none of this — that is done in the dashboard and reaches
the desktop app on its next sync.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| 503 / "passenger application error" | Check the log at `~/flash-sender-src/flash-sender/backend/stderr.log`, or the Errors page in cPanel. Usually `dist/` is missing — run `npm run build`. |
| `P1001: Can't reach database server` | Wrong `DATABASE_URL`. Use the **prefixed** names (`eclipse_flashuser`), host `localhost`, and URL-encode the password. |
| `P1010: User denied access` | The database user was not granted ALL PRIVILEGES on the database. Redo that in MySQL Databases. |
| Dashboard loads but every request fails | The app is running but the API isn't reachable at `/api`. Confirm the Application URL is the domain root, not a subfolder. |
| Blank page at `/` | `ADMIN_DIST_PATH` is wrong or `admin/dist` was never built. The startup log says so explicitly — check `stderr.log`. |
| Desktop app: "backend URL must use https" | You entered `http://`. Use `https://send.eclipselivecam.online`. |
| Desktop app: "API key not recognised" | Key was revoked or mistyped. Issue a new one in the dashboard under **App keys**. |
| `prisma migrate dev` fails on shadow database | Expected on shared hosting. Use `npx prisma migrate deploy`. |
| `Prisma Client could not locate the Query Engine for runtime "debian-openssl-1.0.x"` | The host runs an older OpenSSL than the machine that generated the client. `schema.prisma` already declares the extra `binaryTargets`; re-run `npx prisma generate` so the matching engine is downloaded. |

### Reading logs

```bash
tail -50 ~/flash-sender-src/flash-sender/backend/stderr.log
```

Passenger writes startup failures there. Logs are JSON with key material
redacted.

---

## Before you enable mainnet

Shared hosting means other customers on the same machine, and cPanel accounts
are compromised often enough to plan around — usually via a weak password or a
stale plugin elsewhere on the account.

This backend decides **which contract addresses your app sends money to**.
Anyone who gets into it can repoint an asset at a contract they control, and
the desktop app will faithfully send there.

So before flipping `TESTNET_ONLY=false`:

- Turn on **two-factor authentication** for the cPanel account.
- Use a unique password for cPanel and a different one for the admin dashboard.
- Test the whole flow on a testnet first, and confirm a real transfer arrives.
- Check the dashboard's **Audit log** periodically. An `asset.update` you did
  not make is the signal that matters most.

For significant balances, put the backend on a VPS you control rather than
shared hosting, and use a hardware wallet as the sender.
