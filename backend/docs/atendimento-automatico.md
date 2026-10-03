# Atendimento automático com IAs gratuitas e reserva por regras

O módulo `src/support-automation.js` consulta o estado real da corrida e mantém o atendimento por regras. Pode usar Gemini e OpenRouter para dúvidas gerais, nesta ordem, voltando às regras quando ambos falham. Não usa OpenAI, não cria corridas, não renova pedidos e não muda preço. Mantém as integrações de OTP e as notificações iniciais do Telegram existentes.

## Gemini e OpenRouter

No painel do atendimento, configure as chaves separadamente. A ativação testa uma dúvida genérica e só grava a chave criptografada após obter uma resposta válida. Nunca devolve a chave na API do painel. As rotas `/api/admin/support-automation/gemini` e `/api/admin/support-automation/openrouter` usam a autenticação existente do dono e o limitador de tentativas. Enviar `{enabled:false}` pausa somente aquele provedor.

Gemini exige a confirmação de um projeto **Free Tier sem faturamento vinculado**. O app não ativa faturamento e não consegue detectar se o titular vincular faturamento ao projeto depois; a gratuidade depende do projeto permanecer no nível gratuito. Modelos permitidos: `gemini-3.5-flash-lite` e `gemini-3.1-flash-lite`, com cotas gratuitas conforme [preços do Google](https://ai.google.dev/gemini-api/docs/pricing). A assinatura do aplicativo Gemini não cobre a API.

A reserva OpenRouter usa exclusivamente `openrouter/free`, com `max_price` zero para entrada e saída, `data_collection:deny` e `require_parameters:true`. Não há modelos pagos nem troca para modelo pago. Se não houver um modelo gratuito disponível com a política de dados e saída JSON exigidas, mantém as regras. Ver [OpenRouter](https://openrouter.ai/collections/free-models) e [roteamento](https://openrouter.ai/docs/guides/routing/provider-selection).

Contadores atômicos em `supportAutomationUsage` sobrevivem aos reinícios: até 100 chamadas Gemini e 50 OpenRouter por dia UTC, com 4 por minuto em cada serviço. Esses são limites locais conservadores; o provedor pode permitir menos. Erros 429 pausam o provedor por 5 minutos; indisponibilidade pausa por um minuto. Cada chamada tenta uma vez e tem timeout (8 segundos Gemini, 12 OpenRouter). A reserva tem um pouco mais de tempo para acomodar a latência dos modelos gratuitos. Não há busca externa, ferramentas, SDK adicional ou geração de mídia.

Telefone, registro da corrida, código e cadastro do cliente nunca são parâmetros enviados às IAs. O texto é filtrado para contatos, endereços e códigos; certas credenciais/documentos impedem a chamada. Essa filtragem é uma redução de dados, não garantia de anonimato: texto livre pode conter dados não reconhecidos. O Gemini gratuito pode usar prompts para melhorar seus produtos. Saídas inválidas, declarações de ações executadas, valores, prazos numéricos e links externos são recusados. Status da corrida, mídia, MENU, opções numéricas e ATENDENTE permanecem determinísticos. O histórico da conversa de IA fica criptografado no chat, limitado a quatro turnos filtrados e válido por 30 minutos; MENU ou respostas por regras limpam esse contexto. Reclamações podem ser encaminhadas ao mesmo ticket humano, com mensagem de confirmação fixa do app.

## Ativação

Abra `https://nexusmotoja.com.br/atendimento.html`, entre com a senha do dono e clique em **Ativar atendimento e avisos nos grupos**. O link também está na área Equipe suporte do painel do dono. A configuração exige que a instância de `EVOLUTION_INSTANCE` esteja conectada ao WhatsApp `5519992306488`, um único grupo com nome `Nexus MotoJá - MOTORISTA` e nenhuma outra integração de webhook ativa. Um webhook diferente é preservado e a configuração retorna erro para revisão.

Usa as variáveis existentes `EVOLUTION_API_URL`, `EVOLUTION_API_KEY`, `EVOLUTION_INSTANCE`, `BACKEND_BASE_URL` e as configurações atuais do Telegram. A rota `/api/admin/support-automation/setup` faz a mesma configuração com autenticação `x-owner-password`. Gera um segredo dedicado para o webhook, grava criptografado e confirma URL, eventos e cabeçalho salvos no provedor. Não altera a chave existente de envio nem o número conectado.

O webhook autenticado é `/api/support/whatsapp/webhook`, cabeçalho `x-motoja-webhook-secret`, eventos `MESSAGES_UPSERT` e `SEND_MESSAGE`. Mídia não é enviada em base64. Grupos, broadcasts, eventos de outras instâncias e mensagens antigas são ignorados. LIDs só são aceitos com mapeamento explícito para número em `remoteJidAlt`.

## Comportamento

- Responde a conversas individuais consultando exclusivamente corridas do número remetente. Um código informado também exige que o telefone da corrida corresponda ao remetente. Várias corridas ativas exigem informar o código.
- Áudios, imagens e localização pedem uma descrição em texto. O endereço recebido aqui não cria uma solicitação; o cliente é orientado a usar o app.
- Saudações mostram opções para pedir corrida, acompanhar, endereço/erro, pagamento/troco e atendimento humano. Aceita números e frases, lembra o assunto para a próxima mensagem e aceita escolhas imediatas sem o antigo bloqueio de 15 segundos. Não é um modelo de IA generativa.
- `ATENDENTE`, opção `5` ou uma reclamação reconhecida registra um pedido na fila do painel. O bot pede uma descrição; as mensagens seguintes durante a pausa atualizam o último detalhe criptografado no ticket. O bot pausa essa conversa por 30 minutos. `MENU` reativa a ajuda automática sem apagar o pedido humano. Uma mensagem manual enviada pelo suporte também pausa o bot por 30 minutos. A fila exige acompanhamento por uma pessoa; não representa atendimento humano garantido.
- A cada minuto, envia avisos de corridas e entregas pendentes ao grupo WhatsApp confirmado. Após dois minutos, envia um lembrete ao WhatsApp e Telegram. Revalida estado e validade antes de enviar. Cada etapa/canal é tentada uma única vez por geração do pedido; renovação pode gerar novos avisos.
- Os novos avisos de grupo mostram valor, tipo e código, sem endereço, nome ou telefone do cliente. O aceite continua no app.
- Não reenvia automaticamente após timeout ambíguo do provedor, para evitar duplicatas. A disponibilidade da Evolution, WhatsApp, Telegram e hospedagem afeta o atendimento.

## Dados e operação

As coleções `supportAutomationEvents`, `supportAutomationChats` e `supportAutomationNotices` guardam hashes, assunto e metadados para evitar duplicatas. Chats podem conter o histórico curto e filtrado da IA, criptografado. Eventos expiram em 24 horas; chats e avisos em 7 dias. A limpeza roda por hora em lotes de até 100 por coleção enquanto a automação está ativa. A fila guarda o telefone e o último detalhe do pedido humano criptografados com AES-GCM e o código da corrida, acessíveis só ao dono. Tickets resolvidos são removidos após 7 dias. As regras Firestore do repositório negam acesso direto aos clientes.

Para pausar, use **Pausar automação** no painel; a mesma integração permanece conectada para OTP e demais funções existentes. A senha do dono fica apenas na memória da página de atendimento. Sem cobrança de IA, mas continuam os custos e limites dos serviços existentes.

Validação: `node --test backend/test/*.test.js` e `node --check backend/src/server.js`.
