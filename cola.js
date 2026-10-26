// Apunta — almacenamiento en el móvil (IndexedDB) y envío a la hoja.
// Lo usan tanto la página como el service worker (envío en segundo plano).

const BD_NOMBRE = 'apunta';
const BD_VERSION = 1;

function abrirBD() {
  return new Promise((resolve, reject) => {
    const pet = indexedDB.open(BD_NOMBRE, BD_VERSION);
    pet.onupgradeneeded = () => {
      const bd = pet.result;
      if (!bd.objectStoreNames.contains('pendientes')) bd.createObjectStore('pendientes', { keyPath: 'id' });
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
        await Cola.quitar(apunte.id);
        if (r.hoy) await Ajustes.guardar('hoy', { dia: diaLocal(), lista: r.hoy });
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

function diaLocal(fecha) {
  const d = fecha ? new Date(fecha) : new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
