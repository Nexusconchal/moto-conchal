# Alerta contínuo do motoboy

Som aprovado: `audio/motoja-bora-rodar-v1.wav`. O cliente web repete o próprio arquivo via Web Audio, sem limite de ciclos, e solicita vibração enquanto houver ofertas pendentes. O aceite é validado no servidor; fechar uma prévia do mapa não silencia ofertas que continuam disponíveis.

`POST /api/drivers/:cpf/call-alerts` exige a autenticação existente do motorista e reconcilia até 30 IDs de corrida/entrega. Só retorna metadados de chamadas pendentes autorizadas para as cidades e os serviços do motorista. Não retorna endereços ou dados de clientes. Chamadas aceitas, canceladas, expiradas, exclusivas ou reservadas para outro motorista são removidas.

O namespace autenticado `/driver-availability` informa mudanças imediatas. A consulta a cada 3 segundos cobre perda de evento ou aceite em outro celular. FCM de controle chega somente a Androids que registraram `callAlertVersion: 1`; aparelhos antigos e web mantêm a notificação compatível. O áudio e o token autenticado não são enviados a outros serviços.

O novo Android usa serviço em primeiro plano, áudio com `setLooping(true)` e vibração repetida. A sessão existente fica cifrada no armazenamento privado com Android Keystore. O serviço exige confirmação do backend antes de tocar e encerra após a chamada deixar de ser elegível. Sem rede, um chamado já confirmado continua somente até a próxima reconciliação ou sua expiração. Não há limite arbitrário de 8 repetições.

## Entrega e verificação

- Publicar backend e arquivos do motoboy juntos.
- A versão Android necessária é 1.0.5, versionCode 6; código em `playstore/motorista-alerta-continuo`.
- A experiência web depende de interação do usuário para liberar o áudio e da execução permitida pelo navegador. A tela bloqueada requer a nova versão Android.
- `npm test`: ciclo por 6 minutos, aceite por outro aparelho, resposta atrasada, próxima entrega, indisponibilidade, expiração, permissões por cidade/serviço e compatibilidade FCM.
- Compilação e lint Android executados. Vibração física, FCM e execução com tela bloqueada precisam de validação num Android real.

Clientes, empresas e MotoJÁ Food não recebem alterações de interface neste trabalho.
