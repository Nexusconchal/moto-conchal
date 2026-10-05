(() => {
  const money = value => Number(value || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const labels = { approved: 'Aprovada', aprovado: 'Saldo creditado', aguardando_pagamento: 'Aguardando pagamento',
    criando_pagamento: 'Preparando pagamento', falha_preparacao: 'Não foi possível preparar o pagamento', pending: 'Pagamento pendente', in_process: 'Pagamento em análise',
    rejected: 'Pagamento recusado', cancelled: 'Pagamento cancelado', refunded: 'Pagamento devolvido',
    charged_back: 'Pagamento contestado', credito_estornado: 'Crédito estornado', pagamento_divergente: 'Pagamento precisa de conferência' };
  function checkout(value) {
    try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password
      && ['www.mercadopago.com.br','www.mercadopago.com','mercadopago.com.br','mercadopago.com'].includes(u.hostname)
      && u.pathname.startsWith('/checkout/') ? u.href : ''; } catch { return ''; }
  }
  window.MotojaCompanyDeposits = { create(options) {
    const $ = id => document.getElementById(id);
    let owner = '', current = null, busy = false, loadedAt = 0;
    let lastFocusCheck = 0, generation = 0, operation = '', mode = options.mode();
    const automatic = () => options.mode() === 'mercadopago';
    const active = (who, ticket) => who === identity() && options.authenticated() && automatic() && ticket === generation;
    const feedback = (message, error = false) => {
      $('recargaFeedback').textContent = message;
      $('recargaFeedback').style.color = error ? '#fca5a5' : '';
    };
    const identity = () => String(options.account() || '');
    const storageKey = () => `motojaRecarga:${identity()}`;
    const saved = () => { try { return JSON.parse(localStorage.getItem(storageKey()) || '{}'); } catch { return {}; } };
    const remember = value => { try { localStorage.setItem(storageKey(), JSON.stringify(value)); } catch {} };
    function render() {
      const box = $('recargaAutomatica');
      box.style.display = automatic() && current ? 'grid' : 'none';
      $('recargaValores').style.display = automatic() ? 'grid' : 'none';
      $('recargaTitulo').textContent = current ? labels[current.status] || 'Aguardando confirmação' : 'Recarga automática';
      $('recargaTexto').textContent = !current
        ? 'Escolha o valor e pague no checkout seguro. O saldo entra após a confirmação do Mercado Pago.'
        : current.status === 'criando_pagamento' ? `Preparando sua recarga de ${money(current.valor)}...`
        : current.status === 'falha_preparacao' ? `Não consegui preparar a recarga de ${money(current.valor)}. Tente solicitar novamente.`
        : current.creditado ? `Pagamento: ${money(current.valorBruto)} · Taxa: ${money(current.taxaMercadoPago)} · Saldo creditado: ${money(current.valorCreditado)}.`
        : current.status === 'credito_estornado' ? 'O crédito desta recarga foi estornado. Fale com o suporte em caso de dúvida.'
        : current.status === 'pagamento_divergente' ? 'O valor recebido não confere com a recarga. O saldo não foi liberado; procure o suporte.'
        : `Recarga de ${money(current.valor)}. Se já pagou, toque em “Conferir pagamento”. Não é necessário enviar comprovante para aprovação automática.`;
      $('recargaCodigo').textContent = current?.id ? `Código: ${current.id}` : '';
      const url = checkout(current?.checkoutUrl);
      $('continuarRecarga').hidden = !url;
      if (url) $('continuarRecarga').href = url; else $('continuarRecarga').removeAttribute('href');
      $('conferirRecarga').hidden = !current?.id || current.creditado || current.status === 'credito_estornado';
      $('conferirRecarga').disabled = busy;
      $('novaRecarga').hidden = !current;
      $('novaRecarga').disabled = busy;
      $('conferirRecarga').textContent = busy ? 'Conferindo...' : 'Conferir pagamento';
    }
    function apply(data, who, ticket) {
      if (!active(who, ticket)) return false;
      current = data.deposit || null;
      loadedAt = Date.now();
      if (data.balance) options.balance(data.balance);
      if (current) remember({ ...saved(), depositId: current.id });
      render(); return true;
    }
    async function load(force = false) {
      const who = identity();
      if (!who || !options.authenticated() || !automatic() || busy) { render(); return; }
      if (owner !== who) { owner = who; current = null; loadedAt = 0; feedback(''); }
      if (!force && Date.now() - loadedAt < 30000) { render(); return; }
      const params = new URLSearchParams(location.search);
      const fromReturn = params.get('depositId');
      const id = fromReturn || saved().depositId || '';
      if (!id) { loadedAt = Date.now(); render(); return; }
      const ticket = ++generation;
      busy = true; operation = 'load'; render();
      try {
        const result = await options.api(`/api/companies/me/deposit${id ? `?id=${encodeURIComponent(id)}` : ''}`);
        if (!apply(result, who, ticket)) return;
        if (result.available === false) feedback('A recarga automática está indisponível. Use o Pix manual ou fale com o suporte.', true);
        if (params.has('deposito')) {
          for (const key of ['deposito','depositId','payment_id','collection_id','collection_status','status','external_reference','payment_type','merchant_order_id','preference_id','site_id','processing_mode','merchant_account_id']) params.delete(key);
          history.replaceState(null, '', location.pathname + (params.size ? `?${params}` : '') + location.hash);
          window.dispatchEvent(new Event('motoja:finance-open'));
          feedback('Conferindo o pagamento com o Mercado Pago...');
          busy = false;
          if (current && !current.creditado) await verify();
          else if (current?.creditado) feedback('Recarga confirmada. O saldo já está disponível.');
        }
      } catch (error) { if (active(who, ticket)) feedback(error.message || 'Não consegui carregar a recarga. Tente novamente.', true); }
      finally { if (ticket === generation) { busy = false; operation = ''; render(); } }
    }
    async function verify() {
      const who = identity();
      if (!who || !current?.id || busy || !options.authenticated() || !automatic()) return;
      const id = current.id;
      const ticket = ++generation;
      busy = true; operation = 'verify'; render(); feedback('Consultando a confirmação do Mercado Pago...');
      try {
        const data = await options.api('/api/companies/me/deposit/verify', { depositId: id });
        if (!apply(data, who, ticket)) return;
        feedback(current?.creditado ? 'Pagamento confirmado. Saldo atualizado.' : 'Ainda não há crédito confirmado. Se acabou de pagar, aguarde um pouco e confira novamente.');
      } catch (error) { if (active(who, ticket)) feedback(error.message || 'Não consegui conferir. Seu saldo não foi alterado por esta tentativa.', true); }
      finally { if (ticket === generation) { busy = false; operation = ''; render(); } }
    }
    async function start(value) {
      const who = identity();
      if (!who || !options.authenticated()) throw new Error('Entre na conta da empresa para recarregar.');
      if (!automatic()) throw new Error('Escolha Automático Mercado Pago para criar esta recarga.');
      if (!Number.isFinite(value) || value < 10 || value > 5000) throw new Error('Informe entre R$ 10,00 e R$ 5.000,00.');
      if (busy && operation === 'start') return;
      const previous = saved();
      const requestId = previous.requestId && previous.valor === value && !previous.depositId ? previous.requestId : crypto.randomUUID();
      remember({ requestId, valor: value });
      const ticket = ++generation;
      current = { valor: value, status: 'criando_pagamento' };
      busy = true; operation = 'start'; render(); feedback('Preparando checkout seguro...');
      try {
        const data = await options.api('/api/companies/deposit-preference', { valor: value, requestId });
        if (!active(who, ticket)) return;
        remember({ requestId, valor: value, depositId: data.depositId });
        const url = checkout(data.initPoint);
        if (data.status === 'aprovado') { busy = false; await load(true); return; }
        if (!url) throw new Error('Não foi possível abrir o checkout. Confira a recarga antes de tentar novamente.');
        current = { id: data.depositId, valor: value, status: 'aguardando_pagamento', checkoutUrl: url };
        render(); feedback('Checkout criado. Você será direcionado ao Mercado Pago.');
        options.navigate(url);
      } catch (error) {
        if (active(who, ticket)) {
          current = { valor: value, status: 'falha_preparacao' };
          if (error.depositId) { remember({ ...saved(), depositId: error.depositId }); busy = false; await load(true); }
          feedback(error.message || 'Não foi possível criar a recarga. Tente novamente.', true);
        }
        throw error;
      } finally { if (ticket === generation) { busy = false; operation = ''; render(); } }
    }
    $('conferirRecarga').onclick = verify;
    $('novaRecarga').onclick = () => { if (busy) return; remember({}); current = null; loadedAt = Date.now(); feedback('Informe o valor para uma nova recarga. Um pagamento anterior pendente ainda pode ser confirmado.'); render(); $('valorDeposito').focus(); };
    document.querySelectorAll('[data-recarga-valor]').forEach(button => button.onclick = () => { $('valorDeposito').value = button.dataset.recargaValor; $('valorDeposito').dispatchEvent(new Event('input')); $('valorDeposito').focus(); });
    document.addEventListener('visibilitychange', () => {
      if (!automatic() || document.visibilityState !== 'visible' || !current?.id || current.creditado || current.status === 'credito_estornado' || Date.now() - lastFocusCheck < 30000) return;
      lastFocusCheck = Date.now(); verify();
    });
    return { start, load, refreshMode() {
      if (mode !== options.mode()) { mode = options.mode(); generation++; busy = false; operation = ''; feedback(''); }
      render();
    }, reset() { generation++; busy = false; operation = ''; owner = ''; current = null; loadedAt = 0; feedback(''); render(); } };
  } };
})();
