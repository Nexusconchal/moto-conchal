# Nexus MotoJa na Play Store

Este projeto continua funcionando por link no GitHub Pages e tambem pode virar app Android para a Play Store.

## Apps

- Cliente: `https://nexusconchal.github.io/moto-conchal/`
- Motorista: `https://nexusconchal.github.io/moto-conchal/motoboy.html`
- Politica de privacidade: `https://nexusconchal.github.io/moto-conchal/privacy.html`

## Forma recomendada

Use TWA/Bubblewrap ou Capacitor para empacotar cada tela como um app Android separado.

Sugestao de pacotes Android:

- Cliente: `br.com.nexusmotoja.cliente`
- Motorista: `br.com.nexusmotoja.motorista`

## Antes de publicar

1. Testar cliente pedindo corrida por GPS e por endereco digitado.
2. Testar motorista aceitando, avisando cliente e finalizando.
3. Testar Telegram recebendo chamada nova.
4. Testar Mercado Pago no fluxo real ou sandbox.
5. Conferir se o link da politica de privacidade abre.
6. Criar teste fechado na Play Console se o Google exigir.

## Observacao importante

Depois que gerar o app Android e assinar, sera preciso publicar o arquivo `assetlinks.json` em:

`https://nexusconchal.github.io/moto-conchal/.well-known/assetlinks.json`

Esse arquivo depende do nome do pacote e da assinatura SHA-256 gerada no Android. Por isso ele deve ser criado depois que o app Android existir.
