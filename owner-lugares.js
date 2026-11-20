// Painel do dono: lugares conhecidos (supermercado, hospital, escola...). O cliente digita o nome
// do lugar no app e a corrida vai para o ponto certo, sem precisar saber rua e numero.
(function () {
  "use strict";
  const backend = () => (window.CONFIG && window.CONFIG.backend) || "https://motoboy-conchal.onrender.com";
  const senha = () => window.senhaDono || document.getElementById("senha")?.value?.trim() || "";
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const cidades = { conchal: "Conchal", aguai: "Aguaí", engenheiro_coelho: "Engenheiro Coelho" };

  function montar() {
    if (document.getElementById("lugares-section")) return;
    const corridas = document.getElementById("corridas-section");
    if (!corridas) return;
    const box = document.createElement("section");
    box.id = "lugares-section";
    box.className = "box grid";
    box.innerHTML = `<h2>Lugares conhecidos</h2>
      <p class="muted">Cadastre comércios e lugares que os clientes pedem pelo nome (supermercado, farmácia, hospital, escola, rodoviária...). Quando o cliente digitar o nome no app, a corrida vai direto para o endereço certo.</p>
      <form id="lugarForm" class="filters" style="grid-template-columns:repeat(auto-fit,minmax(200px,1fr));align-items:end">
        <label>Nome do lugar<input id="lugarNomes" placeholder="Supermercado São Roque; Mercado São Roque" maxlength="300" required></label>
        <label>Endereço (rua e número)<input id="lugarEndereco" placeholder="Rua Mogi Mirim, 417" maxlength="120"></label>
        <label>Cidade<select id="lugarCidade">${Object.entries(cidades).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select></label>
        <label>Ou coordenada do Google Maps (opcional)<input id="lugarCoordenada" placeholder="-22.3375, -47.1704" maxlength="60"></label>
        <button type="submit">Cadastrar lugar</button>
      </form>
      <p class="muted" style="font-size:.78rem">Dica: mais de um nome separado por ponto e vírgula (;). Se o endereço não for achado, abra o lugar no Google Maps, toque no ponto e copie os números (latitude, longitude).</p>
      <p id="lugarAviso" class="muted" hidden></p>
      <div id="lugaresLista" class="table compact"></div>`;
    corridas.insertAdjacentElement("afterend", box);
    box.querySelector("#lugarForm").addEventListener("submit", cadastrar);
    box.addEventListener("click", apagar);
  }

  function aviso(texto, erro = false) {
    const el = document.getElementById("lugarAviso");
    if (!el) return;
    el.hidden = !texto;
    el.textContent = texto || "";
    el.style.color = erro ? "#ff8a80" : "#7ee2a8";
  }

  async function api(caminho, corpo) {
    const r = await fetch(`${backend()}${caminho}`, {
      method: corpo ? "POST" : "GET",
      headers: { "content-type": "application/json", "x-owner-password": senha() },
      ...(corpo ? { body: JSON.stringify(corpo) } : {}),
      cache: "no-store",
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.message || d.error || "Não consegui falar com o servidor.");
    return d;
  }

  async function carregar() {
    montar();
    const lista = document.getElementById("lugaresLista");
    if (!lista || !senha()) return;
    try {
      const d = await api("/api/admin/places");
      const itens = d.lugares || [];
      lista.innerHTML = itens.length
        ? `<table><thead><tr><th>Lugar</th><th>Endereço</th><th>Cidade</th><th></th></tr></thead><tbody>${itens.map((l) => `<tr><td><strong>${esc(l.nomes?.[0] || "-")}</strong>${(l.nomes || []).length > 1 ? `<br><small class="muted">também: ${esc(l.nomes.slice(1).join("; "))}</small>` : ""}</td><td>${esc(l.endereco || "-")}${l.bairro ? `<br><small class="muted">${esc(l.bairro)}</small>` : ""}</td><td>${esc(cidades[l.cidade] || l.cidade)}</td><td><a href="https://www.google.com/maps?q=${l.lat},${l.lon}" target="_blank" rel="noopener">Ver no mapa</a> <button type="button" data-apagar-lugar="${esc(l.id)}">Apagar</button></td></tr>`).join("")}</tbody></table>`
        : '<div class="empty">Nenhum lugar cadastrado ainda. O Supermercado São Roque (Conchal) já vem cadastrado no sistema.</div>';
    } catch (e) {
      lista.innerHTML = `<div class="empty">${esc(e.message)} (o servidor precisa estar atualizado no Render)</div>`;
    }
  }

  async function cadastrar(event) {
    event.preventDefault();
    const botao = event.target.querySelector("button[type=submit]");
    botao.disabled = true;
    aviso("Procurando o endereço...");
    try {
      const d = await api("/api/admin/places", {
        nomes: document.getElementById("lugarNomes").value,
        endereco: document.getElementById("lugarEndereco").value,
        cidade: document.getElementById("lugarCidade").value,
        coordenada: document.getElementById("lugarCoordenada").value,
      });
      aviso(`✅ ${d.lugar.nomes[0]} cadastrado em ${d.lugar.endereco || "ponto do mapa"}. Os clientes já podem pedir pelo nome.`);
      event.target.reset();
      carregar();
    } catch (e) {
      aviso(e.message, true);
    } finally {
      botao.disabled = false;
    }
  }

  async function apagar(event) {
    const botao = event.target.closest("[data-apagar-lugar]");
    if (!botao || !confirm("Apagar este lugar? Os clientes vão precisar digitar a rua e o número.")) return;
    botao.disabled = true;
    try {
      await api(`/api/admin/places/${encodeURIComponent(botao.dataset.apagarLugar)}/delete`, {});
      carregar();
    } catch (e) {
      alert(e.message);
      botao.disabled = false;
    }
  }

  // Monta junto com o painel e carrega depois do login (a senha fica em window.senhaDono).
  document.addEventListener("DOMContentLoaded", montar);
  const espera = setInterval(() => { if (senha() && window.senhaDono) { clearInterval(espera); carregar(); } }, 1500);
  window.addEventListener("motoja:admin-state", () => { if (!document.querySelector("#lugaresLista table, #lugaresLista .empty")) carregar(); });
})();
