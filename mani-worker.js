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
     alla pagina:   { tipo:'pronto', delegato }
                    { tipo:'mani', landmarks, t }
                    { tipo:'errore', messaggio }
   ========================================================================= */

let mano = null;

async function carica(base, modello){
  const mod = await import(base + '/vision_bundle.mjs');
  const fileset = await mod.FilesetResolver.forVisionTasks(base + '/wasm');
  const opzioni = delegate => ({
    baseOptions: { modelAssetPath: modello, delegate },
    runningMode: 'VIDEO',
    numHands: 2,
    minHandDetectionConfidence: 0.6,
    minHandPresenceConfidence: 0.5,
    minTrackingConfidence: 0.5
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
      const delegato = await carica(m.base, m.modello);
      self.postMessage({ tipo: 'pronto', delegato });
    } catch (err){
      self.postMessage({ tipo: 'errore', messaggio: String((err && err.message) || err) });
    }
  } else if (m.tipo === 'analizza'){
    let landmarks = null;
    try {
      const r = mano.detectForVideo(m.fotogramma, m.t);
      /* solo i numeri, in oggetti semplici */
      landmarks = (r && r.landmarks || []).map(lm => lm.map(p => ({ x: p.x, y: p.y, z: p.z })));
    } catch (err){}
    try { m.fotogramma.close(); } catch (err){}
    self.postMessage({ tipo: 'mani', landmarks, t: m.t });
  }
};
