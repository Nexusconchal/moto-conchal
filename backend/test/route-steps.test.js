import test from 'node:test';
import assert from 'node:assert/strict';
import { osrmRouteSteps, textoDoPasso } from '../src/route-steps.js';

const passo = (type, modifier, name = '', extra = {}) => ({ name, maneuver: { type, modifier, location: [-47.17, -22.33], ...extra } });

test('curvas viram instrucoes em portugues com o artigo certo da rua', () => {
  assert.deepEqual(textoDoPasso(passo('turn', 'right', 'Rua São Paulo')), { tipo: 'direita', texto: 'Vire à direita na Rua São Paulo' });
  assert.deepEqual(textoDoPasso(passo('turn', 'sharp left', 'Avenida Brasil')), { tipo: 'esquerda', texto: 'Vire à esquerda na Avenida Brasil' });
  assert.equal(textoDoPasso(passo('turn', 'left', 'Largo da Matriz')).texto, 'Vire à esquerda no Largo da Matriz');
  assert.equal(textoDoPasso(passo('turn', 'right', 'SP-191')).texto, 'Vire à direita na SP-191');
  assert.equal(textoDoPasso(passo('turn', 'right', 'Benedito Nogueira')).texto, 'Vire à direita em Benedito Nogueira');
  assert.equal(textoDoPasso(passo('turn', 'left')).texto, 'Vire à esquerda');
  assert.deepEqual(textoDoPasso(passo('turn', 'slight right', 'Rua 7')), { tipo: 'leve-direita', texto: 'Siga à direita na Rua 7' });
  assert.equal(textoDoPasso(passo('end of road', 'left', 'Rua Rosas')).texto, 'No fim da rua, vire à esquerda na Rua Rosas');
  assert.equal(textoDoPasso(passo('fork', 'slight left')).texto, 'Na bifurcação, mantenha-se à esquerda');
  assert.equal(textoDoPasso(passo('off ramp', 'slight right', 'Rodovia SP-191')).texto, 'Pegue a saída à direita para a Rodovia SP-191');
  assert.deepEqual(textoDoPasso(passo('turn', 'uturn', 'Rua Chagas')), { tipo: 'retorno', texto: 'Faça o retorno na Rua Chagas' });
});

test('rotatoria fala a saida por extenso, para a voz do celular ler certo', () => {
  assert.deepEqual(textoDoPasso(passo('roundabout', 'right', 'Avenida Lauro', { exit: 2 })), { tipo: 'rotatoria', texto: 'Na rotatória, pegue a segunda saída para a Avenida Lauro' });
  assert.equal(textoDoPasso(passo('rotary', 'straight', '', { exit: 1 })).texto, 'Na rotatória, pegue a primeira saída');
  assert.equal(textoDoPasso(passo('roundabout', 'right', '', { exit: 11 })).texto, 'Na rotatória, pegue a 11ª saída');
});

test('seguir reto, saida e troca de nome da rua nao viram instrucao; chegada diz o lado', () => {
  assert.equal(textoDoPasso(passo('depart', 'right', 'Rua A')), null);
  assert.equal(textoDoPasso(passo('new name', 'straight', 'Rua B')), null);
  assert.equal(textoDoPasso(passo('continue', 'straight', 'Rua C')), null);
  assert.equal(textoDoPasso(passo('continue', undefined, 'Rua C')), null);
  assert.equal(textoDoPasso(passo('exit roundabout', 'right')), null);
  assert.deepEqual(textoDoPasso(passo('arrive', 'left')), { tipo: 'chegada', texto: 'Chegada ao destino, à esquerda' });
  assert.deepEqual(textoDoPasso(passo('arrive')), { tipo: 'chegada', texto: 'Chegada ao destino' });
});

test('rota do OSRM vira a lista de passos com o ponto de cada curva', () => {
  const route = {
    legs: [{
      steps: [
        { name: 'Rua Duque de Caxias', maneuver: { type: 'depart', modifier: 'right', location: [-47.1735, -22.3318] } },
        { name: 'Rua São Paulo', maneuver: { type: 'turn', modifier: 'left', location: [-47.17451234, -22.33051234] } },
        { name: 'Rua São Paulo', maneuver: { type: 'new name', modifier: 'straight', location: [-47.175, -22.3299] } },
        { name: 'Rua José Nogueira', ref: '', maneuver: { type: 'turn', modifier: 'right', location: [-47.1755, -22.3295] } },
        { name: '', maneuver: { type: 'arrive', modifier: 'right', location: [-47.176, -22.329] } },
        { name: 'sem ponto', maneuver: { type: 'turn', modifier: 'right' } }
      ]
    }]
  };
  assert.deepEqual(osrmRouteSteps(route), [
    { tipo: 'esquerda', texto: 'Vire à esquerda na Rua São Paulo', lat: -22.330512, lon: -47.174512 },
    { tipo: 'direita', texto: 'Vire à direita na Rua José Nogueira', lat: -22.3295, lon: -47.1755 },
    { tipo: 'chegada', texto: 'Chegada ao destino, à direita', lat: -22.329, lon: -47.176 }
  ]);
  assert.deepEqual(osrmRouteSteps({}), []);
  assert.deepEqual(osrmRouteSteps({ legs: [{ steps: 'x' }] }), []);
});
