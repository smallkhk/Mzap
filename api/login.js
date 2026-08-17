const { sql } = require('@vercel/postgres');
const crypto  = require('crypto');

function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ valid: false, reason: 'Method not allowed' });

  const body     = req.body || {};
  const username = (body.username || '').toString().trim().toLowerCase();
  const password = (body.password || '').toString().trim();

  if (!username || !password)
    return res.json({ valid: false, reason: 'Username and password required' });

  try {
    const hash = hashPassword(password);
    const { rows } = await sql`
      SELECT id, is_active, expires_at, tier
      FROM users
      WHERE username = ${username}
        AND password_hash = ${hash}
      LIMIT 1
    `;

    if (!rows.length)
      return res.json({ valid: false, reason: 'Invalid username or password' });

    if (!rows[0].is_active)
      return res.json({ valid: false, reason: 'Account disabled' });

    if (rows[0].expires_at && new Date(rows[0].expires_at) < new Date())
      return res.json({ valid: false, reason: 'License expired' });

    const token = crypto.randomBytes(24).toString('hex');
    const farFuture = '2099-12-31T00:00:00Z';

    await sql`UPDATE users SET last_login = NOW() WHERE id = ${rows[0].id}`;
    await sql`
      INSERT INTO tokens (token, user_id, expires_at)
      VALUES (${token}, ${rows[0].id}, ${farFuture})
      ON CONFLICT DO NOTHING
    `;

    return res.json({
      valid:             true,
      tier:              rows[0].tier || 'premium',
      LicenseExpiresAt:  farFuture,
      Token_Expires_At:  farFuture,
      Encrypted_Payload: token,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ valid: false, reason: 'Server error' });
  }
};
