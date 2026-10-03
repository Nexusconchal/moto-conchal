# Atendimento automático sem IA paga

O módulo `src/support-automation.js` usa regras e consulta o estado real da corrida. Não usa OpenAI, não cria corridas, não renova pedidos, não muda preço e não promete motorista ou prazo de chegada. Mantém as integrações de OTP e as notificações iniciais do Telegram existentes.

## Ativação

Abra `https://nexusmotoja.com.br/atendimento.html`, entre com a senha do dono e clique em **Ativar atendimento e avisos nos grupos**. O link também está na área Equipe suporte do painel do dono. A configuração exige que a instância de `EVOLUTION_INSTANCE` esteja conectada ao WhatsApp `5519992306488`, um único grupo com nome `Nexus MotoJá - MOTORISTA` e nenhuma outra integração de webhook ativa. Um webhook diferente é preservado e a configuração retorna erro para revisão.

Usa as variáveis existentes `EVOLUTION_API_URL`, `EVOLUTION_API_KEY`, `EVOLUTION_INSTANCE`, `BACKEND_BASE_URL` e as configurações atuais do Telegram. A rota `/api/admin/support-automation/setup` faz a mesma configuração com autenticação `x-owner-password`. Gera um segredo dedicado para o webhook, grava criptografado e confirma URL, eventos e cabeçalho salvos no provedor. Não altera a chave existente de envio nem o número conectado.

O webhook autenticado é `/api/support/whatsapp/webhook`, cabeçalho `x-motoja-webhook-secret`, eventos `MESSAGES_UPSERT` e `SEND_MESSAGE`. Mídia não é enviada em base64. Grupos, broadcasts, eventos de outras instâncias e mensagens antigas são ignorados. LIDs só são aceitos com mapeamento explícito para número em `remoteJidAlt`.

## Comportamento

- Responde a conversas individuais consultando exclusivamente corridas do número remetente. Um código informado também exige que o telefone da corrida corresponda ao remetente. Várias corridas ativas exigem informar o código.
- Áudios, imagens e localização pedem uma descrição em texto. O endereço recebido aqui não cria uma solicitação; o cliente é orientado a usar o app.
- `ATENDENTE` ou uma reclamação reconhecida registra um pedido na fila do painel. O bot pausa essa conversa por 30 minutos. Uma mensagem manual enviada pelo suporte também pausa o bot por 30 minutos. A fila exige acompanhamento por uma pessoa; não representa atendimento humano garantido.
- A cada minuto, envia avisos de corridas e entregas pendentes ao grupo WhatsApp confirmado. Após dois minutos, envia um lembrete ao WhatsApp e Telegram. Revalida estado e validade antes de enviar. Cada etapa/canal é tentada uma única vez por geração do pedido; renovação pode gerar novos avisos.
- Os novos avisos de grupo mostram valor, tipo e código, sem endereço, nome ou telefone do cliente. O aceite continua no app.
- Não reenvia automaticamente após timeout ambíguo do provedor, para evitar duplicatas. A disponibilidade da Evolution, WhatsApp, Telegram e hospedagem afeta o atendimento.

## Dados e operação

As coleções `supportAutomationEvents`, `supportAutomationChats` e `supportAutomationNotices` guardam hashes e metadados para evitar duplicatas; não armazenam o conteúdo da conversa. Eventos expiram em 24 horas; chats e avisos em 7 dias. A limpeza roda por hora em lotes de até 100 por coleção enquanto a automação está ativa. A fila guarda o telefone criptografado com AES-GCM e o código da corrida, acessíveis só ao dono. Tickets resolvidos são removidos após 7 dias. As regras Firestore do repositório negam acesso direto aos clientes.

Para pausar, use **Pausar automação** no painel; a mesma integração permanece conectada para OTP e demais funções existentes. A senha do dono fica apenas na memória da página de atendimento. Sem cobrança de IA, mas continuam os custos e limites dos serviços existentes.

Validação: `node --test backend/test/*.test.js` e `node --check backend/src/server.js`.
