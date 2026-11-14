# MotoJÁ Motorista 1.0.8 — ligação pelo app e alerta contínuo

Atualização exclusiva do aplicativo Android do motoboy, pacote `br.com.nexusconchal.motoja.motorista`, versionCode 9 (use um número maior que o da versão que está na Play Store). O projeto anterior permanece preservado.

Novidades da 1.0.8:
- **Ligação pelo app com o cliente:** permissões `RECORD_AUDIO` e `MODIFY_AUDIO_SETTINGS`; o WebView libera o microfone (além da câmera) só para nexusmotoja.com.br. `NexusNative.audioCallVersion()` indica ao site que o app já tem o microfone.

Novidades da 1.0.7:
- **Alarme de reserva insistente:** se o Android não deixar abrir o serviço do alerta contínuo (app fechado há muito tempo, economia de bateria), a chamada aparece no canal `chamadas` com a voz "MotoJÁ! Bora rodar!" em modo insistente (`FLAG_INSISTENT`): repete até alguém aceitar (o push `removed` cancela), a chamada expirar (`setTimeoutAfter`) ou o motoboy abrir o app.
- **Abrir o app para o alarme de reserva** (o painel assume o aviso).
- **Bateria:** `NexusNative.batteryUnrestricted()` e `NexusNative.openBatterySettings()`; o Perfil do motoboy mostra se o alerta contínuo está ligado e o botão para liberar a bateria.
- **Servidor:** a chamada não vai mais para o app nativo de quem está Indisponível (não mostrava nada e fazia o Android atrasar as mensagens urgentes do app).

Novidades da 1.0.6:
- **Tela acesa no GPS:** enquanto o motoboy está com o mapa de navegação aberto ou com corrida/entrega mandando GPS para o cliente, o site chama `NexusNative.keepScreenOn(true)` e o app liga `FLAG_KEEP_SCREEN_ON` (a tela não apaga, como no Google Maps). Ao fechar o mapa/finalizar, volta ao normal.
- **Som da notificação com o app fechado:** `res/raw/chamada.wav` agora é a própria voz “MotoJÁ! Bora rodar!” (antes era um bip-bip). Vale para quem recebe a notificação comum do canal `chamadas`.

O áudio aprovado “MotoJÁ! Bora rodar!” toca em loop com vibração enquanto existir chamada pendente autorizada. O serviço consulta o servidor a cada 3 segundos e também recebe a retirada da chamada por FCM. Aceite por qualquer motorista, cancelamento, expiração, indisponibilidade e encerramento da sessão interrompem o alerta. Uma tentativa de aceite ainda não confirmada não silencia a chamada. O modo silencioso, o modo de vibração e as permissões do aparelho são respeitados.

O serviço Android mantém o toque em segundo plano com uma notificação visível. A atualização do painel web, sozinha, não oferece a mesma garantia com a tela bloqueada. Instale a nova versão Android para usar esse serviço. O sistema ainda pode restringir a execução, por exemplo se o usuário bloquear notificações ou encerrar o aplicativo nas configurações.

## Compilar

Use JDK 17 ou 21, Android SDK e Gradle wrapper. Configure o SDK em `local.properties` e use o `app/google-services.json` do projeto Firebase já utilizado pelo aplicativo. Esses arquivos locais não são publicados.

```
gradlew.bat assembleDebug bundleRelease lintRelease
```

`assembleDebug` gera um APK com sufixo `.teste`, instalável ao lado da versão de produção. O bundle release só poderá ser enviado à Play Store após assinar com a chave de upload existente. Preencha `keystore.properties` a partir de `keystore.properties.example`, sem enviar esse arquivo ou a chave para o GitHub. Sem esse arquivo, o AAB gerado é **sem assinatura**.

## Validação necessária no aparelho

1. Entrar com um motoboy de teste, permitir notificações e selecionar Disponível.
2. Receber uma corrida e deixar tocar por mais de 30 segundos; repetir com a tela bloqueada.
3. Aceitar em outro celular e verificar a parada no aparelho que tocava.
4. Receber uma nova entrega e verificar que o alerta recomeça.
5. Conferir cancelamento, indisponibilidade, modo vibrar e modo silencioso.

Não é necessário criar corridas reais para executar a suíte isolada do backend. O Android compilou e passou no lint; a validação física de vibração, FCM e tela bloqueada depende de um aparelho.
