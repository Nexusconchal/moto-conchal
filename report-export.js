(function (root) {
  'use strict';
  const cash = value => Number(value || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const date = ms => ms ? new Date(ms).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' }) : '';
  const day = ms => new Date(ms).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  const text = value => String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, 10000);
  const scripts = new Map();
  function loadScript(src) {
    if (!scripts.has(src)) scripts.set(src, new Promise((resolve, reject) => {
      const script = document.createElement('script'); script.src = src;
      script.onload = resolve; script.onerror = () => { scripts.delete(src); script.remove(); reject(new Error('Não consegui preparar o arquivo. Tente novamente.')); };
      document.head.append(script);
    }));
    return scripts.get(src);
  }
  const statuses = { pendente: 'Aguardando motoboy', aceita: 'Aceita', retirada: 'Retirada', finalizada: 'Concluída', cancelada: 'Cancelada', expirada: 'Expirada' };
  function summaryRows(d) {
    return [
      ['Empresa', text(d.empresa)], ['Período das chamadas', day(d.sinceMs) + ' a ' + day(d.untilMs)],
      ['Gerado em', date(d.geradoEm)], ['Chamadas', d.totalChamadas], ['Entregas solicitadas', d.totalEntregas],
      ['Chamadas concluídas', d.chamadasConcluidas], ['Entregas concluídas', d.entregasConcluidas],
      ['Chamadas aguardando motoboy', d.chamadasPendentes], ['Chamadas em andamento', d.chamadasEmAndamento],
      ['Chamadas canceladas', d.chamadasCanceladas], ['Chamadas expiradas', d.chamadasExpiradas],
      ['Entregas cobradas (R$)', d.totalGasto], ['Valor reservado (R$)', d.totalReservado],
      ['Motoboys receberam (R$)', d.totalMotoboy], ['MotoJá nas entregas (R$)', d.totalApp],
      ['Ativações de diária (R$)', d.totalDiarias], ['Entregas + ativações (R$)', d.totalDebitado],
      ['Critério', 'Chamadas criadas no período; situação na geração. Ativações de diária separadas por dia.'],
      ['Lotes', 'Uma chamada pode conter várias entregas. Endereços nas notas não possuem distância calculada.']
    ];
  }
  const headers = ['Criada em', 'Código', 'Modalidade', 'Tipo', 'Região / bairro', 'Quantidade', 'Situação', 'Motoboy', 'Aceita em', 'Concluída em', 'Valor combinado (R$)', 'Cobrado (R$)', 'Reservado (R$)', 'Motoboy (R$)', 'MotoJá (R$)', 'Retirada', 'Destino'];
  function destination(row) {
    const extra = (row.pontosExtras || []).length ? row.pontosExtras.map(point => (point.ordem || '') + '. ' + text(point.digitado)).join('\n') : text(row.enderecosExtras);
    return text(row.entrega) + (extra ? '\nPontos extras:\n' + extra : '');
  }
  function detailRows(d) {
    return (d.ultimas || []).map(row => [date(row.criadaEm), text(row.id), text(row.modalidade), text(row.tipoEntrega), text(row.bairroEntrega), row.quantidade,
      statuses[row.status] || text(row.status), text(row.motoboy) || 'Ainda não aceito', date(row.aceitaEm), date(row.finalizadaEm),
      row.valor, row.cobrado, row.reservado, row.valorMotoboy, row.valorApp, text(row.retirada), destination(row)]);
  }
  function assertComplete(d) {
    if (!d?.ok || d.parcial) throw new Error(d?.aviso || 'Carregue um relatório completo antes de baixar.');
  }
  function excelWorkbook(d, XLSX) {
    assertComplete(d);
    const workbook = XLSX.utils.book_new();
    const summary = XLSX.utils.aoa_to_sheet(summaryRows(d));
    const excelDate = ms => ({ t: 'n', v: (ms - 10800000) / 86400000 + 25569, z: 'dd/mm/yyyy hh:mm' });
    if (d.geradoEm) summary.B3 = excelDate(d.geradoEm);
    summary['!cols'] = [{ wch: 33 }, { wch: 100 }];
    [11, 12, 13, 14, 15, 16].forEach(index => { const cell = summary['B' + (index + 1)]; if (cell) cell.z = '"R$" #,##0.00'; });
    const details = XLSX.utils.aoa_to_sheet([headers, ...detailRows(d)]);
    details['!cols'] = [21, 27, 26, 36, 28, 12, 21, 28, 21, 21, 22, 18, 18, 18, 18, 60, 70].map(wch => ({ wch }));
    details['!autofilter'] = { ref: details['!ref'] };
    (d.ultimas || []).forEach((item, index) => { for (const [col, field] of [['A', 'criadaEm'], ['I', 'aceitaEm'], ['J', 'finalizadaEm']]) if (item[field]) details[col + (index + 2)] = excelDate(item[field]); });
    for (let row = 2; row <= (d.ultimas || []).length + 1; row++) for (const col of ['K', 'L', 'M', 'N', 'O']) if (details[col + row]) details[col + row].z = '"R$" #,##0.00';
    const plans = XLSX.utils.aoa_to_sheet([['Dia da ativação', 'Valor da diária (R$)', 'Ativada em'], ...(d.diarias || []).map(plan => [text(plan.dia), plan.valor, date(plan.ativadoEm)])]);
    plans['!cols'] = [{ wch: 20 }, { wch: 24 }, { wch: 24 }];
    (d.diarias || []).forEach((plan, index) => { if (plan.ativadoEm) plans['C' + (index + 2)] = excelDate(plan.ativadoEm); });
    for (let row = 2; row <= (d.diarias || []).length + 1; row++) if (plans['B' + row]) plans['B' + row].z = '"R$" #,##0.00';
    XLSX.utils.book_append_sheet(workbook, summary, 'Resumo'); XLSX.utils.book_append_sheet(workbook, details, 'Chamadas'); XLSX.utils.book_append_sheet(workbook, plans, 'Diárias');
    return workbook;
  }
  async function logoImage() {
    return new Promise(resolve => {
      const image = new Image();
      image.onload = () => {
        try { const canvas = document.createElement('canvas'); canvas.width = 180; canvas.height = 180;
          const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 180, 180); ctx.drawImage(image, 0, 0, 180, 180); resolve(canvas.toDataURL('image/jpeg', .85));
        } catch (_) { resolve(null); }
      };
      image.onerror = () => resolve(null); image.src = './nexus-motoja-icon-192.png';
    });
  }
  function pdfDocument(d, JsPDF, logo) {
    assertComplete(d);
    const pdf = new JsPDF({ unit: 'mm', format: 'a4', compress: true });
    let y = 0;
    const left = 15, width = 180;
    function page() {
      if (y) pdf.addPage();
      pdf.setFillColor(255, 128, 0); pdf.rect(0, 0, 210, 4, 'F');
      if (logo) pdf.addImage(logo, 'JPEG', 170, 9, 24, 24);
      pdf.setTextColor(25, 31, 39); pdf.setFont('helvetica', 'bold'); pdf.setFontSize(17); pdf.text('Nexus MotoJá', left, 17);
      pdf.setFont('helvetica', 'normal'); pdf.setFontSize(10); pdf.text('Relatório da empresa', left, 24);
      pdf.text(pdf.splitTextToSize(text(d.empresa), 145), left, 30);
      pdf.setFontSize(9); pdf.text(day(d.sinceMs) + ' a ' + day(d.untilMs) + ' | Gerado: ' + date(d.geradoEm), left, 40);
      pdf.setDrawColor(215); pdf.line(left, 44, 195, 44); y = 51;
    }
    function line(value, { bold = false, size = 10 } = {}) {
      pdf.setFont('helvetica', bold ? 'bold' : 'normal'); pdf.setFontSize(size);
      const lines = pdf.splitTextToSize(text(value), width);
      for (const part of lines) {
        if (y + 6 > 279) { page(); pdf.setFont('helvetica', bold ? 'bold' : 'normal'); pdf.setFontSize(size); }
        pdf.text(part, left, y); y += size === 9 ? 4.3 : 5.4;
      }
    }
    page(); line('Resumo do período', { bold: true, size: 12 }); y += 2;
    summaryRows(d).slice(3, 17).forEach(([label, value], index) => line(label.replace(' (R$)', '') + ': ' + (index >= 8 ? cash(value) : value)));
    y += 3; line('Chamadas criadas no período; situação na geração. Ativações de diária separadas por dia.', { size: 9 });
    line('Um lote representa uma chamada e pode conter várias entregas.', { size: 9 });
    y += 5; line('Detalhes das chamadas', { bold: true, size: 12 });
    if (!(d.ultimas || []).length) line('Nenhuma chamada neste período.');
    (d.ultimas || []).forEach((row, index) => {
      if (y + 47 > 279) page(); y += 3;
      line((index + 1) + '. ' + text(row.id) + ' | ' + (statuses[row.status] || text(row.status)), { bold: true });
      line(date(row.criadaEm) + ' | ' + text(row.modalidade) + ' | ' + row.quantidade + ' entrega(s)', { size: 9 });
      line('Motoboy: ' + (text(row.motoboy) || 'Ainda não aceito') + (row.aceitaEm ? ' | Aceita: ' + date(row.aceitaEm) : ''), { size: 9 });
      line('Tipo: ' + text(row.tipoEntrega) + ' | Região/bairro: ' + text(row.bairroEntrega), { size: 9 });
      line('Combinado: ' + cash(row.valor) + ' | Cobrado: ' + cash(row.cobrado) + ' | Reservado: ' + cash(row.reservado), { size: 9 });
      line('Motoboy: ' + cash(row.valorMotoboy) + ' | MotoJá: ' + cash(row.valorApp) + (row.finalizadaEm ? ' | Concluída: ' + date(row.finalizadaEm) : ''), { size: 9 });
      line('Retirada: ' + text(row.retirada), { size: 9 }); line('Destino: ' + destination(row), { size: 9 });
      y += 2; pdf.setDrawColor(230); pdf.line(left, y, 195, y); y += 4;
    });
    if ((d.diarias || []).length) {
      y += 4; line('Ativações do plano diário', { bold: true, size: 12 });
      d.diarias.forEach(plan => line(text(plan.dia) + ' | ' + cash(plan.valor) + ' | ' + date(plan.ativadoEm)));
    }
    const pages = pdf.getNumberOfPages();
    for (let index = 1; index <= pages; index++) { pdf.setPage(index); pdf.setFontSize(8); pdf.setTextColor(100); pdf.text('MotoJá | Uso interno da empresa', left, 290); pdf.text(index + ' / ' + pages, 195, 290, { align: 'right' }); }
    return pdf;
  }
  const filename = d => 'motoja-relatorio-' + new Date(d.sinceMs - 10800000).toISOString().slice(0, 10) + '-a-' + new Date(d.untilMs - 10800000).toISOString().slice(0, 10);
  root.MotojaReportExport = {
    summaryRows, detailRows, excelWorkbook, pdfDocument,
    async excel(d) { assertComplete(d); await loadScript('./vendor/xlsx-0.20.3.min.js'); root.XLSX.writeFileXLSX(excelWorkbook(d, root.XLSX), filename(d) + '.xlsx'); },
    async pdf(d) { assertComplete(d); await loadScript('./vendor/jspdf-4.2.1.min.js'); const logo = await logoImage(); pdfDocument(d, root.jspdf.jsPDF, logo).save(filename(d) + '.pdf'); }
  };
})(typeof window === 'undefined' ? globalThis : window);
