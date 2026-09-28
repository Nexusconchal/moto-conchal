export function distanceMeters(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b.latitude - a.latitude) * rad;
  const dLon = (b.longitude - a.longitude) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.latitude * rad) * Math.cos(b.latitude * rad) * Math.sin(dLon / 2) ** 2;
  return 12742000 * Math.asin(Math.sqrt(Math.min(1, h)));
}

export function validateLocation(body, previous = null, now = Date.now()) {
  const numeric = (value) => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
  if (!numeric(body.latitude) || !numeric(body.longitude) || Math.abs(Number(body.latitude)) > 90 || Math.abs(Number(body.longitude)) > 180) {
    return { error: 'coordenadas_invalidas' };
  }
  const timestamp = Number(body.timestamp);
  if (!numeric(body.timestamp) || now - timestamp > 30000 || timestamp - now > 10000) return { error: 'localizacao_fora_do_tempo' };
  if (!numeric(body.accuracy) || Number(body.accuracy) < 0 || Number(body.accuracy) > 100) return { error: 'gps_impreciso' };
  const location = {
    latitude: Number(body.latitude), longitude: Number(body.longitude), accuracy: Number(body.accuracy),
    heading: numeric(body.heading) && Number(body.heading) >= 0 && Number(body.heading) < 360 ? Number(body.heading) : null,
    speed: numeric(body.speed) && Number(body.speed) >= 0 && Number(body.speed) <= 70 ? Number(body.speed) : null,
    clientTimestamp: timestamp, serverTimestampMs: now
  };
  if (previous) {
    if (timestamp <= Number(previous.clientTimestamp || 0)) return { ignored: 'posicao_antiga' };
    const elapsed = timestamp - Number(previous.clientTimestamp || 0);
    if (elapsed > 0 && elapsed < 120000) {
      const tolerance = location.accuracy + Number(previous.accuracy || 0) + 30;
      if (distanceMeters(previous, location) > 60 * elapsed / 1000 + tolerance) return { error: 'salto_gps_invalido' };
    }
    if (now - Number(previous.serverTimestampMs || 0) < 5000) return { ignored: 'intervalo_minimo' };
  }
  return { location };
}
