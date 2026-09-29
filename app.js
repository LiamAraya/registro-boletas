const STORAGE_KEY = 'boletas-registro-v1';
const MAX_THUMB_SIDE = 700;
const OCR_MAX_SIDE = 1800;

const uploadZone = document.getElementById('uploadZone');
const fileInput = document.getElementById('fileInput');
const uploadPrompt = document.getElementById('uploadPrompt');
const preview = document.getElementById('preview');
const ocrStatus = document.getElementById('ocrStatus');
const ocrStatusText = document.getElementById('ocrStatusText');
const entryForm = document.getElementById('entryForm');
const fechaInput = document.getElementById('fecha');
const montoInput = document.getElementById('monto');
const numeroInput = document.getElementById('numero');
const rawTextEl = document.getElementById('rawText');
const cancelBtn = document.getElementById('cancelBtn');
const tableBody = document.getElementById('tableBody');
const countEl = document.getElementById('count');
const totalSumEl = document.getElementById('totalSum');
const emptyMsg = document.getElementById('emptyMsg');
const exportBtn = document.getElementById('exportBtn');

let currentThumbDataUrl = null;

function loadEntries() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || [];
  } catch {
    return [];
  }
}

function saveEntries(entries) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch (e) {
    alert('No se pudo guardar (almacenamiento local lleno). Intenta borrar boletas antiguas.');
  }
}

function resetCapture() {
  fileInput.value = '';
  preview.hidden = true;
  uploadPrompt.hidden = false;
  ocrStatus.hidden = true;
  entryForm.hidden = true;
  currentThumbDataUrl = null;
}

uploadZone.addEventListener('click', () => fileInput.click());

['dragover', 'dragenter'].forEach(evt =>
  uploadZone.addEventListener(evt, e => {
    e.preventDefault();
    uploadZone.classList.add('dragover');
  })
);
['dragleave', 'dragend', 'drop'].forEach(evt =>
  uploadZone.addEventListener(evt, () => uploadZone.classList.remove('dragover'))
);
uploadZone.addEventListener('drop', e => {
  e.preventDefault();
  const file = e.dataTransfer.files && e.dataTransfer.files[0];
  if (file) handleFile(file);
});

fileInput.addEventListener('change', () => {
  const file = fileInput.files[0];
  if (file) handleFile(file);
});

