const { sql } = require('@vercel/postgres');
const crypto  = require('crypto');

function checkAuth(req) {
  return req.headers['x-admin-key'] === process.env.ADMIN_KEY;
}

function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!checkAuth(req)) return res.status(401).json({ error: 'Unauthorized' });

  try {
    if (req.method === 'GET') {
      const { rows } = await sql`
        SELECT id, username, is_active, tier, expires_at, last_login, created_at
        FROM users ORDER BY id DESC
      `;
      return res.json({ users: rows });
    }

    if (req.method === 'POST') {
      const { action, username, password, tier, expires, id } = req.body || {};

      if (action === 'create') {
        if (!username || !password)
          return res.status(400).json({ error: 'username and password required' });
        const t = (tier || 'premium').toLowerCase();
        await sql`
          INSERT INTO users (username, password_hash, tier, expires_at)
          VALUES (
            ${username.toLowerCase().trim()},
            ${hashPassword(password)},
            ${t},
            ${expires || null}
          )
        `;
        return res.json({ ok: true });
      }

      if (action === 'toggle') {
        await sql`UPDATE users SET is_active = NOT is_active WHERE id = ${id}`;
        return res.json({ ok: true });
      }

      if (action === 'reset_password') {
        if (!password) return res.status(400).json({ error: 'password required' });
        await sql`UPDATE users SET password_hash = ${hashPassword(password)} WHERE id = ${id}`;
        return res.json({ ok: true });
      }

      if (action === 'set_tier') {
        const t = (tier || 'premium').toLowerCase();
        await sql`UPDATE users SET tier = ${t} WHERE id = ${id}`;
        return res.json({ ok: true });
      }
    }

    if (req.method === 'DELETE') {
      const { id } = req.body || {};
      await sql`DELETE FROM users WHERE id = ${id}`;
      return res.json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
};
