(() => {
  "use strict";

  const API = "https://motoboy-conchal.onrender.com";
  const TOKEN_KEY = "nexus_carroja_customer_session_v1";
  const DEVICE_KEY = "nexus_carroja_device_v1";
  const ACTIVE_RIDE_KEY = "nexus_carroja_active_ride_v1";
  const AGUAI = [-22.0572, -46.9784];
  const $ = (id) => document.getElementById(id);
  const money = (value) => Number(value || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  const digits = (value) => String(value || "").replace(/\D/g, "");
  const escapeHtml = (value) => String(value || "").replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
  })[character]);

  let token = localStorage.getItem(TOKEN_KEY) || "";
  let customer = null;
  let quote = null;
  let photoData = "";
  let verificationToken = "";
  let currentRide = null;
  let ridePollTimer = null;
  let toastTimer = null;
  let installPrompt = null;
  let map;
  let routeLayer;
  let originMarker;
  let destinationMarker;
  let driverMarker;

  const deviceId = (() => {
    let value = localStorage.getItem(DEVICE_KEY);
    if (!value) {
      value = globalThis.crypto?.randomUUID?.() || `carroja-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      localStorage.setItem(DEVICE_KEY, value);
    }
    return value;
  })();

  async function api(path, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (options.body && !headers["content-type"]) headers["content-type"] = "application/json";
    if (token) headers.authorization = `Bearer ${token}`;
    let response;
    try {
      response = await fetch(`${API}${path}`, { ...options, headers, cache: "no-store" });
    } catch (_error) {
      const error = new Error("Não foi possível conectar ao servidor do CarroJÁ. Aguarde alguns segundos e tente novamente.");
      error.status = 0;
      error.code = "network_error";
      throw error;
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.message || data.error || "Não foi possível concluir agora.");
      error.status = response.status;
      error.code = data.error || "request_failed";
      throw error;
    }
    return data;
  }

  function toast(message, error = false) {
    const element = $("toast");
    element.textContent = message;
    element.className = `toast show${error ? " error" : ""}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { element.className = "toast"; }, 3600);
  }

  function setMessage(id, message, success = false) {
    const element = $(id);
    element.textContent = message || "";
    element.classList.toggle("success", success);
  }

  function setBusy(button, busy, label = "Aguarde...") {
    if (!button) return;
    if (busy) {
      button.dataset.previousHtml = button.innerHTML;
      button.disabled = true;
      button.textContent = label;
    } else {
      button.disabled = false;
      if (button.dataset.previousHtml) button.innerHTML = button.dataset.previousHtml;
      delete button.dataset.previousHtml;
      window.lucide?.createIcons();
    }
  }

  function maskCpf(input) {
    const value = digits(input.value).slice(0, 11);
    input.value = value.replace(/(\d{3})(\d)/, "$1.$2").replace(/(\d{3})(\d)/, "$1.$2").replace(/(\d{3})(\d{1,2})$/, "$1-$2");
  }

  function maskPhone(input) {
    const value = digits(input.value).slice(0, 11);
    input.value = value.replace(/^(\d{2})(\d)/, "($1) $2").replace(/(\d{5})(\d{4})$/, "$1-$2");
  }

  function periodNow() {
    const hour = new Date().getHours();
    if (hour < 6) return { label: "Madrugada", rate: 8.2 };
    if (hour >= 18) return { label: "Noite", rate: 6.2 };
    return { label: "Dia", rate: 4.2 };
  }

  function updateFareBadge() {
    const period = periodNow();
    $("currentFareBadge").textContent = `${period.label} · ${money(period.rate)}/km`;
  }

  function initializeMap() {
    if (!window.L) {
      $("map").innerHTML = '<div class="map-fallback"><strong>Mapa temporariamente indisponível</strong><span>Você ainda pode entrar na conta e preencher os endereços.</span></div>';
      return;
    }
    map = L.map("map", { zoomControl: true }).setView(AGUAI, 14);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "&copy; OpenStreetMap",
    }).addTo(map);
  }

  function pinIcon(kind) {
    return L.divIcon({ className: `map-pin ${kind}`, html: "<span></span>", iconSize: [34, 40], iconAnchor: [17, 36] });
  }

  function carIcon() {
    return L.divIcon({ className: "car-map-icon", html: "<span>🚘</span>", iconSize: [42, 42], iconAnchor: [21, 21] });
  }

  function clearRoute() {
    if (!map) return;
    [routeLayer, originMarker, destinationMarker].forEach((layer) => { if (layer) map.removeLayer(layer); });
    routeLayer = originMarker = destinationMarker = null;
  }

  function drawRoute(origin, destination, geometry = []) {
    if (!map || !window.L) return;
    clearRoute();
    originMarker = L.marker([origin.lat, origin.lon], { icon: pinIcon("origin") }).addTo(map);
    destinationMarker = L.marker([destination.lat, destination.lon], { icon: pinIcon("destination") }).addTo(map);
    const points = Array.isArray(geometry) && geometry.length > 1
      ? geometry.map((point) => [Number(point[0]), Number(point[1])])
      : [[origin.lat, origin.lon], [destination.lat, destination.lon]];
    routeLayer = L.polyline(points, { color: "#19c46b", weight: 6, opacity: 0.92, lineJoin: "round" }).addTo(map);
    map.fitBounds(routeLayer.getBounds(), { padding: [64, 64], maxZoom: 16 });
  }

  function updateDriverMarker(location) {
    if (!map || !window.L) return;
    const latitude = Number(location?.latitude);
    const longitude = Number(location?.longitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return;
    if (!driverMarker) driverMarker = L.marker([latitude, longitude], { icon: carIcon(), zIndexOffset: 1000 }).addTo(map);
    else driverMarker.setLatLng([latitude, longitude]);
  }

  async function geocode(address) {
    const text = String(address || "").trim();
    if (text.length < 5) throw new Error("Digite rua, número, bairro e cidade.");
    const query = /brasil/i.test(text) ? text : `${text}, Brasil`;
    const params = new URLSearchParams({ text: query, limit: "5", bias: "proximity:-46.9784,-22.0572" });
    const data = await api(`/api/maps/geocode?${params}`);
    const feature = data.features?.find((item) => {
      const [lon, lat] = item.geometry?.coordinates || [];
      return Number.isFinite(Number(lat)) && Number.isFinite(Number(lon));
    });
    if (!feature) throw new Error("Endereço não encontrado. Inclua número, bairro e cidade.");
    const [lon, lat] = feature.geometry.coordinates;
    const properties = feature.properties || {};
    return {
      lat: Number(lat),
      lon: Number(lon),
      text: properties.formatted || text,
      city: properties.city || properties.municipality || properties.county || "",
    };
  }

  function currentPosition() {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) return reject(new Error("Este aparelho não oferece GPS."));
      navigator.geolocation.getCurrentPosition(
        ({ coords }) => resolve({ lat: coords.latitude, lon: coords.longitude }),
        () => reject(new Error("Libere a localização do navegador ou digite o endereço.")),
        { enableHighAccuracy: true, timeout: 16000, maximumAge: 30000 },
      );
    });
  }

  async function locateOrigin(button = null) {
    setBusy(button, true, "Localizando...");
    try {
      const point = await currentPosition();
      const params = new URLSearchParams({ lat: point.lat, lon: point.lon });
      const data = await api(`/api/maps/reverse?${params}`);
      const properties = data.features?.[0]?.properties || {};
      point.text = properties.formatted || "Localização atual pelo GPS";
      point.city = properties.city || properties.municipality || properties.county || "";
      $("originInput").value = point.text;
      $("originInput").dataset.lat = point.lat;
      $("originInput").dataset.lon = point.lon;
      $("originInput").dataset.city = point.city;
      map?.setView([point.lat, point.lon], 16);
      toast("Local de partida atualizado pelo GPS.");
      return point;
    } finally {
      setBusy(button, false);
    }
  }

  function invalidatePoint(input) {
    delete input.dataset.lat;
    delete input.dataset.lon;
    delete input.dataset.city;
    quote = null;
    $("quoteCard").classList.add("hidden");
  }

  async function resolveInput(input) {
    const savedLat = Number(input.dataset.lat);
    const savedLon = Number(input.dataset.lon);
    if (Number.isFinite(savedLat) && Number.isFinite(savedLon) && savedLat && savedLon) {
      return { lat: savedLat, lon: savedLon, text: input.value.trim(), city: input.dataset.city || "" };
    }
    const point = await geocode(input.value);
    input.value = point.text;
    input.dataset.lat = point.lat;
    input.dataset.lon = point.lon;
    input.dataset.city = point.city;
    return point;
  }

  async function calculateRide() {
    const button = $("calculateButton");
    setBusy(button, true, "Calculando rota...");
    try {
      const [origin, destination] = await Promise.all([resolveInput($("originInput")), resolveInput($("destinationInput"))]);
      const data = await api("/api/car/fare", {
        method: "POST",
        body: JSON.stringify({ points: [origin, destination] }),
      });
      quote = { ...data, origin, destination };
      $("quoteTotal").textContent = money(data.total);
      $("quoteDistance").textContent = `${Number(data.km).toFixed(2).replace(".", ",")} km`;
      $("quotePeriod").textContent = data.period === "madrugada" ? "Madrugada" : data.period === "noite" ? "Noite" : "Dia";
      $("quoteRate").textContent = `${money(data.rate)}/km`;
      $("quoteEta").textContent = "Preço fechado para esta rota";
      $("quoteCard").classList.remove("hidden");
      $("mapStatus").textContent = "Rota calculada";
      drawRoute(origin, destination, data.geometry);
    } catch (error) {
      toast(error.message, true);
    } finally {
      setBusy(button, false);
    }
  }

  function authHeadersReady() {
    if (token && customer) return true;
    openAuth("login");
    toast("Entre na sua conta para confirmar a corrida.", true);
    return false;
  }

  async function confirmRide() {
    if (!quote) return toast("Calcule a rota antes de confirmar.", true);
    if (!authHeadersReady()) return;
    const button = $("confirmButton");
    setBusy(button, true, "Chamando motoristas...");
    try {
      const requestId = globalThis.crypto?.randomUUID?.().replace(/-/g, "") || `${Date.now()}${Math.random().toString(16).slice(2)}`;
      const data = await api("/api/car/rides", {
        method: "POST",
        body: JSON.stringify({
          clientRequestId: requestId,
          quoteToken: quote.quoteToken,
          origem: $("originInput").value,
          origemEncontrada: quote.origin.text,
          origemLat: quote.origin.lat,
          origemLon: quote.origin.lon,
          destino: $("destinationInput").value,
          destinoEncontrado: quote.destination.text,
          destinoLat: quote.destination.lat,
          destinoLon: quote.destination.lon,
          cidadeOperacao: quote.origin.city || quote.destination.city || "Região atendida",
          observacao: $("rideNote").value,
          pagamentoModo: $("paymentMode").value,
        }),
      });
      localStorage.setItem(ACTIVE_RIDE_KEY, data.rideId);
      currentRide = {
        id: data.rideId, status: "pendente", origem: quote.origin.text, destino: quote.destination.text,
        valor: quote.total, km: quote.km, tarifaLabel: quote.label,
      };
      renderActiveRide(currentRide);
      startRidePolling();
      toast("Corrida enviada aos motoristas.");
    } catch (error) {
      if (error.status === 401) clearSession();
      toast(error.message, true);
    } finally {
      setBusy(button, false);
    }
  }

  const statusLabels = {
    pendente: ["Procurando motorista", "Pendente"],
    aceita: ["Motorista a caminho", "Aceita"],
    motorista_chegou: ["Seu motorista chegou", "No embarque"],
    em_andamento: ["Corrida em andamento", "Em viagem"],
    finalizada: ["Você chegou ao destino", "Finalizada"],
    cancelada: ["Corrida cancelada", "Cancelada"],
    expirada: ["Nenhum motorista aceitou", "Expirada"],
  };

  function renderActiveRide(ride) {
    currentRide = ride;
    $("bookingForm").classList.add("hidden");
    $("activeRide").classList.remove("hidden");
    const labels = statusLabels[ride.status] || ["Acompanhando corrida", ride.status];
    $("activeRideTitle").textContent = labels[0];
    $("activeRideStatus").textContent = labels[1];
    $("activeOrigin").textContent = ride.origem || "-";
    $("activeDestination").textContent = ride.destino || "-";
    $("activePrice").textContent = money(ride.valor);
    $("mapStatus").textContent = labels[0];
    const accepted = ["aceita", "motorista_chegou", "em_andamento", "finalizada"].includes(ride.status) && ride.motorista;
    $("searchAnimation").classList.toggle("hidden", Boolean(accepted) || ["finalizada", "cancelada", "expirada"].includes(ride.status));
    $("acceptedDriver").classList.toggle("hidden", !accepted);
    $("driverMapCard").classList.toggle("hidden", !accepted || ride.status === "finalizada");
    if (accepted) {
      $("acceptedDriverName").textContent = ride.motorista;
      $("acceptedDriverPhoto").src = ride.motoristaFoto || "./carroja-icon.svg";
      $("acceptedCar").textContent = [ride.carro?.modelo, ride.carro?.cor, ride.carro?.placa].filter(Boolean).join(" · ");
      $("driverMapName").textContent = ride.motorista;
      $("driverMapUpdate").textContent = labels[0];
      const phone = digits(ride.motoristaTelefone);
      $("driverWhatsapp").href = phone ? `https://wa.me/55${phone}` : "#";
      updateDriverMarker(ride.motoristaLocalizacao);
    }
    const finished = ["finalizada", "cancelada", "expirada"].includes(ride.status);
    $("cancelRideButton").classList.toggle("hidden", finished || ride.status === "em_andamento");
    if (finished) {
      clearInterval(ridePollTimer);
      ridePollTimer = null;
      localStorage.removeItem(ACTIVE_RIDE_KEY);
      setTimeout(() => resetBooking(), 5000);
    }
  }

  function resetBooking() {
    currentRide = null;
    $("activeRide").classList.add("hidden");
    $("bookingForm").classList.remove("hidden");
    $("driverMapCard").classList.add("hidden");
    if (driverMarker && map) map.removeLayer(driverMarker);
    driverMarker = null;
    quote = null;
    $("quoteCard").classList.add("hidden");
    $("mapStatus").textContent = "Informe seu destino";
  }

  async function refreshRide() {
    const rideId = localStorage.getItem(ACTIVE_RIDE_KEY);
    if (!rideId || !token) return;
    try {
      const data = await api(`/api/car/rides/${encodeURIComponent(rideId)}/status`);
      renderActiveRide(data.ride);
    } catch (error) {
      if (error.status === 404) {
        localStorage.removeItem(ACTIVE_RIDE_KEY);
        resetBooking();
      } else if (error.status === 401) clearSession();
    }
  }

  function startRidePolling() {
    clearInterval(ridePollTimer);
    refreshRide();
    ridePollTimer = setInterval(refreshRide, 10000);
  }

  async function cancelRide() {
    if (!currentRide?.id || !confirm("Cancelar esta corrida?")) return;
    const button = $("cancelRideButton");
    setBusy(button, true, "Cancelando...");
    try {
      await api(`/api/car/rides/${encodeURIComponent(currentRide.id)}/cancel`, {
        method: "POST", body: JSON.stringify({ reason: "Cancelada pelo passageiro no aplicativo" }),
      });
      currentRide.status = "cancelada";
      renderActiveRide(currentRide);
      toast("Corrida cancelada.");
    } catch (error) {
      toast(error.message, true);
    } finally {
      setBusy(button, false);
    }
  }

  function openAuth(tab = "login") {
    document.querySelectorAll("[data-auth-tab]").forEach((button) => button.classList.toggle("active", button.dataset.authTab === tab));
    document.querySelectorAll("[data-auth-panel]").forEach((panel) => panel.classList.toggle("hidden", panel.dataset.authPanel !== tab));
    if (!$("authDialog").open) $("authDialog").showModal();
  }

  function populateAccount() {
    if (!customer) return;
    $("accountName").textContent = customer.nome || "Passageiro";
    $("accountPhone").textContent = customer.telefoneCliente || "";
    $("accountCpf").textContent = `CPF final ${customer.cpfFinal || "-"}`;
    $("accountPhoto").src = customer.fotoCliente || "./carroja-icon.svg";
  }

  async function compressPhoto(file, maxLength = 210000) {
    if (!file?.type?.startsWith("image/")) throw new Error("Escolha uma foto válida.");
    const source = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error("Não foi possível ler a foto."));
      reader.readAsDataURL(file);
    });
    const image = await new Promise((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error("Foto inválida."));
      element.src = source;
    });
    const scale = Math.min(1, 600 / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    canvas.getContext("2d", { alpha: false }).drawImage(image, 0, 0, canvas.width, canvas.height);
    let quality = 0.82;
    let result = canvas.toDataURL("image/jpeg", quality);
    while (result.length > maxLength && quality > 0.38) {
      quality -= 0.08;
      result = canvas.toDataURL("image/jpeg", quality);
    }
    if (result.length > 220000) throw new Error("A foto ficou muito grande. Escolha outra.");
    return result;
  }

  async function sendOtp() {
    const phone = digits($("registerPhone").value);
    if (phone.length < 10) return setMessage("registerMessage", "Digite o WhatsApp com DDD.");
    const button = $("sendOtpButton");
    setBusy(button, true, "Enviando...");
    try {
      const data = await api("/api/car/customers/otp/request", {
        method: "POST", body: JSON.stringify({ telefoneCliente: phone, deviceId }),
      });
      verificationToken = "";
      setMessage("registerMessage", data.message || "Código enviado pelo WhatsApp.", true);
      $("registerOtp").focus();
    } catch (error) {
      setMessage("registerMessage", error.message);
    } finally {
      setBusy(button, false);
    }
  }

  async function login(event) {
    event.preventDefault();
    const button = event.submitter;
    setBusy(button, true, "Entrando...");
    setMessage("loginMessage", "");
    try {
      const data = await api("/api/car/customers/login", {
        method: "POST",
        body: JSON.stringify({ cpf: digits($("loginCpf").value), password: $("loginPassword").value, deviceId }),
      });
      token = data.token;
      customer = data.customer;
      localStorage.setItem(TOKEN_KEY, token);
      populateAccount();
      $("authDialog").close();
      toast("Conta conectada com segurança.");
      if (localStorage.getItem(ACTIVE_RIDE_KEY)) startRidePolling();
    } catch (error) {
      setMessage("loginMessage", error.message);
    } finally {
      setBusy(button, false);
    }
  }

  async function register(event) {
    event.preventDefault();
    if (!photoData) return setMessage("registerMessage", "Escolha uma foto do rosto.");
    const phone = digits($("registerPhone").value);
    const code = digits($("registerOtp").value);
    if (code.length !== 6) return setMessage("registerMessage", "Digite o código de 6 números enviado pelo WhatsApp.");
    const button = event.submitter;
    setBusy(button, true, "Criando conta...");
    setMessage("registerMessage", "Confirmando seu WhatsApp...");
    try {
      if (!verificationToken) {
        const verified = await api("/api/car/customers/otp/verify", {
          method: "POST", body: JSON.stringify({ telefoneCliente: phone, deviceId, code }),
        });
        verificationToken = verified.verificationToken;
      }
      const data = await api("/api/car/customers/register", {
        method: "POST",
        body: JSON.stringify({
          nome: $("registerName").value,
          telefoneCliente: phone,
          cpf: digits($("registerCpf").value),
          dataNascimento: $("registerBirth").value,
          fotoCliente: photoData,
          password: $("registerPassword").value,
          deviceId,
          verificationToken,
        }),
      });
      token = data.token;
      customer = data.customer;
      localStorage.setItem(TOKEN_KEY, token);
      populateAccount();
      $("authDialog").close();
      toast("Conta criada. Você já pode pedir sua corrida.");
    } catch (error) {
      if (["codigo_expirado", "codigo_incorreto", "whatsapp_nao_verificado"].includes(error.code)) verificationToken = "";
      setMessage("registerMessage", error.message);
    } finally {
      setBusy(button, false);
    }
  }

  async function openHistory() {
    if (!authHeadersReady()) return;
    $("historyList").innerHTML = '<div class="empty-state">Carregando histórico...</div>';
    $("historyDialog").showModal();
    try {
      const data = await api("/api/car/customers/me/rides");
      if (!data.rides?.length) {
        $("historyList").innerHTML = '<div class="empty-state">Você ainda não realizou corridas no CarroJá.</div>';
        return;
      }
      $("historyList").innerHTML = data.rides.map((ride) => `<article class="history-item">
        <div><strong>${escapeHtml(ride.origem)} → ${escapeHtml(ride.destino)}</strong><span>${new Date(ride.criadaEmMs || Date.now()).toLocaleString("pt-BR")}</span><small>${Number(ride.km || 0).toFixed(2).replace(".", ",")} km · ${escapeHtml(statusLabels[ride.status]?.[1] || ride.status)}</small></div><b>${money(ride.valor)}</b>
      </article>`).join("");
    } catch (error) {
      $("historyList").innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
    }
  }

  function openAccount() {
    if (!authHeadersReady()) return;
    populateAccount();
    $("accountDialog").showModal();
  }

  function clearSession() {
    token = "";
    customer = null;
    localStorage.removeItem(TOKEN_KEY);
    clearInterval(ridePollTimer);
    openAuth("login");
  }

  async function logout() {
    try { await api("/api/car/customers/logout", { method: "POST", body: "{}" }); } catch {}
    $("accountDialog").close();
    clearSession();
    toast("Você saiu da conta.");
  }

  function bindEvents() {
    $("originInput").addEventListener("input", (event) => invalidatePoint(event.target));
    $("destinationInput").addEventListener("input", (event) => invalidatePoint(event.target));
    $("originGpsButton").addEventListener("click", (event) => locateOrigin(event.currentTarget).catch((error) => toast(error.message, true)));
    $("locateButton").addEventListener("click", (event) => locateOrigin(event.currentTarget).catch((error) => toast(error.message, true)));
    $("calculateButton").addEventListener("click", calculateRide);
    $("confirmButton").addEventListener("click", confirmRide);
    $("cancelRideButton").addEventListener("click", cancelRide);
    ["historyButton", "panelHistoryButton", "mobileHistoryButton"].forEach((id) => $(id).addEventListener("click", openHistory));
    ["profileButton", "mobileProfileButton", "mobileAccountButton"].forEach((id) => $(id).addEventListener("click", openAccount));
    $("logoutButton").addEventListener("click", logout);
    document.querySelectorAll("[data-close-dialog]").forEach((button) => button.addEventListener("click", () => $(button.dataset.closeDialog).close()));
    document.querySelectorAll("[data-auth-tab]").forEach((button) => button.addEventListener("click", () => openAuth(button.dataset.authTab)));
    document.querySelectorAll("[data-toggle-password]").forEach((button) => button.addEventListener("click", () => {
      const input = $(button.dataset.togglePassword);
      input.type = input.type === "password" ? "text" : "password";
    }));
    $("loginCpf").addEventListener("input", (event) => maskCpf(event.target));
    $("registerCpf").addEventListener("input", (event) => maskCpf(event.target));
    $("registerPhone").addEventListener("input", (event) => maskPhone(event.target));
    $("registerPhoto").addEventListener("change", async (event) => {
      try {
        photoData = await compressPhoto(event.target.files?.[0]);
        $("registerPhotoLabel").textContent = "Foto pronta";
      } catch (error) {
        photoData = "";
        event.target.value = "";
        setMessage("registerMessage", error.message);
      }
    });
    $("sendOtpButton").addEventListener("click", sendOtp);
    $("loginForm").addEventListener("submit", login);
    $("registerForm").addEventListener("submit", register);
    $("authDialog").addEventListener("cancel", (event) => { if (!customer) event.preventDefault(); });
    window.addEventListener("beforeinstallprompt", (event) => { event.preventDefault(); installPrompt = event; });
    ["installButton", "mobileInstallButton"].forEach((id) => $(id).addEventListener("click", async () => {
      if (!installPrompt) return toast("No celular, use o menu do navegador e escolha Instalar aplicativo.");
      installPrompt.prompt();
      await installPrompt.userChoice;
      installPrompt = null;
    }));
    document.addEventListener("visibilitychange", () => { if (!document.hidden && currentRide) refreshRide(); });
  }

  async function initialize() {
    window.lucide?.createIcons();
    initializeMap();
    bindEvents();
    updateFareBadge();
    setInterval(updateFareBadge, 60000);
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js?v=1", { scope: "./", updateViaCache: "none" }).then((registration) => registration.update()).catch(() => {});
    if (token) {
      try {
        const data = await api("/api/car/customers/me");
        customer = data.customer;
        populateAccount();
      } catch {
        token = "";
        localStorage.removeItem(TOKEN_KEY);
      }
    }
    if (!customer) openAuth(new URLSearchParams(location.search).get("cadastro") === "1" ? "register" : "login");
    if (token && localStorage.getItem(ACTIVE_RIDE_KEY)) startRidePolling();
    setTimeout(() => $("boot").classList.add("done"), 220);
  }

  initialize();
})();