function handleFile(file) {
  if (!file.type.startsWith('image/')) {
    alert('Por favor elige un archivo de imagen.');
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      const resized = resizeImage(img, MAX_THUMB_SIDE);
      currentThumbDataUrl = resized;
      preview.src = resized;
      preview.hidden = false;
      uploadPrompt.hidden = true;
      runOcr(img);
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
}

function resizeImage(img, maxSide) {
  let { width, height } = img;
  if (width > height && width > maxSide) {
    height = Math.round(height * (maxSide / width));
    width = maxSide;
  } else if (height > maxSide) {
    width = Math.round(width * (maxSide / height));
    height = maxSide;
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d').drawImage(img, 0, 0, width, height);
  return canvas.toDataURL('image/jpeg', 0.82);
}

function applyGrayscaleContrast(ctx, width, height) {
  const imageData = ctx.getImageData(0, 0, width, height);
  const d = imageData.data;
  const gray = new Float32Array(width * height);
  let min = 255, max = 0;
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    const g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    gray[p] = g;
    if (g < min) min = g;
    if (g > max) max = g;
  }
  const range = Math.max(1, max - min);
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    const v = Math.min(255, Math.max(0, ((gray[p] - min) / range) * 255));
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  ctx.putImageData(imageData, 0, 0);
}

function prepareForOcr(img, maxSide) {
  let { width, height } = img;
  const scale = Math.min(1, maxSide / Math.max(width, height));
  width = Math.round(width * scale);
  height = Math.round(height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, width, height);
  applyGrayscaleContrast(ctx, width, height);
  return { dataUrl: canvas.toDataURL('image/png'), scale };
}

const NUMERO_LINE_RE = /\b(?:boleta|factura|electr[oó]nica|bateta|nro\.?|n[°º]\.?)\b/i;

async function runOcr(img) {
  ocrStatus.hidden = false;
  entryForm.hidden = true;
  ocrStatusText.textContent = 'Leyendo la boleta…';
  try {
    const { dataUrl, scale } = prepareForOcr(img, OCR_MAX_SIDE);
    const result = await Tesseract.recognize(dataUrl, 'spa+eng', {
      logger: m => {
        if (m.status === 'recognizing text') {
          ocrStatusText.textContent = `Leyendo la boleta… ${Math.round(m.progress * 100)}%`;
        }
      }
    });
    const text = result.data.text || '';
    rawTextEl.textContent = text.trim() || '(no se detectó texto)';
    fillGuesses(text);

    try {
      ocrStatusText.textContent = 'Afinando número de boleta…';
      const refined = await refineNumero(img, result.data.lines, scale);
      if (refined) numeroInput.value = refined;
    } catch (e) {
      console.error('refineNumero failed', e);
    }
  } catch (err) {
    console.error(err);
    rawTextEl.textContent = 'No se pudo leer el texto automáticamente. Completa los campos a mano.';
  } finally {
    ocrStatus.hidden = true;
    entryForm.hidden = false;
  }
}

// Busca, dentro del texto ya leído, la línea con la etiqueta de boleta/factura y
// su dígito más largo; recorta esa palabra en alta resolución desde la imagen
// original y la vuelve a leer restringida a dígitos. El primer OCR (a tamaño de
// página completa) suele perder 1-2 dígitos en números pequeños o borrosos; este
// segundo paso, enfocado solo en esa palabra y ampliado ~8-10x, es mucho más preciso.
async function refineNumero(img, lines, ocrScale) {
  if (!lines || !lines.length) return null;
  const line = lines.find(l => NUMERO_LINE_RE.test(l.text) && l.words && l.words.some(w => /^\d{4,}$/.test(w.text)));
  if (!line) return null;
  const digitWords = line.words.filter(w => /^\d{4,}$/.test(w.text));
  if (!digitWords.length) return null;
  const word = digitWords.reduce((a, b) => (b.text.length > a.text.length ? b : a));

  const pad = 8;
  const bx0 = Math.max(0, word.bbox.x0 / ocrScale - pad);
  const by0 = Math.max(0, word.bbox.y0 / ocrScale - pad);
  const bx1 = word.bbox.x1 / ocrScale + pad;
  const by1 = word.bbox.y1 / ocrScale + pad;
  const cw = bx1 - bx0, ch = by1 - by0;
  if (cw <= 0 || ch <= 0 || cw > 2000 || ch > 2000) return null;

  const upscale = Math.max(4, Math.min(12, Math.round(300 / ch)));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(cw * upscale);
  canvas.height = Math.round(ch * upscale);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, bx0, by0, cw, ch, 0, 0, canvas.width, canvas.height);
  applyGrayscaleContrast(ctx, canvas.width, canvas.height);
  const cropUrl = canvas.toDataURL('image/png');

  const worker = await Tesseract.createWorker('eng');
  await worker.setParameters({ tessedit_char_whitelist: '0123456789', tessedit_pageseg_mode: '7' });
  const r = await worker.recognize(cropUrl);
  await worker.terminate();
  const digits = (r.data.text || '').replace(/\D/g, '');
  return digits.length >= 4 && digits.length <= 14 ? digits : null;
}

function fillGuesses(text) {
  fechaInput.value = guessDate(text) || '';
  montoInput.value = guessAmount(text) || '';
  numeroInput.value = guessNumero(text) || '';
}

