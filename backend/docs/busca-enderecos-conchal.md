# Busca de endereços de Conchal-SP

A busca de endereço (app de empresas e app do cliente) consulta primeiro o cadastro local de ruas de Conchal. O Geoapify só entra quando a rua não está nesse cadastro.

## De onde vêm as ruas

- `backend/data/cnefe-conchal.txt`: IBGE CNEFE, Censo 2022, município 3512209. São 13.733 endereços reais com número, bairro, CEP e coordenada, agrupados em 662 trechos (rua + bairro). Inclui o Distrito de Tujuguaba e o Iate Clube.
- `backend/data/osm-conchal.txt`: ruas do OpenStreetMap dentro de Conchal. Serve para recuperar acentos e para incluir ruas novas que o IBGE ainda não tem.

Martinho Prado e outras cidades não fazem parte do cadastro. Esses endereços continuam indo para o mapa externo.

## O que a busca tolera

- Erro de grafia: letra dobrada ou faltando (Coletta/Colleta, Kamer/Kammer), letras trocadas de lugar (Pamlas/Palmas), gue/ge (Guelly/Gelly), z/s.
- Falta de acento, abreviação (R., Av., Dr., Prof., Ver., Pref.) e número escrito por extenso (15/XV/Quinze, 9/Nove, 2/II).
- Bairro escrito depois da rua, com número no nome do bairro: em "Rua dos Coletta, Esperança 2", o 2 é do bairro e não o número da casa.

## Quando a busca pede mais informação

- Quando o nome digitado serve para duas ruas diferentes (por exemplo "Rua Megiato" pode ser João Megiato ou Nelson Megiatto), a resposta mostra as opções e pede o nome completo e o bairro. A busca nunca escolhe uma das duas por conta própria.
- Quando o mesmo nome existe em lugares distantes (por exemplo "Rua Um") e nem o bairro nem o número resolvem, a busca também pede o bairro.

## Precisão do ponto (`match_precision`)

- `numero`: é o número exato cadastrado no IBGE.
- `interpolado`: o ponto fica entre dois números conhecidos da mesma rua (erro de até cerca de 20 m).
- `aproximado`: o número está fora da faixa conhecida e o ponto usa o número mais próximo, a até 200 números de distância.
- `rua`: não foi informado número, então o ponto é o centro da rua no bairro.

## Atualizar o cadastro

Rode o comando abaixo numa máquina com internet liberada para o IBGE e o Overpass:

```
cd backend
npm run gazetteer:build
npm test
```
