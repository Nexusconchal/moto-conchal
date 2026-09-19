const ids = ['backendUrl', 'companyId', 'captureKey', 'watchFolder'];
const statusBox = document.getElementById('status');
function status(value) { statusBox.textContent = value.message; statusBox.style.color = value.ok ? '#bfffd2' : '#ffb1b1'; }
window.nexus.getConfig().then((config) => {
  ids.forEach((id) => { document.getElementById(id).value = config[id] || ''; });
  document.getElementById('autoStart').checked = !!config.autoStart;
});
window.nexus.onStatus(status);
document.getElementById('choose').onclick = async () => {
  const folder = await window.nexus.chooseFolder();
  if (folder) document.getElementById('watchFolder').value = folder;
};
document.getElementById('save').onclick = async () => {
  try {
    const config = Object.fromEntries(ids.map((id) => [id, document.getElementById(id).value.trim()]));
    config.autoStart = document.getElementById('autoStart').checked;
    await window.nexus.saveConfig(config);
    status({ ok: true, message: 'Configuracao salva. Leitor em funcionamento.' });
  } catch (error) { status({ ok: false, message: error.message }); }
};
document.getElementById('stop').onclick = async () => { await window.nexus.stop(); status({ ok: true, message: 'Leitura pausada.' }); };
