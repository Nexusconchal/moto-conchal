(function () {
  'use strict';
  const animations = new WeakMap();
  function age(location) {
    const timestamp = Number(location?.clientTimestamp || location?.serverTimestampMs || 0);
    return timestamp > 0 ? Math.max(0, Date.now() - timestamp) : Infinity;
  }
  function move(marker, point, location) {
    const previous = animations.get(marker);
    const timestamp = Number(location?.clientTimestamp || location?.serverTimestampMs || 0);
    if (previous && timestamp <= previous.timestamp) return;
    if (previous?.frame) cancelAnimationFrame(previous.frame);
    const from = marker.getLatLng();
    const state = { timestamp, frame: null };
    animations.set(marker, state);
    if (!previous || timestamp - previous.timestamp > 30000 || age(location) > 30000 ||
        window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      marker.setLatLng(point);
      return;
    }
    const started = performance.now();
    const duration = Math.min(1800, Math.max(300, timestamp - previous.timestamp));
    function tick(now) {
      if (!marker._map) return;
      const t = Math.min(1, (now - started) / duration);
      marker.setLatLng([from.lat + (point[0] - from.lat) * t, from.lng + (point[1] - from.lng) * t]);
      if (t < 1) state.frame = requestAnimationFrame(tick);
    }
    state.frame = requestAnimationFrame(tick);
  }
  window.MotoTracking = { age, move };
})();
