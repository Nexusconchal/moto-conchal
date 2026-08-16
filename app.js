const NUMERO_WHATSAPP_EMPRESA = "5519992306488";

const MENSAGEM_PADRAO =
  "Olá! Agradecemos seu contato! \u{1F3CD}\uFE0F\n" +
  "Como podemos te ajudar hoje?\n\n" +
  "Para solicitar uma corrida, preencha:\n" +
  "\u{1F464} *Nome:* \n" +
  "\u{1F4CD} *Endereço de onde você está:* \n" +
  "\u{1F3AF} *Endereço de destino:* \n\n" +
  "Qualquer problema, entre em contato por aqui mesmo que o suporte vai te ajudar!";

document.getElementById("btn-pedir").addEventListener("click", () => {
  const texto = encodeURIComponent(MENSAGEM_PADRAO);
  const link = `https://wa.me/${NUMERO_WHATSAPP_EMPRESA}?text=${texto}`;

  window.open(link, "_blank");
});
