import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const home = fs.readFileSync(new URL('../../motoboy-home.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../../motoboy.html', import.meta.url), 'utf8');

test('motoboy fora da area (ex.: Araras) nao ve "Procurando chamadas" verde e pode conferir o GPS na hora', () => {
  assert.match(html, /foraDaArea: \(\) => !Object\.values\(cidadesAtivas\)\.some\(Boolean\)/);
  assert.match(html, /conferirCidade: \(\) => confirmarCidadePeloGps\(\)/);
  assert.match(home, /else if \(fora\) estado = 'fora';/);
  assert.match(home, /estado === 'fora' \? 'Fora da área'/);
  assert.match(home, /fora: 'Fora da área atendida'/);
  assert.match(home, /conferir\.hidden = estado !== 'fora';/);
  assert.doesNotMatch(home, /Entregas para comércios chegam de todas as cidades atendidas/, 'texto errado: entregas tambem seguem a cidade do GPS');
  // Fora da area confere o GPS a cada 2 min (dentro, a cada 5).
  assert.match(html, /\(fora \? 2 : 5\) \* 60000/);
});
