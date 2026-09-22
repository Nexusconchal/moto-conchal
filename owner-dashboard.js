(function () {
  "use strict";

  let adminState = null;
  let dashboardReady = false;
  const nativeFetch = window.fetch.bind(window);

  window.fetch = async function (...args) {
    const response = await nativeFetch(...args);
    const url = String(typeof args[0] === "string" ? args[0] : args[0]?.url || "");
    if (response.ok && url.includes("/api/admin/state")) {
      response
        .clone()
        .json()
        .then((payload) => {
          adminState = payload;
          window.dispatchEvent(new CustomEvent("motoja:admin-state", { detail: payload }));
        })
        .catch(() => {});
    }
    return response;
  };

  const money = (value) =>
    Number(value || 0).toLocaleString("pt-BR", {
      style: "currency",
      currency: "BRL",
    });

  const number = (value) =>
    Number(value || 0).toLocaleString("pt-BR", { maximumFractionDigits: 1 });

  function timestamp(value) {
    if (!value) return 0;
    if (typeof value === "number") return value;
    if (value.seconds) return Number(value.seconds) * 1000;
    const parsed = new Date(value).getTime();
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function jobTimestamp(job) {
    return timestamp(
      job.finalizadaEm ||
        job.retiradaEm ||
        job.aceitaEm ||
        job.criadaEm ||
        job.atualizadaEm,
    );
  }

  function startOfDay(value = new Date()) {
    const date = value instanceof Date ? new Date(value) : new Date(`${value}T00:00:00`);
    date.setHours(0, 0, 0, 0);
    return date;
  }

  function endOfDay(value = new Date()) {
    const date = value instanceof Date ? new Date(value) : new Date(`${value}T23:59:59`);
    date.setHours(23, 59, 59, 999);
    return date;
  }

  function inSelectedPeriod(item) {
    const select = document.getElementById("periodo");
    const period = select?.value || "hoje";
    const date = new Date(jobTimestamp(item));
    if (!jobTimestamp(item)) return false;
    if (period === "todos") return true;
    const today = startOfDay();
    if (period === "hoje") return date >= today && date <= endOfDay();
    if (period === "ontem") {
      const yesterday = startOfDay();
      yesterday.setDate(yesterday.getDate() - 1);
      return date >= yesterday && date <= endOfDay(yesterday);
    }
    if (period === "7dias") {
      const first = startOfDay();
      first.setDate(first.getDate() - 6);
      return date >= first && date <= endOfDay();
    }
    if (period === "personalizado") {
      const startValue = document.getElementById("dataInicio")?.value;
      const endValue = document.getElementById("dataFim")?.value;
      return (!startValue || date >= startOfDay(startValue)) && (!endValue || date <= endOfDay(endValue));
    }
    const day = date.getDate();
    if (period === "1-10") return day >= 1 && day <= 10;
    if (period === "11-20") return day >= 11 && day <= 20;
    return day >= 21 && day <= 31;
  }

  function isSpecialDestination(value) {
    return /martinho\s*prado|tujuguaba|iate/i.test(
      String(value || "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, ""),
    );
  }

  function isFoodDelivery(item) {
    return /lanche|comida|pizza|pastel|acai|sorvete|marmita|farmacia/i.test(
      String(item.tipoEntrega || ""),
    );
  }

  function deliveryAppValue(item) {
    const value = Number(item.valor || 0);
    if (item.tipo === "servico_exclusivo" || /exclusivo/i.test(String(item.tipoEntrega || ""))) {
      return Number(item.ganhoApp || item.valorApp || item.ganhoAppPrevisto || 20);
    }
    if (isFoodDelivery(item)) {
      const destinations = [
        `${item.entrega || ""} ${item.entregaEncontrada || ""}`,
        ...(Array.isArray(item.pontosExtras)
          ? item.pontosExtras.map((point) => `${point.digitado || ""} ${point.encontrado || ""}`)
          : []),
      ];
      let fee = 0;
      for (let index = 0; index < Math.max(1, Number(item.paradas || 1)); index += 1) {
        fee += isSpecialDestination(destinations[index]) ? 2 : 1.5;
      }
      return Math.min(value, fee);
    }
    return value * (Number(item.km || 0) > 8 ? 0.2 : 0.25);
  }

  function appValue(item, type) {
    if (type === "delivery") return deliveryAppValue(item);
    return Number(item.valor || 0) * (Number(item.km || 0) > 8 ? 0.2 : 0.25);
  }

  function periodLabel() {
    const select = document.getElementById("periodo");
    return select?.options[select.selectedIndex]?.textContent || "Hoje";
  }

  function statusGroup(status) {
    if (status === "finalizada") return "finalizada";
    if (status === "cancelada") return "cancelada";
    if (status === "expirada") return "expirada";
    if (status === "pendente") return "pendente";
    return "andamento";
  }

  function calculateSummary(state) {
    const rides = (state.corridas || []).filter(inSelectedPeriod).map((item) => ({ ...item, serviceType: "ride" }));
    const deliveries = (state.entregas || []).filter(inSelectedPeriod).map((item) => ({ ...item, serviceType: "delivery" }));
    const jobs = [...rides, ...deliveries];
    const finished = jobs.filter((item) => item.status === "finalizada");
    const gross = finished.reduce((sum, item) => sum + Number(item.valor || 0), 0);
    const app = finished.reduce((sum, item) => sum + appValue(item, item.serviceType), 0);
    const resolved = jobs.filter((item) => ["finalizada", "cancelada", "expirada"].includes(item.status));
    const canceled = jobs.filter((item) => item.status === "cancelada").length;
    const accepted = jobs.filter((item) => ["aceita", "retirada", "finalizada"].includes(item.status)).length;
    return {
      rides,
      deliveries,
      jobs,
      finished,
      gross,
      app,
      driver: gross - app,
      average: finished.length ? gross / finished.length : 0,
      completionRate: resolved.length ? (finished.length / resolved.length) * 100 : 0,
      cancellationRate: finished.length + canceled ? (canceled / (finished.length + canceled)) * 100 : 0,
      acceptanceRate: jobs.length ? (accepted / jobs.length) * 100 : 0,
    };
  }

  function metric(label, value, detail, tone = "") {
    return `<div class="owner-metric ${tone}"><span>${label}</span><strong>${value}</strong><small>${detail}</small></div>`;
  }

  function alertItem(label, detail, count, href, severity = "warn") {
    return `<a class="owner-alert ${severity}" href="${href}"><span class="owner-alert-count">${count}</span><span><strong>${label}</strong><small>${detail}</small></span><b>Ver</b></a>`;
  }

  function renderAlerts(state, summary) {
    const now = Date.now();
    const oldPending = summary.jobs.filter(
      (item) => item.status === "pendente" && now - jobTimestamp(item) > 10 * 60 * 1000,
    ).length;
    const stalled = summary.jobs.filter(
      (item) => ["aceita", "retirada"].includes(item.status) && now - jobTimestamp(item) > 30 * 60 * 1000,
    ).length;
    const expired = summary.jobs.filter((item) => item.status === "expirada").length;
    const pendingDeposits = (state.depositos || []).filter((item) => item.status === "pendente").length;
    const pendingCompanies = (state.empresas || []).filter((item) => item.status === "aguardando_aprovacao").length;
    const recoveries = (state.recuperacoesSenhaEmpresa || []).filter((item) => !item.status || item.status === "pendente").length;
    const lowBalance = (state.empresas || []).filter(
      (item) => item.status === "aprovada" && Number(item.disponivel ?? item.saldo ?? 0) < 16,
    ).length;
    const blockedDrivers = (state.motoboys || []).filter((item) => item.status === "bloqueado").length;
    const alerts = [
      oldPending && alertItem("Chamadas demorando", "Pendentes há mais de 10 minutos", oldPending, "#corridas-section", "danger"),
      stalled && alertItem("Serviços parados", "Aceitos ou retirados há mais de 30 minutos", stalled, "#entregas-section", "danger"),
      expired && alertItem("Serviços expirados", "Podem ser chamados novamente", expired, "#entregas-section"),
      pendingDeposits && alertItem("Depósitos aguardando", "Precisam de conferência", pendingDeposits, "#depositos-section"),
      pendingCompanies && alertItem("Empresas para aprovar", "Cadastros esperando sua decisão", pendingCompanies, "#empresas-section"),
      recoveries && alertItem("Recuperações de senha", "Pedidos ainda não atendidos", recoveries, "#senhas-section"),
      lowBalance && alertItem("Empresas com saldo baixo", "Menos de R$ 16 disponíveis", lowBalance, "#empresas-section"),
      blockedDrivers && alertItem("Motoboys bloqueados", "Confira os motivos registrados", blockedDrivers, "#motoboys-section", "neutral"),
    ].filter(Boolean);
    document.getElementById("ownerAlerts").innerHTML = alerts.length
      ? alerts.join("")
      : '<div class="owner-all-good"><strong>Operação em ordem</strong><span>Nenhum alerta importante neste momento.</span></div>';
    document.getElementById("ownerAlertBadge").textContent = `${alerts.length} alerta${alerts.length === 1 ? "" : "s"}`;
  }

  function renderStatusBars(summary) {
    const labels = [
      ["finalizada", "Finalizados", "green"],
      ["andamento", "Em andamento", "blue"],
      ["pendente", "Pendentes", "orange"],
      ["expirada", "Expirados", "yellow"],
      ["cancelada", "Cancelados", "red"],
    ];
    const counts = Object.fromEntries(labels.map(([key]) => [key, 0]));
    summary.jobs.forEach((item) => {
      counts[statusGroup(item.status)] += 1;
    });
    const max = Math.max(1, ...Object.values(counts));
    document.getElementById("ownerStatusBars").innerHTML = labels
      .map(
        ([key, label, tone]) => `<div class="owner-status-row"><span>${label}</span><div><i class="${tone}" style="width:${Math.max(counts[key] ? 7 : 0, (counts[key] / max) * 100)}%"></i></div><strong>${counts[key]}</strong></div>`,
      )
      .join("");
  }

  function renderTrend(state) {
    const allJobs = [
      ...(state.corridas || []).map((item) => ({ ...item, serviceType: "ride" })),
      ...(state.entregas || []).map((item) => ({ ...item, serviceType: "delivery" })),
    ];
    const days = [];
    for (let offset = 6; offset >= 0; offset -= 1) {
      const date = startOfDay();
      date.setDate(date.getDate() - offset);
      const end = endOfDay(date);
      const jobs = allJobs.filter((item) => {
        const time = jobTimestamp(item);
        return time >= date.getTime() && time <= end.getTime();
      });
      days.push({
        label: new Intl.DateTimeFormat("pt-BR", { weekday: "short" }).format(date).replace(".", ""),
        date: new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit" }).format(date),
        total: jobs.length,
        finished: jobs.filter((item) => item.status === "finalizada").length,
      });
    }
    const max = Math.max(1, ...days.map((day) => day.total));
    document.getElementById("ownerTrend").innerHTML = days
      .map(
        (day) => `<div class="owner-trend-day" title="${day.total} chamados, ${day.finished} finalizados"><div class="owner-trend-bars"><i style="height:${Math.max(day.total ? 8 : 2, (day.total / max) * 100)}%"></i><b style="height:${Math.max(day.finished ? 6 : 2, (day.finished / max) * 100)}%"></b></div><strong>${day.total}</strong><span>${day.label}</span><small>${day.date}</small></div>`,
      )
      .join("");
  }

  function rankRows(entries, emptyText) {
    if (!entries.length) return `<div class="owner-empty">${emptyText}</div>`;
    return entries
      .map(
        (item, index) => `<div class="owner-rank-row"><span>${index + 1}</span><div><strong>${escapeHtml(item.name)}</strong><small>${item.count} serviço${item.count === 1 ? "" : "s"}</small></div><b>${money(item.value)}</b></div>`,
      )
      .join("");
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function renderRankings(summary) {
    const companies = new Map();
    summary.deliveries
      .filter((item) => item.status === "finalizada")
      .forEach((item) => {
        const name = item.empresa || "Empresa não informada";
        const row = companies.get(name) || { name, count: 0, value: 0 };
        row.count += 1;
        row.value += Number(item.valor || 0);
        companies.set(name, row);
      });
    const drivers = new Map();
    summary.finished.forEach((item) => {
      const name = item.motoboy || "Sem motoboy";
      const row = drivers.get(name) || { name, count: 0, value: 0 };
      row.count += 1;
      row.value += Number(item.valor || 0) - appValue(item, item.serviceType);
      drivers.set(name, row);
    });
    document.getElementById("ownerCompanyRanking").innerHTML = rankRows(
      [...companies.values()].sort((a, b) => b.count - a.count || b.value - a.value).slice(0, 5),
      "Nenhuma entrega finalizada neste período.",
    );
    document.getElementById("ownerDriverRanking").innerHTML = rankRows(
      [...drivers.values()].sort((a, b) => b.count - a.count || b.value - a.value).slice(0, 5),
      "Nenhum serviço finalizado neste período.",
    );
  }

  function renderFinance(state, summary) {
    const deposits = (state.depositos || []).filter(inSelectedPeriod);
    const approved = deposits.filter((item) => item.status === "aprovado").reduce((sum, item) => sum + Number(item.valor || 0), 0);
    const pending = deposits.filter((item) => item.status === "pendente").reduce((sum, item) => sum + Number(item.valor || 0), 0);
    document.getElementById("ownerFinance").innerHTML = [
      ["Faturamento finalizado", money(summary.gross)],
      ["Repasse dos motoboys", money(summary.driver)],
      ["Receita da MotoJÁ", money(summary.app)],
      ["Depósitos aprovados", money(approved)],
      ["Depósitos aguardando", money(pending)],
      ["Ticket médio", money(summary.average)],
    ]
      .map(([label, value]) => `<div><span>${label}</span><strong>${value}</strong></div>`)
      .join("");
  }

  function renderDashboard() {
    if (!dashboardReady || !adminState) return;
    const summary = calculateSummary(adminState);
    document.getElementById("ownerPeriodLabel").textContent = periodLabel();
    document.getElementById("ownerUpdatedAt").textContent = `Atualizado às ${new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" }).format(new Date())}`;
    document.getElementById("ownerMetrics").innerHTML = [
      metric("Solicitações", summary.jobs.length, `${summary.rides.length} corridas e ${summary.deliveries.length} entregas`),
      metric("Finalizadas", summary.finished.length, `${number(summary.completionRate)}% de conclusão`, "good"),
      metric("Em operação", summary.jobs.filter((item) => ["aceita", "retirada"].includes(item.status)).length, "Aceitas ou retiradas", "info"),
      metric("Pendentes", summary.jobs.filter((item) => item.status === "pendente").length, "Aguardando motoboy", "attention"),
      metric("Receita MotoJÁ", money(summary.app), `Bruto finalizado: ${money(summary.gross)}`, "money"),
      metric("Cancelamentos", `${number(summary.cancellationRate)}%`, `${summary.jobs.filter((item) => item.status === "cancelada").length} cancelados`, "danger"),
    ].join("");
    renderAlerts(adminState, summary);
    renderStatusBars(summary);
    renderTrend(adminState);
    renderRankings(summary);
    renderFinance(adminState, summary);
  }

  function csvCell(value) {
    let text = String(value ?? "").replace(/\r?\n/g, " ");
    if (/^[=+\-@]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  }

  function exportCsv(type) {
    if (!adminState) return;
    const isDelivery = type === "deliveries";
    const source = (isDelivery ? adminState.entregas : adminState.corridas) || [];
    const rows = source.filter(inSelectedPeriod);
    const headers = isDelivery
      ? ["Data", "Status", "Empresa", "Motoboy", "Tipo", "Retirada", "Entrega", "Paradas", "Km", "Valor"]
      : ["Data", "Status", "Cliente", "Motoboy", "Origem", "Destino", "Km", "Valor", "Pagamento"];
    const dataRows = rows.map((item) =>
      isDelivery
        ? [new Date(jobTimestamp(item)).toLocaleString("pt-BR"), item.status, item.empresa, item.motoboy, item.tipoEntrega, item.retirada, item.entrega, item.paradas, item.km, item.valor]
        : [new Date(jobTimestamp(item)).toLocaleString("pt-BR"), item.status, item.nome, item.motoboy, item.origem, item.destino, item.km, item.valor, item.pagamento?.status || ""],
    );
    const csv = `\uFEFF${[headers, ...dataRows].map((row) => row.map(csvCell).join(";")).join("\r\n")}`;
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `motoja-${isDelivery ? "entregas" : "corridas"}-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function createDashboard() {
    const panel = document.getElementById("painel");
    const oldCards = panel?.querySelector(":scope > .cards");
    if (!panel || !oldCards || document.getElementById("visao-section")) return;

    const dashboard = document.createElement("section");
    dashboard.id = "visao-section";
    dashboard.className = "owner-command";
    dashboard.innerHTML = `
      <header class="owner-command-head">
        <div><span class="owner-eyebrow">CENTRAL DE OPERAÇÃO</span><h2>Visão geral da MotoJÁ</h2><p>Decisões rápidas usando os mesmos dados já carregados pelo painel.</p></div>
        <div class="owner-command-meta"><strong id="ownerPeriodLabel">Hoje</strong><span id="ownerUpdatedAt">Carregando...</span></div>
      </header>
      <div id="ownerMetrics" class="owner-metrics"></div>
      <div class="owner-command-grid">
        <section class="owner-panel owner-alert-panel"><header><div><span>OPERAÇÃO</span><h3>Precisa de atenção</h3></div><b id="ownerAlertBadge">0 alertas</b></header><div id="ownerAlerts" class="owner-alerts"><div class="owner-empty">Carregando alertas...</div></div></section>
        <section class="owner-panel"><header><div><span>STATUS</span><h3>Saúde da operação</h3></div></header><div id="ownerStatusBars" class="owner-status-bars"></div></section>
      </div>
      <div class="owner-command-grid">
        <section class="owner-panel owner-trend-panel"><header><div><span>VOLUME</span><h3>Movimento nos últimos 7 dias</h3></div><div class="owner-legend"><i></i> Chamados <b></b> Finalizados</div></header><div id="ownerTrend" class="owner-trend"></div></section>
        <section class="owner-panel"><header><div><span>FINANCEIRO</span><h3>Fechamento do período</h3></div></header><div id="ownerFinance" class="owner-finance"></div></section>
      </div>
      <div class="owner-command-grid owner-rank-grid">
        <section class="owner-panel"><header><div><span>EMPRESAS</span><h3>Mais entregas no período</h3></div></header><div id="ownerCompanyRanking" class="owner-ranking"></div></section>
        <section class="owner-panel"><header><div><span>MOTOBOYS</span><h3>Mais serviços no período</h3></div></header><div id="ownerDriverRanking" class="owner-ranking"></div></section>
      </div>
      <section class="owner-export-band"><div><strong>Relatórios para conferência</strong><span>Os arquivos respeitam o período selecionado acima e não fazem nova consulta ao Firebase.</span></div><div><button id="ownerExportRides" type="button">Exportar corridas CSV</button><button id="ownerExportDeliveries" type="button">Exportar entregas CSV</button></div></section>`;
    panel.insertBefore(dashboard, oldCards);

    const nav = panel.querySelector(".dash-nav");
    if (nav) {
      const overviewLink = document.createElement("a");
      overviewLink.href = "#visao-section";
      overviewLink.textContent = "Visão";
      nav.prepend(overviewLink);
    }

    document.getElementById("ownerExportRides").addEventListener("click", () => exportCsv("rides"));
    document.getElementById("ownerExportDeliveries").addEventListener("click", () => exportCsv("deliveries"));
    ["periodo", "dataInicio", "dataFim"].forEach((id) => {
      document.getElementById(id)?.addEventListener("change", () => queueMicrotask(renderDashboard));
    });
    dashboardReady = true;
    renderDashboard();
  }

  window.addEventListener("motoja:admin-state", (event) => {
    adminState = event.detail;
    renderDashboard();
  });
  document.addEventListener("DOMContentLoaded", createDashboard);
})();
