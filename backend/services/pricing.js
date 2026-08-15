// services/pricing.js
// Regras de tarifacao do Moto Conchal.
// Valores em CENTAVOS para evitar erros de ponto flutuante com dinheiro.

const FAIXAS = [
  { limite_km: 2, valor_centavos: 700,  label: 'Até 2 km' },
  { limite_km: 4, valor_centavos: 1400, label: 'Até 4 km' },
  { limite_km: 5, valor_centavos: 1600, label: 'Até 5 km' },
];

// Acima de 5km: taxa proporcional baseada no valor/km da última faixa (R$16/5km = R$3,20/km),
// aplicada sobre o km excedente, mantendo o R$16,00 como base.
const VALOR_BASE_5KM_CENTAVOS = 1600;
const VALOR_POR_KM_EXCEDENTE_CENTAVOS = 320; // R$ 3,20 por km acima de 5km

/**
 * Calcula o valor da corrida a partir da distancia em km.
 * @param {number} distanciaKm
 * @returns {{ faixa: string, valor_centavos: number, valor_reais: string }}
 */
function calcularValorCorrida(distanciaKm) {
  if (typeof distanciaKm !== 'number' || isNaN(distanciaKm) || distanciaKm <= 0) {
    throw new Error('Distância inválida.');
  }

  for (const faixa of FAIXAS) {
    if (distanciaKm <= faixa.limite_km) {
      return {
        faixa: faixaParaCodigo(faixa.limite_km),
        valor_centavos: faixa.valor_centavos,
        valor_reais: centavosParaReais(faixa.valor_centavos),
      };
    }
  }

  // Acima de 5km -> proporcional
  const kmExcedente = distanciaKm - 5;
  const valor_centavos = Math.round(
    VALOR_BASE_5KM_CENTAVOS + kmExcedente * VALOR_POR_KM_EXCEDENTE_CENTAVOS
  );

  return {
    faixa: 'acima_5km',
    valor_centavos,
    valor_reais: centavosParaReais(valor_centavos),
  };
}

function faixaParaCodigo(limite_km) {
  return `${limite_km}km`;
}

function centavosParaReais(centavos) {
  return (centavos / 100).toFixed(2).replace('.', ',');
}

function listarFaixas() {
  return FAIXAS.map((f) => ({
    faixa: faixaParaCodigo(f.limite_km),
    label: f.label,
    valor_centavos: f.valor_centavos,
    valor_reais: centavosParaReais(f.valor_centavos),
  }));
}

module.exports = {
  calcularValorCorrida,
  listarFaixas,
  centavosParaReais,
};
