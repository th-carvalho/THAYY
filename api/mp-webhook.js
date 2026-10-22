const {findVendaByMarker, createVenda} = require('./_lib/lucromais');
const {getPayment, refundPayment, webhookSignatureValid, formaPagamento} = require('./_lib/mercadopago');

async function registrarVenda(payment) {
  const marker = `MP ${payment.id}`;
  const since = new Date(new Date(payment.date_created || Date.now()).getTime() - 24 * 60 * 60 * 1000);
  if (await findVendaByMarker(marker, since)) return {status: 'ja_registrada'};

  const meta = payment.metadata || {};
  const itens = Array.isArray(meta.itens) ? meta.itens : [];
  if (!itens.length) return {status: 'sem_itens'};

  const venda = {
    forma_pagamento: formaPagamento(payment),
    parcelas: Number(payment.installments) || 1,
    valor_total: Number(payment.transaction_amount).toFixed(2),
    taxa_entrega: Number(meta.frete) || 0,
    endereco_entrega: String(meta.endereco || '').slice(0, 500),
    observacao: [`Pedido site ${meta.pedido || payment.external_reference}`, marker, meta.cliente].filter(Boolean).join(' · '),
    itens: itens.map(item => ({
      tipo: 'roupa',
      variacao_id: Number(item.v),
      roupa_id: Number(item.r),
      quantidade: Number(item.q),
      valor_unitario: Number(item.p),
      nome_item: item.n,
    })),
  };

  try {
    await createVenda(venda);
    return {status: 'registrada'};
  } catch (error) {
    if (!error.semEstoque) throw error;
    console.error('[Webhook] Estoque insuficiente, estornando pagamento', payment.id, error.message);
    await refundPayment(payment.id);
    return {status: 'estornado'};
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({error: 'Método não permitido.'});
  }

  let body = {};
  try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}); } catch { return res.status(400).json({error: 'Payload inválido.'}); }

  const tipo = body.type || req.query.type || req.query.topic;
  const paymentId = (body.data && body.data.id) || req.query['data.id'] || req.query.id;
  if (tipo !== 'payment' || !paymentId) return res.status(200).json({ignorado: true});
  if (!webhookSignatureValid(req, req.query['data.id'] || paymentId)) return res.status(401).json({error: 'Assinatura inválida.'});

  try {
    const payment = await getPayment(paymentId);
    if (payment.status !== 'approved') return res.status(200).json({status: payment.status});
    const result = await registrarVenda(payment);
    return res.status(200).json(result);
  } catch (error) {
    console.error('[Webhook] Falha ao processar pagamento', paymentId, error.message);
    return res.status(500).json({error: 'Falha temporária ao processar o pagamento.'});
  }
};
