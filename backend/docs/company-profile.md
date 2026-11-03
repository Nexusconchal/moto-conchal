# Edição do cadastro da empresa

`POST /api/companies/me/profile` exige sessão da empresa, aprovação e limita a cinco chamadas por minuto por conta. Valida e aceita apenas empresa, responsável, endereço de retirada e WhatsApp de contato. Grava uma atualização com merge somente se houver mudança; não altera documento/identidade, saldo, reserva, senha, e-mail, status ou permissões.

O telefone original continua identificando a conta e sua recuperação. `telefoneContato` é um contato comercial editável, sem migração financeira. Novas entregas usam o contato salvo no servidor; o corpo enviado pelo navegador não pode substituí-lo. Entregas anteriores preservam seus dados. O contato é removido da lista pública de chamadas pendentes, seguindo a proteção do telefone original.

A interface mantém um rascunho separado do cadastro sincronizado. Cancelar ou fechar descarta o rascunho, salvar bloqueia cliques duplicados e erros preservam a edição. Respostas atrasadas de outra sessão são ignoradas. Chamadas manuais exigem salvar ou cancelar alterações antes de enviar. Não há escrita a cada tecla nem listener novo no Firebase.
