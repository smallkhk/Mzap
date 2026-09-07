# Production deployment

Deploying the backend and admin dashboard. The desktop app is distributed as an
installer — see [BUILD-WINDOWS.md](BUILD-WINDOWS.md).

---

## Before you deploy

- [ ] `JWT_SECRET` is 48 bytes of real randomness, not a placeholder
- [ ] `REQUIRE_HTTPS=true`, with a valid certificate
- [ ] `ADMIN_ORIGINS` lists only your dashboard's origin
- [ ] `DATABASE_URL` uses `sslmode=require`
- [ ] `TESTNET_ONLY` is set deliberately — `false` only where real funds are intended
- [ ] The admin password is strong and unique
- [ ] Database backups are configured and a restore has been tested
- [ ] `.env` is not committed anywhere

---

## 1. Database

Any PostgreSQL 14+ works — RDS, Cloud SQL, Neon, Supabase, or self-hosted.

```bash
createdb flashsender
createuser flashsender --pwprompt
psql -c "GRANT ALL PRIVILEGES ON DATABASE flashsender TO flashsender;"
```

Apply migrations (never `migrate dev` in production — it can prompt and reset):

```bash
cd backend
DATABASE_URL="postgresql://…" npx prisma migrate deploy
```

Back up on a schedule and verify restores:

```bash
pg_dump "$DATABASE_URL" | gzip > "backup-$(date +%F).sql.gz"
```

The audit log grows over time. If it becomes large, archive rows older than a
retention period you have decided on — do not silently delete them.

---

## 2. Backend

### Environment

```bash
NODE_ENV=production
PORT=4000
DATABASE_URL=postgresql://user:pass@host:5432/flashsender?sslmode=require
JWT_SECRET=<node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))">
ACCESS_TOKEN_TTL=15m
REFRESH_TOKEN_TTL_DAYS=7
ADMIN_ORIGINS=https://admin.yourdomain.com
REQUIRE_HTTPS=true
TRUST_PROXY=true
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX=120
AUTH_RATE_LIMIT_MAX=10
LOG_LEVEL=info
TESTNET_ONLY=false
```

Store these in your platform's secret manager, not in a file in the repo.

### Build and run

```bash
cd backend
npm ci --omit=dev
npx prisma generate
npm run build
node dist/index.js
```

### systemd

```ini
# /etc/systemd/system/flash-sender.service
[Unit]
Description=Flash Sender backend
After=network.target postgresql.service

[Service]
Type=simple
User=flashsender
WorkingDirectory=/opt/flash-sender/backend
EnvironmentFile=/etc/flash-sender/backend.env
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=5

# Hardening
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/flash-sender/backend

[Install]
WantedBy=multi-user.target
```

```bash
sudo chmod 600 /etc/flash-sender/backend.env
sudo systemctl enable --now flash-sender
sudo journalctl -u flash-sender -f
```

### Docker

```dockerfile
# backend/Dockerfile
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY prisma ./prisma
RUN npx prisma generate
COPY . .
RUN npm run build

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
USER node
EXPOSE 4000
CMD ["node", "dist/index.js"]
```

---

## 3. TLS

The desktop client **refuses a non-HTTPS backend URL** (except loopback), so TLS
is not optional.

```nginx
server {
    listen 443 ssl http2;
    server_name api.yourdomain.com;

    ssl_certificate     /etc/letsencrypt/live/api.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/api.yourdomain.com/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;

    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;

    location / {
        proxy_pass http://127.0.0.1:4000;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}

server {
    listen 80;
    server_name api.yourdomain.com;
    return 301 https://$host$request_uri;
}
```

Set `TRUST_PROXY=true` so `X-Forwarded-Proto` is honoured and rate limiting sees
real client IPs. Without it every request appears to come from the proxy and the
limiter becomes useless.

---

## 4. Admin dashboard

Static files — any static host works.

```bash
cd admin
echo "VITE_API_BASE_URL=https://api.yourdomain.com" > .env.production
npm ci && npm run build
# deploy admin/dist/
```

```nginx
server {
    listen 443 ssl http2;
    server_name admin.yourdomain.com;
    root /var/www/flash-sender-admin;

    add_header X-Frame-Options DENY always;
    add_header X-Content-Type-Options nosniff always;
    add_header Referrer-Policy no-referrer always;

    location / { try_files $uri /index.html; }
}
```

Its origin must appear in the backend's `ADMIN_ORIGINS`.

Consider restricting the dashboard further — IP allow-list, VPN, or an
authenticating proxy in front. It is the control surface for which contract
addresses your users' money is sent to.

---

## 5. First-run setup

```bash
cd backend

# Administrator (password is prompted, never in argv)
npm run create-admin -- --email you@yourdomain.com --role ADMIN

# A key per desktop installation
npm run create-api-key -- --name "Workstation 1"
```

Then, in the dashboard: add your networks, add your assets, and **test each new
asset with a tiny amount before relying on it**.

---

## 6. Monitoring

- `GET /health` — returns `503` when the database is unreachable. Point your
  uptime check here.
- Logs are JSON (pino) with key material redacted. Ship them somewhere durable.
- Watch the audit log for unexpected `asset.update` / `asset.create` entries —
  an unexplained change to a contract address is the single most important
  signal this system produces.

---

## 7. Upgrades

```bash
git pull
cd backend
npm ci --omit=dev
npx prisma migrate deploy      # back up first
npm run build
sudo systemctl restart flash-sender
```

Desktop clients are versioned independently. Because assets are backend-driven,
most changes need no client update at all — that is the point of the design.

---

## 8. Rotating credentials

**JWT secret** — changing `JWT_SECRET` invalidates every admin session
immediately; everyone signs in again. No data is lost.

**A desktop API key** — issue a new one, put it in that installation's Settings,
then revoke the old one in the dashboard.

**Compromised admin account** — disable the account, rotate `JWT_SECRET` to kill
its sessions, then review the audit log for every change it made, paying
particular attention to contract addresses.
