(function () {
  "use strict";

  const pages = {
    overview: {
      title: "Visão geral",
      eyebrow: "Central de operação",
      description: "Acompanhe a saúde da operação e resolva primeiro o que exige atenção.",
      targets: ["visao-section"],
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
    ["Entregas", "deliveries", "02", "Operação"],
    ["Corridas", "rides", "03", ""],
    ["CarroJÁ", "cars", "04", ""],
    ["Depósitos", "deposits", "05", "Financeiro"],
    ["Empresas", "companies", "06", "Gestão"],
    ["Motoboys", "drivers", "07", ""],
    ["Equipe suporte", "support", "08", ""],
    ["Funil", "funnel", "09", "Análise"],
  ];

  let supportAccountsLoading = false;
  let carAdminState = { corridasCarro: [], carroMotoristas: [] };

  function escapeHtml(value) {
    return String(value || "").replace(/[&<>'"]/g, (character) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
    })[character]);
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
        <a href="./suporte/" target="_blank" rel="noopener">Abrir site do suporte</a>
      </div>
      <div class="owner-support-security"><strong>Acesso protegido</strong><span>CPF, nascimento e foto ficam disponíveis somente nesta área do dono. O suporte não recebe dados financeiros.</span></div>
      <div id="ownerSupportAccounts" class="owner-support-list"><div class="owner-support-empty">Abra esta página para carregar as contas.</div></div>`;
    panel.appendChild(section);
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
        const response = await fetch(`${CONFIG.backend}/api/admin/support/accounts/${accountId}/${action}`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-owner-password": senhaDono },
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
      const response = await fetch(`${CONFIG.backend}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-owner-password": senhaDono }, body: JSON.stringify(body) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.message || data.error || "Não foi possível atualizar.");
      await carregarPainel();
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
        <div class="owner-support-person">${account.foto ? `<img src="${account.foto}" alt="Foto de ${escapeHtml(account.nome)}">` : '<span>MJ</span>'}<div><strong>${escapeHtml(account.nome)}</strong><small>${escapeHtml(account.telefone || "Sem telefone")}</small></div></div>
        <div class="owner-support-detail"><span>CPF</span><strong>${escapeHtml(account.cpf || `***.***.***-${account.cpfFinal || "**"}`)}</strong></div>
        <div class="owner-support-detail"><span>Nascimento</span><strong>${escapeHtml(account.dataNascimento || "-")}</strong></div>
        <div class="owner-support-detail"><span>Cadastro</span><strong>${supportDate(account.cadastradaEm)}</strong></div>
        <div class="owner-support-state ${status}"><strong>${supportStatusLabel(status)}</strong><small>${escapeHtml(account.motivoBloqueio || (account.ultimoLoginEm ? `Último login: ${supportDate(account.ultimoLoginEm)}` : "Ainda não entrou"))}</small></div>
        <div class="owner-support-actions">${primaryAction}</div>
      </article>`;
    }).join("");
  }

  async function loadSupportAccounts() {
    if (supportAccountsLoading || !senhaDono) return;
    supportAccountsLoading = true;
    const root = document.getElementById("ownerSupportAccounts");
    if (root) root.innerHTML = '<div class="owner-support-empty">Carregando contas protegidas...</div>';
    try {
      const response = await fetch(`${CONFIG.backend}/api/admin/support/accounts`, {
        headers: { "x-owner-password": senhaDono }, cache: "no-store",
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
  });
})();
