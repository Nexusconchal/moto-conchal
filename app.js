const NUMERO_WHATSAPP_EMPRESA = "5519992306488";

const MENSAGEM_PADRAO = 
  "Olá! Agradecemos seu contato! \uD83C\uDFCD\uFE0F\n" +
  "Como podemos te ajudar hoje?\n\n" +
  "Para solicitar uma corrida, preencha:\n" +
  "\uD83D\uDC64 *Nome:* \n" +
  "\uD83D\uDCCD *Endereço de onde você está:* \n" +
  "\uD83C\uDFAF *Endereço de destino:* \n\n" +
  "Qualquer problema, entre em contato por aqui mesmo que o suporte vai te ajudar!";

document.getElementById("btn-pedir").addEventListener("click", () => {
  const texto = encodeURIComponent(MENSAGEM_PADRAO);
  const link = `https://wa.me/${NUMERO_WHATSAPP_EMPRESA}?text=${texto}`;
  window.open(link, "_blank");
});
