const { sql } = require('@vercel/postgres');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ valid: false, reason: 'Method not allowed' });

  const body  = req.body || {};
  const token = (body.token || body.Encrypted_Payload || '').toString().trim();

  if (!token)
    return res.json({ valid: false, reason: 'No token provided' });

  try {
    const { rows } = await sql`
      SELECT t.token, t.expires_at, u.tier, u.is_active
      FROM tokens t
      JOIN users u ON u.id = t.user_id
      WHERE t.token = ${token}
      LIMIT 1
    `;

    if (!rows.length)
      return res.json({ valid: false, reason: 'Invalid token' });

    if (!rows[0].is_active)
      return res.json({ valid: false, reason: 'Account disabled' });

    if (rows[0].expires_at && new Date(rows[0].expires_at) < new Date())
      return res.json({ valid: false, reason: 'Token expired' });

    return res.json({
      valid:            true,
      tier:             rows[0].tier || 'premium',
      LicenseExpiresAt: '2099-12-31T00:00:00Z',
      Token_Expires_At: '2099-12-31T00:00:00Z',
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ valid: false, reason: 'Server error' });
  }
};
