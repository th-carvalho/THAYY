const crypto = require('crypto');
const {httpError, getCatalog} = require('./_lib/lucromais');
const {PARCELAS_MAX, FRETE_GRATIS_ACIMA, UFS, calcularFrete, configPublica} = require('./_lib/loja');
const {createPreference} = require('./_lib/mercadopago');

const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX = 10;
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

const MAX_ITENS = 20;
const MAX_POR_ITEM = 10;

const digits = v => String(v ?? '').replace(/\D/g, '');
const text = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

function cpfValido(cpf) {
  if (cpf.length !== 11 || /^(\d)\1{10}$/.test(cpf)) return false;
  for (const size of [9, 10]) {
    let sum = 0;
    for (let i = 0; i < size; i++) sum += Number(cpf[i]) * (size + 1 - i);
    if ((sum * 10) % 11 % 10 !== Number(cpf[size])) return false;
  }
  return true;
}

function validarCliente(body) {
  const cliente = body.cliente || {};
  const endereco = body.endereco || {};
  const retirada = body.retirada === true;
  const dados = {
    nome: text(cliente.nome, 120),
    email: text(cliente.email, 120).toLowerCase(),
    cpf: digits(cliente.cpf),
    telefone: digits(cliente.telefone),
    retirada,
    cep: retirada ? '' : digits(endereco.cep),
    rua: retirada ? '' : text(endereco.rua, 120),
    numero: retirada ? '' : text(endereco.numero, 20),
    complemento: retirada ? '' : text(endereco.complemento, 60),
    bairro: retirada ? '' : text(endereco.bairro, 80),
    cidade: retirada ? '' : text(endereco.cidade, 80),
    uf: retirada ? '' : text(endereco.uf, 2).toUpperCase(),
  };
  if (dados.nome.split(' ').length < 2) throw httpError(400, 'Informe seu nome completo.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(dados.email)) throw httpError(400, 'Informe um email válido.');
  if (!cpfValido(dados.cpf)) throw httpError(400, 'Informe um CPF válido.');
  if (dados.telefone.length < 10 || dados.telefone.length > 11) throw httpError(400, 'Informe um celular com DDD.');
  if (!retirada) {
    if (dados.cep.length !== 8) throw httpError(400, 'Informe um CEP válido.');
    if (!dados.rua || !dados.numero || !dados.bairro || !dados.cidade) throw httpError(400, 'Preencha o endereço de entrega completo.');
    if (!UFS.includes(dados.uf)) throw httpError(400, 'Selecione o estado de entrega.');
  }
  return dados;
}

async function montarItens(itensPedido) {
  if (!Array.isArray(itensPedido) || !itensPedido.length) throw httpError(400, 'Sua sacola está vazia.');
  if (itensPedido.length > MAX_ITENS) throw httpError(400, 'Pedido com itens demais.');

  const catalogo = await getCatalog({fresh: true});
  const porVariacao = new Map();
  catalogo.forEach(p => p.variacoes.forEach(v => porVariacao.set(Number(v.id), {produto: p, variacao: v})));

  const quantidades = new Map();
  for (const item of itensPedido) {
    const id = Number(item.variacao_id);
    const qty = Number(item.quantidade);
    if (!Number.isSafeInteger(id) || !Number.isSafeInteger(qty) || qty < 1) throw httpError(400, 'Item inválido na sacola.');
    quantidades.set(id, (quantidades.get(id) || 0) + qty);
  }

  const indisponiveis = [];
  const itens = [];
  for (const [id, quantidade] of quantidades) {
    const found = porVariacao.get(id);
    if (!found) { indisponiveis.push({variacao_id: id, disponivel: 0}); continue; }
    const {produto, variacao} = found;
    const limite = Math.min(MAX_POR_ITEM, variacao.estoque === null ? MAX_POR_ITEM : variacao.estoque);
    if (quantidade > limite) { indisponiveis.push({variacao_id: id, disponivel: limite}); continue; }
    const detalhe = [variacao.cor, variacao.tamanho].filter(Boolean).join(' / ');
    itens.push({
      variacao_id: id,
      roupa_id: produto.id,
      quantidade,
      preco: produto.preco,
      nome: detalhe ? `${produto.nome} — ${detalhe}` : produto.nome,
      foto: variacao.fotos[0] || produto.foto_url || '',
    });
  }

  if (indisponiveis.length) {
    const error = httpError(409, 'Algumas peças da sua sacola acabaram de esgotar ou têm menos unidades disponíveis. Revise sua sacola.');
    error.indisponiveis = indisponiveis;
    throw error;
  }
  if (itens.some(i => !(i.preco > 0))) throw httpError(409, 'Uma das peças está sem preço cadastrado. Fale conosco pelo WhatsApp.');
  return itens;
}

function siteUrl(req) {
  if (process.env.SITE_URL) return process.env.SITE_URL.replace(/\/$/, '');
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `https://${host}`;
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'GET') {
    const {cep, subtotal: subtotalStr, uf} = req.query;
    if (cep && digits(cep).length === 8) {
      const subtotalVal = parseFloat(subtotalStr) || 0;
      const freteFixo = calcularFrete(String(uf || '').toUpperCase(), subtotalVal);
      return res.status(200).json({
        opcoes: [{id: 0, nome: freteFixo.gratis ? 'Frete Grátis' : freteFixo.regiao, preco: freteFixo.valor, prazo: freteFixo.prazo, gratis: freteFixo.gratis}],
      });
    }
    return res.status(200).json(configPublica());
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({error: 'Método não permitido.'});
  }

  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket?.remoteAddress || 'unknown';
  if (!checkRateLimit(ip)) return res.status(429).json({error: 'Muitas tentativas. Aguarde um momento e tente novamente.'});

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const cliente = validarCliente(body);
    const itens = await montarItens(body.itens);
    const subtotal = Math.round(itens.reduce((s, i) => s + i.preco * i.quantidade, 0) * 100) / 100;

    let frete;
    if (cliente.retirada) {
      frete = {valor: 0, regiao: 'Retirada na loja', prazo: '', gratis: true};
    } else {
      const freteFixo = calcularFrete(cliente.uf, subtotal);
      frete = freteFixo;
    }

    const pedido = `THF-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
    const base = siteUrl(req);
    const [primeiroNome, ...sobrenome] = cliente.nome.split(' ');
    const enderecoTexto = cliente.retirada
      ? 'Retirada na loja'
      : [`${cliente.rua}, ${cliente.numero}`, cliente.complemento, cliente.bairro, `${cliente.cidade}/${cliente.uf}`, `CEP ${cliente.cep.replace(/(\d{5})(\d{3})/, '$1-$2')}`].filter(Boolean).join(' - ');

    const preference = await createPreference({
      external_reference: pedido,
      statement_descriptor: 'THAYYFASHION',
      items: itens.map(item => ({
        id: String(item.variacao_id),
        title: item.nome.slice(0, 250),
        quantity: item.quantidade,
        unit_price: item.preco,
        currency_id: 'BRL',
        category_id: 'fashion',
        ...(item.foto ? {picture_url: item.foto} : {}),
      })),
      shipments: {mode: 'not_specified', cost: frete.valor},
      payer: {
        name: primeiroNome,
        surname: sobrenome.join(' '),
        email: cliente.email,
        phone: {area_code: cliente.telefone.slice(0, 2), number: cliente.telefone.slice(2)},
        identification: {type: 'CPF', number: cliente.cpf},
        address: {zip_code: cliente.cep, street_name: cliente.rua, street_number: cliente.numero},
      },
      payment_methods: {installments: PARCELAS_MAX, excluded_payment_types: [{id: 'ticket'}]},
      back_urls: {
        success: `${base}/?pedido=aprovado&ref=${pedido}`,
        pending: `${base}/?pedido=pendente&ref=${pedido}`,
        failure: `${base}/?pedido=recusado&ref=${pedido}`,
      },
      auto_return: 'approved',
      notification_url: `${base}/api/mp-webhook?source_news=webhooks`,
      expires: true,
      expiration_date_to: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
      metadata: {
        pedido,
        frete: frete.valor,
        nome_cliente: cliente.nome,
        endereco: enderecoTexto,
        cliente: `${cliente.nome} · CPF ${cliente.cpf} · Tel ${cliente.telefone} · ${cliente.email}`,
        itens: itens.map(i => ({v: i.variacao_id, r: i.roupa_id, q: i.quantidade, p: i.preco, n: i.nome.slice(0, 120)})),
      },
    }, pedido);

    return res.status(200).json({pedido, url: preference.init_point});
  } catch (error) {
    const status = Number.isInteger(error.status) ? error.status : 500;
    if (status >= 500) console.error('[Checkout]', error);
    return res.status(status).json({
      error: status >= 500 && !error.status ? 'Não foi possível iniciar o pagamento. Tente novamente.' : error.message,
      ...(error.indisponiveis ? {indisponiveis: error.indisponiveis} : {}),
    });
  }
};
