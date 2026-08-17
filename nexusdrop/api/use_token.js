const { sql } = require('@vercel/postgres');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ success: false, message: 'Method not allowed' });

  const body  = req.body || {};
  const token = (body.token || '').toString().trim();

  if (!token)
    return res.json({ success: false, message: 'No token provided' });

  try {
    const { rows } = await sql`
      SELECT t.id, t.uses_left, t.expires_at, u.is_active
      FROM tokens t
      JOIN users u ON u.id = t.user_id
      WHERE t.token = ${token}
      LIMIT 1
    `;

    if (!rows.length)
      return res.json({ success: false, message: 'Invalid token' });

    if (!rows[0].is_active)
      return res.json({ success: false, message: 'Account disabled' });

    if (rows[0].expires_at && new Date(rows[0].expires_at) < new Date())
      return res.json({ success: false, message: 'Token expired' });

    const tokensLeft = rows[0].uses_left ?? 999;

    await sql`UPDATE tokens SET uses_left = GREATEST(uses_left - 1, 0) WHERE id = ${rows[0].id}`;

    return res.json({
      success:      true,
      tokens_left:  tokensLeft,
      message:      'Token valid',
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};
