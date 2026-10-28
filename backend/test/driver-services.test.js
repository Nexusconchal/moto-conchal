import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
function slice(start, end) { const a = source.indexOf(start); const b = source.indexOf(end, a + start.length); assert.ok(a >= 0 && b > a, start); return source.slice(a, b); }

test('motoboy chooses Moto taxi and/or Entregas; standalone deliveries count as entregas', () => {
  const context = vm.createContext({
    driverRideCities: (d) => ({ conchal: (d.cidade || 'conchal') === 'conchal', aguai: d.cidade === 'aguai' }),
    rideOperatingCity: (r) => r.cidadeOperacao || 'conchal',
    isStandaloneDelivery: (r) => r.modalidade === 'entrega_avulsa'
  });
  vm.runInContext(slice('function driverServices(', 'function rideOperatingCity('), context);
  const corrida = { modalidade: 'corrida' };
  const avulsa = { modalidade: 'entrega_avulsa' };
  const ambos = {};
  const soEntrega = { servicosAtivos: { corrida: false, entrega: true } };
  const soCorrida = { servicosAtivos: { corrida: true, entrega: false } };
  assert.deepEqual({ ...context.driverServices(ambos) }, { corrida: true, entrega: true }, 'padrao: os dois');
  assert.equal(context.driverWantsRide(ambos, corrida), true);
  assert.equal(context.driverWantsRide(soEntrega, corrida), false);
  assert.equal(context.driverWantsRide(soEntrega, avulsa), true);
  assert.equal(context.driverWantsRide(soCorrida, avulsa), false);
  assert.equal(context.driverWantsDeliveryIn(soCorrida, 'conchal'), false);
  assert.equal(context.driverWantsDeliveryIn(soEntrega, 'conchal'), true);
  assert.equal(context.driverWantsRide({ cidade: 'aguai' }, corrida), false, 'a cidade continua valendo');
});

test('push, Telegram, open list and accept all respect the choice; the plan delivery still reaches its motoboy', () => {
  assert.match(slice('async function repeatRideAlert(', '\n}\n'), /driverWantsRide\(data, ride\)/);
  assert.match(slice('async function notifyDriversAboutRide(', 'if (!tokens.length)'), /telegramReadyDrivers\(drivers\.docs \|\| \[\], \(data\) => driverWantsRide\(data, ride\)\)[\s\S]*if \(!driverWantsRide\(data, ride\)\) return;/);
  assert.match(slice('async function repeatDeliveryAlert(', '\n}\n'), /driverWantsDeliveryIn\(data, city\)/);
  assert.match(slice('async function notifyDriversAboutDelivery(', 'const send ='), /const inCity = \(data\) => driverWantsDeliveryIn\(data, city\);/);
  const jobs = slice("app.post('/api/drivers/:cpf/jobs'", "const jobs = sortJobs(");
  assert.match(jobs, /services\[rideServiceKind\(docSnap\.data\(\)\)\]/);
  assert.match(jobs, /motoboyExclusivoCpf\) === driverCpf \|\| \(services\.entrega/);
  assert.equal((source.match(/code = 'servico_desativado'/g) || []).length, 2, 'aceite de corrida e de entrega');
  const route = slice("app.post('/api/drivers/:cpf/services'", "// Abertura do app com a chave");
  assert.match(route, /getDriverWithProof\(cpf, req\.body\)/);
  assert.match(route, /servico_obrigatorio/);
  assert.match(route, /driverProofCache\.clear\(\)/);
});
