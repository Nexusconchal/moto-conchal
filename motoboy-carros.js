(() => {
  "use strict";

  const API = "https://motoboy-conchal.onrender.com";
  const STORAGE_KEY = "motoJaMotoboyDados";
  const POLL_MS = 20000;
  let profile = null;
  let carDriver = null;
  let scope = "pending";
  let pollTimer = null;
  let locationWatch = null;
  let currentActiveRideId = "";

  const digits = (value) => String(value || "").replace(/\D/g, "");
  const escapeHtml = (value) => String(value || "").replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
  })[character]);
  const money = (value) => Number(value || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

  function readProfile() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || "null"); } catch { return null; }
  }

  function proof(extra = {}) {
    return {
      driverCpf: digits(profile?.cpf),
      driverCnh: digits(profile?.cnh),
      driverTelefone: digits(profile?.telefone),
      ...extra,
    };
  }

  async function api(path, body = {}) {
    const response = await fetch(`${API}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(proof(body)),
      cache: "no-store",
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.message || data.error || "Não foi possível concluir.");
      error.status = response.status;
      error.code = data.error;
      throw error;
    }
    return data;
  }

  function buildUi() {
    const gains = document.getElementById("aba-ganhos");
    if (!gains || document.getElementById("carJobsEntry")) return;
    gains.insertAdjacentHTML("afterend", '<button id="carJobsEntry" class="car-jobs-entry" type="button">Corridas de carro</button>');
    document.body.insertAdjacentHTML("beforeend", `
      <section id="carJobsOverlay" class="car-jobs-overlay hidden" aria-label="Corridas de carro">
        <div class="car-jobs-shell">
          <header class="car-jobs-head"><div><small>NEXUS CARROJÁ</small><h2>Corridas de carro</h2></div><button id="carJobsClose" class="car-jobs-close" type="button" aria-label="Fechar">×</button></header>
          <div id="carJobsContent" class="car-jobs-content"><div class="car-empty">Carregando cadastro do carro...</div></div>
        </div>
      </section>`);
    document.getElementById("carJobsEntry").addEventListener("click", open);
    document.getElementById("carJobsClose").addEventListener("click", close);
    document.getElementById("carJobsOverlay").addEventListener("click", (event) => { if (event.target.id === "carJobsOverlay") close(); });
    document.getElementById("carJobsContent").addEventListener("click", handleClick);
    document.getElementById("carJobsContent").addEventListener("submit", handleSubmit);
  }

  async function open() {
    profile = readProfile();
    if (!profile?.cpf || !profile?.cnh || !profile?.telefone) {
      alert("Entre no Painel do Motoboy antes de abrir as corridas de carro.");
      return;
    }
    document.getElementById("carJobsOverlay").classList.remove("hidden");
    document.body.style.overflow = "hidden";
    await loadStatus();
    clearInterval(pollTimer);
    if (carDriver?.status === "aprovado") pollTimer = setInterval(loadJobs, POLL_MS);
  }

  function close() {
    document.getElementById("carJobsOverlay")?.classList.add("hidden");
    document.body.style.overflow = "";
    clearInterval(pollTimer);
    pollTimer = null;
  }

  function statusLabel(status) {
    return ({ nao_cadastrado: "Não cadastrado", aguardando_aprovacao: "Aguardando aprovação", aprovado: "Aprovado", bloqueado: "Bloqueado" })[status] || status;
  }

  async function loadStatus() {
    const root = document.getElementById("carJobsContent");
    root.innerHTML = '<div class="car-empty">Conferindo cadastro com segurança...</div>';
    try {
      const data = await api(`/api/drivers/${digits(profile.cpf)}/car/status`);
      carDriver = data.carDriver;
      renderStatus();
      if (carDriver.status === "aprovado") await loadJobs();
    } catch (error) {
      root.innerHTML = `<div class="car-empty">${escapeHtml(error.message)}</div>`;
    }
  }

  function renderStatus() {
    const root = document.getElementById("carJobsContent");
    const badgeClass = carDriver.status === "bloqueado" ? "blocked" : carDriver.status === "aprovado" ? "" : "waiting";
    let html = `<div class="car-status-card"><div><small>Motorista</small><strong>${escapeHtml(profile.nome || "Motoboy")}</strong><small>${carDriver.modelo ? `${escapeHtml(carDriver.modelo)} · ${escapeHtml(carDriver.placa)}` : "Cadastre seu carro para começar"}</small></div><span class="car-status-badge ${badgeClass}">${escapeHtml(statusLabel(carDriver.status))}</span></div>`;
    if (carDriver.status === "nao_cadastrado") html += registrationForm();
    if (carDriver.status === "aguardando_aprovacao") html += '<div class="car-empty">Cadastro recebido. O dono precisa conferir o carro e o CRLV antes de liberar corridas.</div>';
    if (carDriver.status === "bloqueado") html += `<div class="car-empty">${escapeHtml(carDriver.motivoBloqueio || "Cadastro de carro bloqueado. Fale com o suporte.")}</div>`;
    if (carDriver.status === "aprovado") {
      html += `<div class="car-online"><div><strong>Receber corridas de carro</strong><small>${carDriver.online ? "Você aparece como disponível" : "Ative quando estiver com o carro"}</small></div><button id="carOnlineToggle" class="${carDriver.online ? "car-danger" : "car-primary"}" type="button">${carDriver.online ? "Ficar offline" : "Ficar online"}</button></div>
        <div class="car-tabs"><button class="car-tab ${scope === "pending" ? "active" : ""}" data-car-scope="pending" type="button">Disponíveis</button><button class="car-tab ${scope === "mine" ? "active" : ""}" data-car-scope="mine" type="button">Minha corrida</button></div><div id="carJobsList" class="car-jobs-list"><div class="car-empty">Carregando corridas...</div></div>`;
    }
    root.innerHTML = html;
  }

  function registrationForm() {
    return `<form id="carRegisterForm" class="car-register"><h3>Cadastrar carro</h3><p>Esse cadastro é separado da moto e só libera depois da aprovação do dono.</p><div class="car-form-grid">
      <label>Modelo<input name="modelo" maxlength="80" placeholder="Ex.: Chevrolet Onix" required></label>
      <label>Ano<input name="ano" inputmode="numeric" maxlength="4" placeholder="2022" required></label>
      <label>Placa<input name="placa" maxlength="8" placeholder="ABC1D23" required></label>
      <label>Cor<input name="cor" maxlength="40" placeholder="Prata" required></label>
    </div><label>Cidade base<input name="cidadeBase" maxlength="80" placeholder="Ex.: Aguaí" required></label>
      <label>Foto do carro<input name="fotoCarro" type="file" accept="image/*" capture="environment" required></label>
      <label>Foto do CRLV<input name="crlvFoto" type="file" accept="image/*" capture="environment" required></label>
      <button class="car-primary" type="submit">Enviar para aprovação</button><p id="carRegisterFeedback" class="car-feedback"></p></form>`;
  }

  async function imageData(file, documentPhoto = false) {
    if (!file?.type?.startsWith("image/")) throw new Error("Escolha uma foto válida.");
    const source = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error("Não consegui ler a foto."));
      reader.readAsDataURL(file);
    });
    const image = await new Promise((resolve, reject) => {
      const item = new Image();
      item.onload = () => resolve(item);
      item.onerror = () => reject(new Error("Foto inválida."));
      item.src = source;
    });
    let max = documentPhoto ? 1100 : 650;
    let quality = documentPhoto ? 0.82 : 0.78;
    const limit = documentPhoto ? 520000 : 210000;
    let result = "";
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const scale = Math.min(1, max / Math.max(image.naturalWidth, image.naturalHeight));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      canvas.getContext("2d", { alpha: false }).drawImage(image, 0, 0, canvas.width, canvas.height);
      result = canvas.toDataURL("image/jpeg", quality);
      if (result.length <= limit) return result;
      max = Math.round(max * 0.82);
      quality = Math.max(0.42, quality - 0.08);
    }
    throw new Error("A foto ficou muito grande. Tire outra mais perto e com boa luz.");
  }

  async function handleSubmit(event) {
    if (event.target.id !== "carRegisterForm") return;
    event.preventDefault();
    const form = event.target;
    const button = event.submitter;
    const feedback = document.getElementById("carRegisterFeedback");
    button.disabled = true;
    feedback.textContent = "Preparando documentos protegidos...";
    try {
      const data = new FormData(form);
      const [fotoCarro, crlvFoto] = await Promise.all([imageData(data.get("fotoCarro")), imageData(data.get("crlvFoto"), true)]);
      const result = await api(`/api/drivers/${digits(profile.cpf)}/car/register`, {
        modelo: data.get("modelo"), ano: data.get("ano"), placa: data.get("placa"), cor: data.get("cor"), cidadeBase: data.get("cidadeBase"), fotoCarro, crlvFoto,
      });
      carDriver = result.carDriver;
      renderStatus();
    } catch (error) {
      feedback.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  }

  async function loadJobs() {
    if (!carDriver || carDriver.status !== "aprovado" || document.getElementById("carJobsOverlay")?.classList.contains("hidden")) return;
    const root = document.getElementById("carJobsList");
    if (!root) return;
    try {
      const data = await api(`/api/drivers/${digits(profile.cpf)}/car/jobs`, { scope });
      carDriver = data.carDriver;
      renderJobs(data.jobs || []);
    } catch (error) {
      root.innerHTML = `<div class="car-empty">${escapeHtml(error.message)}</div>`;
    }
  }

  function renderJobs(jobs) {
    const root = document.getElementById("carJobsList");
    if (!root) return;
    currentActiveRideId = scope === "mine" ? String(jobs[0]?.id || "") : "";
    if (scope === "mine" && currentActiveRideId) startLocation(currentActiveRideId);
    else stopLocation();
    if (!jobs.length) {
      root.innerHTML = `<div class="car-empty">${scope === "pending" ? (carDriver.online ? "Nenhuma corrida disponível agora." : "Fique online para receber e aceitar corridas.") : "Você não tem corrida de carro em andamento."}</div>`;
      return;
    }
    root.innerHTML = jobs.map((job) => `<article class="car-job">
      <div class="car-job-head"><strong>${escapeHtml(job.cidadeOperacao || "Corrida de carro")}</strong><span class="car-job-status">${escapeHtml(job.status)}</span></div>
      <div class="car-route"><i></i><div><small>Partida</small><span>${escapeHtml(job.origem)}</span></div><i></i><div><small>Destino</small><span>${escapeHtml(job.destino)}</span></div></div>
      ${job.passageiro ? `<div><small>Passageiro</small><strong>${escapeHtml(job.passageiro)}</strong></div>` : ""}
      <div class="car-job-value"><span>${Number(job.km || 0).toFixed(2).replace(".", ",")} km · ${escapeHtml(job.pagamentoModo || "pix")}</span><strong>Você recebe ${money(job.motoristaRecebe)}</strong></div>
      ${job.observacao ? `<small>Observação: ${escapeHtml(job.observacao)}</small>` : ""}
      <div class="car-job-actions">${actions(job)}</div>
    </article>`).join("");
  }

  function actions(job) {
    if (scope === "pending") return `<button class="car-primary" data-car-action="accept" data-id="${job.id}" type="button">Aceitar corrida</button>`;
    const whatsapp = job.passageiroTelefone ? `<a class="car-secondary" href="https://wa.me/55${digits(job.passageiroTelefone)}" target="_blank" rel="noopener" style="display:grid;place-items:center;text-decoration:none">Chamar passageiro</a>` : "";
    if (job.status === "aceita") return `${whatsapp}<button class="car-primary" data-car-action="arrived" data-id="${job.id}" type="button">Cheguei ao embarque</button><button class="car-primary" data-car-action="start" data-id="${job.id}" type="button">Iniciar corrida</button><button class="car-danger" data-car-action="cancel" data-id="${job.id}" type="button">Cancelar aceite</button>`;
    if (job.status === "motorista_chegou") return `${whatsapp}<button class="car-primary" data-car-action="start" data-id="${job.id}" type="button">Passageiro embarcou</button><button class="car-danger" data-car-action="cancel" data-id="${job.id}" type="button">Cancelar aceite</button>`;
    if (job.status === "em_andamento") return `${whatsapp}<button class="car-primary" data-car-action="finish" data-id="${job.id}" type="button">Finalizar corrida</button>`;
    return "";
  }

  async function handleClick(event) {
    const scopeButton = event.target.closest("[data-car-scope]");
    if (scopeButton) {
      scope = scopeButton.dataset.carScope;
      renderStatus();
      await loadJobs();
      return;
    }
    if (event.target.closest("#carOnlineToggle")) {
      const button = event.target.closest("#carOnlineToggle");
      button.disabled = true;
      try {
        const data = await api(`/api/drivers/${digits(profile.cpf)}/car/online`, { online: !carDriver.online });
        carDriver.online = data.online;
        renderStatus();
        await loadJobs();
      } catch (error) { alert(error.message); button.disabled = false; }
      return;
    }
    const actionButton = event.target.closest("[data-car-action]");
    if (!actionButton) return;
    const action = actionButton.dataset.carAction;
    const rideId = actionButton.dataset.id;
    if (action === "cancel" && !confirm("Cancelar seu aceite e devolver a corrida para outros motoristas?")) return;
    if (action === "finish" && !confirm("Confirmar que o passageiro chegou ao destino?")) return;
    actionButton.disabled = true;
    try {
      const endpoint = action === "cancel" ? "driver-cancel" : action;
      await api(`/api/car/rides/${encodeURIComponent(rideId)}/${endpoint}`, action === "cancel" ? { reason: "Motorista cancelou antes do início" } : {});
      if (action === "accept") scope = "mine";
      if (["finish", "cancel"].includes(action)) stopLocation();
      renderStatus();
      await loadJobs();
    } catch (error) {
      alert(error.message);
      actionButton.disabled = false;
    }
  }

  function startLocation(rideId) {
    if (currentActiveRideId === rideId && locationWatch !== null) return;
    stopLocation();
    currentActiveRideId = rideId;
    if (!navigator.geolocation) return;
    locationWatch = navigator.geolocation.watchPosition(({ coords }) => {
      if (!currentActiveRideId) return;
      api(`/api/car/rides/${encodeURIComponent(currentActiveRideId)}/location`, {
        latitude: coords.latitude, longitude: coords.longitude, accuracy: coords.accuracy, clientTimestampMs: Date.now(),
      }).catch(() => {});
    }, () => {}, { enableHighAccuracy: true, maximumAge: 12000, timeout: 20000 });
  }

  function stopLocation() {
    if (locationWatch !== null) navigator.geolocation?.clearWatch(locationWatch);
    locationWatch = null;
    currentActiveRideId = "";
  }

  function initialize() {
    buildUi();
    const observer = new MutationObserver(buildUi);
    observer.observe(document.body, { childList: true, subtree: true });
    if (new URLSearchParams(location.search).get("aba") === "carros") setTimeout(open, 900);
  }

  initialize();
})();
