// Meus cartoes e pagar a corrida com cartao salvo (cobrado pelo Mercado Pago na conta MotoJa).
// Uso: MotojaCartoes.configurar({ backend, authHeaders, logado, pedirLogin })
//      MotojaCartoes.abrir()                       -> tela Meus cartoes
//      MotojaCartoes.pagar({ rideId, valor, aoPagar })
//      MotojaCartoes.disponivel()                  -> true se ja da para mostrar o botao
// O numero do cartao vai do celular direto para o Mercado Pago (token); a MotoJa recebe
// so o token e guarda o final. Para pagar: CPF do dono do cartao + codigo de seguranca.
(function () {
  "use strict";
  let cfg = {};
  let config = null;
  let mpPromise = null;
  const SDK = "https://sdk.mercadopago.com/js/v2";
  const SEGURANCA = "https://www.mercadopago.com/v2/security.js";
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const so = (v) => String(v || "").replace(/\D/g, "");
  const reais = (v) => Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

  function cpfValido(valor) {
    const c = so(valor);
    if (c.length !== 11 || /^(\d)\1{10}$/.test(c)) return false;
    for (const t of [9, 10]) {
      let soma = 0;
      for (let i = 0; i < t; i += 1) soma += Number(c[i]) * (t + 1 - i);
      if (((soma * 10) % 11) % 10 !== Number(c[t])) return false;
    }
    return true;
  }

  async function api(caminho, corpo, metodo) {
    const r = await fetch(`${cfg.backend}${caminho}`, {
      method: metodo || (corpo ? "POST" : "GET"),
      headers: { "content-type": "application/json", ...(cfg.authHeaders?.() || {}), ...(window.MP_DEVICE_SESSION_ID ? { "x-meli-session-id": String(window.MP_DEVICE_SESSION_ID) } : {}) },
      body: corpo ? JSON.stringify(corpo) : undefined,
    });
    const dados = await r.json().catch(() => ({}));
    if (r.status === 401) { cfg.pedirLogin?.("Entre na sua conta para usar cartão."); throw new Error("Entre na sua conta para usar cartão."); }
    if (!r.ok && r.status !== 402) throw new Error(dados.message || "Não consegui falar com o servidor. Tente de novo.");
    return { ...dados, httpStatus: r.status };
  }

  async function carregarConfig() {
    if (config) return config;
    try {
      const r = await fetch(`${cfg.backend}/api/payments/card-config`);
      config = r.ok ? await r.json() : { ativo: false };
    } catch (_) {
      config = null;
      return { ativo: false };
    }
    return config;
  }

  function script(src, attrs = {}) {
    return new Promise((ok, erro) => {
      if (document.querySelector(`script[src="${src}"]`)) return ok();
      const s = document.createElement("script");
      s.src = src;
      s.async = true;
      Object.entries(attrs).forEach(([k, v]) => s.setAttribute(k, v));
      s.onload = ok;
      s.onerror = () => erro(new Error("Não consegui abrir o Mercado Pago. Confira a internet."));
      document.head.appendChild(s);
    });
  }

  async function mercadoPago() {
    const c = await carregarConfig();
    if (!c.ativo || !c.publicKey) throw new Error("Pagamento com cartão no app ainda não está disponível.");
    if (!mpPromise) {
      mpPromise = (async () => {
        script(SEGURANCA, { view: "checkout" }).catch(() => {});
        await script(SDK);
        return new window.MercadoPago(c.publicKey, { locale: "pt-BR" });
      })().catch((e) => { mpPromise = null; throw e; });
    }
    return mpPromise;
  }

  function estilo() {
    if (document.getElementById("mjc-style")) return;
    const s = document.createElement("style");
    s.id = "mjc-style";
    s.textContent = `
      .mjc-back{position:fixed;inset:0;z-index:9500;background:rgba(0,0,0,.62);display:flex;justify-content:center;align-items:flex-end}
      .mjc{width:min(560px,100%);max-height:94vh;display:flex;flex-direction:column;background:#0f1118;color:#f3f5f8;border-radius:20px 20px 0 0;border:1px solid rgba(255,154,0,.3);overflow:hidden;font-family:inherit}
      .mjc>header{display:flex;align-items:center;gap:10px;padding:16px;border-bottom:1px solid rgba(255,255,255,.08);background:#141824}
      .mjc>header h2{flex:1;margin:0;font-size:1.12rem;font-weight:900}
      .mjc>header button{width:38px;height:38px;border-radius:12px;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.05);color:#fff;font-size:1.2rem;cursor:pointer;padding:0;box-shadow:none}
      .mjc-body{overflow-y:auto;padding:16px 16px calc(18px + env(safe-area-inset-bottom));display:grid;gap:12px}
      .mjc-nota{margin:0;color:#aeb4c3;font-size:.84rem;line-height:1.4}
      .mjc-card{display:flex;align-items:center;gap:12px;padding:14px;border-radius:16px;background:linear-gradient(135deg,#1d2433,#141a26);border:1px solid rgba(255,255,255,.1)}
      .mjc-card.sel{border-color:#ff9a00;box-shadow:0 0 0 2px rgba(255,154,0,.35)}
      .mjc-card .ic{font-size:1.6rem}
      .mjc-card div{flex:1;display:grid;gap:2px}
      .mjc-card strong{font-size:1rem;letter-spacing:.5px}.mjc-card small{color:#9aa3b2;font-size:.76rem}
      .mjc-card button{border:1px solid rgba(255,82,82,.5);background:transparent;color:#ff8a80;border-radius:10px;padding:8px 10px;font:inherit;font-weight:800;font-size:.8rem;cursor:pointer;box-shadow:none}
      .mjc-vazio{padding:20px 14px;text-align:center;color:#aeb4c3;border:1px dashed rgba(255,255,255,.15);border-radius:14px;line-height:1.45}
      .mjc-btn{width:100%;padding:14px;border-radius:14px;border:0;font:inherit;font-weight:900;font-size:1rem;cursor:pointer;box-shadow:none}
      .mjc-btn.laranja{background:linear-gradient(135deg,#ff9a00,#ff7a00);color:#111}.mjc-btn.azul{background:linear-gradient(135deg,#009ee3,#007eb5);color:#fff}
      .mjc-btn.cinza{background:#232a38;color:#e6e9ef}.mjc-btn:disabled{opacity:.6}
      .mjc-campo{display:grid;gap:5px}.mjc-campo span{font-size:.8rem;font-weight:800;color:#cbd2dc}
      .mjc-campo input{width:100%;box-sizing:border-box;padding:13px 14px;border-radius:12px;border:1px solid rgba(255,255,255,.16);background:#171c28;color:#fff;font:inherit;font-size:1.02rem;letter-spacing:.5px}
      .mjc-campo input:focus{outline:2px solid #ff9a00;border-color:transparent}
      .mjc-dupla{display:grid;grid-template-columns:1fr 1fr;gap:10px}
      .mjc-msg{padding:11px 13px;border-radius:12px;font-weight:800;font-size:.9rem;line-height:1.35}
      .mjc-msg.erro{background:rgba(255,82,82,.13);border:1px solid rgba(255,82,82,.45);color:#ffb4ab}
      .mjc-msg.ok{background:rgba(37,211,102,.14);border:1px solid rgba(37,211,102,.45);color:#9ef0bf}
      .mjc-msg[hidden]{display:none}
      .mjc-cadeado{display:flex;gap:8px;align-items:flex-start;padding:10px 12px;border-radius:12px;background:rgba(0,158,227,.1);border:1px solid rgba(0,158,227,.3);color:#bfe6ff;font-size:.8rem;line-height:1.4}`;
    document.head.appendChild(s);
  }

  function folha(titulo) {
    fechar();
    estilo();
    const back = document.createElement("div");
    back.className = "mjc-back";
    back.innerHTML = `<div class="mjc" role="dialog" aria-modal="true" aria-label="${esc(titulo)}"><header><h2>${esc(titulo)}</h2><button type="button" data-mjc-fechar aria-label="Fechar">×</button></header><div class="mjc-body"><div class="mjc-vazio">Carregando...</div></div></div>`;
    back.addEventListener("click", (e) => { if (e.target === back || e.target.closest("[data-mjc-fechar]")) fechar(); });
    document.body.appendChild(back);
    return back.querySelector(".mjc-body");
  }

  function fechar() { document.querySelector(".mjc-back")?.remove(); }

  function linhaCartao(c, { remover = false, escolher = false, selecionado = false } = {}) {
    const tipo = c.tipo === "debito" ? "Débito" : "Crédito";
    return `<label class="mjc-card${selecionado ? " sel" : ""}" data-card="${esc(c.id)}">
      ${escolher ? `<input type="radio" name="mjc-cartao" value="${esc(c.id)}" ${selecionado ? "checked" : ""} style="accent-color:#ff9a00;width:20px;height:20px">` : ""}
      <span class="ic">💳</span>
      <div><strong>${esc(c.bandeiraNome)} •••• ${esc(c.final)}</strong><small>${tipo}${c.validade ? ` · vence ${esc(c.validade)}` : ""}${c.titular ? ` · ${esc(c.titular)}` : ""}</small></div>
      ${remover ? `<button type="button" data-remover="${esc(c.id)}">Remover</button>` : ""}
    </label>`;
  }

  // ---------- Meus cartoes ----------
  async function abrir() {
    if (!cfg.logado?.()) { cfg.pedirLogin?.("Entre na sua conta para salvar cartões."); return; }
    const corpo = folha("💳 Meus cartões");
    try {
      const dados = await api("/api/customers/me/cards");
      if (!dados.ativo) {
        corpo.innerHTML = `<div class="mjc-vazio">💳 O pagamento com cartão salvo chega em breve.<br>Por enquanto, pague pelo link do Mercado Pago que aparece quando o motoboy aceita.</div>`;
        return;
      }
      mostrarLista(corpo, dados.cartoes || []);
    } catch (e) {
      corpo.innerHTML = `<div class="mjc-msg erro">${esc(e.message)}</div>`;
    }
  }

  function mostrarLista(corpo, cartoes, voltar) {
    corpo.innerHTML = `
      <p class="mjc-nota">Salve seu cartão uma vez. Na hora de pagar a corrida, você só digita o <b>CPF do dono do cartão</b> e o <b>código de segurança</b>.</p>
      ${cartoes.length ? cartoes.map((c) => linhaCartao(c, { remover: true })).join("") : `<div class="mjc-vazio">Você ainda não tem cartão salvo.</div>`}
      <button type="button" class="mjc-btn laranja" data-adicionar>➕ Adicionar cartão</button>
      <div class="mjc-msg" hidden></div>`;
    const msg = corpo.querySelector(".mjc-msg");
    corpo.querySelector("[data-adicionar]").onclick = () => mostrarCadastro(corpo, voltar);
    corpo.querySelectorAll("[data-remover]").forEach((b) => {
      b.onclick = async (e) => {
        e.preventDefault();
        const c = cartoes.find((x) => x.id === b.dataset.remover);
        if (!confirm(`Remover o cartão ${c?.bandeiraNome || ""} final ${c?.final || ""}?`)) return;
        b.disabled = true;
        try {
          const r = await api(`/api/customers/me/cards/${encodeURIComponent(b.dataset.remover)}/remove`, {});
          mostrarLista(corpo, r.cartoes || [], voltar);
        } catch (err) {
          b.disabled = false;
          msg.hidden = false;
          msg.className = "mjc-msg erro";
          msg.textContent = err.message;
        }
      };
    });
  }

  function formatarNumero(v) { return so(v).slice(0, 19).replace(/(\d{4})(?=\d)/g, "$1 "); }
  function formatarValidade(v) { const d = so(v).slice(0, 4); return d.length > 2 ? `${d.slice(0, 2)}/${d.slice(2)}` : d; }
  function formatarCpf(v) { const d = so(v).slice(0, 11); return d.replace(/(\d{3})(\d)/, "$1.$2").replace(/(\d{3})(\d)/, "$1.$2").replace(/(\d{3})(\d{1,2})$/, "$1-$2"); }

  function mostrarCadastro(corpo, voltar) {
    corpo.innerHTML = `
      <button type="button" class="mjc-btn azul" data-escanear>📷 Escanear o cartão com a câmera</button>
      <p class="mjc-nota" style="text-align:center">ou digite os dados abaixo</p>
      <label class="mjc-campo"><span>Número do cartão</span><input id="mjc-numero" inputmode="numeric" autocomplete="cc-number" placeholder="0000 0000 0000 0000" maxlength="23"></label>
      <label class="mjc-campo"><span>Nome impresso no cartão</span><input id="mjc-nome" autocomplete="cc-name" placeholder="Como está no cartão" maxlength="40" style="text-transform:uppercase"></label>
      <div class="mjc-dupla">
        <label class="mjc-campo"><span>Validade</span><input id="mjc-validade" inputmode="numeric" autocomplete="cc-exp" placeholder="MM/AA" maxlength="5"></label>
        <label class="mjc-campo"><span>Código de segurança</span><input id="mjc-cvv" inputmode="numeric" autocomplete="cc-csc" placeholder="3 números atrás" maxlength="4" type="password"></label>
      </div>
      <label class="mjc-campo"><span>CPF do dono do cartão</span><input id="mjc-cpf" inputmode="numeric" placeholder="000.000.000-00" maxlength="14"></label>
      <div class="mjc-cadeado">🔒 <span>O número do cartão vai direto do seu celular para o Mercado Pago. A MotoJá guarda só o final do cartão.</span></div>
      <div class="mjc-msg" hidden></div>
      <button type="button" class="mjc-btn laranja" data-salvar>Salvar cartão</button>
      <button type="button" class="mjc-btn cinza" data-voltar>Voltar</button>`;
    const $ = (id) => corpo.querySelector(`#${id}`);
    const msg = corpo.querySelector(".mjc-msg");
    const aviso = (texto, tipo = "erro") => { msg.hidden = !texto; msg.className = `mjc-msg ${tipo}`; msg.textContent = texto; };
    $("mjc-numero").oninput = (e) => { e.target.value = formatarNumero(e.target.value); };
    $("mjc-validade").oninput = (e) => { e.target.value = formatarValidade(e.target.value); };
    $("mjc-cvv").oninput = (e) => { e.target.value = so(e.target.value).slice(0, 4); };
    $("mjc-cpf").oninput = (e) => { e.target.value = formatarCpf(e.target.value); };
    corpo.querySelector("[data-voltar]").onclick = async () => {
      if (voltar) return voltar();
      try { mostrarLista(corpo, (await api("/api/customers/me/cards")).cartoes || []); } catch (e) { aviso(e.message); }
    };
    corpo.querySelector("[data-escanear]").onclick = async () => {
      aviso("");
      const abriu = await window.MotojaCartaoScan?.abrirCameraCartao({
        aoLer: (d) => {
          $("mjc-numero").value = formatarNumero(d.numero);
          if (d.validade) $("mjc-validade").value = `${String(d.validade.mes).padStart(2, "0")}/${String(d.validade.ano).slice(-2)}`;
          if (d.nome && !$("mjc-nome").value) $("mjc-nome").value = d.nome;
          aviso(`✅ Cartão final ${d.numero.slice(-4)} lido! Confira${d.validade ? "" : " a validade"}, digite o código de segurança e o CPF.`, "ok");
          (d.validade ? $("mjc-cvv") : $("mjc-validade")).focus();
        },
      });
      if (!abriu) aviso("Não consegui abrir a câmera aqui. Digite os dados do cartão (ou libere a câmera nas permissões do app).");
    };
    corpo.querySelector("[data-salvar]").onclick = async (e) => {
      const botao = e.currentTarget;
      const numero = so($("mjc-numero").value);
      const nome = String($("mjc-nome").value || "").trim().toUpperCase();
      const [mes, ano] = String($("mjc-validade").value || "").split("/");
      const cvv = so($("mjc-cvv").value);
      const cpf = so($("mjc-cpf").value);
      const agora = new Date();
      const anoCheio = 2000 + Number(ano || 0);
      if (!window.MotojaCartaoScan?.numeroValido(numero)) return aviso("Número do cartão inválido. Confira os números.");
      if (nome.length < 3) return aviso("Digite o nome como está no cartão.");
      if (!(Number(mes) >= 1 && Number(mes) <= 12) || !ano || ano.length !== 2 || anoCheio * 12 + Number(mes) < agora.getFullYear() * 12 + agora.getMonth() + 1) return aviso("Validade inválida ou vencida (MM/AA).");
      if (cvv.length < 3) return aviso("Digite o código de segurança (3 ou 4 números atrás do cartão).");
      if (!cpfValido(cpf)) return aviso("CPF do dono do cartão inválido.");
      botao.disabled = true;
      botao.textContent = "Salvando no Mercado Pago...";
      aviso("");
      try {
        const mp = await mercadoPago();
        let token;
        try {
          token = await mp.createCardToken({
            cardNumber: numero, cardholderName: nome, cardExpirationMonth: String(mes).padStart(2, "0"),
            cardExpirationYear: String(anoCheio), securityCode: cvv, identificationType: "CPF", identificationNumber: cpf,
          });
        } catch (_) {
          throw new Error("O Mercado Pago não aceitou os dados. Confira número, validade, código e CPF.");
        }
        const r = await api("/api/customers/me/cards", { token: token.id, cpf });
        ["mjc-numero", "mjc-cvv"].forEach((id) => { $(id).value = ""; });
        if (voltar) return voltar(r.cartao?.id);
        mostrarLista(corpo, r.cartoes || []);
        const ok = corpo.querySelector(".mjc-msg");
        ok.hidden = false;
        ok.className = "mjc-msg ok";
        ok.textContent = `✅ Cartão final ${r.cartao?.final || ""} salvo!`;
      } catch (err) {
        aviso(err.message);
      } finally {
        botao.disabled = false;
        botao.textContent = "Salvar cartão";
      }
    };
  }

  // ---------- Pagar a corrida ----------
  async function pagar({ rideId, valor, aoPagar }) {
    if (!cfg.logado?.()) { cfg.pedirLogin?.("Entre na sua conta para pagar com cartão."); return; }
    const corpo = folha(`💳 Pagar ${reais(valor)}`);
    let escolhido = "";
    async function telaPagar(novoId) {
      let dados;
      try {
        dados = await api("/api/customers/me/cards");
      } catch (e) {
        corpo.innerHTML = `<div class="mjc-msg erro">${esc(e.message)}</div>`;
        return;
      }
      const cartoes = dados.cartoes || [];
      if (!dados.ativo) {
        corpo.innerHTML = `<div class="mjc-vazio">Pagamento com cartão salvo ainda não está disponível. Use o link do Mercado Pago.</div>`;
        return;
      }
      if (!cartoes.length) {
        corpo.innerHTML = `<div class="mjc-vazio">Você ainda não tem cartão salvo.<br>Cadastre agora: leva menos de 1 minuto.</div><button type="button" class="mjc-btn laranja" data-adicionar>➕ Adicionar cartão</button>`;
        corpo.querySelector("[data-adicionar]").onclick = () => mostrarCadastro(corpo, telaPagar);
        return;
      }
      escolhido = cartoes.some((c) => c.id === novoId) ? novoId : cartoes.some((c) => c.id === escolhido) ? escolhido : cartoes[0].id;
      corpo.innerHTML = `
        <p class="mjc-nota">Escolha o cartão:</p>
        ${cartoes.map((c) => linhaCartao(c, { escolher: true, selecionado: c.id === escolhido })).join("")}
        <button type="button" class="mjc-btn cinza" data-adicionar style="padding:10px">➕ Usar outro cartão</button>
        <label class="mjc-campo"><span>CPF do dono do cartão</span><input id="mjc-pag-cpf" inputmode="numeric" placeholder="000.000.000-00" maxlength="14"></label>
        <label class="mjc-campo"><span>Código de segurança (atrás do cartão)</span><input id="mjc-pag-cvv" inputmode="numeric" autocomplete="cc-csc" placeholder="3 números" maxlength="4" type="password"></label>
        <div class="mjc-msg" hidden></div>
        <button type="button" class="mjc-btn laranja" data-pagar>Pagar ${reais(valor)}</button>
        <p class="mjc-nota" style="text-align:center">🔒 Pagamento processado pelo Mercado Pago.</p>`;
      const msg = corpo.querySelector(".mjc-msg");
      const aviso = (texto, tipo = "erro") => { msg.hidden = !texto; msg.className = `mjc-msg ${tipo}`; msg.textContent = texto; };
      corpo.querySelectorAll('input[name="mjc-cartao"]').forEach((r) => {
        r.onchange = () => {
          escolhido = r.value;
          corpo.querySelectorAll(".mjc-card").forEach((el) => el.classList.toggle("sel", el.dataset.card === escolhido));
        };
      });
      corpo.querySelector("[data-adicionar]").onclick = () => mostrarCadastro(corpo, telaPagar);
      const cpfInput = corpo.querySelector("#mjc-pag-cpf");
      const cvvInput = corpo.querySelector("#mjc-pag-cvv");
      cpfInput.oninput = (e) => { e.target.value = formatarCpf(e.target.value); };
      cvvInput.oninput = (e) => { e.target.value = so(e.target.value).slice(0, 4); };
      corpo.querySelector("[data-pagar]").onclick = async (e) => {
        const botao = e.currentTarget;
        const cpf = so(cpfInput.value);
        const cvv = so(cvvInput.value);
        if (!cpfValido(cpf)) return aviso("Digite o CPF do dono do cartão.");
        if (cvv.length < 3) return aviso("Digite o código de segurança do cartão.");
        botao.disabled = true;
        botao.textContent = "Pagando...";
        aviso("");
        try {
          const mp = await mercadoPago();
          let token;
          try {
            token = await mp.createCardToken({ cardId: escolhido, securityCode: cvv });
          } catch (_) {
            throw new Error("Não consegui confirmar o cartão. Confira o código de segurança.");
          }
          const r = await api(`/api/rides/${encodeURIComponent(rideId)}/card-payment`, { cardId: escolhido, cpf, token: token.id });
          cvvInput.value = "";
          if (r.aprovado) {
            corpo.innerHTML = `<div class="mjc-msg ok" style="text-align:center;font-size:1.05rem;padding:18px">${esc(r.message || "Pagamento aprovado! ✅")}</div><button type="button" class="mjc-btn laranja" data-mjc-fechar>Fechar</button>`;
            corpo.querySelector("[data-mjc-fechar]").onclick = fechar;
            try { navigator.vibrate?.(120); } catch (_) {}
            aoPagar?.();
            return;
          }
          aviso(r.message || "O pagamento não foi aprovado.");
        } catch (err) {
          aviso(err.message);
        } finally {
          if (botao.isConnected) {
            botao.disabled = false;
            botao.textContent = `Pagar ${reais(valor)}`;
          }
        }
      };
    }
    await telaPagar();
  }

  function configurar(opcoes) {
    cfg = { ...cfg, ...opcoes };
    carregarConfig();
  }

  function disponivel() { return !!(config?.ativo && cfg.logado?.()); }

  window.MotojaCartoes = { configurar, abrir, pagar, disponivel, cpfValido };
})();
