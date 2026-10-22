(function () {
  "use strict";

  const pages = {
    overview: {
      title: "Visão geral",
      eyebrow: "Central de operação",
      description: "Acompanhe a saúde da operação e resolva primeiro o que exige atenção.",
      targets: ["visao-section"],
    },
    plans: {
      title: "Planos das empresas",
      eyebrow: "Plano Diário Pro e Meio Período",
      description: "Veja qual empresa ativou cada plano e escolha o motoboy que roda sozinho as entregas desse plano.",
      targets: ["planos-section"],
    },
    ratings: {
      title: "Avaliações dos clientes",
      eyebrow: "Qualidade",
      description: "Notas de 1 a 5 estrelas, etiquetas e comentários que os clientes deixam para cada motoboy depois da corrida.",
      targets: ["avaliacoes-section"],
    },
    referrals: {
      title: "Indique e ganhe",
      eyebrow: "Clientes",
      description: "Cada amigo indicado que faz a primeira corrida vale 1 participação no sorteio de 1 corrida grátis do mês.",
      targets: ["indicacoes-section"],
    },
    deliveries: {
      title: "Entregas de empresas",
      eyebrow: "Operação",
      description: "Consulte entregas, filtre responsáveis e faça ajustes operacionais.",
      targets: ["entregas-section"],
    },
    rides: {
      title: "Corridas de mototáxi",
      eyebrow: "Operação",
      description: "Acompanhe corridas, pagamentos e cancelamentos em um só lugar.",
      targets: ["corridas-section"],
    },
    cars: {
      title: "Nexus CarroJÁ",
      eyebrow: "Operação de carros",
      description: "Aprove motoristas de carro e acompanhe cada corrida sem misturar com o mototáxi.",
      targets: ["carroja-section"],
    },
    deposits: {
      title: "Depósitos e créditos",
      eyebrow: "Financeiro",
      description: "Confira comprovantes, aprove valores e controle créditos das empresas.",
      targets: ["depositos-section"],
    },
    companies: {
      title: "Empresas",
      eyebrow: "Cadastros e acesso",
      description: "Gerencie aprovação, saldo, bloqueio e recuperação de senha das empresas.",
      targets: ["empresas-section", "senhas-section"],
    },
    drivers: {
      title: "Motoboys",
      eyebrow: "Equipe de campo",
      description: "Confira cadastros, situação dos motoboys e produção por profissional.",
      targets: ["motoboys-section", "resumo-section"],
    },
    support: {
      title: "Equipe de suporte",
      eyebrow: "Controle de acesso",
      description: "Aprove profissionais, confira a identificação e encerre acessos imediatamente.",
      targets: ["suporte-contas-section"],
    },
    funnel: {
      title: "Funil e marketing",
      eyebrow: "Inteligência",
      description: "Identifique em qual etapa os clientes desistem antes de confirmar.",
      targets: ["funil-section"],
    },
  };

  const navConfig = [
    ["Visão geral", "overview", "01", ""],
    ["Planos", "plans", "02", ""],
    ["Entregas", "deliveries", "03", "Operação"],
    ["Corridas", "rides", "04", ""],
    ["CarroJÁ", "cars", "05", ""],
    ["Depósitos", "deposits", "06", "Financeiro"],
    ["Empresas", "companies", "07", "Gestão"],
    ["Motoboys", "drivers", "08", ""],
    ["Avaliações", "ratings", "09", ""],
    ["Indicações", "referrals", "10", ""],
    ["Equipe suporte", "support", "11", ""],
    ["Funil", "funnel", "12", "Análise"],
  ];

  const DEFAULT_BACKEND = "https://motoboy-conchal.onrender.com";

  function getBackendUrl() {
    if (typeof window !== "undefined" && window.CONFIG && window.CONFIG.backend) {
      return window.CONFIG.backend;
    }
    if (typeof CONFIG !== "undefined" && CONFIG && CONFIG.backend) {
      return CONFIG.backend;
    }
    return DEFAULT_BACKEND;
  }

  if (typeof window !== "undefined") {
    window.CONFIG = window.CONFIG || { backend: DEFAULT_BACKEND };
  }

  let supportAccountsLoading = false;
  let carAdminState = { corridasCarro: [], carroMotoristas: [] };

  function getOwnerPassword() {
    return window.senhaDono || document.getElementById("senha")?.value?.trim() || "";
  }

  function escapeHtml(value) {
    return String(value || "").replace(/[&<>'"]/g, (character) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
    })[character]);
  }

  function formatCpf(value) {
    const digits = String(value || "").replace(/\D/g, "");
    if (digits.length === 11) {
      return digits.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, "$1.$2.$3-$4");
    }
    return value || "-";
  }

  function formatPhone(value) {
    const digits = String(value || "").replace(/\D/g, "");
    if (digits.length === 11) {
      return digits.replace(/(\d{2})(\d{5})(\d{4})/, "($1) $2-$3");
    }
    if (digits.length === 10) {
      return digits.replace(/(\d{2})(\d{4})(\d{4})/, "($1) $2-$3");
    }
    return value || "Sem telefone";
  }

  function formatBirth(value) {
    if (!value) return "-";
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      const [year, month, day] = value.split("-");
      return `${day}/${month}/${year}`;
    }
    return value;
  }

  function supportDate(value) {
    const seconds = Number(value?.seconds || 0);
    return seconds ? new Date(seconds * 1000).toLocaleString("pt-BR") : "-";
  }

  function supportStatusLabel(status) {
    if (status === "aprovada") return "Aprovada";
    if (status === "bloqueada") return "Bloqueada";
    return "Aguardando aprovação";
  }

  function ensureSupportSection(panel) {
    if (document.getElementById("suporte-contas-section")) return;
    const section = document.createElement("section");
    section.id = "suporte-contas-section";
    section.className = "box owner-support-management";
    section.innerHTML = `
      <div class="owner-support-heading">
        <div><h2>Contas da equipe de suporte</h2><p class="muted">O site operacional é separado. Aqui você apenas aprova, bloqueia e encerra sessões.</p></div>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <button id="btnRecarregarSuporte" type="button" class="secondary" style="min-height:36px;padding:0 14px;font-size:.82rem">Recarregar contas</button>
          <a href="./suporte/" target="_blank" rel="noopener">Abrir site do suporte</a>
          <a href="./atendimento.html" target="_blank" rel="noopener">Atendimento automático e fila humana</a>
        </div>
      </div>
      <div class="owner-support-security"><strong>Acesso protegido</strong><span>CPF, nascimento e foto ficam disponíveis somente nesta área do dono. O suporte não recebe dados financeiros.</span></div>
      <div id="ownerSupportAccounts" class="owner-support-list"><div class="owner-support-empty">Abra esta página para carregar as contas.</div></div>`;
    panel.appendChild(section);
    section.querySelector("#btnRecarregarSuporte")?.addEventListener("click", () => loadSupportAccounts());
    section.addEventListener("click", async (event) => {
      const button = event.target.closest("[data-support-action]");
      if (!button) return;
      const action = button.dataset.supportAction;
      const accountId = button.dataset.accountId;
      let reason = "";
      if (action === "block") {
        reason = prompt("Motivo do bloqueio:", "Acesso encerrado pelo dono") || "";
        if (!reason.trim()) return;
        if (!confirm("Bloquear esta conta e encerrar todas as sessões agora?")) return;
      } else if (!confirm("Aprovar esta pessoa para acessar o site de suporte?")) return;
      button.disabled = true;
      try {
        const response = await fetch(`${getBackendUrl()}/api/admin/support/accounts/${accountId}/${action}`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-owner-password": getOwnerPassword() },
          body: action === "block" ? JSON.stringify({ reason: reason.trim() }) : "{}",
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.message || data.error || "Não foi possível atualizar a conta.");
        await loadSupportAccounts();
      } catch (error) {
        alert(error.message || "Não foi possível atualizar a conta.");
        button.disabled = false;
      }
    });
  }

  function planDate(ms) {
    const value = Number(ms || 0);
    if (!value) return "-";
    return new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
  }

  function ensurePlansSection(panel) {
    if (document.getElementById("planos-section")) return;
    const section = document.createElement("section");
    section.id = "planos-section";
    section.className = "box owner-plans";
    section.innerHTML = `
      <div class="owner-plans-head"><div><h2>Planos ativados</h2><p class="muted">Últimos 30 dias. Ao escolher um motoboy, ele fica fixo no plano: cada entrega desse plano é aceita automaticamente por ele, ele recebe o aviso no WhatsApp dele; a notificação do app e os grupos do Telegram e do WhatsApp avisam todo mundo, mas só ele vê e pega a entrega e a entrega finaliza sozinha em 1 minuto (o ganho aparece em Ver ganhos). A empresa continua chamando pelo app normalmente.</p></div></div>
      <div class="owner-plans-filter" role="group" aria-label="Filtrar planos"><button type="button" data-plans-filter="ativos" aria-pressed="true">Valendo agora</button><button type="button" data-plans-filter="todos" aria-pressed="false">Todos</button></div>
      <div id="ownerPlansList" class="owner-plans-list"><div class="owner-support-empty">Aguardando dados do painel...</div></div>`;
    panel.appendChild(section);
    section.addEventListener("click", handlePlanAction);
  }

  // Avaliacoes dos clientes: o dono ve tudo (cliente, corrida, nota e comentario).
  function ensureRatingsSection(panel) {
    if (document.getElementById("avaliacoes-section")) return;
    const section = document.createElement("section");
    section.id = "avaliacoes-section";
    section.className = "box owner-ratings";
    section.innerHTML = `
      <div class="owner-plans-head"><div><h2>Avaliações dos motoboys</h2><p class="muted">Depois de cada corrida o cliente pode dar de 1 a 5 estrelas, marcar etiquetas e deixar um comentário. O motoboy vê a média e os comentários sem o nome do cliente; aqui você vê tudo.</p></div></div>
      <div id="ownerRatingsSummary" class="owner-ratings-summary"></div>
      <h3 class="owner-ratings-title">Ranking por motoboy</h3>
      <div id="ownerRatingsRanking" class="owner-ratings-ranking"></div>
      <h3 class="owner-ratings-title">Últimas avaliações</h3>
      <div class="owner-plans-filter" role="group" aria-label="Filtrar avaliações">
        <button type="button" data-ratings-filter="todas" aria-pressed="true">Todas</button>
        <button type="button" data-ratings-filter="baixas" aria-pressed="false">Notas 1 a 3</button>
        <button type="button" data-ratings-filter="comentario" aria-pressed="false">Com comentário</button>
        <select data-ratings-driver aria-label="Motoboy"><option value="">Todos os motoboys</option></select>
      </div>
      <div id="ownerRatingsList" class="owner-ratings-list"><div class="owner-support-empty">Aguardando dados do painel...</div></div>`;
    panel.appendChild(section);
    section.addEventListener("click", (event) => {
      const filter = event.target.closest("[data-ratings-filter]");
      if (!filter) return;
      ratingsFilter = filter.dataset.ratingsFilter;
      renderRatingsSection();
    });
    section.addEventListener("change", (event) => {
      if (!event.target.matches("[data-ratings-driver]")) return;
      ratingsDriver = event.target.value;
      renderRatingsSection();
    });
  }

  let ratingsFilter = "todas", ratingsDriver = "";
  // Estrelas preenchidas na proporcao da nota (4,67 mostra quase 5 cheias).
  const ratingStars = (nota) => `<span class="owner-stars" style="--p:${Math.max(0, Math.min(100, (Number(nota) || 0) * 20))}%" aria-label="${Number(nota || 0).toFixed(1)} de 5">★★★★★</span>`;
  function renderRatingsSection() {
    const list = document.getElementById("ownerRatingsList");
    if (!list) return;
    const ratings = Array.isArray(carAdminState.avaliacoes) ? carAdminState.avaliacoes : [];
    const drivers = Array.isArray(carAdminState.motoboys) ? carAdminState.motoboys : [];
    const now = Date.now();
    const last30 = ratings.filter((r) => now - Number(r.criadoEmMs || 0) < 30 * 864e5);
    const media30 = last30.length ? last30.reduce((t, r) => t + Number(r.nota || 0), 0) / last30.length : 0;
    const baixas30 = last30.filter((r) => Number(r.nota) <= 3).length;
    document.getElementById("ownerRatingsSummary").innerHTML = `
      <div><span>Média (30 dias)</span><strong>${media30 ? media30.toFixed(2).replace(".", ",") : "-"}</strong><small>${media30 ? ratingStars(media30) : "sem avaliações"}</small></div>
      <div><span>Avaliações (30 dias)</span><strong>${last30.length}</strong><small>de corridas finalizadas</small></div>
      <div><span>Notas 1 a 3 (30 dias)</span><strong class="${baixas30 ? "owner-ratings-bad" : ""}">${baixas30}</strong><small>${baixas30 ? "confira os comentários" : "nenhuma reclamação"}</small></div>`;

    const lowByDriver = {};
    ratings.forEach((r) => { if (Number(r.nota) <= 3) lowByDriver[r.motoboyCpf] = (lowByDriver[r.motoboyCpf] || 0) + 1; });
    const ranking = drivers
      .filter((d) => Number(d.notaQtd || 0) > 0)
      .map((d) => ({ cpf: String(d.id || d.cpf || ""), nome: d.nome || "Motoboy", total: Number(d.notaQtd || 0), media: Number(d.notaSoma || 0) / Number(d.notaQtd || 1) }))
      .sort((a, b) => b.media - a.media || b.total - a.total);
    document.getElementById("ownerRatingsRanking").innerHTML = ranking.length
      ? ranking.map((d, i) => `<article class="${d.media < 4.5 ? "attention" : ""}"><b>${i + 1}º</b><div><strong>${escapeHtml(d.nome)}</strong><small>CPF ${formatCpf(d.cpf)}</small></div><div><strong class="owner-ratings-stars">${d.media.toFixed(2).replace(".", ",")} ${ratingStars(d.media)}</strong><small>${d.total} avaliaç${d.total === 1 ? "ão" : "ões"}${lowByDriver[d.cpf] ? ` · ${lowByDriver[d.cpf]} nota(s) baixa(s) recentes` : ""}</small></div></article>`).join("")
      : `<div class="owner-support-empty">Nenhum motoboy avaliado ainda.</div>`;

    const select = document.querySelector("[data-ratings-driver]");
    if (select) {
      const names = new Map(ratings.map((r) => [r.motoboyCpf, r.motoboy || formatCpf(r.motoboyCpf)]));
      select.innerHTML = `<option value="">Todos os motoboys</option>${[...names].sort((a, b) => String(a[1]).localeCompare(String(b[1]), "pt-BR")).map(([cpf, nome]) => `<option value="${escapeHtml(cpf)}" ${cpf === ratingsDriver ? "selected" : ""}>${escapeHtml(nome)}</option>`).join("")}`;
    }
    document.querySelectorAll("[data-ratings-filter]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.ratingsFilter === ratingsFilter)));
    const shown = ratings.filter((r) => (!ratingsDriver || r.motoboyCpf === ratingsDriver)
      && (ratingsFilter !== "baixas" || Number(r.nota) <= 3)
      && (ratingsFilter !== "comentario" || String(r.comentario || "").trim()));
    list.innerHTML = shown.length
      ? shown.slice(0, 200).map((r) => `<article class="${Number(r.nota) <= 3 ? "low" : ""}"><div><span>${planDate(r.criadoEmMs)}</span><strong class="owner-ratings-stars">${ratingStars(r.nota)}</strong><small>${Number(r.nota)} de 5</small></div><div><span>Motoboy</span><strong>${escapeHtml(r.motoboy || "-")}</strong><small>CPF ${formatCpf(r.motoboyCpf)}</small></div><div><span>Cliente</span><strong>${escapeHtml(r.clienteNome || "Cliente")}</strong><small>Corrida ${escapeHtml(String(r.rideId || r.id || "").slice(0, 10))}</small></div><div class="owner-ratings-text">${(r.tags || []).length ? `<em>${r.tags.map(escapeHtml).join(" · ")}</em>` : ""}${r.comentario ? `<p>“${escapeHtml(r.comentario)}”</p>` : (r.tags || []).length ? "" : `<small>Sem comentário</small>`}</div></article>`).join("")
      : `<div class="owner-support-empty">${ratings.length ? "Nenhuma avaliação com esse filtro." : "Ainda não chegou nenhuma avaliação. Elas aparecem aqui assim que os clientes avaliarem as corridas."}</div>`;
  }

  // Indique e ganhe: participacoes do mes por cliente e sorteio da corrida gratis.
  function ensureReferralsSection(panel) {
    if (document.getElementById("indicacoes-section")) return;
    const section = document.createElement("section");
    section.id = "indicacoes-section";
    section.className = "box owner-ratings";
    section.innerHTML = `
      <div class="owner-plans-head"><div><h2>Indicações qualificadas</h2><p class="muted">Conta quando o amigo se cadastra pelo link de quem indicou e faz a primeira corrida finalizada. Cada amigo vale 1 participação no sorteio do mês.</p></div></div>
      <div class="owner-plans-filter" role="group" aria-label="Mês"><button type="button" data-ref-mes="atual" aria-pressed="true">Este mês</button><button type="button" data-ref-mes="anterior" aria-pressed="false">Mês passado</button><button type="button" class="approve" data-ref-sortear>🎲 Sortear ganhador</button></div>
      <div id="ownerReferralWinner"></div>
      <h3 class="owner-ratings-title">Participações por cliente</h3>
      <div id="ownerReferralRanking" class="owner-ratings-ranking"></div>
      <h3 class="owner-ratings-title">Amigos que fizeram a primeira corrida</h3>
      <div id="ownerReferralList" class="owner-ratings-ranking"></div>`;
    panel.appendChild(section);
    section.addEventListener("click", (event) => {
      const mes = event.target.closest("[data-ref-mes]");
      if (mes) { referralMonth = mes.dataset.refMes; referralWinner = null; renderReferralsSection(); return; }
      if (event.target.closest("[data-ref-sortear]")) drawReferralWinner();
    });
  }

  let referralMonth = "atual", referralWinner = null;
  function referralMonthKey() {
    const now = new Date();
    const date = referralMonth === "anterior" ? new Date(now.getFullYear(), now.getMonth() - 1, 15) : now;
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
  }
  function referralRanking() {
    const mes = referralMonthKey();
    const list = (Array.isArray(carAdminState.indicacoes) ? carAdminState.indicacoes : []).filter((item) => item.mes === mes);
    const byReferrer = new Map();
    list.forEach((item) => {
      const current = byReferrer.get(item.indicadorId) || { id: item.indicadorId, nome: item.indicadorNome || "Cliente", total: 0 };
      current.total += 1;
      byReferrer.set(item.indicadorId, current);
    });
    return { list, ranking: [...byReferrer.values()].sort((a, b) => b.total - a.total || a.nome.localeCompare(b.nome, "pt-BR")) };
  }
  function drawReferralWinner() {
    const { ranking } = referralRanking();
    const tickets = ranking.flatMap((person) => Array(person.total).fill(person));
    if (!tickets.length) return alert("Ninguém tem participação neste mês ainda.");
    const random = new Uint32Array(1);
    crypto.getRandomValues(random);
    referralWinner = tickets[random[0] % tickets.length];
    renderReferralsSection();
  }
  function renderReferralsSection() {
    const rankingRoot = document.getElementById("ownerReferralRanking");
    if (!rankingRoot) return;
    const { list, ranking } = referralRanking();
    document.querySelectorAll("[data-ref-mes]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.refMes === referralMonth)));
    const tickets = ranking.reduce((total, person) => total + person.total, 0);
    document.getElementById("ownerReferralWinner").innerHTML = referralWinner
      ? `<div class="owner-ratings-summary" style="grid-template-columns:1fr"><div><span>🎉 Ganhador sorteado (${tickets} participações)</span><strong>${escapeHtml(referralWinner.nome)}</strong><small>WhatsApp ${escapeHtml(formatPhone(referralWinner.id))} · ${referralWinner.total} participação(ões). Combine a corrida grátis com ele.</small></div></div>`
      : "";
    rankingRoot.innerHTML = ranking.length
      ? ranking.map((person, index) => `<article><b>${index + 1}º</b><div><strong>${escapeHtml(person.nome)}</strong><small>${escapeHtml(formatPhone(person.id))}</small></div><div><strong>${person.total} participaç${person.total > 1 ? "ões" : "ão"}</strong><small>${Math.round((person.total / tickets) * 100)}% de chance</small></div></article>`).join("")
      : `<div class="owner-support-empty">Nenhuma indicação qualificada neste mês ainda.</div>`;
    document.getElementById("ownerReferralList").innerHTML = list.length
      ? list.sort((a, b) => Number(b.qualificadaEmMs || 0) - Number(a.qualificadaEmMs || 0)).map((item) => `<article><b>✅</b><div><strong>${escapeHtml(item.indicadoNome || "Cliente")}</strong><small>final ${escapeHtml(item.indicadoFinal || "")} · ${planDate(item.qualificadaEmMs)}</small></div><div><strong>indicado por ${escapeHtml(item.indicadorNome || "Cliente")}</strong><small>${escapeHtml(formatPhone(item.indicadorId))}</small></div></article>`).join("")
      : `<div class="owner-support-empty">Quando um amigo indicado fizer a primeira corrida, ele aparece aqui.</div>`;
  }

  let plansFilter = "ativos";
  function renderPlansSection() {
    const root = document.getElementById("ownerPlansList");
    if (!root) return;
    const now = Date.now();
    const plans = (Array.isArray(carAdminState.planosAtivados) ? carAdminState.planosAtivados : [])
      .filter((plan) => plansFilter === "todos" || Number(plan.expiraEmMs || 0) > now);
    document.querySelectorAll("[data-plans-filter]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.plansFilter === plansFilter)));
    const drivers = (Array.isArray(carAdminState.motoboys) ? carAdminState.motoboys : [])
      .filter((driver) => driver.status !== "bloqueado" && String(driver.id || driver.cpf || "").replace(/\D/g, "").length === 11)
      .sort((a, b) => String(a.nome || "").localeCompare(String(b.nome || ""), "pt-BR"));
    if (!plans.length) {
      root.innerHTML = `<div class="owner-support-empty">${plansFilter === "todos" ? "Nenhuma empresa ativou plano nos últimos 30 dias." : "Nenhum plano valendo agora. Toque em Todos para ver os anteriores."}</div>`;
      return;
    }
    root.innerHTML = plans.map((plan) => {
      const active = Number(plan.expiraEmMs || 0) > now;
      const daily = plan.tipo !== "meio_periodo";
      const chosen = String(plan.motoboyExclusivoCpf || "");
      const options = drivers.map((driver) => {
        const cpf = String(driver.id || driver.cpf || "").replace(/\D/g, "");
        return `<option value="${cpf}" ${cpf === chosen ? "selected" : ""}>${escapeHtml(driver.nome || "Motoboy")} · CPF ${formatCpf(cpf)}</option>`;
      }).join("");
      const choice = active
        ? `<div class="owner-plan-driver"><label>Motoboy do plano<select data-plan-driver="${escapeHtml(plan.id)}"><option value="">Todos os motoboys (sem reserva)</option>${options}</select></label><button class="approve" type="button" data-plan-save="${escapeHtml(plan.id)}">Salvar motoboy</button></div>`
        : `<div class="owner-plan-driver"><span>Motoboy do plano</span><strong>${chosen ? escapeHtml(plan.motoboyExclusivoNome || formatCpf(chosen)) : "Todos os motoboys"}</strong></div>`;
      return `<article class="owner-plan ${active ? "active" : ""}"><div><span>Empresa</span><strong>${escapeHtml(plan.empresa || plan.empresaId || "-")}</strong><small>${escapeHtml(formatPhone(plan.empresaId || ""))}</small></div><div><span>Modalidade</span><strong>${daily ? "Plano Diário Pro" : "Plano Meio Período"}</strong><small>${Number(plan.valor || (daily ? 70 : 25)).toLocaleString("pt-BR", { style: "currency", currency: "BRL" })} · ${daily ? "R$ 4,00 / R$ 10,00 por entrega" : "R$ 5,50 / R$ 12,00 por entrega"}</small></div><div><span>Escolheu em</span><strong>${planDate(plan.ativadoEmMs)}</strong><small>${active ? `Vale até ${planDate(plan.expiraEmMs)}` : `Encerrou ${planDate(plan.expiraEmMs)}`}</small></div><div><span>Situação</span><strong class="${active ? "state-aprovada" : ""}">${active ? "Valendo agora" : "Encerrado"}</strong><small>${chosen ? `Só ${escapeHtml(plan.motoboyExclusivoNome || "o motoboy escolhido")}` : "Aberto para todos"}</small></div>${choice}</article>`;
    }).join("");
  }

  async function handlePlanAction(event) {
    const filter = event.target.closest("[data-plans-filter]");
    if (filter) {
      plansFilter = filter.dataset.plansFilter;
      renderPlansSection();
      return;
    }
    const save = event.target.closest("[data-plan-save]");
    if (!save) return;
    const key = save.dataset.planSave;
    const select = [...document.querySelectorAll("[data-plan-driver]")].find((item) => item.dataset.planDriver === key);
    const cpf = select?.value || "";
    const label = cpf ? select.options[select.selectedIndex].textContent : "todos os motoboys";
    if (!confirm(cpf ? `Deixar ${label} fixo neste plano? As entregas serão aceitas automaticamente por ele e finalizadas sozinhas em 1 minuto.` : "Liberar as entregas deste plano para todos os motoboys?")) return;
    save.disabled = true;
    save.textContent = "Salvando...";
    try {
      const response = await fetch(`${getBackendUrl()}/api/admin/plans/${encodeURIComponent(key)}/driver`, { method: "POST", headers: { "content-type": "application/json", "x-owner-password": getOwnerPassword() }, body: JSON.stringify({ cpf }) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.message || data.error || "Não consegui salvar o motoboy do plano.");
      alert(cpf ? `Pronto: ${data.motoboy?.nome || "o motoboy escolhido"} ficou fixo neste plano. Cada entrega nova é aceita por ele na hora, ele recebe aviso no WhatsApp, todos veem a notificação e os grupos (mas só ele pega) e ela finaliza sozinha em 1 minuto.${data.entregasAceitas ? ` ${data.entregasAceitas} entrega(s) que estavam esperando já ficaram com ele.` : ""}` : "Pronto: as entregas deste plano voltaram a aparecer para todos os motoboys.");
      if (typeof window.carregarPainel === "function") await window.carregarPainel();
    } catch (error) {
      alert(error.message || "Não consegui salvar o motoboy do plano.");
    } finally {
      save.disabled = false;
      save.textContent = "Salvar motoboy";
    }
  }

  function carStatusLabel(status) {
    return ({ pendente: "Pendente", aceita: "Motorista a caminho", motorista_chegou: "No embarque", em_andamento: "Em andamento", finalizada: "Finalizada", cancelada: "Cancelada", expirada: "Expirada" })[status] || status || "-";
  }

  function carDate(value) {
    const seconds = Number(value?.seconds || 0);
    return seconds ? new Date(seconds * 1000).toLocaleString("pt-BR") : "-";
  }

  function ensureCarSection(panel) {
    if (document.getElementById("carroja-section")) return;
    const section = document.createElement("section");
    section.id = "carroja-section";
    section.className = "box owner-car-management";
    section.innerHTML = `
      <div class="owner-car-heading"><div><h2>Operação Nexus CarroJÁ</h2><p class="muted">Cadastros e corridas ficam separados da operação de motos.</p></div><a href="./carroja/" target="_blank" rel="noopener">Abrir CarroJÁ</a></div>
      <div id="ownerCarMetrics" class="owner-car-metrics"></div>
      <div class="owner-car-panel"><header><div><span>MOTORISTAS</span><h3>Cadastros de carro</h3></div></header><div id="ownerCarDrivers" class="owner-car-list"><div class="owner-support-empty">Aguardando dados do painel...</div></div></div>
      <div class="owner-car-panel"><header><div><span>CORRIDAS</span><h3>Chamados recentes</h3></div></header><div id="ownerCarRides" class="owner-car-list"><div class="owner-support-empty">Aguardando dados do painel...</div></div></div>`;
    panel.appendChild(section);
    section.addEventListener("click", handleCarAction);
  }

  function renderCarSection() {
    const metrics = document.getElementById("ownerCarMetrics");
    const driversRoot = document.getElementById("ownerCarDrivers");
    const ridesRoot = document.getElementById("ownerCarRides");
    if (!metrics || !driversRoot || !ridesRoot) return;
    const rides = Array.isArray(carAdminState.corridasCarro) ? carAdminState.corridasCarro : [];
    const drivers = Array.isArray(carAdminState.carroMotoristas) ? carAdminState.carroMotoristas : [];
    const pendingDrivers = drivers.filter((driver) => driver.status === "aguardando_aprovacao").length;
    const active = rides.filter((ride) => ["pendente", "aceita", "motorista_chegou", "em_andamento"].includes(ride.status)).length;
    const finished = rides.filter((ride) => ride.status === "finalizada");
    const revenue = finished.reduce((total, ride) => total + Number(ride.appFee || 0), 0);
    metrics.innerHTML = `<article><span>Motoristas</span><strong>${drivers.length}</strong><small>${pendingDrivers} aguardando aprovação</small></article><article><span>Em operação</span><strong>${active}</strong><small>Pendentes ou em viagem</small></article><article><span>Finalizadas</span><strong>${finished.length}</strong><small>Histórico carregado</small></article><article><span>Receita do app</span><strong>${Number(revenue).toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}</strong><small>Corridas finalizadas</small></article>`;
    driversRoot.innerHTML = drivers.length ? drivers.map((driver) => {
      const car = driver || {};
      const cpf = car.id || car.motoristaCpf || "";
      const driverName = car.motoristaNome || "Motorista";
      const status = car.status || "aguardando_aprovacao";
      const action = status === "aprovado"
        ? `<button class="danger" data-car-driver-action="block" data-cpf="${escapeHtml(cpf)}">Bloquear carro</button>`
        : `<button class="approve" data-car-driver-action="approve" data-cpf="${escapeHtml(cpf)}">${status === "bloqueado" ? "Reativar carro" : "Aprovar carro"}</button>`;
      const carPhoto = escapeHtml(car.fotoCarro || "");
      const carDocument = escapeHtml(car.crlvFoto || "");
      const documents = `${carPhoto ? `<a href="${carPhoto}" target="_blank" rel="noopener">Ver carro</a>` : ""}${carDocument ? `<a href="${carDocument}" target="_blank" rel="noopener">Ver CRLV</a>` : ""}`;
      return `<article class="owner-car-driver"><div class="owner-car-person">${carPhoto ? `<img src="${carPhoto}" alt="Carro de ${escapeHtml(driverName)}">` : "<span>CAR</span>"}<div><strong>${escapeHtml(driverName)}</strong><small>${escapeHtml(car.modelo || "-")} · ${escapeHtml(car.cor || "-")} · ${escapeHtml(car.placa || "-")}</small><div class="owner-car-docs">${documents}</div></div></div><div><span>Cidade base</span><strong>${escapeHtml(car.cidadeBase || "-")}</strong></div><div><span>Status</span><strong class="state-${escapeHtml(status)}">${escapeHtml(status.replaceAll("_", " "))}</strong><small>${car.online ? "Online agora" : "Offline"}</small></div><div class="owner-car-actions">${action}</div></article>`;
    }).join("") : '<div class="owner-support-empty">Nenhum motorista cadastrou carro ainda.</div>';
    const ordered = [...rides].sort((a, b) => Number(b.criadaEm?.seconds || 0) - Number(a.criadaEm?.seconds || 0));
    ridesRoot.innerHTML = ordered.length ? ordered.map((ride) => {
      const canCancel = ["pendente", "aceita", "motorista_chegou"].includes(ride.status);
      const canFinish = ["aceita", "motorista_chegou", "em_andamento"].includes(ride.status) && ride.motoristaCpf;
      return `<article class="owner-car-ride"><div><span>${carDate(ride.criadaEm)}</span><strong>${escapeHtml(ride.passageiroNome || "Passageiro")}</strong><small>${escapeHtml(ride.origemEncontrada || ride.origem)} → ${escapeHtml(ride.destinoEncontrado || ride.destino)}</small></div><div><span>Motorista</span><strong>${escapeHtml(ride.motorista || "Aguardando")}</strong><small>${Number(ride.km || 0).toFixed(2).replace(".", ",")} km · ${Number(ride.valor || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}</small></div><div><span>Status</span><strong>${escapeHtml(carStatusLabel(ride.status))}</strong></div><div class="owner-car-actions">${canFinish ? `<button class="approve" data-car-ride-action="finish" data-id="${ride.id}">Finalizar</button>` : ""}${canCancel ? `<button class="danger" data-car-ride-action="cancel" data-id="${ride.id}">Cancelar</button>` : ""}</div></article>`;
    }).join("") : '<div class="owner-support-empty">Nenhuma corrida de carro registrada.</div>';
  }

  async function handleCarAction(event) {
    const driverButton = event.target.closest("[data-car-driver-action]");
    const rideButton = event.target.closest("[data-car-ride-action]");
    if (!driverButton && !rideButton) return;
    const button = driverButton || rideButton;
    let path = "";
    let body = {};
    if (driverButton) {
      const action = driverButton.dataset.carDriverAction;
      if (action === "block") {
        const reason = prompt("Motivo do bloqueio do carro:", "Bloqueado pelo dono");
        if (!reason?.trim()) return;
        body.reason = reason.trim();
      } else if (!confirm("Aprovar este carro para receber corridas?")) return;
      path = `/api/admin/car/drivers/${driverButton.dataset.cpf}/${action}`;
    } else {
      const action = rideButton.dataset.carRideAction;
      const reason = prompt(action === "finish" ? "Motivo da finalização manual:" : "Motivo do cancelamento:", action === "finish" ? "Corrida concluída e confirmada pelo suporte" : "Cancelada pelo dono");
      if (!reason?.trim()) return;
      if (!confirm(action === "finish" ? "Confirmar que esta corrida foi concluída?" : "Cancelar esta corrida de carro?")) return;
      body.reason = reason.trim();
      path = `/api/admin/car/rides/${rideButton.dataset.id}/${action === "finish" ? "force-finish" : "cancel"}`;
    }
    button.disabled = true;
    try {
      const response = await fetch(`${getBackendUrl()}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-owner-password": getOwnerPassword() }, body: JSON.stringify(body) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.message || data.error || "Não foi possível atualizar.");
      if (typeof window.carregarPainel === "function") {
        await window.carregarPainel();
      }
    } catch (error) {
      alert(error.message || "Não foi possível atualizar.");
      button.disabled = false;
    }
  }

  function renderSupportAccounts(accounts) {
    const root = document.getElementById("ownerSupportAccounts");
    if (!root) return;
    if (!accounts.length) {
      root.innerHTML = '<div class="owner-support-empty">Nenhum cadastro de suporte recebido.</div>';
      return;
    }
    root.innerHTML = accounts.map((account) => {
      const status = account.status || "aguardando_aprovacao";
      const primaryAction = status === "aprovada"
        ? `<button class="danger" data-support-action="block" data-account-id="${account.id}">Bloquear e desconectar</button>`
        : `<button class="approve" data-support-action="approve" data-account-id="${account.id}">${status === "bloqueada" ? "Reativar conta" : "Aprovar acesso"}</button>`;
      return `<article class="owner-support-card">
        <div class="owner-support-person">${account.foto ? `<img src="${account.foto}" alt="Foto de ${escapeHtml(account.nome)}">` : '<span>MJ</span>'}<div><strong>${escapeHtml(account.nome)}</strong><small>${escapeHtml(formatPhone(account.telefone))}</small></div></div>
        <div class="owner-support-detail"><span>CPF</span><strong>${escapeHtml(account.cpf ? formatCpf(account.cpf) : `***.***.***-${account.cpfFinal || "**"}`)}</strong></div>
        <div class="owner-support-detail"><span>Nascimento</span><strong>${escapeHtml(formatBirth(account.dataNascimento))}</strong></div>
        <div class="owner-support-detail"><span>Cadastro</span><strong>${supportDate(account.cadastradaEm)}</strong></div>
        <div class="owner-support-state ${status}"><strong>${supportStatusLabel(status)}</strong><small>${escapeHtml(account.motivoBloqueio || (account.ultimoLoginEm ? `Último login: ${supportDate(account.ultimoLoginEm)}` : "Ainda não entrou"))}</small></div>
        <div class="owner-support-actions">${primaryAction}</div>
      </article>`;
    }).join("");
  }

  async function loadSupportAccounts() {
    const pwd = getOwnerPassword();
    const root = document.getElementById("ownerSupportAccounts");
    if (!pwd) {
      if (root) root.innerHTML = '<div class="owner-support-empty">Faça login com a senha do dono para carregar as contas.</div>';
      return;
    }
    if (supportAccountsLoading) return;
    supportAccountsLoading = true;
    if (root) root.innerHTML = '<div class="owner-support-empty">Carregando contas protegidas...</div>';
    try {
      const response = await fetch(`${getBackendUrl()}/api/admin/support/accounts`, {
        headers: { "x-owner-password": pwd }, cache: "no-store",
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.message || data.error || "Erro ao carregar equipe.");
      renderSupportAccounts(Array.isArray(data.accounts) ? data.accounts : []);
    } catch (error) {
      if (root) root.innerHTML = `<div class="owner-support-empty error">${escapeHtml(error.message || "Erro ao carregar equipe.")}</div>`;
    } finally {
      supportAccountsLoading = false;
    }
  }

  function currentPageFromHash() {
    const hash = window.location.hash.replace("#", "");
    const match = Object.entries(pages).find(([, page]) => page.targets.includes(hash));
    return match?.[0] || "overview";
  }

  function setPage(name, options = {}) {
    const page = pages[name] || pages.overview;
    const shell = document.getElementById("ownerWorkspace");
    if (!shell) return;

    Object.values(pages)
      .flatMap((item) => item.targets)
      .forEach((id) => {
        const section = document.getElementById(id);
        if (section) section.hidden = !page.targets.includes(id);
      });

    shell.querySelectorAll("[data-owner-page]").forEach((link) => {
      const active = link.dataset.ownerPage === name;
      link.classList.toggle("active", active);
      // No celular as abas rolam de lado: mantem a aba escolhida visivel.
      const nav = link.parentElement;
      if (active && nav && nav.scrollWidth > nav.clientWidth) {
        const offset = link.getBoundingClientRect().left - nav.getBoundingClientRect().left;
        if (offset < 0 || offset + link.offsetWidth > nav.clientWidth) nav.scrollBy({ left: offset - 8, behavior: "smooth" });
      }
      if (active) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    });

    document.getElementById("ownerWorkspaceEyebrow").textContent = page.eyebrow;
    document.getElementById("ownerWorkspaceTitle").textContent = page.title;
    document.getElementById("ownerWorkspaceDescription").textContent = page.description;
    shell.dataset.page = name;

    if (options.updateHash !== false) {
      history.replaceState(null, "", `#${page.targets[0]}`);
    }
    if (options.scroll !== false) {
      document.querySelector(".owner-workspace-head")?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
    if (name === "support") loadSupportAccounts();
    if (name === "cars") renderCarSection();
    if (name === "plans") renderPlansSection();
    if (name === "ratings") renderRatingsSection();
    if (name === "referrals") renderReferralsSection();
  }

  function buildNavigation(nav) {
    nav.innerHTML = "";
    nav.classList.add("owner-side-nav");
    navConfig.forEach(([label, page, index, group]) => {
      if (group) {
        const heading = document.createElement("span");
        heading.className = "owner-nav-group";
        heading.textContent = group;
        nav.appendChild(heading);
      }
      const link = document.createElement("a");
      link.href = `#${pages[page].targets[0]}`;
      link.dataset.ownerPage = page;
      link.innerHTML = `<span>${index}</span><strong>${label}</strong>`;
      link.addEventListener("click", (event) => {
        event.preventDefault();
        setPage(page);
      });
      nav.appendChild(link);
    });
  }

  function createWorkspace() {
    const panel = document.getElementById("painel");
    const nav = panel?.querySelector(":scope > .dash-nav");
    const overview = document.getElementById("visao-section");
    if (!panel || !nav || !overview || document.getElementById("ownerWorkspace")) return;
    ensureSupportSection(panel);
    ensureCarSection(panel);
    ensurePlansSection(panel);
    ensureRatingsSection(panel);
    ensureReferralsSection(panel);

    const originalChildren = [...panel.children];
    const globalFilters = originalChildren.find((element) => element.querySelector?.("#periodo"));
    const legacyCards = originalChildren.find((element) => element.classList?.contains("cards"));

    const shell = document.createElement("div");
    shell.id = "ownerWorkspace";
    shell.className = "owner-workspace";
    shell.innerHTML = `
      <aside class="owner-sidebar">
        <div class="owner-sidebar-brand"><span>MJ</span><div><strong>Central MotoJÁ</strong><small>Administração</small></div></div>
        <div class="owner-sidebar-label">Menu principal</div>
        <div id="ownerNavSlot"></div>
        <div class="owner-sidebar-foot"><i></i><div><strong>Sistema operacional</strong><small>Dados sincronizados pelo painel</small></div></div>
      </aside>
      <div class="owner-stage">
        <header class="owner-workspace-head">
          <div><span id="ownerWorkspaceEyebrow">Central de operação</span><h2 id="ownerWorkspaceTitle">Visão geral</h2><p id="ownerWorkspaceDescription"></p></div>
          <div class="owner-workspace-state"><i></i><span><strong>Operação online</strong><small>Última carga do painel</small></span></div>
        </header>
        <div id="ownerFilterSlot"></div>
        <div id="ownerPageSlot" class="owner-page-slot"></div>
      </div>`;

    panel.appendChild(shell);
    const navSlot = shell.querySelector("#ownerNavSlot");
    const filterSlot = shell.querySelector("#ownerFilterSlot");
    const pageSlot = shell.querySelector("#ownerPageSlot");

    buildNavigation(nav);
    navSlot.appendChild(nav);

    if (globalFilters) {
      globalFilters.classList.add("owner-global-filters");
      filterSlot.appendChild(globalFilters);
    }
    if (legacyCards) {
      legacyCards.classList.add("owner-legacy-cards");
      pageSlot.appendChild(legacyCards);
    }
    Object.values(pages)
      .flatMap((page) => page.targets)
      .forEach((id) => {
        const section = document.getElementById(id);
        if (section) pageSlot.appendChild(section);
      });

    const logo = document.querySelector(".brand-logo img");
    if (logo) logo.src = "./nexus-motoja-icon-192.png?v=174";

    document.addEventListener("click", (event) => {
      const link = event.target.closest("#ownerAlerts a[href^='#']");
      if (!link) return;
      const target = link.getAttribute("href").slice(1);
      const match = Object.entries(pages).find(([, page]) => page.targets.includes(target));
      if (!match) return;
      event.preventDefault();
      setPage(match[0]);
    });

    window.addEventListener("hashchange", () => setPage(currentPageFromHash(), { updateHash: false, scroll: false }));
    setPage(currentPageFromHash(), { updateHash: false, scroll: false });
  }

  document.addEventListener("DOMContentLoaded", createWorkspace);
  window.addEventListener("motoja:admin-state", (event) => {
    carAdminState = event.detail || carAdminState;
    renderCarSection();
    renderPlansSection();
    renderRatingsSection();
    renderReferralsSection();
    if (Array.isArray(event.detail?.contasSuporte) && event.detail.contasSuporte.length) {
      renderSupportAccounts(event.detail.contasSuporte);
    } else if (getOwnerPassword()) {
      loadSupportAccounts();
    } else if (Array.isArray(event.detail?.contasSuporte)) {
      renderSupportAccounts([]);
    }
  });
})();
