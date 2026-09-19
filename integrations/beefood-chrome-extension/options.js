const ids = ['backendUrl', 'companyId', 'captureKey'];
chrome.storage.sync.get(ids).then((saved) => ids.forEach((id) => {
  if (saved[id]) document.getElementById(id).value = saved[id];
}));
document.querySelector('form').onsubmit = async (event) => {
  event.preventDefault();
  const data = Object.fromEntries(ids.map((id) => [id, document.getElementById(id).value.trim()]));
  data.companyId = data.companyId.replace(/\D/g, '');
  await chrome.storage.sync.set(data);
  document.getElementById('status').textContent = 'Configuracao salva.';
};
