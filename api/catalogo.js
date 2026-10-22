const {getCatalog} = require('./_lib/lucromais');

const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX = 30;
const rateBuckets = new Map();
function checkRateLimit(ip) {
  const now = Date.now();
  const bucket = rateBuckets.get(ip) || {count: 0, resetAt: now + RATE_WINDOW_MS};
  if (now > bucket.resetAt) { bucket.count = 0; bucket.resetAt = now + RATE_WINDOW_MS; }
  bucket.count += 1;
  rateBuckets.set(ip, bucket);
  if (rateBuckets.size > 5000) {
    for (const [key, val] of rateBuckets) { if (now > val.resetAt) rateBuckets.delete(key); }
  }
  return bucket.count <= RATE_MAX;
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({error: 'Método não permitido.'});
  }

  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket?.remoteAddress || 'unknown';
  if (!checkRateLimit(ip)) return res.status(429).json({error: 'Muitas requisições. Aguarde um momento.'});

  try {
    const catalog = await getCatalog();
    res.setHeader('Cache-Control', 'public, s-maxage=180, stale-while-revalidate=60');
    return res.status(200).json(catalog);
  } catch (error) {
    const status = Number.isInteger(error.status) ? error.status : 502;
    return res.status(status).json({error: error.message || 'Falha ao consultar o estoque.'});
  }
};
