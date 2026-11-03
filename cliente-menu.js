// Telas do menu do cliente: Motoristas, Minhas corridas, Indique e ganhe e Ajuda.
// Uso: MotojaClienteMenu.configurar({ backend, token, pedirLogin, pedirDeNovo, whatsapp, tabelas, authHeaders })
//      MotojaClienteMenu.abrir("motoristas" | "corridas" | "indique" | "ajuda")
(function () {
  "use strict";
  let cfg = {};
  const INDICACAO = "motoJaIndicacao";
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const reais = (v) => Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  const estrelas = (n) => `<span class="mjm-stars" style="--p:${Math.max(0, Math.min(100, Number(n || 0) * 20))}%">★★★★★</span>`;
  const msDe = (v) => (typeof v === "number" ? v : v?._seconds ? v._seconds * 1000 : v?.seconds ? v.seconds * 1000 : Date.parse(v || "") || 0);
  const dataHora = (ms) => (ms ? new Date(ms).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" }) : "");

  // Link de indicacao (?indicacao=CODIGO): guarda para enviar no cadastro.
  try {
    const code = new URLSearchParams(location.search).get("indicacao");
    if (code && /^[A-Za-z0-9]{6}$/.test(code)) localStorage.setItem(INDICACAO, code.toUpperCase());
  } catch (_) {}

  function injectStyle() {
    if (document.getElementById("mjm-style")) return;
    const style = document.createElement("style");
    style.id = "mjm-style";
    style.textContent = `
      .mjm-back{position:fixed;inset:0;z-index:9000;background:rgba(0,0,0,.6);display:flex;justify-content:center;align-items:flex-end}
      .mjm{width:min(560px,100%);height:min(92vh,900px);display:flex;flex-direction:column;background:#0f1118;color:#f3f5f8;border-radius:20px 20px 0 0;border:1px solid rgba(255,154,0,.3);overflow:hidden;font-family:inherit}
      .mjm>header{display:flex;align-items:center;gap:10px;padding:16px;border-bottom:1px solid rgba(255,255,255,.08);background:#141824}
      .mjm>header h2{flex:1;margin:0;font-size:1.15rem;font-weight:900}
      .mjm>header button{width:38px;height:38px;border-radius:12px;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.05);color:#fff;font-size:1.2rem;cursor:pointer;box-shadow:none;padding:0}
      .mjm-body{flex:1;overflow-y:auto;padding:16px;display:grid;gap:12px;align-content:start}
      .mjm-intro{margin:0;color:#aeb4c3;font-size:.85rem;line-height:1.4}
      .mjm-vazio{padding:22px 14px;text-align:center;color:#aeb4c3;border:1px dashed rgba(255,255,255,.15);border-radius:14px;line-height:1.4}
      .mjm-stars{display:inline-block;letter-spacing:1px;background:linear-gradient(90deg,#ffb400 var(--p),#3a4252 var(--p));-webkit-background-clip:text;background-clip:text;color:transparent}
      .mjm-btn{padding:12px 14px;border-radius:12px;border:0;font:inherit;font-weight:900;cursor:pointer;box-shadow:none}
      .mjm-btn.verde{background:#25d366;color:#08210f}.mjm-btn.laranja{background:#ff8a00;color:#111}.mjm-btn.cinza{background:#232a38;color:#e6e9ef}
      .mjm-drivers{display:grid;grid-template-columns:repeat(2,1fr);gap:10px}
      .mjm-driver{position:relative;padding:14px 10px;border-radius:16px;background:linear-gradient(180deg,rgba(255,255,255,.07),rgba(255,255,255,.03));border:1px solid rgba(255,255,255,.1);text-align:center;display:grid;gap:4px;justify-items:center}
      .mjm-driver img,.mjm-driver .sem-foto{width:74px;height:74px;border-radius:50%;object-fit:cover;border:3px solid #ff9a00;background:#1a1f2c;display:grid;place-items:center;font-weight:900;color:#ff9a00;font-size:1.3rem}
      .mjm-driver strong{font-size:1rem}.mjm-driver small{color:#aeb4c3;font-size:.76rem}
      .mjm-driver .online{position:absolute;top:10px;right:10px;padding:3px 8px;border-radius:999px;background:rgba(37,211,102,.16);color:#7ee2a8;font-size:.66rem;font-weight:800}
      .mjm-driver .novo{color:#ffd39a;font-size:.74rem;font-weight:800}
      .mjm-resumo{display:grid;grid-template-columns:repeat(2,1fr);gap:10px}
      .mjm-resumo div{padding:12px;border-radius:14px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.08)}
      .mjm-resumo span{display:block;color:#9aa3b2;font-size:.72rem}.mjm-resumo strong{display:block;font-size:1.3rem;color:#ffd166;margin-top:2px}
      .mjm-ride{padding:14px;border-radius:16px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.09);display:grid;gap:8px}
      .mjm-ride-top{display:flex;justify-content:space-between;align-items:center;gap:8px}
      .mjm-ride-top strong{font-size:1.05rem}.mjm-ride-top small{display:block;color:#9aa3b2;font-weight:600;font-size:.74rem}
      .mjm-chip{padding:4px 10px;border-radius:999px;font-size:.72rem;font-weight:800;white-space:nowrap}
      .mjm-chip.ok{background:rgba(37,211,102,.15);color:#7ee2a8}.mjm-chip.no{background:rgba(255,82,82,.14);color:#ff8a80}.mjm-chip.wait{background:rgba(255,154,0,.15);color:#ffd39a}.mjm-chip.off{background:#232a38;color:#aeb4c3}
      .mjm-rota{font-size:.84rem;color:#d6dae2;line-height:1.4}.mjm-rota b{color:#ff9a00}
      .mjm-motoboy{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:.82rem;color:#aeb4c3}
      .mjm-acoes{display:flex;gap:8px}.mjm-acoes .mjm-btn{flex:1;padding:10px;font-size:.86rem}
      .mjm-codigo{padding:18px;border-radius:18px;text-align:center;background:linear-gradient(145deg,rgba(255,154,0,.18),rgba(255,106,0,.08));border:1px solid rgba(255,154,0,.45)}
      .mjm-codigo span{display:block;color:#ffd39a;font-size:.78rem;font-weight:800}
      .mjm-codigo strong{display:block;font-size:2.2rem;letter-spacing:6px;margin:6px 0;color:#fff}
      .mjm-passos{margin:0;padding-left:20px;display:grid;gap:6px;color:#d6dae2;font-size:.88rem;line-height:1.4}
      .mjm-amigo{display:flex;justify-content:space-between;align-items:center;padding:10px 12px;border-radius:12px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);font-size:.88rem}
      .mjm-faq details{border-radius:14px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.09);padding:0 14px}
      .mjm-faq summary{cursor:pointer;padding:14px 0;font-weight:800;list-style:none;display:flex;justify-content:space-between;gap:10px}
      .mjm-faq summary::after{content:"+";color:#ff9a00;font-size:1.2rem;line-height:1}.mjm-faq details[open] summary::after{content:"−"}
      .mjm-faq p,.mjm-faq ul{margin:0 0 14px;color:#cbd2dc;font-size:.88rem;line-height:1.45}.mjm-faq ul{padding-left:18px}
      .mjm-faq{display:grid;gap:8px}`;
    document.head.appendChild(style);
  }

  function sheet(titulo) {
    fechar();
    injectStyle();
    const back = document.createElement("div");
    back.className = "mjm-back";
    back.innerHTML = `<div class="mjm" role="dialog" aria-modal="true" aria-label="${esc(titulo)}"><header><h2>${esc(titulo)}</h2><button type="button" data-mjm-fechar aria-label="Fechar">×</button></header><div class="mjm-body"><div class="mjm-vazio">Carregando...</div></div></div>`;
    back.addEventListener("click", (e) => { if (e.target === back || e.target.closest("[data-mjm-fechar]")) fechar(); });
    document.body.appendChild(back);
    return back.querySelector(".mjm-body");
  }

  function fechar() {
    document.querySelector(".mjm-back")?.remove();
  }

  async function api(path, auth) {
    const headers = auth ? { authorization: `Bearer ${cfg.token?.() || ""}` } : {};
    const r = await fetch(`${cfg.backend}${path}`, { headers, cache: "no-store" });
    const d = await r.json().catch(() => ({}));
    if (r.status === 401 && auth) throw Object.assign(new Error("login"), { login: true });
    if (!r.ok) throw new Error(d.message || "Não consegui carregar agora. Tente de novo.");
    return d;
  }

  // Telas que precisam de cadastro: sem conta, abre o login/cadastro.
  function exigeConta(motivo, tela) {
    if (cfg.token?.()) return true;
    fechar();
    cfg.pedirLogin?.(motivo, tela);
    return false;
  }

  // ---------- Motoristas ----------
  async function motoristas() {
    if (!exigeConta("Para ver os motoboys disponíveis, entre ou crie sua conta.", "motoristas")) return;
    const body = sheet("Motoboys disponíveis");
    try {
      const d = await api("/api/drivers/public", true);
      const lista = d.motoboys || [];
      body.innerHTML = `<p class="mjm-intro">Estes motoboys estão <strong style="color:#7ee2a8">disponíveis agora</strong>. Todos são cadastrados com CNH e documento da moto, aprovados pela nossa equipe e avaliados pelos clientes a cada corrida.</p>
        ${lista.length ? `<div class="mjm-drivers">${lista.map((m) => `<div class="mjm-driver"><span class="online">● Disponível</span>${m.foto ? `<img src="${esc(cfg.backend + m.foto)}" alt="" loading="lazy" onerror="this.outerHTML='<span class=&quot;sem-foto&quot;>MJ</span>'">` : '<span class="sem-foto">MJ</span>'}<strong>${esc(m.nome)}</strong>${m.moto ? `<small>🏍️ ${esc(m.moto)}</small>` : ""}${m.avaliacoes ? `<small>${estrelas(m.media)} ${String(m.media.toFixed(1)).replace(".", ",")} · ${m.avaliacoes} avaliaç${m.avaliacoes > 1 ? "ões" : "ão"}</small>` : '<span class="novo">Novo na MotoJá</span>'}</div>`).join("")}</div>` : '<div class="mjm-vazio">Nenhum motoboy disponível neste momento.<br>Assim que alguém ficar disponível, aparece aqui. Você também pode pedir a corrida: ela toca para todos.</div>'}`;
    } catch (e) {
      if (e.login) { fechar(); return cfg.pedirLogin?.("Sua sessão expirou. Entre de novo para ver os motoboys.", "motoristas"); }
      body.innerHTML = `<div class="mjm-vazio">${esc(e.message)}</div>`;
    }
  }

  // ---------- Minhas corridas ----------
  const STATUS = {
    finalizada: ["Finalizada", "ok"], cancelada: ["Cancelada", "no"], expirada: ["Sem motoboy", "off"],
    pendente: ["Procurando motoboy", "wait"], aceita: ["Em andamento", "wait"], finalizada_por_inatividade: ["Encerrada", "off"],
  };

  async function corridas() {
    if (!exigeConta("Para ver suas corridas, entre ou crie sua conta. Assim seu histórico fica salvo mesmo trocando de celular.", "corridas")) return;
    const body = sheet("Minhas corridas");
    try {
      const d = await api("/api/customers/me/rides", true);
      const rides = d.rides || [];
      const feitas = rides.filter((r) => r.status === "finalizada");
      if (!rides.length) {
        body.innerHTML = `<div class="mjm-vazio">Você ainda não fez nenhuma corrida com a MotoJá.<br><br><button type="button" class="mjm-btn laranja" data-mjm-pedir>Pedir minha primeira corrida</button></div>`;
        body.querySelector("[data-mjm-pedir]").onclick = () => { fechar(); cfg.pedirDeNovo?.({}); };
        return;
      }
      body.innerHTML = `<div class="mjm-resumo"><div><span>Corridas feitas</span><strong>${feitas.length}</strong></div><div><span>Total gasto</span><strong>${reais(feitas.reduce((t, r) => t + Number(r.valor || 0), 0))}</strong></div></div>
        ${rides.slice(0, 60).map((r, i) => {
          const [rotulo, cor] = STATUS[r.status] || [r.status || "-", "off"];
          const entrega = r.modalidade === "entrega_avulsa";
          return `<article class="mjm-ride">
            <div class="mjm-ride-top"><div><strong>${reais(r.valor)}</strong><small>${entrega ? "📦 Entrega" : "🏍️ Corrida"} · ${esc(dataHora(msDe(r.criadaEm)))}${r.km ? ` · ${String(Number(r.km).toFixed(1)).replace(".", ",")} km` : ""}</small></div><span class="mjm-chip ${cor}">${esc(rotulo)}</span></div>
            <div class="mjm-rota"><b>●</b> ${esc(r.origem || "-")}<br><b>●</b> ${esc(r.destino || r.destinoEncontrado || "-")}</div>
            ${r.motoboy ? `<div class="mjm-motoboy"><span>Motoboy: <strong style="color:#fff">${esc(r.motoboy)}</strong></span>${r.avaliacaoNota ? `<span title="Sua avaliação">${estrelas(r.avaliacaoNota)}</span>` : ""}</div>` : ""}
            <div class="mjm-acoes">${r.podeAvaliar && r.motoboy ? `<button type="button" class="mjm-btn laranja" data-mjm-avaliar="${i}">⭐ Avaliar</button>` : ""}<button type="button" class="mjm-btn cinza" data-mjm-denovo="${i}">↻ Pedir de novo</button></div>
          </article>`;
        }).join("")}`;
      body.onclick = (e) => {
        const denovo = e.target.closest("[data-mjm-denovo]");
        if (denovo) { fechar(); cfg.pedirDeNovo?.(rides[Number(denovo.dataset.mjmDenovo)]); return; }
        const avaliar = e.target.closest("[data-mjm-avaliar]");
        if (avaliar) {
          const r = rides[Number(avaliar.dataset.mjmAvaliar)];
          window.MotojaRideRating?.open({ rideId: r.id, backend: cfg.backend, motoboy: r.motoboy, foto: r.motoboyFoto, auth: cfg.authHeaders, onDone: () => corridas() });
        }
      };
    } catch (e) {
      if (e.login) { fechar(); return cfg.pedirLogin?.("Sua sessão expirou. Entre de novo para ver suas corridas.", "corridas"); }
      body.innerHTML = `<div class="mjm-vazio">${esc(e.message)}</div>`;
    }
  }

  // ---------- Indique e ganhe ----------
  async function indique() {
    if (!exigeConta("Para indicar amigos e concorrer, entre ou crie sua conta.", "indique")) return;
    const body = sheet("Indique e ganhe");
    try {
      const d = await api("/api/customers/me/referral", true);
      const texto = `Peça mototáxi e entregas pelo app Nexus MotoJá em Conchal, Aguaí e Engenheiro Coelho. Cadastre-se pelo meu link: ${d.link}`;
      const mesNome = new Date().toLocaleDateString("pt-BR", { month: "long" });
      body.innerHTML = `<div class="mjm-codigo"><span>SEU CÓDIGO</span><strong>${esc(d.codigo)}</strong><button type="button" class="mjm-btn verde" data-mjm-share style="width:100%">Compartilhar no WhatsApp</button><button type="button" class="mjm-btn cinza" data-mjm-copiar style="width:100%;margin-top:8px">Copiar link</button></div>
        <div class="mjm-resumo"><div><span>Participações em ${esc(mesNome)}</span><strong>${d.participacoesMes}</strong></div><div><span>Amigos que já andaram</span><strong>${d.totalAndaram}</strong></div></div>
        <div><strong>Como funciona</strong><ol class="mjm-passos" style="margin-top:8px"><li>Mande seu link para os amigos.</li><li>O amigo se cadastra no app pelo seu link.</li><li>Quando ele fizer a <b>primeira corrida</b>, você ganha <b>1 participação</b> no sorteio de <b>1 corrida grátis</b> do mês.</li><li>Quanto mais amigos andarem, mais chances você tem.</li></ol></div>
        <div><strong>Seus indicados</strong><div style="display:grid;gap:8px;margin-top:8px">${(d.amigos || []).length ? d.amigos.map((a) => `<div class="mjm-amigo"><span>${esc(a.nome)}</span><span class="mjm-chip ${a.andou ? "ok" : "wait"}">${a.andou ? "✅ Já andou" : "Cadastrou · falta a 1ª corrida"}</span></div>`).join("") : '<div class="mjm-vazio">Ninguém se cadastrou pelo seu link ainda.</div>'}</div></div>`;
      body.querySelector("[data-mjm-share]").onclick = () => {
        if (navigator.share) navigator.share({ title: "Nexus MotoJá", text: texto }).catch(() => {});
        else location.href = `https://api.whatsapp.com/send?text=${encodeURIComponent(texto)}`;
      };
      body.querySelector("[data-mjm-copiar]").onclick = async (e) => {
        try { await navigator.clipboard.writeText(d.link); e.target.textContent = "Link copiado ✓"; } catch (_) { prompt("Copie seu link:", d.link); }
      };
    } catch (e) {
      if (e.login) { fechar(); return cfg.pedirLogin?.("Sua sessão expirou. Entre de novo para ver suas indicações.", "indique"); }
      body.innerHTML = `<div class="mjm-vazio">${esc(e.message)}</div>`;
    }
  }

  // ---------- Ajuda ----------
  function tabelaHtml(t) {
    if (!t) return "";
    return `<li><b>${esc(t.horario)}</b>: ${t.faixas.map((f) => `${esc(f.label.replace(/ - modo \w+/, ""))} ${reais(f.valor)}`).join(" · ")} · acima de 8 km ${reais(t.kmExtra)}/km</li>`;
  }

  function ajuda() {
    const body = sheet("Ajuda");
    const t = cfg.tabelas || {};
    const faq = [
      ["Como peço uma corrida?", `<p>Toque em <b>Pedir Corrida</b>, use sua localização (ou digite onde está), digite o destino e toque em <b>Calcular valor</b>. Confirmando, a chamada toca para os motoboys disponíveis e o primeiro que aceitar vai até você.</p>`],
      ["Quanto custa?", `<p>O preço é fixo pela distância, sem surpresa:</p><ul>${tabelaHtml(t.dia)}${tabelaHtml(t.noite)}${tabelaHtml(t.madrugada)}</ul>`],
      ["Como pago?", `<p>Depois que o motoboy aceitar, você pode pagar <b>pelo app (Pix ou cartão)</b> no botão que aparece, ou direto para o motoboy em <b>dinheiro ou Pix</b>. Nunca pague antes de um motoboy aceitar.</p>`],
      ["Posso cancelar?", `<ul><li><b>Antes de um motoboy aceitar:</b> cancele quando quiser, sem custo.</li><li><b>Depois que ele aceitou:</b> se ele passar de <b>15 minutos</b> sem chegar, aparece o botão <b>Cancelar motoboy</b> para chamar outro ou cancelar a corrida.</li></ul>`],
      ["Como sei quem é o motoboy?", `<p>Assim que ele aceita, aparecem o <b>nome e a foto</b> dele, e você acompanha no <b>mapa ao vivo</b> ele chegando. Vocês conversam pelo <b>chat do app</b>, sem precisar passar seu número.</p>`],
      ["É seguro?", `<ul><li>Todos os motoboys enviam CNH e documento da moto e são aprovados pela nossa equipe.</li><li>Cada corrida pode ser avaliada, e motoboys com reclamação são acompanhados.</li><li>No chat, números de telefone e links ficam escondidos.</li></ul>`],
      ["Como funciona a entrega?", `<p>Toque em <b>Enviar Entrega</b> para mandar chave, documento, celular e outros objetos pequenos pelo mesmo preço da corrida. Você recebe um <b>código</b> e passa para quem vai receber: o motoboy só finaliza com esse código.</p>`],
      ["Quais cidades vocês atendem?", `<p>Conchal, Aguaí e Engenheiro Coelho (SP).</p>`],
      ["Esqueci minha senha", `<p>Na tela de entrar, toque em <b>Esqueci minha senha</b>. Você recebe um código no WhatsApp para criar uma senha nova.</p>`],
    ];
    body.innerHTML = `<div class="mjm-faq">${faq.map(([q, a]) => `<details><summary>${esc(q)}</summary>${a}</details>`).join("")}</div>
      <div class="mjm-vazio" style="border-style:solid">Não achou o que procurava?<br><br><button type="button" class="mjm-btn verde" data-mjm-zap>💬 Falar com o suporte no WhatsApp</button></div>`;
    body.querySelector("[data-mjm-zap]").onclick = () => cfg.whatsapp?.("Olá, preciso de ajuda no app MotoJá.");
  }

  function abrir(tela) {
    ({ motoristas, corridas, indique, ajuda })[tela]?.();
  }

  window.MotojaClienteMenu = {
    configurar: (options) => { cfg = { ...cfg, ...options }; },
    abrir,
    fechar,
    indicacaoPendente: () => { try { return localStorage.getItem(INDICACAO) || ""; } catch (_) { return ""; } },
    limparIndicacao: () => { try { localStorage.removeItem(INDICACAO); } catch (_) {} },
  };
})();
