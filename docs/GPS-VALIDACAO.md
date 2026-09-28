# GPS: validacao e publicacao

## Alteracoes

- Consulta de entregas filtra status ativos no Firestore antes do limite de 100.
- Uma captura GPS por pagina do motorista, compartilhada entre os servicos.
- Envio no maximo a cada 8 segundos por servico; parado, heartbeat em 20 segundos.
- Servidor valida idade, precisao, sequencia e deslocamento dos pontos e impõe intervalo minimo de 5 segundos entre gravacoes.
- A transacao confere dono e status antes de gravar, evitando restaurar GPS apos finalizacao concorrente.
- Empresa recebe Socket.IO e faz reconciliacao a cada 60 segundos com socket conectado, 15 segundos sem socket.
- Marcadores interpolam pontos recebidos; nao representam uma posicao medida entre duas amostras e nao fazem map matching.
- Posicao sem atualizacao por 30 segundos e marcada como atrasada.
- Passageiro exige aparelho de origem (identificador aleatorio local) ou sessao da conta associada. O identificador nao e mais enviado nas listas do motorista.
- ETA usa duracao da rota, sem informacao de transito ao vivo.

## Testes locais

`node --test backend/test/tracking.test.js`

`node --check backend/src/server.js`

`RUNTIME_NODE_MODULES` deve apontar para uma instalacao de Playwright ao executar `node backend/test/tracking-browser.cjs`. O teste usa Chrome no Windows e Leaflet; todos os endpoints operacionais sao simulados. Nenhuma corrida, saldo ou posicao e escrita em producao.

## Publicacao coordenada

1. Publicar frontend/cache v187 e backend juntos. Passageiros com pagina antiga precisam recarregar para enviar o novo cabecalho de acompanhamento; nao apagar dados locais ou sessoes.
2. Verificar a consulta de entregas ativas na configuracao de indices do projeto. Caso retorne erro de indice, criar apenas o indice solicitado para empresaId + status; nao substituir a configuracao inteira do Firebase.
3. Verificar o rastreamento com passageiro no aparelho de origem, passageiro autenticado e acesso negado por aparelho de terceiro, inclusive quando a resposta estiver em cache.
4. Validar com motorista autorizado: retirada, deslocamento, alternancia de abas, perda/retorno de rede, finalizacao e cancelamento concorrentes.
5. Medir atraso ponta a ponta, consumo de bateria e leituras/gravacoes com varios motoristas em campo antes de aumentar frequencia.

## Limites ainda existentes

- Este repositorio nao contem implementacao Android nativa de localizacao em foreground service. Navegador/PWA nao garante captura com tela apagada ou aplicativo suspenso.
- Autenticacao do motorista ainda utiliza a comprovacao legada (CPF/CNH/telefone). A migracao para sessoes revogaveis exige alteracoes coordenadas em login e demais endpoints, preservando usuarios atuais.
- Identificadores de aparelhos presentes em respostas de versoes antigas nao podem ser revogados apenas removendo-os das respostas novas. Para uma migracao de seguranca completa, substituir a autorizacao de convidado por credencial exclusiva da corrida e prever recuperacao autenticada.
- Ainda e necessario testar em aparelhos reais. Testes locais de navegador nao comprovam comportamento do GPS, economia de bateria ou disponibilidade do servidor em producao.
- O limite de 100 entregas ativas permanece; operacoes acima dele precisam de paginacao.
