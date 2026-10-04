(function (root) {
  'use strict';
  root.MotojaCompanyReports = {
    create({ fetchReport, identity, escapeHtml, money }) {
      const $ = id => document.getElementById(id);
      const box = $('relatorioEmpresa'), period = $('periodoRelatorio'), start = $('inicioRelatorio'), end = $('fimRelatorio');
      const loadButton = $('verRelatorioDia'), excel = $('baixarRelatorioExcel'), pdf = $('baixarRelatorioPdf');
      let loaded = null, account = '', sequence = 0, busy = false;
      const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
      const iso = ms => new Date(ms).toISOString().slice(0, 10);
      const disableExports = () => { excel.disabled = true; pdf.disabled = true; };
      function reset(message = 'Escolha o período e clique em Ver relatório.') {
        sequence++; loaded = null; account = ''; disableExports(); box.textContent = message;
      }
      function setPeriod() {
        end.value = today();
        const ms = Date.parse(end.value + 'T12:00:00Z');
        start.value = period.value === '7days' ? iso(ms - 6 * 86400000) : period.value === 'month' ? end.value.slice(0, 8) + '01' : end.value;
        const custom = period.value === 'custom'; start.disabled = !custom; end.disabled = !custom;
        start.max = today(); end.max = today(); reset();
      }
      function render(d) {
        if (!d?.ok) { reset(); return; }
        if (d.schemaVersion !== 2) { reset('A atualização do relatório está em andamento. Aguarde um pouco e tente novamente.'); return; }
        loaded = d; account = identity();
        const metric = (label, value) => `<div class="report-metric"><span>${label}</span><strong>${value}</strong></div>`;
        const safe = escapeHtml;
        const rows = (d.ultimas || []).map(row => `<tr><td>${safe(new Date(row.criadaEm).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' }))}<br><small>${safe(row.id)}</small></td><td>${safe(row.modalidade)}<br><small>${safe(row.tipoEntrega)} · ${safe(row.bairroEntrega)}</small><details><summary>Ver destinos</summary>${safe(row.entrega)}${(row.pontosExtras || []).length ? "<br>" + row.pontosExtras.map(point => safe(point.digitado)).join("<br>") : row.enderecosExtras ? "<br>" + safe(row.enderecosExtras) : ""}</details></td><td>${Number(row.quantidade || 0)}</td><td>${safe(row.status)}<br>${safe(row.motoboy || 'Aguardando motoboy')}</td><td>${money(row.valor)}</td><td>${money(row.cobrado)}</td><td>${money(row.reservado)}</td></tr>`).join('');
        box.innerHTML = `<h3>Resumo do período</h3><p class="muted">Chamadas criadas entre ${safe(start.value.split('-').reverse().join('/'))} e ${safe(end.value.split('-').reverse().join('/'))}. Situação na geração.</p>${d.parcial ? `<p class="warn">${safe(d.aviso)}</p>` : ''}<div class="report-metrics">${metric('Chamadas', d.totalChamadas)}${metric('Entregas solicitadas', d.totalEntregas)}${metric('Entregas concluídas', d.entregasConcluidas)}${metric('Em andamento / aguardando', d.chamadasEmAndamento + ' / ' + d.chamadasPendentes)}${metric('Canceladas / expiradas', d.chamadasCanceladas + ' / ' + d.chamadasExpiradas)}${metric('Entregas cobradas', money(d.totalGasto))}${metric('Valor reservado', money(d.totalReservado))}${metric('Ativações de diária', money(d.totalDiarias))}${metric('Entregas + ativações', money(d.totalDebitado))}${metric('Motoboys receberam', money(d.totalMotoboy))}${metric('MotoJá nas entregas', money(d.totalApp))}</div><p class="muted">Um lote com 5 entregas conta como 1 chamada e 5 entregas. Reservas são cobradas ao concluir. Ativação de diária aparece separada das entregas.</p><div class="report-table"><table><thead><tr><th>Data / código</th><th>Modalidade / região</th><th>Qtd.</th><th>Situação / motoboy</th><th>Combinado</th><th>Cobrado</th><th>Reservado</th></tr></thead><tbody>${rows || '<tr><td colspan="7">Nenhuma chamada neste período.</td></tr>'}</tbody></table></div><p class="muted">Gerado às ${safe(new Date(d.geradoEm).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' }))}. Atualizações repetidas reutilizam os dados por até 1 minuto.</p>`;
        excel.disabled = pdf.disabled = !!d.parcial;
      }
      async function load() {
        if (busy) return;
        const sinceMs = Date.parse(start.value + 'T00:00:00-03:00'), untilMs = Date.parse(end.value + 'T23:59:59.999-03:00');
        if (!Number.isFinite(sinceMs) || !Number.isFinite(untilMs) || untilMs < sinceMs || untilMs - sinceMs >= 31 * 86400000 || end.value > today()) {
          reset('Escolha um período válido de até 31 dias, terminando até hoje.'); return;
        }
        const company = identity(); if (!company) { reset('Entre na conta da empresa para ver o relatório.'); return; }
        reset('Carregando relatório...'); const request = sequence;
        busy = true; loadButton.disabled = true; period.disabled = true; start.disabled = end.disabled = true; loadButton.textContent = 'Carregando relatório...';
        try { const data = await fetchReport(sinceMs, untilMs); if (sequence === request && identity() === company) render(data); }
        catch (error) { if (sequence === request) reset(error.message || 'Não consegui carregar o relatório.'); }
        finally { busy = false; loadButton.disabled = false; period.disabled = false; start.disabled = end.disabled = period.value !== 'custom'; loadButton.textContent = 'Ver relatório'; }
      }
      async function download(format, button) {
        if (!loaded || account !== identity() || loaded.parcial) { reset('Carregue novamente o relatório antes de baixar.'); return; }
        const d = loaded; const label = button.textContent; button.disabled = true; button.textContent = 'Preparando...';
        try { await root.MotojaReportExport[format](d); }
        catch (error) { alert(error.message || 'Não consegui gerar o arquivo. Tente novamente.'); }
        finally { button.textContent = label; button.disabled = !loaded || loaded.parcial || account !== identity(); }
      }
      period.onchange = setPeriod; start.onchange = end.onchange = () => reset();
      excel.onclick = () => download('excel', excel); pdf.onclick = () => download('pdf', pdf);
      setPeriod(); return { render, reset, load };
    }
  };
})(window);
