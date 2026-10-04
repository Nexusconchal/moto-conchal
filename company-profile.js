(function () {
  'use strict';
  window.MotojaCompanyProfile = { create(options) {
    const fields = ['empresa', 'responsavel', 'telefoneContato', 'retirada'];
    const el = id => document.getElementById(id);
    const read = () => Object.fromEntries(fields.map(key => [key, el(key).value.trim()]));
    const write = data => fields.forEach(key => { el(key).value = data[key] || ''; });
    let committed = null, busy = false;
    const feedback = (text, error = false) => {
      el('cadastroFeedback').textContent = text;
      el('cadastroFeedback').style.color = error ? '#ffb366' : '#86efac';
    };
    const dirty = () => !!committed && fields.some(key => read()[key] !== committed[key]);
    const lock = value => {
      busy = value;
      fields.forEach(key => { el(key).disabled = value; });
      ['salvarCadastroLoja', 'cancelarCadastroLoja', 'editarCadastroLoja'].forEach(key => { el(key).disabled = value; });
      el('salvarCadastroLoja').textContent = value ? 'Salvando...' : 'Salvar alterações';
    };
    const close = () => {
      el('cadastroLoja').classList.add('hidden');
      el('editarCadastroLoja').textContent = 'Editar cadastro da loja';
      el('editarCadastroLoja').setAttribute('aria-expanded', 'false');
    };
    const restore = () => { if (committed) write(committed); options.changed(); };
    el('editarCadastroLoja').onclick = () => {
      if (busy) return;
      if (!committed) return options.notice('Aguarde a sincronização do cadastro.');
      if (!el('cadastroLoja').classList.contains('hidden')) { restore(); feedback(''); close(); return; }
      write(committed); feedback(''); el('cadastroLoja').classList.remove('hidden');
      el('editarCadastroLoja').textContent = 'Fechar cadastro';
      el('editarCadastroLoja').setAttribute('aria-expanded', 'true');
    };
    el('cancelarCadastroLoja').onclick = () => { if (busy) return; restore(); feedback(''); close(); options.notice('Alterações descartadas.'); };
    el('salvarCadastroLoja').onclick = async () => {
      if (busy || !committed) return;
      if (!dirty()) { feedback('O cadastro já está salvo.'); return; }
      const draft = read(), identity = options.identity();
      if (!identity) return feedback('Entre na conta para salvar.', true);
      if (!draft.empresa || !draft.responsavel || !draft.retirada || !/^[1-9]\d{9,10}$/.test(draft.telefoneContato)) return feedback('Preencha empresa, responsável, endereço e WhatsApp com DDD.', true);
      lock(true); feedback('');
      try {
        const company = await options.save(draft);
        if (options.identity() !== identity) return;
        committed = { empresa: company.empresa, responsavel: company.responsavel, retirada: company.retirada, telefoneContato: company.telefoneContato || company.telefoneEmpresa };
        write(committed); options.saved(company); options.changed(); feedback('Cadastro salvo na sua conta.');
      } catch (error) { if (options.identity() === identity) feedback(error.message || 'Não consegui salvar. Tente novamente.', true); }
      finally { lock(false); }
    };
    fields.forEach(key => el(key).addEventListener('input', () => { feedback(dirty() ? 'Alterações ainda não salvas.' : ''); options.changed(); }));
    el('telefoneContato').addEventListener('input', () => { el('telefoneContato').value = el('telefoneContato').value.replace(/\D/g, '').slice(0, 11); });
    return {
      sync(company) {
        committed = { empresa: company.empresa || '', responsavel: company.responsavel || '', retirada: company.retirada || '', telefoneContato: company.telefoneContato || company.telefoneEmpresa || '' };
        write(committed);
      },
      canRequest() {
        if (busy || dirty()) { options.notice('Salve as alterações do cadastro ou toque em Cancelar antes de chamar o motoboy.'); return false; }
        return true;
      }
    };
  } };
})();
