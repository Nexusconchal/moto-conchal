# Relatórios de entregas

O relatório da empresa consulta chamadas criadas no período escolhido, com a situação atual no momento da geração. Finalizações de chamadas criadas antes do período não entram nesse conjunto. A diária é listada pela data de ativação, separada do preço das entregas. O relatório não altera saldo, reservas, cancelamentos ou valores combinados.

- Autenticação e vínculo da empresa são conferidos antes da consulta e antes de usar o cache.
- Período máximo de 31 dias, até 500 chamadas. Excesso é marcado como parcial, com downloads bloqueados; o usuário deve reduzir o período.
- Índice `entregas: telefoneEmpresa ASC, criadaEm DESC`, criado no projeto `moto-conchal`, plano Spark. A configuração está em `firestore.indexes.json`.
- Consultas repetidas reaproveitam a resposta por 60 segundos, com até 10 respostas em memória. Não há consulta periódica automática.
- Excel/PDF são gerados no navegador usando os mesmos dados. Bibliotecas locais com versões fixas só são carregadas ao baixar; não há envio dos relatórios a um serviço externo.
- Campos exportados não incluem CPF do motoboy, WhatsApp ou nomes de recebedores. Strings no Excel são células de texto, sem fórmulas provenientes de nomes/endereço.
- Uma chamada em lote representa um serviço e N entregas. Os ganhos só entram após a conclusão, por meio dos registros e agregados já existentes.
- Lotes antigos com contador legado de uma entrega têm correção idempotente de quantidade, limitada a 100 lotes por motoboy na primeira consulta do processo. A correção não muda ganhos, dinheiro, número de serviços ou saldos. Falha nessa correção não impede acesso aos ganhos existentes.

Validação: `node --test backend/test/*.test.js`. Os testes incluem arquivos XLSX/PDF reais, contagem de lote, diária separada, chamadas pendentes/canceladas, proteção de sessão e de nomes com aparência de fórmula, além dos testes dos fluxos anteriores.
