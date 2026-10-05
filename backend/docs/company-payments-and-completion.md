# Recargas e confirmação das entregas

## Mercado Pago

A recarga mantém o Checkout Pro e crédito líquido. `GET /api/companies/me/deposit` lê a última recarga ou um ID pertencente à sessão. `POST /api/companies/me/deposit/verify` confere o pagamento diretamente na API do recebedor, recuperando uma notificação atrasada. Ambos exigem conta aprovada, não usam valores de retorno do navegador como prova e limitam consultas a 10/minuto por conta. A verificação tem intervalo mínimo de 30 segundos e trava em memória por depósito; o webhook permanece o caminho principal.

O identificador de criação é vinculado à empresa e gravado antes de abrir a preferência. Repetições reutilizam o checkout, não criam outra preferência com o mesmo identificador. Preparações incompletas não são repetidas silenciosamente; a interface permite consultar e iniciar uma nova recarga explicitamente. Apenas URLs HTTPS de checkout nos domínios oficiais são aceitas. Não há fallback para checkout sandbox.

Webhook e conferência compartilham a mesma transação: referência, moeda, tipo, empresa, ID e valor são verificados; o saldo recebe o líquido confirmado uma vez, preservando outras reservas. Notificações antigas não rebaixam uma recarga aprovada. Estorno total confirmado reverte o crédito uma vez e não permite recreditar por evento antigo. Um segundo pagamento de uma recarga já creditada requer conferência do suporte, não gera crédito extra automático. Estornos de recargas automáticas devem ser feitos no Mercado Pago; o cancelamento manual de crédito fica restrito ao Pix manual.

A tela mostra última recarga, continuar pagamento, conferir pagamento, código e valores pago/taxa/crédito. Valores ilustrativos fixos de tarifas foram removidos. Há consulta na entrada da conta, retorno do checkout, abertura do Financeiro e retorno à aba com recarga pendente, sem polling permanente nem leitura do histórico inteiro. Exportações e regras de diária/preços não mudam.

## Entregas de empresas

Novas entregas comuns, com endereço ou com notas, recebem no servidor `confirmacaoEmpresaVersao: 1`. Integrações que criam entregas diretamente também recebem essa regra. O cliente não pode removê-la. Entregas antigas e escalas exclusivas preservam seu fluxo anterior.

A loja confirma a retirada no app autenticado; depois o motoboy inicia o GPS. O servidor rejeita retirada sem autorização da loja. Quando o motoboy solicita conclusão, as verificações existentes de retirada, tempo mínimo, GPS e confirmação do lote são mantidas, mas não há desconto nem ganho ainda. A chamada permanece `retirada` com `conclusaoStatus: aguardando_empresa`, rastreamento parado e reserva preservada. Repetições não renovam horário ou evidência.

A empresa aprova com uma transação única que desconta a reserva da chamada e registra o ganho conforme a tabela já aplicada. Pode também informar um problema com motivo. O motoboy pode registrar problema independentemente. Contestações mantêm dinheiro reservado, não podem ser aprovadas novamente pela empresa e não bloqueiam outras chamadas do motorista. Não há aprovação ou devolução automática por decurso de tempo.

O painel do dono lista pendências e contestações, inclusive fora do filtro do relatório atual, com alerta visual após uma hora. O dono pode confirmar serviço pelo `force-finish` existente, com motivo, cobrando o valor reservado e registrando ganho uma vez, ou recusar a conclusão e liberar somente aquela reserva. Chamadas protegidas não permitem alteração do preço durante a finalização nem cobrança posterior de conclusão recusada. Cancelamento pelo motorista após retirada autorizada é bloqueado dentro da transação, inclusive numa corrida concorrente com a aprovação de retirada.

Confirmações de retirada, solicitação, aprovação e contestação são registradas na subcoleção da entrega em eventos únicos; a decisão do dono também tem registro com motivo. Regras de cobrança e relatório continuam baseadas em `finalizada`, portanto pendências não entram como ganho ou entrega cobrada. GPS e confirmação da loja ajudam na conferência, mas não são prova independente de recebimento de cada cliente.

Não foram criados novos índices, varreduras periódicas nem alterações no plano Firebase. Novas escritas acontecem apenas nas ações de confirmação/contestação. A fila do dono reaproveita os dados já carregados pelo painel.
