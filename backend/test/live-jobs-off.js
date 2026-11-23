// Espelho ao vivo desligado nos testes: as rotas consultam o banco falso, como antes.
export const liveJobs = { ready: () => false, docs: () => [], doc: () => null, noteWrite() {}, stats: () => ({}) };
export async function activeJobsSnapshot(_name, filter, fallback) {
  const docs = (await fallback()).docs.filter((doc) => !filter || filter(doc.data() || {}, doc));
  return { docs, size: docs.length, empty: docs.length === 0, forEach: (fn) => docs.forEach(fn) };
}