function guessDate(text) {
  const patterns = [
    /\b(\d{4})[-/](\d{1,2})[-/](\d{1,2})\b/,
    /\b(\d{1,2})[-/](\d{1,2})[-/](\d{4})\b/,
    /\b(\d{1,2})[-/](\d{1,2})[-/](\d{2})\b/
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (!m) continue;
    let y, mo, d;
    if (m[1].length === 4) {
      [, y, mo, d] = m;
    } else if (m[3].length === 4) {
      [, d, mo, y] = m;
    } else {
      [, d, mo, y] = m;
      y = '20' + y;
    }
    y = Number(y); mo = Number(mo); d = Number(d);
    if (mo > 12 && d <= 12) [mo, d] = [d, mo];
    if (mo < 1 || mo > 12 || d < 1 || d > 31) continue;
    return `${String(y).padStart(4, '0')}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  return null;
}

function guessAmount(text) {
  const lines = text.split('\n').filter(l => !/subtotal|ahorro|descuento/i.test(l));
  const numRe = /(?:s\/\.?|\$|usd|clp|pen)?\s*(\d{1,3}(?:[.,]\d{2,3})+|\d+)/i;

  const totalLines = lines.filter(l => /\btotal\b/i.test(l));
  for (const line of totalLines.reverse()) {
    const m = line.match(numRe);
    if (m) return normalizeAmount(m[1]);
  }

  const otherLines = lines.filter(l => /\b(monto|importe)\b/i.test(l));
  for (const line of otherLines.reverse()) {
    const m = line.match(numRe);
    if (m) return normalizeAmount(m[1]);
  }

  let best = null;
  const all = [...text.matchAll(new RegExp(numRe, 'gi'))];
  for (const m of all) {
    const val = normalizeAmount(m[1]);
    const num = parseFloat(val);
    if (!isNaN(num) && (best === null || num > parseFloat(best))) best = val;
  }
  return best;
}

function normalizeAmount(raw) {
  const s = raw.trim();
  const groups = s.split(/[.,]/);
  if (groups.length === 1) return groups[0];
  const last = groups[groups.length - 1];
  if (last.length === 2) {
    return groups.slice(0, -1).join('') + '.' + last;
  }
  return groups.join('');
}

function guessNumero(text) {
  const patterns = [
    /\b([A-Z]\d{3}-\d{5,8})\b/,
    /\b(?:boleta(?:\s*electr[oó]nica)?|factura(?:\s*electr[oó]nica)?|electr[oó]nica|nro\.?|n[°º]\.?)\s*(?:n[°º]\.?)?\s*[:.]?\s*([0-9][0-9A-Z-]{2,14})\b/i
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) return m[1].toUpperCase();
  }
  // El número de boleta suele imprimirse cerca del pie del ticket (tras el código
  // de barras), y la etiqueta "BOLETA" a veces se pierde en el OCR — como último
  // recurso, se prefiere la última secuencia larga de dígitos, no la primera
  // (que suele ser el RUC u otro código impreso al inicio).
  const fallback = [...text.matchAll(/\b(\d{6,12})\b/g)];
  if (fallback.length) return fallback[fallback.length - 1][1];
  return null;
}

cancelBtn.addEventListener('click', resetCapture);

entryForm.addEventListener('submit', e => {
  e.preventDefault();
  const entries = loadEntries();
  entries.unshift({
    id: Date.now(),
    fecha: fechaInput.value,
    monto: montoInput.value,
    numero: numeroInput.value.trim(),
    thumb: currentThumbDataUrl
  });
  saveEntries(entries);
  renderTable();
  resetCapture();
});

function renderTable() {
  const entries = loadEntries();
  tableBody.innerHTML = '';
  countEl.textContent = entries.length;
  emptyMsg.classList.toggle('hidden', entries.length > 0);

  let sum = 0;
  for (const entry of entries) {
    const tr = document.createElement('tr');

    const thumbTd = document.createElement('td');
    thumbTd.className = 'thumb';
    if (entry.thumb) {
      const img = document.createElement('img');
      img.src = entry.thumb;
      thumbTd.appendChild(img);
    }
    tr.appendChild(thumbTd);

    const fechaTd = document.createElement('td');
    fechaTd.textContent = entry.fecha || '—';
    tr.appendChild(fechaTd);

    const montoTd = document.createElement('td');
    montoTd.textContent = entry.monto || '—';
    tr.appendChild(montoTd);
    const n = parseFloat(entry.monto);
    if (!isNaN(n)) sum += n;

    const numeroTd = document.createElement('td');
    numeroTd.textContent = entry.numero || '—';
    tr.appendChild(numeroTd);

    const actionsTd = document.createElement('td');
    const delBtn = document.createElement('button');
    delBtn.className = 'delete-btn';
    delBtn.textContent = '✕';
    delBtn.title = 'Eliminar';
    delBtn.addEventListener('click', () => deleteEntry(entry.id));
    actionsTd.appendChild(delBtn);
    tr.appendChild(actionsTd);

    tableBody.appendChild(tr);
  }
  totalSumEl.textContent = entries.length ? `Total: ${sum.toFixed(2)}` : '';
}

function deleteEntry(id) {
  const entries = loadEntries().filter(e => e.id !== id);
  saveEntries(entries);
  renderTable();
}

exportBtn.addEventListener('click', () => {
  const entries = loadEntries();
  if (!entries.length) {
    alert('No hay boletas para exportar.');
    return;
  }
  const rows = [['Fecha', 'Monto', 'Numero de boleta']];
  for (const e of entries) rows.push([e.fecha || '', e.monto || '', e.numero || '']);
  const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `boletas-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
});

renderTable();
