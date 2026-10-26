import crypto from 'node:crypto';

// Pedido de corrida pelo WhatsApp da empresa, por etapas: nome, saida, destino e confirmacao.
// A corrida e criada pelo servidor com as mesmas regras do app (rota e preco calculados la,
// enderecos conferidos, protecao contra pedido repetido). Esta conversa so coleta os dados,
// mostra o resumo e so pede a corrida depois de um SIM.
//
// Seguranca:
// - so numero de telefone real (nunca um LID do WhatsApp sem numero);
// - uma corrida aberta por numero e limite diario de pedidos e por hora de cotacoes;
// - enderecos e nome guardados criptografados; a conversa parada vence em 30 minutos;
// - pode ser desligado: configuracoes/atendimentoAutomatico.pedidoWhatsapp = false.

const hash = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const plain = value => String(value || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

export const BOOKING_IDLE_MS = 30 * 60000;
export const QUOTE_TTL_MS = 10 * 60000;
export const AFTER_RIDE_MS = 3 * 60 * 60000;
export const MAX_RIDES_PER_DAY = 4;
export const MAX_QUOTES_PER_HOUR = 12;
export const MAX_LOOKUPS_PER_HOUR = 30;

export const BOOKING_CITIES = [
  { key: 'conchal', name: 'Conchal' },
  { key: 'aguai', name: 'Aguaí' },
  { key: 'engenheiro_coelho', name: 'Engenheiro Coelho' }
];
const COLLECTING = ['nome', 'origem', 'cidade_origem', 'destino', 'cidade_destino', 'confirmar'];

export function bookingReply(text) {
  const t = plain(text).replace(/[!.?,]+$/g, '').replace(/\s+/g, ' ');
  if (/^(cancelar|cancela|cancele|cancel|desisto|desistir|nao quero mais|esquece)( (a |o )?(corrida|pedido))?$/.test(t)) return 'cancel';
  if (/^(sim|s|ss|sim sim|ok|okay|confirmo|confirmar|confirma|pode|pode sim|pode chamar|pode mandar|isso|isso mesmo|certo|correto|claro|bora|manda|chama|fechado|beleza|blz|positivo)( por favor| pfv| pf)?$/.test(t)) return 'yes';
  if (/^(nao|n|nn|errado|ta errado|esta errado|corrigir|refazer|mudar|trocar)\b/.test(t)) return 'no';
  if (/^(de novo|denovo|novamente|tentar de novo|tenta de novo|pedir de novo|chamar de novo|outra vez)$/.test(t)) return 'again';
  return '';
}

// "Rafael", "maria da silva": letras, de 2 a 60 caracteres, sem numero.
export function validName(text) {
  const name = String(text || '').replace(/\s+/g, ' ').trim();
  if (bookingReply(name)) return '';
  if (name.length < 2 || name.length > 60 || /\d/.test(name) || !/^[\p{L}][\p{L}' .-]*$/u.test(name) || name.split(' ').length > 6) return '';
  return name.split(' ')
    .map(part => (part ? part[0].toUpperCase() + part.slice(1).toLowerCase() : part))
    .join(' ')
    .replace(/ (Da|De|Do|Das|Dos|E) /g, word => word.toLowerCase());
}

export function cityChoice(text) {
  const t = plain(text).replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (t === '1' || /\bconchal\b/.test(t)) return 'conchal';
  if (t === '2' || /\baguai\b/.test(t)) return 'aguai';
  if (t === '3' || /\b(engenheiro coelho|eng coelho|coelho)\b/.test(t)) return 'engenheiro_coelho';
  return '';
}

const money = value => Number(value || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const distance = value => `${Number(value || 0).toFixed(1).replace('.', ',')} km`;
const firstName = name => String(name || '').split(' ')[0];
const cityName = key => BOOKING_CITIES.find(item => item.key === key)?.name || '';
const CITY_QUESTION = 'Em qual cidade fica esse endereço?\n1 • Conchal\n2 • Aguaí\n3 • Engenheiro Coelho';
const ORIGIN_QUESTION = '📍 Onde você está?\nMande sua *localização* (toque no 📎 e escolha Localização) ou escreva *rua, número e bairro*.';
const DESTINATION_QUESTION = '🏁 Para onde você vai?\nEscreva *rua, número e bairro* (e a cidade, se for fora). Também pode mandar a localização do destino.';
const HELP = '\n\nPara desistir, responda CANCELAR. Para falar com uma pessoa, ATENDENTE.';

export function bookingSummary(state) {
  const quote = state.cotacao;
  const period = quote.periodo === 'noite' ? ' (tarifa da noite)' : quote.periodo === 'madrugada' ? ' (tarifa da madrugada)' : '';
  return `Confere o seu pedido, ${firstName(state.nome)}:\n\n📍 Saída: ${state.origem.encontrado}\n🏁 Destino: ${state.destino.encontrado}\n📏 ${distance(quote.km)} · 💰 ${money(quote.valor)}${period}\n💳 O link de pagamento chega aqui depois que um motoboy aceitar.\n\nResponda *SIM* para chamar o motoboy ou *NÃO* para corrigir.`;
}

// Escolha de uma sugestao ("2") mantem o numero da casa que o cliente tinha escrito.
export function suggestionText(suggestion, typed) {
  const [street, bairro] = String(suggestion).split(' - ');
  const number = String(typed || '').replace(/^[^,\d]*/, '').match(/\b(\d{1,5}[a-z]?)\b/i)?.[1] || '';
  return [street, number, bairro].filter(Boolean).join(', ');
}

export function createWhatsappBooking({ db, encrypt, decrypt, now = () => Date.now(), rideExpireMs = 10 * 60000,
  lookupCustomer, resolvePlace, quote, createRide, findOpenRide, cancelRide, renewRide, registrationBlock = async () => '' }) {
  const stateRef = phone => db.collection('whatsappPedidos').doc(hash(phone));
  const seal = value => (value ? encrypt(JSON.stringify(value)) : '');
  const open = value => {
    if (!value) return null;
    try { return JSON.parse(decrypt(value)); } catch { return null; }
  };

  async function load(phone) {
    const data = (await stateRef(phone).get()).data() || {};
    return {
      etapa: data.etapa || '',
      rideId: data.rideId || '',
      cotacao: data.cotacao || null,
      cotacoesHora: data.cotacoesHora || null,
      buscasHora: data.buscasHora || null,
      pedidosDia: data.pedidosDia || null,
      atualizadoEmMs: Number(data.atualizadoEmMs || 0),
      nome: open(data.nomeCriptografado) || '',
      origem: open(data.origemCriptografada),
      destino: open(data.destinoCriptografado),
      pendente: open(data.pendenteCriptografado),
      sugestoes: open(data.sugestoesCriptografadas) || []
    };
  }

  async function save(phone, state) {
    const t = now();
    await stateRef(phone).set({
      etapa: state.etapa || '',
      nomeCriptografado: seal(state.nome),
      origemCriptografada: seal(state.origem),
      destinoCriptografado: seal(state.destino),
      pendenteCriptografado: seal(state.pendente),
      sugestoesCriptografadas: seal(state.sugestoes?.length ? state.sugestoes : null),
      cotacao: state.cotacao || null,
      rideId: state.rideId || '',
      cotacoesHora: state.cotacoesHora || null,
      buscasHora: state.buscasHora || null,
      pedidosDia: state.pedidosDia || null,
      atualizadoEmMs: t,
      expiresAt: new Date(t + 7 * 86400000)
    });
  }

  // Encerra a conversa do pedido; guarda so o nome (para o proximo pedido) e os limites de uso.
  const clear = (phone, state) => save(phone, { nome: state.nome, pedidosDia: state.pedidosDia, cotacoesHora: state.cotacoesHora, buscasHora: state.buscasHora });

  // Cada busca de endereco consulta o mapa: limite por hora para ninguem esgotar a cota.
  async function lookup(phone, state, args) {
    state.buscasHora = window(state.buscasHora, 3600000);
    if (state.buscasHora.n >= MAX_LOOKUPS_PER_HOUR) return { ok: false, motivo: 'limite' };
    state.buscasHora.n += 1;
    return resolvePlace(args);
  }

  function window(counter, windowMs) {
    const start = Number(counter?.inicioMs || 0);
    return now() - start < windowMs ? { inicioMs: start, n: Number(counter.n || 0) } : { inicioMs: now(), n: 0 };
  }

  function placeProblem(result, role) {
    if (result?.motivo === 'limite') return 'Muitas buscas de endereço nesta última hora. Tente de novo mais tarde, peça pelo app ou escreva ATENDENTE.';
    if (result?.motivo === 'fora_da_area') return 'Por enquanto buscamos passageiros em Conchal, Aguaí e Engenheiro Coelho. Mande um endereço de saída numa dessas cidades ou a sua localização.';
    const suggestions = (result?.sugestoes || []).slice(0, 3);
    if (suggestions.length) return `Não achei exatamente esse endereço 😕 Será algum destes?\n${suggestions.map((item, index) => `${index + 1} • ${item}`).join('\n')}\n\nResponda com o número, ou escreva o endereço de novo com *rua, número e bairro*.`;
    return role === 'origem'
      ? 'Não encontrei esse endereço de saída no mapa 😕\nEscreva de novo com *rua, número e bairro*, ou mande a sua 📍 localização.'
      : 'Não encontrei esse destino no mapa 😕\nEscreva de novo com *rua, número e bairro* (e a cidade, se for fora).';
  }

  async function ask(phone, state, etapa, prefix = '') {
    state.etapa = etapa;
    await save(phone, state);
    if (etapa === 'nome') return { text: `${prefix}Qual é o seu nome?${HELP}` };
    if (etapa === 'origem') return { text: `${prefix}${ORIGIN_QUESTION}${HELP}` };
    return { text: `${prefix}${DESTINATION_QUESTION}${HELP}` };
  }

  // Proxima pergunta depois de guardar nome ou saida.
  function next(phone, state, prefix = '') {
    if (!state.nome) return ask(phone, state, 'nome', prefix);
    if (!state.origem) return ask(phone, state, 'origem', prefix);
    return ask(phone, state, 'destino', `${prefix}Saída: ${state.origem.encontrado}\n\n`);
  }

  // Cotacao com limite por hora: cada cotacao consulta rota e mapa.
  async function quoteAndConfirm(phone, state) {
    state.cotacoesHora = window(state.cotacoesHora, 3600000);
    if (state.cotacoesHora.n >= MAX_QUOTES_PER_HOUR) {
      await clear(phone, state);
      return { failed: true, text: 'Muitas tentativas de pedido nesta última hora. Tente de novo mais tarde, peça pelo app ou escreva ATENDENTE.' };
    }
    state.cotacoesHora.n += 1;
    let result;
    try {
      result = await quote(state.origem, state.destino);
    } catch (error) {
      state.destino = null;
      const asked = await ask(phone, state, 'destino', `${error?.publicMessage || 'Não consegui calcular essa rota agora.'}\n\n`);
      return { failed: true, text: asked.text };
    }
    state.cotacao = { km: result.km, valor: result.valor, periodo: result.periodo, cidade: result.cidade, emMs: now(), id: crypto.randomBytes(6).toString('hex') };
    state.etapa = 'confirmar';
    await save(phone, state);
    return { text: bookingSummary(state) };
  }

  function openRideText(ride) {
    if (ride.status === 'pendente') return 'Sua corrida ainda está chamando os motoboys. Assim que um aceitar, te aviso aqui. Para cancelar, responda CANCELAR.';
    return `Sua corrida já foi aceita${ride.motoboy ? ` pelo motoboy ${ride.motoboy}` : ''}. Acompanhe pelo link que te mandei aqui. Se precisar de ajuda, escreva ATENDENTE.`;
  }

  async function confirm(phone, state) {
    const block = await registrationBlock(phone);
    if (block) { await clear(phone, state); return { text: block }; }
    const openRide = await findOpenRide(phone);
    if (openRide) {
      await save(phone, { ...state, etapa: 'enviado', rideId: openRide.id });
      return { text: openRideText(openRide) };
    }
    state.pedidosDia = window(state.pedidosDia, 86400000);
    if (state.pedidosDia.n >= MAX_RIDES_PER_DAY) {
      await clear(phone, state);
      return { text: 'Você já fez vários pedidos por aqui hoje. Para pedir de novo, use o app ou escreva ATENDENTE.' };
    }
    // Cotacao velha (ou o horario mudou de faixa): calcula de novo e pede outro SIM se mudou.
    if (now() - Number(state.cotacao?.emMs || 0) > QUOTE_TTL_MS) {
      const previous = state.cotacao?.valor;
      const fresh = await quoteAndConfirm(phone, state);
      if (fresh.failed) return fresh;
      if (state.cotacao.valor !== previous) return { text: `O valor foi atualizado.\n\n${fresh.text}` };
    }
    let created;
    try {
      created = await createRide({ phone, nome: state.nome, origem: state.origem, destino: state.destino, cotacao: state.cotacao, requestId: `wa-${hash(`${phone}:${state.cotacao.id}`).slice(0, 40)}` });
    } catch (error) {
      if (error?.code === 'valor_nao_confere_com_tabela') {
        const fresh = await quoteAndConfirm(phone, state);
        return fresh.failed ? fresh : { text: `O valor foi atualizado.\n\n${fresh.text}` };
      }
      if (Number(error?.status) !== 400) throw error;
      state.origem = null; state.destino = null; state.cotacao = null;
      return ask(phone, state, 'origem', 'O mapa não confirmou um dos endereços, então não chamei o motoboy. Vamos de novo, com rua, número e bairro.\n\n');
    }
    state.pedidosDia.n += 1;
    await save(phone, { ...state, etapa: 'enviado', rideId: created.rideId });
    if (created.duplicated) return { text: 'Esse pedido já está chamando os motoboys. Assim que um aceitar, te aviso aqui.' };
    return { text: `✅ Pedido enviado, ${firstName(state.nome)}! Estou chamando os motoboys de ${cityName(state.cotacao.cidade) || 'sua cidade'}.\n\nAssim que um aceitar, te mando aqui o nome dele, o link para acompanhar no mapa e o pagamento. Se ninguém aceitar em ${Math.round(rideExpireMs / 60000)} minutos, te aviso.\n\nPara cancelar antes do aceite, responda CANCELAR.` };
  }

  // Resultado da busca de um endereco (ou localizacao) para a saida ou o destino.
  async function applyPlace(phone, state, role, result, typed) {
    if (result?.pedirCidade) {
      state.pendente = { texto: typed };
      state.sugestoes = [];
      state.etapa = role === 'origem' ? 'cidade_origem' : 'cidade_destino';
      await save(phone, state);
      return { text: CITY_QUESTION };
    }
    if (!result?.ok) {
      state.pendente = { texto: typed };
      state.sugestoes = (result?.sugestoes || []).slice(0, 3);
      state.etapa = role;
      await save(phone, state);
      return { text: `${placeProblem(result, role)}${HELP}` };
    }
    state.pendente = null;
    state.sugestoes = [];
    state[role] = result.lugar;
    if (role === 'origem') return next(phone, state, 'Anotado! ');
    return quoteAndConfirm(phone, state);
  }

  async function takePlace(phone, state, event, role) {
    let typed = String(event.text || '').trim();
    const picked = /^[1-3]$/.test(typed) && state.sugestoes?.[Number(typed) - 1];
    if (picked) typed = suggestionText(picked, state.pendente?.texto);
    if (!event.location && typed.length < 4) return ask(phone, state, role);
    const city = role === 'origem' ? '' : state.origem?.cidade || '';
    const result = await lookup(phone, state, { text: event.location ? '' : typed, location: event.location || null, city, role });
    return applyPlace(phone, state, role, result, typed);
  }

  async function start(phone, event) {
    const block = await registrationBlock(phone);
    if (block) return { text: block };
    const previous = await load(phone);
    const openRide = await findOpenRide(phone);
    if (openRide) {
      await save(phone, { ...previous, etapa: 'enviado', rideId: openRide.id });
      return { text: openRideText(openRide) };
    }
    const customer = await lookupCustomer(phone).catch(() => null);
    const state = { nome: validName(customer?.nome) || previous.nome, pedidosDia: previous.pedidosDia, cotacoesHora: previous.cotacoesHora, buscasHora: previous.buscasHora };
    const greeting = state.nome ? `Oi, ${firstName(state.nome)}! Vamos pedir a sua moto 🏍️\n\n` : 'Vamos pedir a sua moto! 🏍️\n\n';
    if (event.location) {
      const result = await lookup(phone, state, { text: '', location: event.location, city: '', role: 'origem' });
      if (!result?.ok) { state.etapa = 'origem'; await save(phone, state); return { text: `${placeProblem(result, 'origem')}${HELP}` }; }
      state.origem = result.lugar;
      return next(phone, state, `${greeting}Recebi sua localização. `);
    }
    return next(phone, state, greeting);
  }

  // Devolve { text } quando a conversa e do pedido; null deixa o atendimento normal responder.
  async function handle(event, intent) {
    const phone = event.phone;
    if (!phone || event.fromMe) return null;
    const reply = bookingReply(event.text);
    const state = await load(phone);
    const idle = now() - state.atualizadoEmMs;
    const collecting = COLLECTING.includes(state.etapa) && idle < BOOKING_IDLE_MS;

    if (collecting) {
      if (intent === 'human' || intent === 'menu') { await clear(phone, state); return null; }
      if (reply === 'cancel') { await clear(phone, state); return { text: 'Tudo bem, cancelei este pedido. Quando precisar, é só mandar *1* ou "quero uma moto".' }; }
      // Localizacao vale como saida (ou destino, se a saida ja foi informada).
      if (event.location && state.etapa !== 'confirmar') {
        const role = state.origem && ['destino', 'cidade_destino'].includes(state.etapa) ? 'destino' : 'origem';
        const result = await lookup(phone, state, { text: '', location: event.location, city: role === 'destino' ? state.origem.cidade : '', role });
        return applyPlace(phone, state, role, result, '');
      }
      if (state.etapa === 'nome') {
        const name = intent === 'other' ? validName(event.text) : '';
        if (!name) return { text: `Me diga só o seu nome, por favor 🙂${HELP}` };
        state.nome = name;
        return next(phone, state, `Prazer, ${firstName(name)}! `);
      }
      if (state.etapa === 'cidade_origem' || state.etapa === 'cidade_destino') {
        const city = cityChoice(event.text);
        if (!city) return { text: CITY_QUESTION };
        const role = state.etapa === 'cidade_origem' ? 'origem' : 'destino';
        const typed = state.pendente?.texto || '';
        const result = await lookup(phone, state, { text: typed, location: null, city, role });
        // A cidade ja foi escolhida: sem endereco, volta a pedir o endereco (nao a cidade de novo).
        return applyPlace(phone, state, role, result?.pedirCidade ? { ok: false } : result, typed);
      }
      if (state.etapa === 'origem') return takePlace(phone, state, event, 'origem');
      if (state.etapa === 'destino') return takePlace(phone, state, event, 'destino');
      if (state.etapa === 'confirmar') {
        if (reply === 'yes') return confirm(phone, state);
        if (reply === 'no') {
          state.origem = null; state.destino = null; state.cotacao = null;
          return ask(phone, state, 'origem', 'Sem problemas, vamos corrigir.\n\n');
        }
        return { text: `Responda *SIM* para chamar o motoboy ou *NÃO* para corrigir.${HELP}` };
      }
    }

    const recentRide = state.rideId && idle < AFTER_RIDE_MS && ['enviado', 'expirado'].includes(state.etapa);
    const callAgain = reply === 'again' || /^(sim|s|pode|pode chamar|chama|chamar|quero|quero sim)$/.test(plain(event.text).replace(/[!.]+$/g, ''));
    if (recentRide && state.etapa === 'expirado' && callAgain) {
      const renewed = await renewRide(phone, state.rideId);
      if (renewed === 'renovada') {
        await save(phone, { ...state, etapa: 'enviado' });
        return { text: 'Pronto, chamei os motoboys de novo! Te aviso aqui assim que um aceitar. Para cancelar, responda CANCELAR.' };
      }
      await clear(phone, state);
      return start(phone, event);
    }
    if (recentRide && reply === 'cancel') {
      const result = await cancelRide(phone, state.rideId);
      if (result.status === 'cancelada') { await clear(phone, state); return { text: 'Pronto, cancelei a sua corrida. Quando precisar, é só mandar *1* aqui.' }; }
      if (result.status === 'aceita') return { text: `${result.motoboy ? `O motoboy ${result.motoboy}` : 'O motoboy'} já aceitou e está a caminho, então não consigo cancelar por aqui. Fale com ele pelo link de acompanhamento que te mandei, ou escreva ATENDENTE.` };
      await clear(phone, state);
      return { text: 'Essa corrida já foi encerrada. Para pedir outra, é só mandar *1*.' };
    }

    if (intent === 'request' || event.location) return start(phone, event);
    return null;
  }

  // Avisos da corrida pedida pelo WhatsApp: motoboy chegou, ninguem aceitou e corrida finalizada.
  // (O aceite ja manda o nome do motoboy, o link e o pagamento.) Cada aviso sai uma vez so.
  async function tick({ sendText }) {
    const snap = await db.collection('corridas').where('whatsappAcompanhar', '==', true).limit(50).get();
    for (const doc of snap.docs) {
      const ride = doc.data() || {};
      const digits = String(ride.telefoneCliente || '').replace(/\D/g, '');
      const phone = digits.length === 10 || digits.length === 11 ? `55${digits}` : '';
      const notice = ride.status === 'aceita' && ride.motoboyChegouEm && !ride.whatsappAvisoChegadaEm ? 'chegada'
        : ride.status === 'expirada' && !ride.whatsappAvisoExpiradaEm ? 'expirada'
        : ride.status === 'finalizada' && !ride.whatsappAvisoFimEm ? 'fim' : '';
      const over = ['finalizada', 'cancelada', 'finalizada_por_inatividade'].includes(ride.status)
        || (ride.status === 'expirada' && ride.whatsappAvisoExpiradaEm && now() - Number(ride.whatsappAvisoExpiradaEm) > AFTER_RIDE_MS);
      if (!notice || !phone) {
        if (over || !phone) await doc.ref.set({ whatsappAcompanhar: false }, { merge: true });
        continue;
      }
      const field = { chegada: 'whatsappAvisoChegadaEm', expirada: 'whatsappAvisoExpiradaEm', fim: 'whatsappAvisoFimEm' }[notice];
      let claimed = false;
      await db.runTransaction(async tx => {
        claimed = false;
        const fresh = (await tx.get(doc.ref)).data() || {};
        if (fresh[field] || fresh.status !== ride.status) return;
        tx.set(doc.ref, { [field]: now(), ...(notice === 'fim' ? { whatsappAcompanhar: false } : {}) }, { merge: true });
        claimed = true;
      });
      if (!claimed) continue;
      if (notice === 'expirada') {
        const state = await load(phone);
        const collecting = COLLECTING.includes(state.etapa) && now() - state.atualizadoEmMs < BOOKING_IDLE_MS;
        if (collecting || (state.rideId && state.rideId !== doc.id)) continue;
        await save(phone, { ...state, etapa: 'expirado', rideId: doc.id });
      }
      const text = notice === 'chegada'
        ? `🏍️ ${ride.motoboy ? `O motoboy ${ride.motoboy}` : 'O motoboy'} chegou ao local de embarque! Ele está te esperando.`
        : notice === 'expirada'
          ? '😕 Nenhum motoboy aceitou a sua corrida a tempo.\n\nQuer tentar de novo? Responda *SIM* para chamar os motoboys outra vez, ou CANCELAR para encerrar.'
          : '✅ Corrida finalizada. Obrigado por andar com a Nexus MotoJá! Quando precisar, é só mandar *1* aqui.';
      await sendText(phone, text).catch(() => ({ sent: false }));
    }
  }

  return { handle, tick };
}
