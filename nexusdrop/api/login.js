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
  if (req.method !== 'POST') return res.status(405).json({ success: false, message: 'Method not allowed' });

  const body     = req.body || {};
  const username = (body.username || '').toString().trim().toLowerCase();
  const password = (body.password || '').toString().trim();

  if (!username || !password)
    return res.json({ success: false, message: 'Username and password required' });

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
      return res.json({ success: false, message: 'Invalid username or password' });

    if (!rows[0].is_active)
      return res.json({ success: false, message: 'Account disabled' });

    if (rows[0].expires_at && new Date(rows[0].expires_at) < new Date())
      return res.json({ success: false, message: 'License expired' });

    const farFuture = '2099-12-31T00:00:00Z';

    await sql`UPDATE users SET last_login = NOW() WHERE id = ${rows[0].id}`;

    return res.json({
      success:     true,
      expiry_date: farFuture,
      message:     'Login successful',
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};
