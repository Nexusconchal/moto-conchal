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

Modelos prontos para comecar:

- `playstore/cliente-twa-manifest.json`
- `playstore/motorista-twa-manifest.json`
- `playstore/assetlinks.example.json`

## Caminho pelo Bubblewrap

1. Instale Node.js, Java/JDK e Android Studio.
2. Instale o Bubblewrap:

```bash
npm install -g @bubblewrap/cli
```

3. Gere o app do cliente:

```bash
bubblewrap init --manifest=https://nexusconchal.github.io/moto-conchal/cliente.webmanifest
bubblewrap build
```

4. Gere o app do motorista em outra pasta:

```bash
bubblewrap init --manifest=https://nexusconchal.github.io/moto-conchal/motorista.webmanifest
bubblewrap build
```

5. Envie o arquivo `.aab` de cada app na Play Console.

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

Use `playstore/assetlinks.example.json` como base e troque os valores `COLE_AQUI_O_SHA256...` pelos SHA-256 reais dos apps.

## Politica e loja

Use estes links no cadastro dos apps:

- Site do cliente: `https://nexusconchal.github.io/moto-conchal/`
- Site do motorista: `https://nexusconchal.github.io/moto-conchal/motoboy.html`
- Politica de privacidade: `https://nexusconchal.github.io/moto-conchal/privacy.html`

Para o app do motorista, deixe claro na descricao que ele e exclusivo para motoboys cadastrados pela Nexus MotoJa.
