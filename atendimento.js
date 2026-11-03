(() => {
  'use strict';
  const backend = 'https://motoboy-conchal.onrender.com';
  let password = '';
  const el = id => document.getElementById(id);
  async function api(path, method = 'GET', payload) {
    const response = await fetch(`${backend}/api/admin/support-automation${path}`, { method, headers: { 'x-owner-password': password, ...(payload ? { 'content-type': 'application/json' } : {}) }, ...(payload ? { body: JSON.stringify(payload) } : {}), cache: 'no-store', signal: AbortSignal.timeout(90000) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || ({ senha_incorreta: 'Senha incorreta.', conecte_whatsapp_suporte: 'Conecte o WhatsApp (19) 99230-6488 na integração.', webhook_existente_preservado: 'Já existe outra integração recebendo as mensagens. Ela foi preservada.', grupo_motoristas_nao_identificado: 'Não foi possível identificar um único grupo Nexus MotoJá - MOTORISTA.' }[data.error]) || 'Não consegui consultar o atendimento. Tente novamente.');
    return data;
  }
  async function refresh() {
    const data = await api('');
    const wa = data.whatsapp || {};
    const conexao = wa.connected ? 'CONECTADO' : wa.state === 'indisponivel' ? 'sem resposta da integração (Evolution fora do ar ou chave errada)' : 'DESCONECTADO — leia o QR Code de novo na Evolution';
    const ultimo = data.lastGroupNotice;
    const ultimoTexto = !ultimo ? 'nenhum desde a última reinicialização do servidor'
      : `${ultimo.status === 'sent' ? 'enviado' : 'FALHOU'} em ${new Date(ultimo.at).toLocaleString('pt-BR')}${ultimo.status === 'sent' ? '' : ` (${ultimo.error || 'erro'})`}`;
    const alertas = [];
    if (!data.enabled || !data.groupAlerts) alertas.push('⚠️ Os avisos nos grupos estão pausados: toque em "Ativar atendimento e avisos nos grupos".');
    if (!wa.connected) alertas.push('⚠️ Sem conexão do WhatsApp, os avisos não chegam no grupo (o Telegram continua).');
    el('status').textContent = `Atendimento: ${data.enabled ? 'ATIVO' : 'PAUSADO'}\nAvisos: ${data.groupAlerts ? 'ativos' : 'pausados'}\nGrupo WhatsApp: ${data.groupName || 'aguardando configuração'}\nConexão do WhatsApp: ${conexao}\nÚltimo aviso no grupo: ${ultimoTexto}${alertas.length ? `\n\n${alertas.join('\n')}` : ''}`;
    const aiLabel = ai => !ai?.configured ? 'aguardando chave' : !ai.enabled ? 'pausada' : ai.reason === 'quota' ? 'cota temporariamente atingida; usando reserva' : ai.reason ? 'indisponível; usando reserva' : 'habilitada';
    el('ai-status').textContent = `Gemini: ${aiLabel(data.gemini)} • OpenRouter: ${aiLabel(data.openrouter)}`;
    if (data.gemini?.model) el('gemini-model').value = data.gemini.model;
    el('tickets').replaceChildren();
    if (!data.tickets.length) el('tickets').textContent = 'Nenhum pedido aguardando.';
    for (const ticket of data.tickets.sort((a, b) => b.requestedAt - a.requestedAt)) {
      const row = document.createElement('li');
      const info = document.createElement('p');
      info.textContent = `${ticket.telefone || 'Telefone indisponível'} • ${new Date(ticket.requestedAt).toLocaleString('pt-BR')}${ticket.rideId ? ` • Corrida ${ticket.rideId}` : ''}`;
      row.append(info);
      if (ticket.mensagem) { const detail = document.createElement('p'); detail.textContent = ticket.mensagem; row.append(detail); }
      if (/^55\d{10,11}$/.test(ticket.telefone)) {
        const link = document.createElement('a'); link.href = `https://wa.me/${ticket.telefone}`; link.textContent = 'Abrir conversa'; link.target = '_blank'; link.rel = 'noopener'; row.append(link);
      }
      const button = document.createElement('button'); button.textContent = 'Marcar como atendido'; button.onclick = () => run(async () => { await api(`/tickets/${ticket.id}/resolve`, 'POST'); await refresh(); }); row.append(' ', button);
      el('tickets').append(row);
    }
  }
  async function run(action) {
    el('error').textContent = '';
    document.querySelectorAll('button').forEach(button => { button.disabled = true; });
    try { await action(); } catch (error) { el('error').textContent = error.message; }
    finally { document.querySelectorAll('button').forEach(button => { button.disabled = false; }); }
  }
  el('login-form').onsubmit = event => { event.preventDefault(); password = el('password').value; run(async () => { await refresh(); el('password').value = ''; el('login').hidden = true; el('panel').hidden = false; }); };
  el('refresh').onclick = () => run(refresh);
  el('setup').onclick = () => run(async () => { el('status').textContent = 'Verificando WhatsApp e grupo…'; await api('/setup', 'POST'); await refresh(); });
  el('pause').onclick = () => run(async () => { await api('/pause', 'POST'); await refresh(); });
  el('test-group').onclick = () => run(async () => { const result = await api('/test-group', 'POST'); await refresh(); el('error').textContent = result.message || 'Mensagem de teste enviada no grupo.'; });
  el('gemini-form').onsubmit = event => { event.preventDefault(); run(async () => { try { await api('/gemini', 'POST', { enabled: true, apiKey: el('gemini-key').value.trim(), model: el('gemini-model').value, freeTierConfirmed: el('gemini-free').checked }); await refresh(); } finally { el('gemini-key').value = ''; } }); };
  el('openrouter-form').onsubmit = event => { event.preventDefault(); run(async () => { try { await api('/openrouter', 'POST', { enabled: true, apiKey: el('openrouter-key').value.trim() }); await refresh(); } finally { el('openrouter-key').value = ''; } }); };
  el('gemini-pause').onclick = () => run(async () => { await api('/gemini', 'POST', { enabled: false }); await refresh(); });
  el('openrouter-pause').onclick = () => run(async () => { await api('/openrouter', 'POST', { enabled: false }); await refresh(); });
})();
