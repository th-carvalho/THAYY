const API_BASE = 'https://lucromais-backend-mssolucoes.vercel.app/api';
const TOKEN_CACHE_MS = 6 * 24 * 60 * 60 * 1000;
const CATALOG_CACHE_MS = 3 * 60 * 1000;

let cachedToken;
let tokenExpiresAt = 0;
let tokenRequest;
let cachedCatalog;
let catalogExpiresAt = 0;

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

async function getToken(forceRefresh = false) {
  if (!forceRefresh && cachedToken && Date.now() < tokenExpiresAt) return cachedToken;
  if (tokenRequest) return tokenRequest;

  tokenRequest = (async () => {
    const email = process.env.LM_EMAIL;
    const senha = process.env.LM_SENHA;
    if (!email || !senha) throw httpError(503, 'Integração de estoque não configurada no servidor.');

    const body = {email, senha};
    if (process.env.LM_EMPRESA_ID) {
      const empresaId = Number(process.env.LM_EMPRESA_ID);
      if (!Number.isInteger(empresaId) || empresaId <= 0) throw httpError(503, 'LM_EMPRESA_ID precisa ser um número válido.');
      body.empresa_id = empresaId;
    }

    let response;
    try {
      response = await fetch(`${API_BASE}/auth/login`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json', Accept: 'application/json'},
        body: JSON.stringify(body),
      });
    } catch {
      throw httpError(502, 'Não foi possível conectar à API de estoque.');
    }

    if (!response.ok) throw httpError(502, 'A autenticação na API de estoque falhou.');

    let result;
    try { result = await response.json(); } catch { throw httpError(502, 'Resposta inválida da autenticação de estoque.'); }

    if (result.multiEmpresa) throw httpError(503, 'Configure LM_EMPRESA_ID com o identificador da empresa Thayy Fashion.');
    if (!result.token) throw httpError(502, 'A API de estoque não retornou um token.');

    cachedToken = result.token;
    tokenExpiresAt = Date.now() + TOKEN_CACHE_MS;
    return cachedToken;
  })();

  try { return await tokenRequest; } finally { tokenRequest = undefined; }
}

async function lmFetch(path, options = {}) {
  let token = await getToken();
  const send = () => fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {...options.headers, Authorization: `Bearer ${token}`, Accept: 'application/json'},
  });
  let response;
  try {
    response = await send();
    if (response.status === 401) {
      cachedToken = undefined;
      tokenExpiresAt = 0;
      token = await getToken(true);
      response = await send();
    }
  } catch (error) {
    if (error.status) throw error;
    throw httpError(502, 'Não foi possível conectar à API de estoque.');
  }
  return response;
}

function publicCatalog(roupas) {
  if (!Array.isArray(roupas)) throw httpError(502, 'Formato de catálogo inesperado na API de estoque.');
  return roupas.map(roupa => {
    const variacoes = (Array.isArray(roupa.variacoes) ? roupa.variacoes : [])
      .map(variacao => {
        const quantidade = Number(variacao.quantidade_atual) || 0;
        const estoqueInfinito = variacao.estoque_infinito === true;
        const fotos = (Array.isArray(variacao.fotos) ? variacao.fotos : [])
          .slice().sort((a, b) => (Number(a.ordem) || 0) - (Number(b.ordem) || 0))
          .map(foto => foto.foto_url).filter(url => typeof url === 'string' && url);
        return {
          id: variacao.id,
          cor: variacao.cor || '',
          tamanho: variacao.tamanho || '',
          disponivel: estoqueInfinito || quantidade > 0,
          estoque: estoqueInfinito ? null : quantidade,
          fotos,
        };
      }).filter(v => v.disponivel);
    return {
      id: roupa.id,
      nome: roupa.nome || '',
      codigo: roupa.codigo || '',
      tipo: roupa.tipo || '',
      genero: roupa.genero || '',
      marca: roupa.marca || '',
      preco: Number(roupa.preco_venda) || 0,
      foto_url: roupa.foto_url || '',
      variacoes,
    };
  }).filter(r => r.nome && r.variacoes.length > 0);
}

async function getCatalog({fresh = false} = {}) {
  if (!fresh && cachedCatalog && Date.now() < catalogExpiresAt) return cachedCatalog;
  const response = await lmFetch('/estoque-roupas');
  if (!response.ok) throw httpError(502, 'A API de estoque recusou a consulta.');
  let roupas;
  try { roupas = await response.json(); } catch { throw httpError(502, 'Resposta inválida da API de estoque.'); }
  cachedCatalog = publicCatalog(roupas);
  catalogExpiresAt = Date.now() + CATALOG_CACHE_MS;
  return cachedCatalog;
}

async function findVendaByMarker(marker, since) {
  const params = new URLSearchParams({dataInicio: since.toISOString()});
  const response = await lmFetch(`/vendas?${params}`);
  if (!response.ok) throw httpError(502, 'Não foi possível consultar as vendas no LucroMais.');
  const vendas = await response.json();
  return Array.isArray(vendas) ? vendas.find(v => String(v.observacao || '').includes(marker)) : undefined;
}

async function createVenda(venda) {
  const response = await lmFetch('/vendas', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(venda),
  });
  let result = {};
  try { result = await response.json(); } catch {}
  if (!response.ok) {
    const error = httpError(response.status, result.error || `LucroMais recusou a venda (HTTP ${response.status}).`);
    error.semEstoque = /estoque insuficiente|não encontrada/i.test(error.message);
    throw error;
  }
  cachedCatalog = undefined;
  return result;
}

module.exports = {httpError, getCatalog, findVendaByMarker, createVenda};
