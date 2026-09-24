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
    const pending = operations.filter((item) => !item.alertaAssumido);
    const banner = $("alarmBanner");
    $("metricAlerts").textContent = pending.length;
    if (!pending.length) {
      banner.className = "alarm-banner quiet";
      $("alarmTitle").textContent = "Nenhum alerta aguardando";
      $("alarmText").textContent = "A central está acompanhando os chamados ativos.";
      stopAlarm();
      return;
    }
    banner.className = "alarm-banner alerting";
    $("alarmTitle").textContent = `${pending.length} alerta${pending.length === 1 ? " precisa" : "s precisam"} de atendimento`;
    $("alarmText").textContent = audioEnabled ? "O alarme para quando todos forem assumidos." : "Ative o som para receber o aviso contínuo.";
    $("enableSound").textContent = audioEnabled ? "Som ativo" : "Ativar som";
    if (!alarmTimer) {
      beep();
      alarmTimer = setInterval(beep, 4200);
    }
    if (document.hidden === false && "Notification" in window && Notification.permission === "granted") {
      const newest = pending[0];
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

  function whatsapp(phone, label) {
    const number = digits(phone);
    if (number.length < 10) return "";
    return `<a href="https://wa.me/55${number}" target="_blank" rel="noopener">WhatsApp ${escapeHtml(label)}</a>`;
  }

  function renderOperations() {
    const query = $("searchInput").value.trim().toLocaleLowerCase("pt-BR");
    const filtered = operations.filter((item) => !query || [item.titulo, item.responsavel, item.origem, item.destino, item.motoboy, item.tipoEntrega].join(" ").toLocaleLowerCase("pt-BR").includes(query));
    $("metricPending").textContent = operations.filter((item) => item.status === "pendente").length;
    $("metricActive").textContent = operations.filter((item) => item.status !== "pendente").length;
    const root = $("operationsList");
    if (!filtered.length) {
      root.innerHTML = `<div class="empty-state">${query ? "Nenhum chamado corresponde à busca." : "Nenhuma corrida ou entrega ativa agora."}</div>`;
      updateAlarm();
      return;
    }
    root.innerHTML = filtered.map((item) => {
      const contacts = [
        whatsapp(item.telefonePrincipal, item.tipo === "entrega" ? "empresa" : "passageiro"),
        whatsapp(item.telefoneRecebedor, "recebedor"),
        whatsapp(item.telefoneMotoboy, "motoboy"),
      ].filter(Boolean).join("");
      const extras = item.pontosExtras?.length
        ? `<div class="extra-stops">${item.pontosExtras.map((point) => `<span>Ponto ${Number(point.ordem || 0)}: ${escapeHtml(point.endereco)}${point.recebedor ? ` · ${escapeHtml(point.recebedor)}` : ""}</span>`).join("")}</div>`
        : "";
      const acknowledgedText = item.alertaAssumido
        ? `Assumido por ${escapeHtml(item.alertaAssumidoPor || "suporte")}`
        : "Assumir alerta e parar alarme";
      const kindLabel = item.tipo === "entrega" ? "Entrega de empresa" : item.tipo === "carro" ? "Corrida de carro" : "Corrida de mototáxi";
      const kindBadge = item.tipo === "entrega" ? "ENT" : item.tipo === "carro" ? "CAR" : "COR";
      return `<article class="operation${item.alertaAssumido ? "" : " unacknowledged"}">
        <div class="operation-top"><div class="operation-kind"><span>${kindBadge}</span><div><strong>${escapeHtml(item.titulo)}</strong><small>${dateText(item.criadaEm)} · ${kindLabel}</small></div></div><span class="status ${escapeHtml(item.status)}">${escapeHtml(item.status)}</span></div>
        <div class="route"><i></i><div><strong>${item.tipo === "entrega" ? "Retirada" : "Origem"}</strong><span>${escapeHtml(item.origem || "Não informada")}</span></div><i></i><div><strong>Destino</strong><span>${escapeHtml(item.destino || "Não informado")}</span></div></div>
        ${extras}
        <div class="operation-meta"><span>${escapeHtml(item.responsavel || item.titulo)}</span>${item.tipoEntrega ? `<span>${escapeHtml(item.tipoEntrega)}</span>` : ""}${item.motoboy ? `<span>${item.tipo === "carro" ? "Motorista" : "Motoboy"}: ${escapeHtml(item.motoboy)}</span>` : ""}${item.paradas > 1 ? `<span>${item.paradas} pontos</span>` : ""}</div>
        ${contacts ? `<div class="contacts">${contacts}</div>` : ""}
        <button class="acknowledge" data-ack-kind="${item.tipo}" data-ack-id="${item.id}" ${item.alertaAssumido ? "disabled" : ""}>${acknowledgedText}</button>
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
    const button = event.target.closest("[data-ack-id]");
    if (!button) return;
    button.disabled = true;
    button.textContent = "Registrando atendimento...";
    try {
      await api(`/api/support/alerts/${button.dataset.ackKind}/${button.dataset.ackId}/acknowledge`, { method: "POST", body: "{}" });
      await refreshOperations();
    } catch (error) {
      toast(error.message, true);
      button.disabled = false;
      button.textContent = "Assumir alerta e parar alarme";
    }
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
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js?v=177", { scope: "./", updateViaCache: "none" }).then((registration) => registration.update()).catch(() => {});
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
