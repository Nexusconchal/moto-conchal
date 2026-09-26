(() => {
  "use strict";

  const API = "https://motoboy-conchal.onrender.com";
  const TOKEN_KEY = "motoja_support_session_v1";
  const $ = (id) => document.getElementById(id);
  let token = localStorage.getItem(TOKEN_KEY) || "";
  let account = null;
  let operations = [];
  let photoData = "";
  let pollTimer = null;
  let alarmTimer = null;
  let socket = null;
  let realtimeRefreshTimer = null;
  let operationsLoading = false;
  let audioContext = null;
  let audioEnabled = false;
  let toastTimer = null;

  let currentFilter = "all";

  function moeda(val) {
    return Number(val || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  }

  function timeAgoText(ms) {
    if (!ms) return "";
    const elapsedMin = Math.floor((Date.now() - ms) / 60000);
    if (elapsedMin < 1) return "Agora";
    if (elapsedMin < 60) return `Há ${elapsedMin} min`;
    const elapsedHours = Math.floor(elapsedMin / 60);
    if (elapsedHours < 24) return `Há ${elapsedHours}h`;
    const elapsedDays = Math.floor(elapsedHours / 24);
    return `Há ${elapsedDays} dia${elapsedDays > 1 ? "s" : ""}`;
  }

  function isItemAlerting(item) {
    if (item.alertaAssumido) return false;
    if (item.status === "pendente") return true;
    const ageMs = Date.now() - (item.criadaEmMs || 0);
    return ageMs <= 2 * 60 * 60 * 1000;
  }

  function escapeHtml(value) {
    return String(value || "").replace(/[&<>'"]/g, (character) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
    })[character]);
  }

  function digits(value) { return String(value || "").replace(/\D/g, ""); }

  function toast(message, error = false) {
    const element = $("toast");
    element.textContent = message;
    element.className = `toast show${error ? " error" : ""}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { element.className = "toast"; }, 3500);
  }

  function setFeedback(id, message, success = false) {
    const element = $(id);
    element.textContent = message || "";
    element.classList.toggle("success", success);
  }

  function maskCpf(input) {
    const value = digits(input.value).slice(0, 11);
    input.value = value.replace(/(\d{3})(\d)/, "$1.$2").replace(/(\d{3})(\d)/, "$1.$2").replace(/(\d{3})(\d{1,2})$/, "$1-$2");
  }

  function maskPhone(input) {
    const value = digits(input.value).slice(0, 11);
    input.value = value.replace(/^(\d{2})(\d)/, "($1) $2").replace(/(\d{5})(\d{4})$/, "$1-$2");
  }

  async function api(path, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (options.body && !headers["content-type"]) headers["content-type"] = "application/json";
    if (token) headers.authorization = `Bearer ${token}`;
    const response = await fetch(`${API}${path}`, { ...options, headers, cache: "no-store" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.message || data.error || "Não foi possível concluir.");
      error.status = response.status;
      error.code = data.error;
      throw error;
    }
    return data;
  }

  function showAuth(view = "login") {
    clearInterval(pollTimer);
    stopAlarm();
    if (socket) socket.disconnect();
    socket = null;
    $("supportApp").classList.add("hidden");
    $("authShell").classList.remove("hidden");
    const login = view === "login";
    $("loginForm").classList.toggle("hidden", !login);
    $("registerForm").classList.toggle("hidden", login);
    $("showLogin").classList.toggle("active", login);
    $("showRegister").classList.toggle("active", !login);
  }

  function showApp() {
    $("authShell").classList.add("hidden");
    $("supportApp").classList.remove("hidden");
    $("operatorName").textContent = account?.nome || "Suporte";
    $("operatorPhoto").src = account?.foto || "../nexus-motoja-icon-192.png";
    refreshOperations();
    connectRealtime();
    clearInterval(pollTimer);
    pollTimer = setInterval(refreshOperations, 90000);
  }

  function connectRealtime() {
    if (!window.io || !token) return;
    if (socket) socket.disconnect();
    socket = window.io(API, { auth: { token }, transports: ["websocket", "polling"] });
    socket.on("support:refresh", () => {
      clearTimeout(realtimeRefreshTimer);
      realtimeRefreshTimer = setTimeout(refreshOperations, 700);
    });
  }

  async function compressPhoto(file) {
    if (!file || !file.type.startsWith("image/")) throw new Error("Escolha uma imagem válida.");
    const source = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error("Não foi possível ler a foto."));
      reader.readAsDataURL(file);
    });
    const image = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("Foto inválida."));
      img.src = source;
    });
    const size = 520;
    const scale = Math.min(1, size / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    canvas.getContext("2d", { alpha: false }).drawImage(image, 0, 0, canvas.width, canvas.height);
    let quality = 0.82;
    let result = canvas.toDataURL("image/jpeg", quality);
    while (result.length > 210000 && quality > 0.42) {
      quality -= 0.08;
      result = canvas.toDataURL("image/jpeg", quality);
    }
    if (result.length > 220000) throw new Error("A foto ficou muito grande. Escolha outra imagem.");
    return result;
  }

  async function enableAudio() {
    try {
      audioContext ||= new (window.AudioContext || window.webkitAudioContext)();
      await audioContext.resume();
      audioEnabled = audioContext.state === "running";
      if (audioEnabled) {
        toast("Alarme sonoro ativado.");
        updateAlarm();
      }
    } catch {
      toast("O navegador não liberou o som. Toque novamente em Ativar som.", true);
    }
  }

  function beep() {
    if (!audioEnabled || !audioContext || audioContext.state !== "running") return;
    const now = audioContext.currentTime;
    [0, 0.24, 0.48].forEach((delay, index) => {
      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();
      oscillator.type = index === 1 ? "square" : "sine";
      oscillator.frequency.setValueAtTime(index === 1 ? 880 : 740, now + delay);
      gain.gain.setValueAtTime(0.0001, now + delay);
      gain.gain.exponentialRampToValueAtTime(0.2, now + delay + 0.025);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + delay + 0.18);
      oscillator.connect(gain).connect(audioContext.destination);
      oscillator.start(now + delay);
      oscillator.stop(now + delay + 0.2);
    });
  }

  function stopAlarm() {
    clearInterval(alarmTimer);
    alarmTimer = null;
  }

  function updateAlarm() {
    const alertingItems = operations.filter(isItemAlerting);
    const staleItems = operations.filter((item) => item.isStale || (Date.now() - (item.criadaEmMs || 0)) > 2 * 60 * 60 * 1000);
    const banner = $("alarmBanner");
    const countAlerts = $("metricAlerts");
    const countStale = $("metricStale");
    const countTotal = $("metricTotal");
    if (countAlerts) countAlerts.textContent = alertingItems.length;
    if (countStale) countStale.textContent = staleItems.length;
    if (countTotal) countTotal.textContent = operations.length;

    if (!alertingItems.length) {
      banner.className = "alarm-banner quiet";
      if (staleItems.length) {
        $("alarmTitle").textContent = `${staleItems.length} chamado${staleItems.length > 1 ? "s antigos" : " antigo"} com finalização pendente`;
        $("alarmText").textContent = "Alarme sonoro desligado para chamados antigos (> 2h). Use a aba '⚠️ Antigos' para dar baixa.";
      } else {
        $("alarmTitle").textContent = "Nenhum alerta recente aguardando";
        $("alarmText").textContent = "A central está acompanhando os chamados ativos em tempo real.";
      }
      stopAlarm();
      return;
    }

    banner.className = "alarm-banner alerting";
    $("alarmTitle").textContent = `${alertingItems.length} alerta${alertingItems.length === 1 ? " recente precisa" : "s recentes precisam"} de atendimento`;
    $("alarmText").textContent = audioEnabled ? "O alarme sonoro para quando forem assumidos." : "Ative o som para receber o aviso contínuo.";
    $("enableSound").textContent = audioEnabled ? "Som ativo" : "Ativar som";
    if (!alarmTimer && audioEnabled) {
      beep();
      alarmTimer = setInterval(beep, 4200);
    }
    if (document.hidden === false && "Notification" in window && Notification.permission === "granted") {
      const newest = alertingItems[0];
      const notificationKey = `${newest.tipo}:${newest.id}:${newest.alertVersion}`;
      if (sessionStorage.getItem("lastSupportNotification") !== notificationKey) {
        sessionStorage.setItem("lastSupportNotification", notificationKey);
        new Notification("Novo chamado MotoJÁ", { body: `${newest.titulo}: ${newest.origem} → ${newest.destino}`, icon: "../nexus-motoja-icon-192.png" });
      }
    }
  }

  function dateText(value) {
    const seconds = Number(value?.seconds || 0);
    return seconds ? new Date(seconds * 1000).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }) : "Agora";
  }

  function whatsapp(phone, label, text = "") {
    const number = digits(phone);
    if (number.length < 10) return "";
    const query = text ? `?text=${encodeURIComponent(text)}` : "";
    return `<a href="https://wa.me/55${number}${query}" target="_blank" rel="noopener">WhatsApp ${escapeHtml(label)}</a>`;
  }

  function renderOperations() {
    const query = $("searchInput").value.trim().toLocaleLowerCase("pt-BR");
    const pendingCount = operations.filter((item) => item.status === "pendente").length;
    const activeCount = operations.filter((item) => item.status !== "pendente" && !item.isStale && (Date.now() - (item.criadaEmMs || 0)) <= 2 * 60 * 60 * 1000).length;
    const staleCount = operations.filter((item) => item.isStale || (Date.now() - (item.criadaEmMs || 0)) > 2 * 60 * 60 * 1000).length;
    const alertCount = operations.filter(isItemAlerting).length;

    if ($("metricPending")) $("metricPending").textContent = pendingCount;
    if ($("metricActive")) $("metricActive").textContent = activeCount;
    if ($("metricStale")) $("metricStale").textContent = staleCount;
    if ($("metricAlerts")) $("metricAlerts").textContent = alertCount;
    if ($("metricTotal")) $("metricTotal").textContent = operations.length;

    let itemsToFilter = operations;
    if (currentFilter === "alerts") {
      itemsToFilter = operations.filter(isItemAlerting);
    } else if (currentFilter === "pending") {
      itemsToFilter = operations.filter((item) => item.status === "pendente");
    } else if (currentFilter === "active") {
      itemsToFilter = operations.filter((item) => item.status !== "pendente" && !item.isStale && (Date.now() - (item.criadaEmMs || 0)) <= 2 * 60 * 60 * 1000);
    } else if (currentFilter === "stale") {
      itemsToFilter = operations.filter((item) => item.isStale || (Date.now() - (item.criadaEmMs || 0)) > 2 * 60 * 60 * 1000);
    }

    const filtered = itemsToFilter.filter((item) => !query || [item.titulo, item.responsavel, item.origem, item.destino, item.motoboy, item.tipoEntrega].join(" ").toLocaleLowerCase("pt-BR").includes(query));
    const root = $("operationsList");
    if (!filtered.length) {
      root.innerHTML = `<div class="empty-state">${query ? "Nenhum chamado corresponde à busca." : "Nenhum chamado nesta categoria no momento."}</div>`;
      updateAlarm();
      return;
    }

    root.innerHTML = filtered.map((item) => {
      const msgPassenger = `Olá ${item.responsavel || item.titulo}, aqui é da Central Nexus MotoJá! Vi que seu chamado de ${item.tipo === "carro" ? "carro" : "mototáxi"} com ${item.motoboy || "nosso motorista"} está em andamento. Está tudo certo com a sua viagem?`;
      const msgDriver = `Olá ${item.motoboy || "motorista"}, aqui é da Central Nexus MotoJá! Notamos que o chamado de ${item.responsavel || item.titulo} está em andamento. Você já concluiu a viagem ou precisa de algum suporte?`;
      const msgReceiver = `Olá ${item.recebedor || "cliente"}, aqui é da Central Nexus MotoJá! O entregador está com seu pedido de ${item.titulo} a caminho para: ${item.destino}.`;

      const contacts = [
        whatsapp(item.telefonePrincipal, item.tipo === "entrega" ? "empresa" : "passageiro", msgPassenger),
        whatsapp(item.telefoneRecebedor, "recebedor", msgReceiver),
        whatsapp(item.telefoneMotoboy, item.tipo === "carro" ? "motorista" : "motoboy", msgDriver),
      ].filter(Boolean).join("");

      const extras = item.pontosExtras?.length
        ? `<div class="extra-stops">${item.pontosExtras.map((point) => `<span>Ponto ${Number(point.ordem || 0)}: ${escapeHtml(point.endereco)}${point.recebedor ? ` · ${escapeHtml(point.recebedor)}` : ""}</span>`).join("")}</div>`
        : "";

      const isStale = item.isStale || (Date.now() - (item.criadaEmMs || 0)) > 2 * 60 * 60 * 1000;
      const staleBadge = isStale ? `<span class="badge-stale">⚠️ Aberto ${timeAgoText(item.criadaEmMs)}</span>` : "";
      const timeBadge = `<span class="time-ago">🕒 ${timeAgoText(item.criadaEmMs)}</span>`;
      const valBadge = item.valor > 0 ? `<span>${moeda(item.valor)}</span>` : "";

      let gpsBadge = "";
      if (item.latitude && item.longitude) {
        if (item.localizacaoAtualizadaEmMs) {
          const gpsAgeMin = Math.floor((Date.now() - item.localizacaoAtualizadaEmMs) / 60000);
          if (gpsAgeMin < 8) {
            gpsBadge = `<span class="badge-gps-live">🟢 GPS ativo (${timeAgoText(item.localizacaoAtualizadaEmMs)})</span>`;
          } else {
            gpsBadge = `<span class="badge-gps-stale">🔴 GPS sem sinal há ${timeAgoText(item.localizacaoAtualizadaEmMs)}</span>`;
          }
        } else {
          gpsBadge = `<span class="badge-gps-live">🟢 GPS registrado</span>`;
        }
      } else if (item.status === "aceita" || item.status === "retirada" || item.status === "em_andamento") {
        gpsBadge = `<span class="badge-gps-none">⚪ Sem sinal GPS</span>`;
      }

      const mapLink = (item.latitude && item.longitude && item.mapsUrl)
        ? `<a href="${escapeHtml(item.mapsUrl)}" target="_blank" rel="noopener" class="btn-map-link">🗺️ Ver no Maps</a>`
        : "";

      const acknowledgedText = item.alertaAssumido
        ? `Assumido por ${escapeHtml(item.alertaAssumidoPor || "suporte")}`
        : "Assumir alerta";
      const kindLabel = item.tipo === "entrega" ? "Entrega de empresa" : item.tipo === "carro" ? "Corrida de carro" : "Corrida de mototáxi";
      const kindBadge = item.tipo === "entrega" ? "ENT" : item.tipo === "carro" ? "CAR" : "COR";
      const isAlerting = isItemAlerting(item);

      return `<article class="operation${isAlerting ? " unacknowledged" : ""}${isStale ? " stale-job" : ""}">
        <div class="operation-top">
          <div class="operation-kind">
            <span>${kindBadge}</span>
            <div>
              <strong>${escapeHtml(item.titulo)}</strong>
              <small>${dateText(item.criadaEm)} · ${kindLabel}</small>
            </div>
          </div>
          <span class="status ${escapeHtml(item.status)}">${escapeHtml(item.status)}</span>
        </div>
        <div class="route">
          <i></i><div><strong>${item.tipo === "entrega" ? "Retirada" : "Origem"}</strong><span>${escapeHtml(item.origem || "Não informada")}</span></div>
          <i></i><div><strong>Destino</strong><span>${escapeHtml(item.destino || "Não informado")}</span></div>
        </div>
        ${extras}
        <div class="operation-meta">
          ${staleBadge}
          ${timeBadge}
          ${valBadge}
          ${gpsBadge}
          <span>${escapeHtml(item.responsavel || item.titulo)}</span>
          ${item.tipoEntrega ? `<span>${escapeHtml(item.tipoEntrega)}</span>` : ""}
          ${item.motoboy ? `<span>${item.tipo === "carro" ? "Motorista" : "Motoboy"}: ${escapeHtml(item.motoboy)}</span>` : ""}
          ${item.paradas > 1 ? `<span>${item.paradas} pontos</span>` : ""}
        </div>
        ${(contacts || mapLink) ? `<div class="contacts">${contacts}${mapLink}</div>` : ""}
        <div class="operation-actions">
          <button class="acknowledge" data-ack-kind="${item.tipo}" data-ack-id="${item.id}" ${item.alertaAssumido ? "disabled" : ""}>${acknowledgedText}</button>
          <button class="btn-op-action btn-op-finish" data-op-finish-kind="${item.tipo}" data-op-finish-id="${item.id}" data-op-finish-driver="${item.motoboyCpf || ""}" data-op-finish-val="${item.valor || 0}">Finalizar</button>
          ${item.status !== "pendente" ? `<button class="btn-op-action btn-op-reassign" data-op-reassign-kind="${item.tipo}" data-op-reassign-id="${item.id}">Trocar Motoboy</button>` : ""}
          <button class="btn-op-action btn-op-cancel" data-op-cancel-kind="${item.tipo}" data-op-cancel-id="${item.id}">Cancelar</button>
        </div>
      </article>`;
    }).join("");
    updateAlarm();
  }

  async function refreshOperations() {
    if (!token || operationsLoading) return;
    operationsLoading = true;
    try {
      const data = await api("/api/support/operations");
      operations = Array.isArray(data.operations) ? data.operations : [];
      $("lastUpdated").textContent = `Atualizado às ${new Date(data.updatedAtMs || Date.now()).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`;
      renderOperations();
    } catch (error) {
      if (error.status === 401 || error.status === 403) {
        localStorage.removeItem(TOKEN_KEY);
        token = "";
        showAuth("login");
        toast(error.message, true);
      } else {
        $("lastUpdated").textContent = "Falha ao sincronizar";
      }
    } finally {
      operationsLoading = false;
    }
  }

  $("showLogin").addEventListener("click", () => showAuth("login"));
  $("showRegister").addEventListener("click", () => showAuth("register"));
  $("loginCpf").addEventListener("input", (event) => maskCpf(event.target));
  $("registerCpf").addEventListener("input", (event) => maskCpf(event.target));
  $("registerPhone").addEventListener("input", (event) => maskPhone(event.target));
  $("searchInput").addEventListener("input", renderOperations);
  $("refreshButton").addEventListener("click", refreshOperations);
  $("enableSound").addEventListener("click", enableAudio);

  $("registerPhoto").addEventListener("change", async (event) => {
    try {
      photoData = await compressPhoto(event.target.files?.[0]);
      $("photoPreview").src = photoData;
      $("photoPreview").style.display = "block";
      $("photoPlaceholder").style.display = "none";
    } catch (error) {
      photoData = "";
      event.target.value = "";
      toast(error.message, true);
    }
  });

  $("loginForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    enableAudio().catch(() => {});
    const button = event.submitter;
    button.disabled = true;
    setFeedback("loginFeedback", "");
    try {
      const data = await api("/api/support/login", {
        method: "POST",
        body: JSON.stringify({ cpf: digits($("loginCpf").value), password: $("loginPassword").value }),
      });
      token = data.token;
      account = data.account;
      localStorage.setItem(TOKEN_KEY, token);
      showApp();
    } catch (error) {
      setFeedback("loginFeedback", error.message);
    } finally {
      button.disabled = false;
    }
  });

  $("registerForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = event.submitter;
    const password = $("registerPassword").value;
    if (password !== $("registerPasswordConfirm").value) return setFeedback("registerFeedback", "As senhas não conferem.");
    if (!photoData) return setFeedback("registerFeedback", "Adicione sua foto de identificação.");
    button.disabled = true;
    setFeedback("registerFeedback", "Enviando cadastro protegido...");
    try {
      const data = await api("/api/support/register", {
        method: "POST",
        body: JSON.stringify({
          nome: $("registerName").value,
          cpf: digits($("registerCpf").value),
          dataNascimento: $("registerBirth").value,
          telefone: digits($("registerPhone").value),
          foto: photoData,
          password,
          consentAccepted: $("registerConsent").checked,
        }),
      });
      setFeedback("registerFeedback", data.message, true);
      $("registerForm").reset();
      photoData = "";
      $("photoPreview").style.display = "none";
      $("photoPlaceholder").style.display = "block";
      setTimeout(() => showAuth("login"), 2800);
    } catch (error) {
      setFeedback("registerFeedback", error.message);
    } finally {
      button.disabled = false;
    }
  });

  $("operationsList").addEventListener("click", async (event) => {
    const ackBtn = event.target.closest("[data-ack-id]");
    if (ackBtn) {
      ackBtn.disabled = true;
      ackBtn.textContent = "Registrando...";
      try {
        await api(`/api/support/alerts/${ackBtn.dataset.ackKind}/${ackBtn.dataset.ackId}/acknowledge`, { method: "POST", body: "{}" });
        await refreshOperations();
      } catch (error) {
        toast(error.message, true);
        ackBtn.disabled = false;
        ackBtn.textContent = "Assumir alerta";
      }
      return;
    }

    const finishBtn = event.target.closest("[data-op-finish-id]");
    if (finishBtn) {
      const kind = finishBtn.dataset.opFinishKind;
      const id = finishBtn.dataset.opFinishId;
      const driverCpf = finishBtn.dataset.opFinishDriver || "";
      const currentVal = Number(finishBtn.dataset.opFinishVal || 0);
      const motivo = prompt("Motivo para finalizar pelo suporte (ex: pago em dinheiro/Pix direto ao motoboy):", "Pago por fora / corrida concluída");
      if (!motivo || !motivo.trim()) return;
      const valorStr = prompt("Valor da corrida para repasse ao motoboy (R$):", String(currentVal || "6.50").replace(".", ","));
      const valor = Number(String(valorStr || "").replace(/[^0-9,.]/g, "").replace(",", "."));
      if (isNaN(valor) || valor <= 0) {
        toast("Valor inválido.", true);
        return;
      }
      if (!confirm(`Finalizar este chamado no valor de ${moeda(valor)} e registrar repasse?`)) return;
      finishBtn.disabled = true;
      finishBtn.textContent = "Finalizando...";
      try {
        await api(`/api/support/operations/${kind}/${id}/finish`, {
          method: "POST",
          body: JSON.stringify({ reason: motivo.trim(), driverCpf, valor }),
        });
        toast("Chamado finalizado com sucesso!");
        await refreshOperations();
      } catch (error) {
        toast(error.message, true);
        finishBtn.disabled = false;
        finishBtn.textContent = "Finalizar";
      }
      return;
    }

    const reassignBtn = event.target.closest("[data-op-reassign-id]");
    if (reassignBtn) {
      const kind = reassignBtn.dataset.opReassignKind;
      const id = reassignBtn.dataset.opReassignId;
      const motivo = prompt("Motivo para devolver este chamado para a fila (ex: motoboy furou pneu / demorou):", "Troca de motoboy solicitada pelo suporte");
      if (!motivo || !motivo.trim()) return;
      if (!confirm("Isso vai desvincular o motoboy atual e devolver a corrida para outros motoboys aceitarem no app. Confirma?")) return;
      reassignBtn.disabled = true;
      reassignBtn.textContent = "Devolvendo...";
      try {
        await api(`/api/support/operations/${kind}/${id}/reassign-to-queue`, {
          method: "POST",
          body: JSON.stringify({ reason: motivo.trim() }),
        });
        toast("Chamado devolvido para a fila de motoboys com sucesso!");
        await refreshOperations();
      } catch (error) {
        toast(error.message, true);
        reassignBtn.disabled = false;
        reassignBtn.textContent = "Trocar Motoboy";
      }
      return;
    }

    const cancelBtn = event.target.closest("[data-op-cancel-id]");
    if (cancelBtn) {
      const kind = cancelBtn.dataset.opCancelKind;
      const id = cancelBtn.dataset.opCancelId;
      const motivo = prompt("Motivo do cancelamento pelo suporte:");
      if (!motivo || !motivo.trim()) return;
      if (!confirm("Tem certeza que deseja cancelar este chamado?")) return;
      cancelBtn.disabled = true;
      cancelBtn.textContent = "Cancelando...";
      try {
        await api(`/api/support/operations/${kind}/${id}/cancel`, {
          method: "POST",
          body: JSON.stringify({ reason: motivo.trim() }),
        });
        toast("Chamado cancelado com sucesso!");
        await refreshOperations();
      } catch (error) {
        toast(error.message, true);
        cancelBtn.disabled = false;
        cancelBtn.textContent = "Cancelar";
      }
      return;
    }
  });

  $("ackAllButton")?.addEventListener("click", async () => {
    const btn = $("ackAllButton");
    btn.disabled = true;
    btn.textContent = "Assumindo...";
    try {
      const data = await api("/api/support/alerts/acknowledge-all", { method: "POST", body: "{}" });
      toast(`${data.count || 0} alerta(s) assumido(s) com sucesso!`);
      await refreshOperations();
    } catch (error) {
      toast(error.message, true);
    } finally {
      btn.disabled = false;
      btn.textContent = "Assumir todos";
    }
  });

  document.querySelectorAll(".metric-card").forEach((card) => {
    card.addEventListener("click", () => {
      document.querySelectorAll(".metric-card").forEach((c) => c.classList.remove("active"));
      card.classList.add("active");
      currentFilter = card.dataset.filter || "all";
      const titles = {
        all: "Chamados ativos",
        alerts: "🚨 Novos alertas prioritários",
        pending: "Aguardando motoboy aceitar",
        active: "Chamados em andamento",
        stale: "⚠️ Chamados antigos (> 2h)",
      };
      const titleEl = $("operationsTitle");
      if (titleEl) titleEl.textContent = titles[currentFilter] || "Chamados ativos";
      renderOperations();
    });
  });

  $("logoutButton").addEventListener("click", async () => {
    try { await api("/api/support/logout", { method: "POST", body: "{}" }); } catch {}
    token = "";
    account = null;
    localStorage.removeItem(TOKEN_KEY);
    showAuth("login");
  });

  document.addEventListener("visibilitychange", () => { if (!document.hidden && token) refreshOperations(); });

  async function initialize() {
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js?v=181", { scope: "./", updateViaCache: "none" }).then((registration) => registration.update()).catch(() => {});
    if (!token) return showAuth("login");
    try {
      const data = await api("/api/support/me");
      account = data.account;
      showApp();
    } catch {
      token = "";
      localStorage.removeItem(TOKEN_KEY);
      showAuth("login");
    }
  }

  initialize();
})();
