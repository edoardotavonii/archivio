/* ================= il modello delle mani, in un filo a parte =================
   MediaPipe HandLandmarker impiega ~17 ms per fotogramma: sul filo
   principale si mangiava un fotogramma su due della nuvola e il sito
   scattava. Qui gira da solo; la pagina gli manda i fotogrammi della
   camera (ImageBitmap, trasferiti senza copia) e riceve indietro solo
   i 21 punti di ogni mano. Nessuna immagine esce da qui.

   Worker "classico", non modulo: il caricatore di MediaPipe usa
   importScripts, che nei worker modulo non esiste. La libreria (che è
   un modulo) entra comunque con import() dinamico.

   Messaggi
     dalla pagina:  { tipo:'carica', base, modello }
                    { tipo:'analizza', fotogramma, t }
     alla pagina:   { tipo:'progresso', ricevuti, totale }   (mentre scarica il modello; si può ignorare)
                    { tipo:'pronto', delegato }
                    { tipo:'mani', landmarks, t }
                    { tipo:'errore', messaggio }
   ========================================================================= */

let mano = null;

/* il file del modello (7,8 MB) Google lo serve con una cache HTTP di un'ora: chi tornava
   lo riscaricava ogni volta (vedi ricerca/benchmark-ingresso). Qui lo si tiene nella
   Cache Storage del browser, con l'indirizzo come chiave: cambia versione, cambia chiave.
   Se la cache non c'è o è piena, si torna a far scaricare il file a MediaPipe. */
async function leggiModello(url){
  if (!self.caches) return null;
  try {
    const cache = await caches.open('mani-modello');
    const salvato = await cache.match(url);
    if (salvato) return new Uint8Array(await salvato.arrayBuffer());
    const r = await fetch(url);
    if (!r.ok) return null;
    /* letto a pezzi, per dire alla pagina quanto manca (l'entrata del sito mostra la percentuale) */
    const totale = Number(r.headers.get('content-length')) || 0;
    const pezzi = []; let ricevuti = 0;
    if (r.body && r.body.getReader){
      const lettore = r.body.getReader();
      for (;;){
        const { done, value } = await lettore.read();
        if (done) break;
        pezzi.push(value); ricevuti += value.length;
        self.postMessage({ tipo: 'progresso', ricevuti, totale });
      }
    } else {
      const tutto = new Uint8Array(await r.arrayBuffer());
      pezzi.push(tutto); ricevuti = tutto.length;
    }
    const byte = new Uint8Array(ricevuti);
    let at = 0; for (const p of pezzi){ byte.set(p, at); at += p.length; }
    try { await cache.put(url, new Response(byte.slice(), { headers: { 'content-type': 'application/octet-stream' } })); } catch (err){ /* cache piena: va bene lo stesso */ }
    return byte;
  } catch (err){
    return null;
  }
}

async function carica(base, modello, soglie){
  const mod = await import(base + '/vision_bundle.mjs');
  const [fileset, byte] = await Promise.all([mod.FilesetResolver.forVisionTasks(base + '/wasm'), leggiModello(modello)]);
  /* soglie facoltative (le passa lavori-prototipo.html); senza, quelle di sempre del sito */
  const s = Object.assign({ rilevamento: 0.6, presenza: 0.5, tracciamento: 0.5 }, soglie || {});
  const opzioni = delegate => ({
    /* una copia dei byte per ogni tentativo: se la GPU fallisce, la CPU riparte da byte intatti */
    baseOptions: byte ? { modelAssetBuffer: byte.slice(), delegate } : { modelAssetPath: modello, delegate },
    runningMode: 'VIDEO',
    numHands: 2,
    minHandDetectionConfidence: s.rilevamento,
    minHandPresenceConfidence: s.presenza,
    minTrackingConfidence: s.tracciamento
  });
  let delegato = 'GPU';
  try { mano = await mod.HandLandmarker.createFromOptions(fileset, opzioni('GPU')); }
  catch (err){ delegato = 'CPU'; mano = await mod.HandLandmarker.createFromOptions(fileset, opzioni('CPU')); }

  /* la prima analisi prepara la scheda grafica e può durare secondi:
     la si fa adesso, su un fotogramma vuoto, così non cade sul primo
     gesto vero */
  try {
    const vuoto = new OffscreenCanvas(320, 240);
    vuoto.getContext('2d').fillRect(0, 0, 320, 240);
    mano.detectForVideo(vuoto, 1);
  } catch (err){}
  return delegato;
}

self.onmessage = async e => {
  const m = e.data;
  if (m.tipo === 'carica'){
    try {
      const delegato = await carica(m.base, m.modello, m.soglie);
      self.postMessage({ tipo: 'pronto', delegato });
    } catch (err){
      self.postMessage({ tipo: 'errore', messaggio: String((err && err.message) || err) });
    }
  } else if (m.tipo === 'analizza'){
    let landmarks = null, lati = [];
    try {
      const r = mano.detectForVideo(m.fotogramma, m.t);
      /* solo i numeri, in oggetti semplici */
      landmarks = (r && r.landmarks || []).map(lm => lm.map(p => ({ x: p.x, y: p.y, z: p.z })));
      /* quale mano è (Left/Right, nella convenzione di MediaPipe): serve al tutorial per i mancini; il sito lo ignora */
      lati = (r && r.handedness || []).map(h => (h && h[0] && h[0].categoryName) || null);
    } catch (err){}
    try { m.fotogramma.close(); } catch (err){}
    self.postMessage({ tipo: 'mani', landmarks, lati, t: m.t });
  }
};
