const FRETE_GRATIS_ACIMA = 199.00;
const PARCELAS_MAX = 6;

const REGIOES_FRETE = [
  {id: 'local',    nome: 'Paraíba',        ufs: ['PB'],                                       valor: 15.00, prazo: '2 a 4 dias úteis'},
  {id: 'nordeste', nome: 'Nordeste',        ufs: ['AL', 'BA', 'CE', 'MA', 'PE', 'PI', 'RN', 'SE'], valor: 22.00, prazo: '4 a 8 dias úteis'},
  {id: 'brasil',   nome: 'Demais estados', ufs: null,                                          valor: 35.00, prazo: '6 a 12 dias úteis'},
];

const UFS = ['AC','AL','AP','AM','BA','CE','DF','ES','GO','MA','MT','MS','MG','PA','PB','PR','PE','PI','RJ','RN','RS','RO','RR','SC','SP','SE','TO'];

function regiaoDaUf(uf) {
  return REGIOES_FRETE.find(r => r.ufs && r.ufs.includes(uf)) || REGIOES_FRETE[REGIOES_FRETE.length - 1];
}

function calcularFrete(uf, subtotal) {
  const regiao = regiaoDaUf(uf);
  const gratis = subtotal >= FRETE_GRATIS_ACIMA;
  return {regiao: regiao.nome, prazo: regiao.prazo, valor: gratis ? 0 : regiao.valor, gratis};
}

function configPublica() {
  return {
    freteGratisAcima: FRETE_GRATIS_ACIMA,
    parcelasMax: PARCELAS_MAX,
    regioes: REGIOES_FRETE.map(({nome, ufs, valor, prazo}) => ({nome, ufs, valor, prazo})),
    checkoutAtivo: Boolean(process.env.MP_ACCESS_TOKEN),
  };
}

module.exports = {PARCELAS_MAX, FRETE_GRATIS_ACIMA, UFS, calcularFrete, configPublica};
