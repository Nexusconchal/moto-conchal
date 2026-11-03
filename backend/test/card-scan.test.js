import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../../cartao-scan.js', import.meta.url), 'utf8');
const context = vm.createContext({});
vm.runInContext(source, context);
const { dadosDoCartao, numeroValido, luhn } = context.MotojaCartaoScan;
const AGORA = new Date(2026, 9, 26);

test('reads a printed card number only when it passes the card check', () => {
  assert.equal(luhn('4111111111111111'), true);
  assert.equal(numeroValido('4111111111111112'), false);
  const lido = dadosDoCartao('NUBANK\n5031 4332 1540 6351\nVALID THRU 11/30\nRAFAEL A SOUZA\nmastercard', AGORA);
  assert.equal(lido.numero, '5031433215406351');
  assert.deepEqual({ ...lido.validade }, { mes: 11, ano: 2030 });
  assert.equal(lido.nome, 'RAFAEL A SOUZA');
});

test('fixes letters the reader confuses inside the number', () => {
  const lido = dadosDoCartao('4lll 1111 IIII 1lI1\n0B/29', AGORA);
  assert.equal(lido.numero, '4111111111111111');
  assert.deepEqual({ ...lido.validade }, { mes: 8, ano: 2029 });
});

test('keeps the latest date (valid from / valid thru) and ignores expired ones', () => {
  const lido = dadosDoCartao('4111 1111 1111 1111\nDESDE 03/22  VALIDO ATE 03/31', AGORA);
  assert.deepEqual({ ...lido.validade }, { mes: 3, ano: 2031 });
  assert.equal(dadosDoCartao('4111 1111 1111 1111 09/26', AGORA).validade, null, 'vencido');
});

test('finds the number inside reader noise and accepts Amex with 15 digits', () => {
  assert.equal(dadosDoCartao('xx 7 4111 1111 1111 1111 2 yy', AGORA).numero, '4111111111111111');
  assert.equal(dadosDoCartao('3782 822463 10005', AGORA).numero, '378282246310005');
  assert.equal(dadosDoCartao('Rua das Flores 123 Centro 13835-000', AGORA).numero, '');
  assert.equal(dadosDoCartao('1234 5678 9012 3456', AGORA).numero, '', 'falha na conta de verificacao');
});

test('the name ignores bank and brand words', () => {
  assert.equal(dadosDoCartao('BANCO DO BRASIL\nVISA PLATINUM\nMARIA DA SILVA', AGORA).nome, 'MARIA DA SILVA');
  assert.equal(dadosDoCartao('VALID THRU', AGORA).nome, '');
});
