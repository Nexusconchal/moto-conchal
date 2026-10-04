export const QUICK_DELIVERY_REGIONS = Object.freeze({
  conchal: { label: 'Conchal — área urbana', fare: 6.5, appFee: 1.5 },
  martinho_prado: { label: 'Martinho Prado', fare: 16, appFee: 2 },
  tujuguaba: { label: 'Tujuguaba', fare: 16, appFee: 2 },
  iate: { label: 'Iate', fare: 16, appFee: 2 }
});

export function prepareQuickDelivery(delivery, rawCount, company, fixedType) {
  const count = Number(rawCount);
  const region = Object.hasOwn(QUICK_DELIVERY_REGIONS, delivery.regiaoEntrega) ? QUICK_DELIVERY_REGIONS[delivery.regiaoEntrega] : null;
  const type = String(delivery.tipoEntrega || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  if (!Number.isInteger(count) || count < 1 || count > 30 || !region || !fixedType || !['lanche / pizza / pastel / marmita', 'acai / pote de sorvete', 'farmacia'].includes(type) || delivery.integracaoOrigem || delivery.integracaoPedidoId) {
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
    valor: Math.round(count * region.fare * 100) / 100,
    precoLabel: `${count} entrega(s) × R$ ${region.fare.toFixed(2).replace('.', ',')} — ${region.label}`,
    recebedor: '', telefoneRecebedor: '', descricao: '', observacao: '',
    pontosExtras: [], enderecosExtras: '', dadosNaNota: true
  });
  return region;
}

export function quickDeliveryFare(delivery, appFee = false) {
  const region = QUICK_DELIVERY_REGIONS[delivery.regiaoEntrega];
  return Math.round(Number(delivery.paradas) * Number(region?.[appFee ? 'appFee' : 'fare'] || 0) * 100) / 100;
}
