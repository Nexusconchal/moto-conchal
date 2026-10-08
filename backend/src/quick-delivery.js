export const QUICK_DELIVERY_REGIONS = Object.freeze({
  conchal: { label: 'Conchal — área urbana', fare: 6.5, appFee: 1.5 },
  martinho_prado: { label: 'Martinho Prado', fare: 16, appFee: 2 },
  tujuguaba: { label: 'Tujuguaba', fare: 16, appFee: 2 },
  iate: { label: 'Iate', fare: 16, appFee: 2 }
});

// Planos com tarifa fixa por entrega: Conchal urbano tem um valor e os
// distritos (Martinho Prado, Tujuguaba, Iate) tem outro, com desconto sobre a taxa normal.
const DAILY_PLAN_FARES = { type: 'Plano Diario MotoJa Pro', fare: 4, appFee: 1, districtFare: 10, districtAppFee: 2, label: 'plano diario' };
const HALF_PLAN_FARES = { type: 'Plano Meio Periodo MotoJa', fare: 5.5, appFee: 1.5, districtFare: 12, districtAppFee: 2, label: 'plano meio periodo' };
export const PLAN_FARES = Object.freeze({
  'plano diario motoja pro': DAILY_PLAN_FARES,
  'plano meio periodo motoja': HALF_PLAN_FARES,
  // Nome antigo, aceito enquanto algum celular ainda usa a versao anterior do app.
  'meio periodo motoja': HALF_PLAN_FARES
});

function planRegionFare(plan, region, appFee = false) {
  const district = region !== 'conchal';
  if (appFee) return district ? plan.districtAppFee : plan.appFee;
  return district ? plan.districtFare : plan.fare;
}

export function planFare(type) {
  const key = String(type || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  return Object.hasOwn(PLAN_FARES, key) ? PLAN_FARES[key] : null;
}

export function prepareQuickDelivery(delivery, rawCount, company, fixedType) {
  const count = Number(rawCount);
  const region = Object.hasOwn(QUICK_DELIVERY_REGIONS, delivery.regiaoEntrega) ? QUICK_DELIVERY_REGIONS[delivery.regiaoEntrega] : null;
  const type = String(delivery.tipoEntrega || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const plan = planFare(type);
  if (!Number.isInteger(count) || count < 1 || count > 30 || !region || (!fixedType && !plan) || !['lanche / pizza / pastel / marmita', 'acai / pote de sorvete', 'farmacia', ...Object.keys(PLAN_FARES)].includes(type) || delivery.integracaoOrigem || delivery.integracaoPedidoId) {
    const error = new Error('Na chamada sem endereco, selecione de 1 a 30 entregas, uma regiao e um tipo com tarifa fixa. Pedidos integrados continuam com endereco.');
    error.status = 400;
    error.code = 'chamada_rapida_invalida';
    throw error;
  }
  Object.assign(delivery, {
    retirada: String(company.retirada || '').trim(),
    entrega: `${count} entrega(s) em ${region.label}. Enderecos nas notas.`,
    entregaEncontrada: 'Enderecos nas notas — rota nao calculada',
    entregaLat: null, entregaLon: null,
    paradas: count, quantidadeEntregas: count, km: 0,
    valor: Math.round(count * (plan ? planRegionFare(plan, delivery.regiaoEntrega) : region.fare) * 100) / 100,
    precoLabel: `${count} entrega(s) × R$ ${(plan ? planRegionFare(plan, delivery.regiaoEntrega) : region.fare).toFixed(2).replace('.', ',')} — ${region.label}${plan ? ` — ${plan.label}` : ''}`,
    recebedor: '', telefoneRecebedor: '', descricao: '', observacao: '',
    pontosExtras: [], enderecosExtras: '', dadosNaNota: true
  });
  if (plan) delivery.tipoEntrega = plan.type;
  return region;
}

export function quickDeliveryFare(delivery, appFee = false) {
  const plan = planFare(delivery.tipoEntrega);
  if (plan) return Math.round(Number(delivery.paradas) * planRegionFare(plan, delivery.regiaoEntrega, appFee) * 100) / 100;
  const region = QUICK_DELIVERY_REGIONS[delivery.regiaoEntrega];
  return Math.round(Number(delivery.paradas) * Number(region?.[appFee ? 'appFee' : 'fare'] || 0) * 100) / 100;
}
