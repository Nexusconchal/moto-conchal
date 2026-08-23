# MotoJa Conchal Backend

Backend para rodar no Render quando o MotoJa Conchal sair do teste e precisar de automacao real.

## O que ele resolve

- Expira corrida pendente depois de 5 minutos, mesmo se o app estiver fechado.
- Reabre corrida aceita quando o motoboy nao avisa o cliente em 3 minutos.
- Guarda autorizacao Mercado Pago dos motoboys via OAuth.
- Cria link de pagamento Mercado Pago com split: 70% motoboy e 30% app.
- Recebe webhook do Mercado Pago e marca pagamento confirmado na corrida.
- Envia notificacao push para os motoboys cadastrados quando chegar corrida nova.
- Envia aviso no grupo do Telegram dos motoboys quando chegar corrida nova.
- Bloqueia valor adulterado pelo navegador: o backend confere o valor com a tabela.
- Bloqueia finalizar corrida sem cliente avisado e sem pagamento aprovado.
- Limita excesso de chamadas na API para reduzir abuso simples.

## Modelo Mercado Pago

O Mercado Pago trabalha o split de marketplace com o `access_token` do vendedor/motoboy e cobra a comissao do app usando `marketplace_fee`.

Exemplo:

- Corrida: R$ 10,00
- Motoboy recebe 70% da corrida: R$ 7,00, descontadas as taxas do Mercado Pago conforme regra deles.
- Dono/app recebe 30% de comissao: R$ 3,00.
- No Checkout Pro isso vai como `marketplace_fee: 3`.

Nao inverter essa regra: **70% e sempre do motoboy; 30% e sempre do dono/app**.

Antes de usar em producao, cada motoboy precisa autorizar a propria conta Mercado Pago pelo link:

```text
https://SEU-BACKEND.onrender.com/api/mercadopago/oauth/start?driverCpf=CPF_DO_MOTOBOY
```

## Variaveis no Render

Copie `.env.example` e cadastre as variaveis no painel do Render.

Obrigatorias:

- `FIREBASE_SERVICE_ACCOUNT_JSON`
- `MP_CLIENT_ID`
- `MP_CLIENT_SECRET`
- `MP_REDIRECT_URI`
- `MP_OWNER_ACCESS_TOKEN`
- `ADMIN_API_KEY`
- `OWNER_PASSWORD` com a senha do painel do dono
- `DRIVER_PASSWORD` com a senha dos motoboys; se nao definir, usa `moto123`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`
- `ALLOWED_ORIGINS` com os dominios autorizados, separados por virgula. Padrao: GitHub Pages do app e Render.

## Endpoints principais

```http
GET /health
GET /api/mercadopago/oauth/start?driverCpf=00000000000
GET /api/mercadopago/oauth/callback
POST /api/drivers/:cpf/push-token
POST /api/rides
POST /api/rides/:rideId/accept
POST /api/rides/:rideId/notify-client
POST /api/rides/:rideId/cancel
POST /api/rides/:rideId/finish
POST /api/rides/:rideId/payment/preference
POST /api/mercadopago/webhook
POST /api/jobs/cleanup
```

Para chamar endpoints de dono/manual, envie:

```http
x-admin-key: sua_senha_admin
```

## Aviso importante

Esse backend ja deixa o caminho profissional pronto, mas o site atual ainda usa Firebase direto no frontend. Quando for ativar de verdade, o proximo passo e trocar as acoes criticas do frontend para chamar este backend.

## Notificacao para motoboys

Para notificar igual app, use Firebase Cloud Messaging:

1. Criar a chave Web Push/VAPID no Firebase.
2. Colocar o `firebase-messaging-sw.js` na raiz do site.
3. No painel do motoboy, pedir permissao de notificacao.
4. Enviar o token para `POST /api/drivers/:cpf/push-token`.
5. Quando `POST /api/rides` criar corrida nova, o backend chama FCM somente para os motoboys ativos.
