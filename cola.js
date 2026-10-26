// Cartapacio — datos en el móvil (IndexedDB) y comunicación con la hoja.
// Lo usan la página y el service worker (envío en segundo plano).

const BD_NOMBRE = 'cartapacio';
const BD_VERSION = 1;

function abrirBD() {
  return new Promise((resolve, reject) => {
    const pet = indexedDB.open(BD_NOMBRE, BD_VERSION);
    pet.onupgradeneeded = () => {
      const bd = pet.result;
      if (!bd.objectStoreNames.contains('pendientes')) bd.createObjectStore('pendientes', { keyPath: 'id' });
      if (!bd.objectStoreNames.contains('notas')) bd.createObjectStore('notas', { keyPath: 'fila' });
      if (!bd.objectStoreNames.contains('ajustes')) bd.createObjectStore('ajustes');
    };
    pet.onsuccess = () => resolve(pet.result);
    pet.onerror = () => reject(pet.error);
  });
}

async function op(almacen, modo, fn) {
  const bd = await abrirBD();
  return new Promise((resolve, reject) => {
    const tx = bd.transaction(almacen, modo);
    const resultado = fn(tx.objectStore(almacen));
    tx.oncomplete = () => resolve(resultado && 'result' in resultado ? resultado.result : undefined);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

const Cola = {
  meter: (apunte) => op('pendientes', 'readwrite', (s) => s.put(apunte)),
  quitar: (id) => op('pendientes', 'readwrite', (s) => s.delete(id)),
  async todos() {
    const lista = await op('pendientes', 'readonly', (s) => s.getAll());
    return (lista || []).sort((a, b) => a.fecha.localeCompare(b.fecha));
  },
  async marcarError(id, error) {
    const bd = await abrirBD();
    return new Promise((resolve, reject) => {
      const tx = bd.transaction('pendientes', 'readwrite');
      const s = tx.objectStore('pendientes');
      const g = s.get(id);
      g.onsuccess = () => { if (g.result) { g.result.ultimoError = error; s.put(g.result); } };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
};

// Copia en el móvil de todas las filas de la hoja (para ver y buscar sin cobertura).
const Notas = {
  todas: () => op('notas', 'readonly', (s) => s.getAll()).then((l) => l || []),
  async poner(lista) {
    if (!lista.length) return;
    const bd = await abrirBD();
    return new Promise((resolve, reject) => {
      const tx = bd.transaction('notas', 'readwrite');
      const s = tx.objectStore('notas');
      lista.forEach((n) => s.put(n));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
};

const Ajustes = {
  leer: (clave) => op('ajustes', 'readonly', (s) => s.get(clave)),
  guardar: (clave, valor) => op('ajustes', 'readwrite', (s) => s.put(valor, clave))
};

// Error con un código que la pantalla sabe explicar.
class ErrorEnvio extends Error {
  constructor(codigo, detalle) { super(codigo); this.codigo = codigo; this.detalle = detalle || ''; }
}

async function llamarScript(cuerpo) {
  const url = await Ajustes.leer('url');
  const clave = await Ajustes.leer('clave');
  if (!url || !clave) throw new ErrorEnvio('sin_config');

  const corte = new AbortController();
  const temporizador = setTimeout(() => corte.abort(), 30000);
  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // evita la consulta previa CORS
      body: JSON.stringify(Object.assign({ clave }, cuerpo)),
      redirect: 'follow',
      signal: corte.signal
    });
  } catch (e) {
    throw new ErrorEnvio(e.name === 'AbortError' ? 'tiempo' : 'red');
  } finally {
    clearTimeout(temporizador);
  }

  const texto = await resp.text();
  let datos;
  try { datos = JSON.parse(texto); }
  catch (e) { throw new ErrorEnvio('respuesta_rara', 'HTTP ' + resp.status); }
  if (!datos.ok) throw new ErrorEnvio(datos.error || 'desconocido', datos.detalle);
  return datos;
}

// Envía los pendientes en orden. Se para en el primer fallo para no desordenar.
// Devuelve { enviados: [respuestas], quedan: n, error: ErrorEnvio|null }
let enviando = null;
function enviarPendientes() {
  if (enviando) return enviando;
  enviando = (async () => {
    const enviados = [];
    let error = null;
    for (const apunte of await Cola.todos()) {
      try {
        const r = await llamarScript({ accion: 'guardar', id: apunte.id, fecha: apunte.fecha, texto: apunte.texto });
        await Notas.poner([{ fila: r.fila, fecha: r.fecha || apunte.fecha, fechaHoja: r.fechaHoja, texto: r.textoHoja }]);
        await Cola.quitar(apunte.id);
        enviados.push(r);
      } catch (e) {
        error = e;
        await Cola.marcarError(apunte.id, e.codigo || 'desconocido');
        break;
      }
    }
    const quedan = (await Cola.todos()).length;
    return { enviados, quedan, error };
  })();
  enviando.finally(() => { enviando = null; });
  return enviando;
}

// Trae de la hoja las filas que el móvil aún no tiene (la hoja solo crece).
let copiando = null;
function copiarHoja() {
  if (copiando) return copiando;
  copiando = (async () => {
    let desde = (await Ajustes.leer('ultimaFila')) || 0;
    let nuevas = 0;
    for (let vuelta = 0; vuelta < 50; vuelta++) {
      const r = await llamarScript({ accion: 'filas', desde });
      await Notas.poner(r.filas);
      nuevas += r.filas.length;
      desde = r.ultima;
      await Ajustes.guardar('ultimaFila', desde);
      if (!r.mas) break;
    }
    await Ajustes.guardar('copiadoA', new Date().toISOString());
    return nuevas;
  })();
  copiando.finally(() => { copiando = null; });
  return copiando;
}
