const { sql } = require('@vercel/postgres');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY)
    return res.status(401).json({ error: 'Unauthorized' });

  try {
    await sql`
      CREATE TABLE IF NOT EXISTS users (
        id            SERIAL PRIMARY KEY,
        username      TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        is_active     BOOLEAN DEFAULT TRUE,
        tier          TEXT DEFAULT 'premium',
        expires_at    TIMESTAMPTZ,
        last_login    TIMESTAMPTZ,
        created_at    TIMESTAMPTZ DEFAULT NOW()
      )
    `;

    await sql`
      CREATE TABLE IF NOT EXISTS tokens (
        id         SERIAL PRIMARY KEY,
        token      TEXT UNIQUE NOT NULL,
        user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
        expires_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `;

    return res.json({ ok: true, message: 'Tables created' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
};
