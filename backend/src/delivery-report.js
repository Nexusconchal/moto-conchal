// Reports are read-only: monetary amounts come from completed jobs, never quotations.
export function deliveryReportQuantity(job = {}) {
  if (job.tipo === 'servico_exclusivo') return Math.max(0, Math.min(300, Math.floor(Number(job.quantidadeEntregasExclusivo || 0))));
  const count = Number(job.paradas || 1);
  return Number.isInteger(count) && count >= 1 && count <= 30 ? count : 1;
}

export function buildCompanyDeliveryReport(jobs, plans, { timestampMs, money, deliverySplit, bairroFromAddress }, range) {
  const rows = jobs.map((item) => {
    const charged = item.status === 'finalizada';
    const active = ['pendente', 'aceita', 'retirada'].includes(item.status);
    const split = charged ? deliverySplit(item) : { driverAmount: 0, appFee: 0 };
    return {
      id: item.id, status: item.status || '', tipoEntrega: item.tipoEntrega || '',
      entregaNaNota: item.entregaNaNota === true, regiaoEntrega: item.regiaoEntrega || '',
      modalidade: item.entregaNaNota ? 'Só chamar motoboy' : item.tipo === 'servico_exclusivo' ? 'Exclusivo' : 'Entrega com endereço',
      quantidade: deliveryReportQuantity(item), retirada: item.retirada || '', entrega: item.entrega || '',
      enderecosExtras: String(item.enderecosExtras || '').slice(0, 10000),
      pontosExtras: (Array.isArray(item.pontosExtras) ? item.pontosExtras : []).slice(0, 29).map(point => ({ ordem: Number(point.ordem || 0), digitado: String(point.digitado || point.encontrado || '').slice(0, 300) })),
      bairroEntrega: item.entregaNaNota ? ({ conchal: 'Conchal urbano', martinho_prado: 'Martinho Prado', tujuguaba: 'Tujuguaba', iate: 'Iate' }[item.regiaoEntrega] || 'Região não informada') : item.bairroEntrega || bairroFromAddress(item.entregaEncontrada || item.entrega),
      motoboy: item.motoboy || '', motoboyFoto: item.motoboyFoto || '',
      valor: money(item.valor), cobrado: charged ? money(item.valor) : 0,
      reservado: active ? money(item.saldoReservado || 0) : 0,
      valorMotoboy: charged ? money(item.ganhoMotoboy ?? item.valorMotoboy ?? split.driverAmount) : 0,
      valorApp: charged ? money(item.ganhoApp ?? item.valorApp ?? split.appFee) : 0,
      criadaEm: timestampMs(item.criadaEm), aceitaEm: timestampMs(item.aceitaEm), finalizadaEm: timestampMs(item.finalizadaEm)
    };
  }).sort((a, b) => b.criadaEm - a.criadaEm || String(a.id).localeCompare(String(b.id)));
  const completed = rows.filter(row => row.status === 'finalizada');
  const sum = (items, field) => money(items.reduce((total, row) => total + Number(row[field] || 0), 0));
  const dailyPlans = plans.filter(plan => plan.status === 'ativo').map(plan => ({ dia: plan.dia, valor: money(plan.valor), ativadoEm: timestampMs(plan.ativadoEm) }));
  const neighborhoods = new Map();
  completed.forEach(row => {
    const item = neighborhoods.get(row.bairroEntrega) || { bairro: row.bairroEntrega, quantidade: 0, total: 0 };
    item.quantidade += row.quantidade; item.total = money(item.total + row.cobrado); neighborhoods.set(row.bairroEntrega, item);
  });
  return {
    ok: true, ...range, schemaVersion: 2, empresa: range.empresa || '', geradoEm: Date.now(),
    totalChamadas: rows.length, totalEntregas: rows.reduce((total, row) => total + row.quantidade, 0),
    chamadasConcluidas: completed.length, entregasConcluidas: completed.reduce((total, row) => total + row.quantidade, 0),
    chamadasCanceladas: rows.filter(row => row.status === 'cancelada').length,
    chamadasExpiradas: rows.filter(row => row.status === 'expirada').length,
    chamadasEmAndamento: rows.filter(row => ['aceita', 'retirada'].includes(row.status)).length,
    chamadasPendentes: rows.filter(row => row.status === 'pendente').length,
    faturaveis: completed.length, totalGasto: sum(completed, 'cobrado'), totalReservado: sum(rows, 'reservado'),
    totalMotoboy: sum(completed, 'valorMotoboy'), totalApp: sum(completed, 'valorApp'),
    totalDiarias: sum(dailyPlans, 'valor'), totalDebitado: money(sum(completed, 'cobrado') + sum(dailyPlans, 'valor')),
    diarias: dailyPlans, porBairro: [...neighborhoods.values()].sort((a, b) => b.quantidade - a.quantidade),
    ultimas: rows
  };
}
