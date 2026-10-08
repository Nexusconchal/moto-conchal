# Disponibilidade voluntária dos motoboys

O motorista inicia indisponível e escolhe Disponível no topo. Apenas sessões autenticadas pelo mesmo mecanismo do painel podem alterar essa escolha. O cliente recebe somente a quantidade por cidade de atendimento; nenhum identificador, telefone, documento ou coordenada é publicado.

O contador exclui motoristas sem sessão conectada, sem heartbeat nos últimos 90 segundos, indisponíveis ou com corrida/entrega aceita ou retirada. Abas do mesmo CPF são deduplicadas e compartilham a escolha. Bloqueio do dono revoga as sessões de disponibilidade imediatamente. A preferência não cancela trabalhos já aceitos, não muda valores, reservas ou confirmação das entregas.

Presença, heartbeats e contagem ficam na memória do processo Render. Não há escrita no Firestore. Ao conectar um motorista, três consultas já indexadas verificam os trabalhos ativos (corridas aceitas, entregas aceitas e retiradas); sessões simultâneas compartilham a inicialização. A autenticação reaproveita o cache existente de cinco minutos e é revalidada nesse intervalo. Não há consulta de trabalhos em cada heartbeat. Os eventos do fluxo existente atualizam a ocupação após sucesso no servidor.

O cliente atualiza a contagem a cada 20 segundos enquanto a página está visível. Falha de conexão exibe disponibilidade não confirmada, não uma contagem antiga. O painel deixa de anunciar disponibilidade enquanto está oculto; o motoboy precisa manter o painel aberto. Avisos dos grupos de Telegram/WhatsApp continuam independentes da preferência individual do painel.

Esta implementação pressupõe a instância única atual do Render. Se o backend passar a várias instâncias, será necessário um armazenamento de presença compartilhado com TTL (por exemplo Redis) antes de escalar, para agregar todas as conexões. Reiniciar a instância zera a presença e os painéis reconectam com segurança; não restaura uma contagem antiga. Clientes antigos continuam operando, mas só quem usa o controle novo aparece na contagem.

Os controles novos filtram a lista de serviços pendentes no painel atualizado; Minhas corridas, Minhas entregas e ganhos permanecem acessíveis. Não há distribuição exclusiva de ofertas, recusa com prazo ou alteração do modelo de aceitação nesta entrega.

Validação: testes de presença, autenticação e isolamento Socket.IO, abas simultâneas, rate limiting, concorrência com aceite/conclusão, revogação e expiração; regressão de pagamentos e conclusão; navegador real em celular e desktop.
