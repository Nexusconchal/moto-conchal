import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { GAZETTEER_CITIES, gazetteerFor } from '../src/conchal-gazetteer.js';

const source = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
const routes = {};
const ctx = vm.createContext({ GAZETTEER_CITIES, gazetteerFor, console, Object, Number, app: { get: (p, ...h) => { routes[p] = h.at(-1); } }, mapLimiter: () => {}, cleanText: (v, n) => String(v || '').slice(0, n) });
const i = source.indexOf("app.get('/api/maps/geocode-cities'");
vm.runInContext(source.slice(i, source.indexOf("app.get('/api/maps/geocode',", i)), ctx);
const ask = (text) => { let out; routes['/api/maps/geocode-cities']({ query: { text } }, { set: () => {}, status: () => ({ json: (d) => { out = d; } }), json: (d) => { out = d; } }); return out.cidades; };

test('endereco sem cidade: o servidor diz em qual cidade a rua existe (so o cadastro do IBGE)', () => {
  assert.equal(ask('Rua Ana Euclidia Silveira Cruz, 120')[0].cidade, 'aguai');
  assert.equal(ask('Avenida Maria Nery Rabelo, 12')[0].cidade, 'aguai');
  // Rua que so existe em Conchal.
  assert.equal(ask('Avenida Presidente Humberto de Alencar Castelo Branco, 61')[0].cidade, 'conchal');
  // Mesmo nome nas duas cidades: as duas aparecem com nota maxima (o app pergunta).
  const iguais = ask('Rua Sete de Setembro, 9').filter((c) => c.nota >= 0.97).map((c) => c.cidade);
  assert.ok(iguais.includes('conchal') && iguais.includes('aguai'));
});
