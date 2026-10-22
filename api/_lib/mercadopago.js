const crypto = require('crypto');
const {httpError} = require('./lucromais');

const MP_API = 'https://api.mercadopago.com';

function accessToken() {
  const token = process.env.MP_ACCESS_TOKEN;
  if (!token) throw httpError(503, 'O pagamento online está em fase final de ativação. Tente novamente em breve.');
  return token;
}

async function mpFetch(path, {method = 'GET', body, idempotencyKey} = {}) {
  let response;
  try {
    response = await fetch(`${MP_API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${accessToken()}`,
        Accept: 'application/json',
        ...(body ? {'Content-Type': 'application/json'} : {}),
        ...(idempotencyKey ? {'X-Idempotency-Key': idempotencyKey} : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (error) {
    if (error.status) throw error;
    throw httpError(502, 'Não foi possível conectar ao Mercado Pago.');
  }
  let result = {};
  try { result = await response.json(); } catch {}
  if (!response.ok) {
    console.error('[Mercado Pago]', method, path, response.status, JSON.stringify(result).slice(0, 500));
    throw httpError(502, 'O Mercado Pago recusou a operação. Tente novamente em instantes.');
  }
  return result;
}

const createPreference = (preference, idempotencyKey) => mpFetch('/checkout/preferences', {method: 'POST', body: preference, idempotencyKey});
const getPayment = id => mpFetch(`/v1/payments/${encodeURIComponent(id)}`);
const refundPayment = id => mpFetch(`/v1/payments/${encodeURIComponent(id)}/refunds`, {method: 'POST', body: {}, idempotencyKey: `refund-${id}`});

function webhookSignatureValid(req, dataId) {
  const secret = process.env.MP_WEBHOOK_SECRET;
  if (!secret) return true;
  const header = String(req.headers['x-signature'] || '');
  const parts = Object.fromEntries(header.split(',').map(p => p.trim().split('=')));
  if (!parts.ts || !parts.v1) return false;
  const ts = Number(parts.ts);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) return false;
  const requestId = req.headers['x-request-id'];
  let manifest = `id:${String(dataId).toLowerCase()};`;
  if (requestId) manifest += `request-id:${requestId};`;
  manifest += `ts:${parts.ts};`;
  const expected = crypto.createHmac('sha256', secret).update(manifest).digest('hex');
  return expected.length === parts.v1.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(parts.v1));
}

function formaPagamento(payment) {
  if (payment.payment_method_id === 'pix' || payment.payment_type_id === 'bank_transfer') return 'pix';
  if (payment.payment_type_id === 'credit_card') return 'credito';
  if (payment.payment_type_id === 'debit_card' || payment.payment_type_id === 'prepaid_card') return 'debito';
  return 'link';
}

module.exports = {createPreference, getPayment, refundPayment, webhookSignatureValid, formaPagamento};
