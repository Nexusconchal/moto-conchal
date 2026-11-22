# MotoJá (moto táxi) na App Store (iPhone)

O app de iPhone do cliente é uma casca nativa (Capacitor 8) que abre `nexusmotoja.com.br`, igual ao app Android em WebView. Tudo o que muda no site aparece no app sem mandar versão nova para a Apple. A pasta é `ios-cliente/`.

O app do **motoboy** no iPhone tem roteiro próprio: `docs/APP-STORE-MOTORISTA.md` (aviso urgente que repete até aceitar e GPS em segundo plano só durante a corrida).

## O que já está pronto (22/11/2026)

- Projeto Xcode em `ios-cliente/ios/App`, com pacote `br.com.nexusconchal.motoja.cliente` (o mesmo do Android), versão 1.0 (1), nome "MotoJá".
- **Notificação nativa** pelo plugin `@capacitor-firebase/messaging`. O `index.html` usa a mesma interface do Android (`pushNativoCliente`) e entrega o token do Firebase ao servidor, que já manda os lembretes com `notification` (aparecem no iPhone sem mudar o servidor).
- App registrado no Firebase **moto-conchal** em 22/11/2026. O `GoogleService-Info.plist` está em `Documents/chaves/ios/` no computador do dono e **não vai para o GitHub**, porque este repositório é público. Ele entra no build pelo Codemagic.
- Permissões com o motivo escrito: localização (onde o motoboy vai te buscar) e câmera/fotos (foto do cadastro).
- Só iPhone e só em pé. Criptografia isenta (só HTTPS). Notificação em segundo plano.
- Ícone 1024 provisório (feito do ícone de 512) e tela de abertura preta.
- Página sem internet (`www/offline.html`).
- Exclusão de conta no app (menu → Excluir minha conta) e explicada na política de privacidade.
- Login sem Google/Facebook, então a regra 4.8 da Apple ("Entrar com a Apple") não se aplica.
- Build na nuvem: workflow `ios-cliente` no `codemagic.yaml` da raiz.

## Na sexta (mesma conta Apple do MotoJÁ Food)

1. **Identificador do app** (Identifiers): `br.com.nexusconchal.motoja.cliente`, com Push Notifications ligado.
2. **Chave de notificação:** a mesma chave APNs (.p8) da conta serve para todos os apps. No Firebase: Configurações → Cloud Messaging → app iOS "MotoJa Cliente iPhone" → enviar a chave.
3. **Criar o app** na App Store Connect: nome **MotoJá Conchal** (o nome "MotoJá" pode estar ocupado), idioma português (Brasil), SKU `motoja-cliente-ios`, disponível só no **Brasil**.
4. **Codemagic** (conta grátis ligada ao GitHub):
   - adicionar o repositório `moto-conchal`;
   - criar o grupo `firebase-cliente` com `GOOGLE_SERVICE_INFO_PLIST_CLIENTE`, que é o arquivo do Firebase em base64;
   - criar `APP_STORE_APPLE_ID_CLIENTE`;
   - rodar o workflow "MotoJá (moto táxi) iPhone → TestFlight".
5. **Testar no iPhone pelo TestFlight:**
   - pedir uma corrida teste;
   - ativar os lembretes;
   - ver a notificação chegar com o app fechado.
6. **Prints:** 6,9" (1320×2868), com a tela inicial, o pedido de corrida, o motoboy a caminho e o pagamento.
7. **Enviar para análise.**

## Textos da loja

- **Nome:** MotoJá Conchal
- **Subtítulo (até 30):** Moto táxi e entregas na cidade
- **Categoria:** Viagem (secundária: Navegação)
- **Texto promocional (até 170):** Peça um moto táxi ou uma entrega em Conchal e região em poucos toques. Veja o preço antes, acompanhe o motoboy no mapa e pague como preferir.
- **Palavras-chave (até 100):** `moto taxi,mototaxi,corrida,entrega,motoboy,Conchal,Aguaí,Engenheiro Coelho,frete,delivery`
- **Descrição:**

  > MotoJá é o moto táxi e as entregas de Conchal e região, com motoboys da cidade.
  >
  > • Peça uma corrida ou uma entrega em poucos toques e veja o preço antes de confirmar.
  > • Acompanhe o motoboy no mapa até ele chegar.
  > • Pague com Pix, cartão salvo com segurança no Mercado Pago ou dinheiro.
  > • Receba lembretes e promoções de corrida, se quiser.
  > • Atendimento pelo WhatsApp oficial.

- **URL de suporte:** https://wa.me/5519992306488
- **Política de privacidade:** https://nexusmotoja.com.br/privacidade.html

## Privacidade do app (questionário da Apple)

**Dados coletados, ligados à conta e sem rastreamento:**
- Contato: nome, telefone (WhatsApp).
- Localização precisa: buscar e levar.
- Endereço: origem e destino das corridas.
- Compras: histórico de corridas.
- Informações financeiras: só o final e a bandeira do cartão; o cartão fica no Mercado Pago.
- Fotos: opcional, a foto do cadastro.
- Identificadores: ID do usuário.

**Uso:** funcionalidade do app e atendimento.

## Nota para o revisor (em inglês)

> MotoJá is a motorcycle taxi and delivery service for small towns in São Paulo state, Brazil (Conchal and nearby cities). Customers request a ride or a delivery, see the price before confirming, track the courier live and pay with Pix, a card saved through Mercado Pago or cash. Rides and deliveries are physical services, so payments are outside In-App Purchase (3.1.5(a)). Motorcycle taxi drivers work under Brazilian federal law 12.009/2009.
>
> Native features: push notifications (APNs via Firebase), location for pickup, camera/photos for the profile picture, in-app account deletion (side menu → Excluir minha conta).
>
> Demo account: [phone/CPF of the test customer created by the owner]. Please do not confirm a real ride: it would call a real driver in Conchal.

## Atenção

- A Apple pode pedir comprovante de que o serviço de moto táxi é legal na cidade (alvará ou autorização da prefeitura). Tenha o documento em mãos.
- A conta de teste do Google (cliente) pode ser usada para o revisor. Antes, combine com os motoboys ou use um modo de teste, para uma corrida de teste não chamar ninguém de verdade.
