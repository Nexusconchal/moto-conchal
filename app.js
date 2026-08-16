const NUMERO_WHATSAPP_EMPRESA = "5519992306488";

const MENSAGEM_PADRAO =
  "Olá! Agradecemos seu contato! 🏍️\n" +
  "Como podemos te ajudar hoje?\n\n" +
  "Para solicitar uma corrida, preencha:\n" +
  "👤 *Nome:* \n" +
  "📍 *Endereço de onde você está:* \n" +
  "🎯 *Endereço de destino:* \n\n" +
  "Qualquer problema, entre em contato por aqui mesmo que o suporte vai te ajudar!";

document.getElementById("btn-pedir").addEventListener("click", function () {

    const texto = encodeURIComponent(MENSAGEM_PADRAO);

    console.log(MENSAGEM_PADRAO);
    console.log(texto);

    const link = "https://wa.me/" + NUMERO_WHATSAPP_EMPRESA + "?text=" + texto;

    window.open(link, "_blank");
});
