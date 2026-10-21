// Alerta insistente das chamadas: depois do primeiro push, o servidor repete o
// aviso (mesma notificacao, que toca e vibra de novo no celular) enquanto a
// chamada continuar pendente. Para quando alguem aceita, quando ela sai de
// pendente ou depois de maxRepeats repeticoes.
export function createOfferAlerts({
  intervalMs = 20000,
  maxRepeats = 8,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  loadPending,
  send,
  onError = (error) => console.error('offer alert failed', error)
} = {}) {
  const active = new Map();

  function stop(kind, id) {
    const key = `${kind}:${id}`;
    const current = active.get(key);
    if (!current) return;
    clearTimer(current.timer);
    active.delete(key);
  }

  function start(kind, id) {
    const key = `${kind}:${id}`;
    stop(kind, id);
    const current = { count: 0, timer: null };
    const tick = async () => {
      if (active.get(key) !== current) return;
      current.count += 1;
      try {
        const job = await loadPending(kind, id);
        if (!job) {
          stop(kind, id);
          return;
        }
        await send(kind, id, job, current.count);
      } catch (error) {
        onError(error);
      }
      if (active.get(key) !== current) return;
      if (current.count >= maxRepeats) {
        stop(kind, id);
        return;
      }
      current.timer = setTimer(tick, intervalMs);
    };
    active.set(key, current);
    current.timer = setTimer(tick, intervalMs);
  }

  return {
    start,
    stop,
    size: () => active.size
  };
}
