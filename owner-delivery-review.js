(() => {
  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const money = value => Number(value || 0).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
  const ms = value => value?.seconds ? value.seconds * 1000 : value?._seconds ? value._seconds * 1000 : Number(value || 0);
  window.MotojaOwnerDeliveryReview = { render(deliveries, options) {
    const section = document.getElementById('entregas-section');
    if (!section) return;
    let box = document.getElementById('ownerDeliveryReview');
    if (!box) { box = document.createElement('section'); box.id = 'ownerDeliveryReview'; box.className='box'; section.prepend(box); }
    const pending = deliveries.filter(item => item.confirmacaoEmpresaVersao === 1 && ['aceita','retirada'].includes(item.status)
      && ['aguardando_empresa','contestada'].includes(item.conclusaoStatus)).sort((a,b) => ms(a.conclusaoSolicitadaEm || a.contestadaEm)-ms(b.conclusaoSolicitadaEm || b.contestadaEm));
    box.innerHTML = `<h2>Entregas aguardando conferência (${pending.length})</h2><p class="muted">Confirme com as partes antes de decidir. O saldo permanece reservado; nenhuma decisão é automática.</p>`
      + (pending.length ? pending.map(item => {
        const elapsed = Math.max(0,Math.floor((Date.now()-ms(item.conclusaoSolicitadaEm || item.contestadaEm))/60000));
        return `<article style="padding:14px;border:1px solid #46505c;border-radius:10px;margin-top:12px;display:grid;gap:10px">
          <strong>${escape(item.empresa)} · ${escape(item.motoboy || 'Motoboy')} · ${Math.max(1,Number(item.paradas || 1))} entrega(s) · ${money(item.saldoReservado || item.valor)}</strong>
          <p>${item.conclusaoStatus === 'contestada' ? 'Problema registrado' : 'Empresa ainda não confirmou'} · ${elapsed} min aguardando${elapsed >= 60 ? ' — conferir com prioridade' : ''}</p>
          ${item.contestacaoMotivo ? `<p>Motivo: ${escape(item.contestacaoMotivo)} · ${escape(item.contestacaoPor || '')}</p>` : ''}
          <small>Código: ${escape(item.id)}</small>
          <div style="display:flex;gap:10px;flex-wrap:wrap"><button class="approve" type="button" data-review="approve" data-id="${escape(item.id)}">Confirmar serviço e descontar saldo</button><button class="danger" type="button" data-review="deny" data-id="${escape(item.id)}">Recusar conclusão e liberar reserva</button></div>
        </article>`;
      }).join('') : '<p>Nenhuma entrega pendente de decisão.</p>');
    box.querySelectorAll('[data-review]').forEach(button => button.onclick = async () => {
      const delivery = pending.find(item => item.id === button.dataset.id);
      if (!delivery) return;
      const approve = button.dataset.review === 'approve';
      const reason = prompt(approve ? 'Como você confirmou que o serviço foi realizado? Motivo obrigatório (10 a 500 caracteres):' : 'Por que o serviço não deve ser cobrado? Motivo obrigatório (10 a 500 caracteres):');
      if (reason === null) return;
      if (reason.trim().length < 10 || reason.trim().length > 500) { alert('Descreva o motivo em 10 a 500 caracteres.'); return; }
      const value = Number(delivery.saldoReservado || delivery.valor || 0);
      if (!confirm(approve ? `Confirmar o serviço e descontar ${money(value)} da empresa?` : `Recusar a conclusão e liberar a reserva de ${money(value)}, sem registrar ganho?`)) return;
      button.disabled = true;
      try {
        const response = await fetch(`${window.CONFIG.backend}/api/admin/deliveries/${encodeURIComponent(delivery.id)}/${approve ? 'force-finish' : 'deny-completion'}`, {
          method:'POST',headers:{'content-type':'application/json','x-owner-password':options.password()},
          body:JSON.stringify({reason:reason.trim(), ...(approve ? { valor:value,driverCpf:delivery.motoboyCpf } : {})})
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.message || 'Não consegui registrar a decisão.');
        await options.refresh();
      } catch (error) { alert(error.message); button.disabled = false; }
    });
  } };
})();
