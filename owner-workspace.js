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
    ["Depósitos", "deposits", "04", "Financeiro"],
    ["Empresas", "companies", "05", "Gestão"],
    ["Motoboys", "drivers", "06", ""],
    ["Funil", "funnel", "07", "Análise"],
  ];

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
})();
