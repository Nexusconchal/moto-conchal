# MotoJá Motorista na App Store (iPhone)

O app de iPhone do motoboy é uma casca nativa (Capacitor 8) que abre `nexusmotoja.com.br/motoboy.html`. Ele faz o que o iPhone exige para um app de entregador ser aprovado, no mesmo modelo do Uber Motorista e do iFood Entregador. A pasta é `ios-motorista/`.

## Como funciona no iPhone (e por que a Apple aprova)

| Recurso | Android (Play Store) | iPhone |
|---|---|---|
| Chamada de corrida/entrega | Toca sem parar até aceitar (alerta próprio do app) | Aviso **urgente** (Time Sensitive, passa pelo modo Foco) com o som "MotoJá, bora rodar" de ~19 s, repetido a cada 20 s pelo "alerta insistente" do servidor até alguém aceitar ou a chamada vencer |
| Celular no silencioso | Toca | Só vibra. O alerta que fura o silencioso (Critical Alert) a Apple libera só para saúde e segurança |
| GPS durante a corrida | Continua com a tela apagada | Continua com a tela apagada ou com o Waze/Google Maps aberto (plugin `@capacitor-community/background-geolocation`, barra azul no topo). Só liga durante corrida/entrega aceita e desliga quando ela termina |
| Ligação pelo app | Toca como ligação | Funciona com o app aberto. Com o app fechado chega um aviso urgente "está te ligando, toque para atender" (tela de ligação igual à do telefone, CallKit, fica para uma versão seguinte) |
| Câmera (nota, cadastro) | Sim | Sim |
| Excluir conta | Perfil → Excluir minha conta | O mesmo |

### O que mudou no código (nada muda no Android nem no link)

- **Servidor** (`backend/src/ios-push.js`): os avisos de chamada, ligação, teste e cancelamento ganharam o bloco `apns` (som de chamada + urgente + troca do aviso anterior). Android e navegador ignoram esse bloco. O registro do aparelho aceita a plataforma `ios_nativo`; quem é `android_nativo` continua igual.
- **`motoboy.html`**: `pushNativo()` também funciona dentro do app de iPhone (plugin FirebaseMessaging) e manda `ios_nativo`. No Android continua o mesmo plugin de sempre.
- **`motoboy-tracking.js`**: no app de iPhone o GPS da corrida usa o plugin nativo de segundo plano. Fora do iPhone continua o GPS do navegador.
- **App** (`ios-motorista/`):
  - pacote `br.com.nexusconchal.motoja.motorista`;
  - permissões com o motivo escrito: localização durante a corrida, câmera, microfone (só na ligação) e fotos;
  - segundo plano: `location` e `remote-notification`;
  - entitlement de notificação urgente e som `chamada.wav` dentro do app;
  - ícone com a moto.

## Na semana da sexta (mesma conta Apple)

1. **Identificador do app:** `br.com.nexusconchal.motoja.motorista`, com **Push Notifications** e **Time Sensitive Notifications** ligados.
2. **Firebase:** o app "MotoJa Motorista iPhone" já está registrado no moto-conchal (22/11/2026), e o arquivo está em `Documents/chaves/ios/`. Falta enviar a mesma chave APNs (.p8) para esse app em Cloud Messaging.
3. **App Store Connect:** criar o app **MotoJá Motorista**, SKU `motoja-motorista-ios`, disponível só no Brasil.
4. **Codemagic:**
   - criar o grupo `firebase-motorista` com `GOOGLE_SERVICE_INFO_PLIST_MOTORISTA` (base64);
   - criar `APP_STORE_APPLE_ID_MOTORISTA`;
   - rodar o workflow "MotoJá Motorista iPhone → TestFlight".
5. **Teste obrigatório no iPhone, pelo TestFlight, antes de mandar:**
   - Ficar **Disponível**, pedir uma corrida pelo app do cliente e conferir que o aviso toca com a tela bloqueada e repete até aceitar.
   - Aceitar, abrir o Waze, apagar a tela e ver no app do cliente o motoboy andando no mapa.
   - Terminar a corrida e conferir que a barra azul some (GPS desligado).
   - Fazer o "Testar aviso" e uma ligação pelo app.
6. **Gravar um vídeo curto** (gravação de tela do iPhone) com esse fluxo, para a nota de revisão.
7. **Prints 6,9"** e envio para análise.

## Textos da loja

- **Nome:** MotoJá Motorista
- **Subtítulo (até 30):** Corridas e entregas na cidade
- **Categoria:** Negócios (secundária: Navegação)
- **Texto promocional:** Receba chamadas de moto táxi e entregas de Conchal e região, aceite com um toque e leve o cliente até o destino com o GPS ligado só durante a corrida.
- **Descrição:**

  > App para motoboys cadastrados na MotoJá (Conchal e região).
  >
  > • Receba chamadas de corrida e de entrega com aviso urgente e som próprio.
  > • Aceite com um toque e veja endereço, valor e distância.
  > • Durante a corrida, sua localização aparece para o cliente e para a loja, mesmo com o Waze aberto. Quando a corrida termina, o GPS desliga.
  > • Escaneie a nota da entrega com a câmera.
  > • Ligue para o cliente ou para a loja pelo app.
  > • Veja seus ganhos e seus planos.

- **URL de suporte:** https://wa.me/5519992306488
- **Política de privacidade:** https://nexusmotoja.com.br/privacidade.html

## Privacidade (questionário da Apple)

**Dados coletados:**
- Contato: nome, telefone.
- Identificadores: CPF/CNH do cadastro, como ID do usuário.
- Localização precisa: só durante corrida/entrega.
- Fotos: documento, moto e notas.
- Áudio: só durante a ligação, sem gravação.
- Informações financeiras: ganhos e repasses.

Todos ligados à conta e nenhum para rastreamento. Uso: funcionalidade do app.

## Nota para o revisor (em inglês)

> MotoJá Motorista is the courier app for registered motorcycle taxi and delivery drivers of MotoJá, a local service in Conchal, São Paulo state, Brazil (motorcycle taxi drivers work under Brazilian federal law 12.009/2009).
>
> - **Background location** (UIBackgroundModes location) is used ONLY while the driver has an accepted ride or delivery, so the customer and the store can follow the driver while the driver navigates with Waze/Google Maps. It stops when the ride ends (blue status bar indicator while active).
> - **Time Sensitive notifications** are used only for new ride/delivery requests and incoming in-app calls, which expire in a few minutes.
> - **Microphone:** in-app calls with the customer or store, never recorded.
> - **Camera:** scanning the delivery note and the profile documents.
>
> Demo account: [driver test account created by the owner]. After signing in, tap "Testar aviso" to receive a test notification. Real rides depend on real customers in Conchal, so we attached a video of the full flow (receive a call, accept, navigate with the screen off, finish).

## Riscos e respostas

- **Se a Apple pedir uma chamada ao vivo para testar:** criar no servidor uma "corrida de teste", visível só para a conta de teste, que não entra nas contas nem nos relatórios.
- **Se a Apple questionar o GPS em segundo plano:** responder que ele só fica ligado durante corrida/entrega aceita, citando o vídeo.
- **Documento:** a Apple pode pedir comprovante de que o moto táxi é legalizado na cidade.
