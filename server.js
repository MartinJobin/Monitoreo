const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

loadEnv(path.join(__dirname, '.env'));

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, 'public');
const SHEET_ID = process.env.SHEET_ID || '1jNVgIDT0wjminZA7Hxaq-fW5LMB7uEWIAYoz52zZJPw';
const SHEET_NAME = process.env.SHEET_NAME || 'ENTRANTES';
const OUTGOING_SHEET_NAME = process.env.OUTGOING_SHEET_NAME || 'NPS SALIENTES TOTAL';
const CHAT_SHEET_NAME = process.env.CHAT_SHEET_NAME || 'NPS CHAT TOTAL';
const NPS_INCOMING_SHEET_NAME = process.env.NPS_INCOMING_SHEET_NAME || 'NPS ENTRANTES TOTAL';
const CHAT_RATINGS_SHEET_NAME = process.env.CHAT_RATINGS_SHEET_NAME || 'CALIF CHAT';
const SHEET_GID = process.env.SHEET_GID || '0';
const CACHE_MS = 5 * 60 * 1000;
const cache = new Map();
const ALERTS_CACHE_MS = 60 * 1000;
const alertsCache = new Map();
const DATA_DIR = path.join(__dirname, 'data');
const DETRACTOR_NOTES_FILE = path.join(DATA_DIR, 'detractor-notes.json');
const ABANDONED_NOTES_FILE = path.join(DATA_DIR, 'abandoned-notes.json');

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][\w]*)\s*=\s*(.*)\s*$/);
    if (!match || match[1] in process.env) continue;
    process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
}

function csvUrl(sheetName, direction) {
  if (direction === 'incoming' && process.env.SHEET_CSV_URL) return process.env.SHEET_CSV_URL;
  if (direction === 'outgoing' && process.env.OUTGOING_SHEET_CSV_URL) return process.env.OUTGOING_SHEET_CSV_URL;
  if (direction === 'chat' && process.env.CHAT_SHEET_CSV_URL) return process.env.CHAT_SHEET_CSV_URL;
  const base = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv`;
  return `${base}&sheet=${encodeURIComponent(sheetName)}${direction === 'incoming' ? `&gid=${encodeURIComponent(SHEET_GID)}` : ''}`;
}

function parseCsv(text) {
  const rows = [];
  let row = [], value = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted && ch === '"' && text[i + 1] === '"') { value += '"'; i++; }
    else if (ch === '"') quoted = !quoted;
    else if (ch === ',' && !quoted) { row.push(value); value = ''; }
    else if ((ch === '\n' || ch === '\r') && !quoted) {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(value); value = '';
      if (row.some(cell => cell.trim())) rows.push(row);
      row = [];
    } else value += ch;
  }
  if (value || row.length) { row.push(value); rows.push(row); }
  const headers = (rows.shift() || []).map((h, i) => h.trim() || `columna_${i + 1}`);
  return rows.map(cells => Object.fromEntries(headers.map((h, i) => [h, cells[i] ?? ''])));
}

function parseCsvMatrix(text) {
  const rows = [];
  let row = [], value = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted && ch === '"' && text[i + 1] === '"') { value += '"'; i++; }
    else if (ch === '"') quoted = !quoted;
    else if (ch === ',' && !quoted) { row.push(value); value = ''; }
    else if ((ch === '\n' || ch === '\r') && !quoted) {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(value); value = ''; rows.push(row); row = [];
    } else value += ch;
  }
  if (value || row.length) { row.push(value); rows.push(row); }
  return rows;
}

async function readMonitoringSchedule(force = false) {
  const key = 'monitoringSchedule';
  const stored = cache.get(key);
  if (!force && stored?.payload && Date.now() - stored.at < CACHE_MS) return stored.payload;
  const sheets = ['SEPTIEMBRE2026', 'OCTUBRE2026'];
  const schedules = await Promise.all(sheets.map(async sheet => {
    const response = await fetch(csvUrl(sheet, key), { signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw new Error(`${sheet}: Google Sheets respondió ${response.status}`);
    const text = await response.text();
    if (/<!doctype html|<html/i.test(text)) throw new Error(`${sheet}: la hoja requiere autorización`);
    return { sheet, rows: parseCsvMatrix(text) };
  }));
  const payload = { source: 'sheet', schedules, updatedAt: new Date().toISOString() };
  cache.set(key, { at: Date.now(), payload });
  return payload;
}

async function readSheet(direction = 'incoming', force = false) {
  const sheetName = direction === 'chatRatings' ? CHAT_RATINGS_SHEET_NAME : direction === 'npsIncoming' ? NPS_INCOMING_SHEET_NAME : direction === 'chat' ? CHAT_SHEET_NAME : direction === 'outgoing' ? OUTGOING_SHEET_NAME : SHEET_NAME;
  const stored = cache.get(direction);
  if (!force && stored?.payload && Date.now() - stored.at < CACHE_MS) return stored.payload;
  try {
    let response, lastError;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        response = await fetch(csvUrl(sheetName, direction), { signal: AbortSignal.timeout(60000) });
        if (!response.ok) throw new Error(`Google Sheets respondió ${response.status}`);
        break;
      } catch (error) {
        lastError = error;
        if (attempt < 3) await new Promise(resolve => setTimeout(resolve, attempt * 750));
      }
    }
    if (!response?.ok) throw lastError || new Error('No se pudo consultar Google Sheets');
    const text = await response.text();
    if (/<!doctype html|<html/i.test(text)) throw new Error('La hoja requiere autorización');
    const rows = parseCsv(text);
    if (!rows.length) throw new Error('La pestaña no contiene filas visibles');
    cache.set(direction, { at: Date.now(), payload: { source: 'sheet', sheet: sheetName, direction, rows, updatedAt: new Date().toISOString() } });
  } catch (error) {
    if (stored?.payload?.source === 'sheet') {
      cache.set(direction, { at: Date.now(), payload: { ...stored.payload, warning: `Se conservó la última lectura válida: ${error.message}` } });
    } else {
      cache.set(direction, { at: Date.now(), payload: { source: 'demo', sheet: sheetName, direction, rows: demoRows(direction), warning: error.message, updatedAt: new Date().toISOString() } });
    }
  }
  return cache.get(direction).payload;
}

function demoRows(direction = 'incoming') {
  const agents = ['Monitorista Titania', 'Sebastian Caiza', 'Erika Mendoza', 'Genesis Castillo', 'Ana Carolina Ribadeneira'];
  const channels = ['PBX', 'WhatsApp', 'Campaña web'];
  const rows = [];
  const start = new Date('2026-05-01T07:00:00');
  for (let i = 0; i < 420; i++) {
    const date = new Date(start.getTime() + i * 5.2 * 60 * 60 * 1000);
    const roll = (i * 37) % 100;
    const status = direction === 'outgoing' ? (roll < 55 ? 'ANSWERED' : roll < 91 ? 'NO ANSWER' : roll < 95 ? 'BUSY' : roll < 98 ? 'CONGESTION' : 'FAILED') : (roll < 81 ? 'Contestada' : roll < 96 ? 'Abandonada' : 'Descartada');
    const duration = status === 'Contestada' ? 35 + ((i * 29) % 580) : 0;
    rows.push({
      Fecha: date.toISOString(), Hora: date.toTimeString().slice(0, 5), Agente: agents[i % agents.length],
      Canal: channels[i % channels.length], Estado: status, Duracion: duration, 'Tiempo de Llamada': direction === 'outgoing' ? 12 + ((i * 17) % 120) : duration, 'Tiempo de Conversacion': duration,
      Espera: 2 + ((i * 13) % 80), Telefono: `5939${String(30000000 + (i % 86)).padStart(8, '0')}`,
      Cliente: i % 7 ? `Cliente ${1 + (i % 180)}` : 'SIN NOMBRE'
    });
  }
  return rows;
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readDetractorNotes() {
  try { return JSON.parse(fs.readFileSync(DETRACTOR_NOTES_FILE, 'utf8')); }
  catch { return []; }
}

function saveDetractorNotes(notes) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const temporary = `${DETRACTOR_NOTES_FILE}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(notes, null, 2), 'utf8');
  fs.renameSync(temporary, DETRACTOR_NOTES_FILE);
}

function readAbandonedNotes() {
  try { return JSON.parse(fs.readFileSync(ABANDONED_NOTES_FILE, 'utf8')); }
  catch { return []; }
}

function saveAbandonedNotes(notes) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const temporary = `${ABANDONED_NOTES_FILE}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(notes, null, 2), 'utf8');
  fs.renameSync(temporary, ABANDONED_NOTES_FILE);
}

function normalizedPhone(value) {
  let digits = String(value || '').replace(/\D/g, '');
  if (digits.startsWith('593')) digits = digits.slice(3);
  else if (digits.startsWith('0')) digits = digits.slice(1);
  return digits;
}

async function readAbandonedCalls(force = false) {
  const stored = cache.get('abandonedCalls');
  if (!force && stored?.payload && Date.now() - stored.at < CACHE_MS) return stored.payload;
  const [incoming, outgoing] = await Promise.all([readSheet('incoming', force), readSheet('outgoing', force)]);
  const abandoned = incoming.rows.filter(row => /abandon|perdid|no contest/i.test(String(row.Estatus || row.Estado || row.Status || '')));
  const phones = new Set(abandoned.map(row => normalizedPhone(row.Telefono || row['Teléfono'])).filter(Boolean));
  const incomingRows = incoming.rows.filter(row => phones.has(normalizedPhone(row.Telefono || row['Teléfono']))).map(row => ({
    FECHAENTRANTE: row.FECHAENTRANTE || row.Fecha, HORAENTRATE: row.HORAENTRATE || row.HORAENTRANTE || row.Hora,
    Estatus: row.Estatus || row.Estado || row.Status, Telefono: row.Telefono || row['Teléfono'], Contacto: row.Contacto || row.Cliente,
    COLA2: row.COLA2 || row.Cola || row['Nombre de Opción'], Agente: row.Agente, 'Tiempo de Espera': row['Tiempo de Espera'] || row.Espera,
    'Identificador único': row['Identificador único']
  }));
  const outgoingRows = outgoing.rows.filter(row => phones.has(normalizedPhone(row.Telefono || row['Teléfono']))).map(row => ({
    Fecha: row.Fecha, 'Estado de Llamada': row['Estado de Llamada'] || row.Estatus || row.Estado,
    Telefono: row.Telefono || row['Teléfono'], Contacto: row.Contacto || row.Cliente,
    'Grupo de Tareas': row['Grupo de Tareas'] || row.Cuenta, Agente: row.Agente, 'Identificador único': row['Identificador único']
  }));
  const payload = { incomingRows, outgoingRows, abandonedCount: abandoned.length, updatedAt: new Date().toISOString() };
  cache.set('abandonedCalls', { at: Date.now(), payload });
  return payload;
}

function readJsonBody(req, limit = 100000) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > limit) reject(new Error('Solicitud demasiado grande')); });
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch { reject(new Error('JSON inválido')); } });
    req.on('error', reject);
  });
}

async function fetchJsonWithRetry(url) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (!response.ok) throw new Error(`API respondió ${response.status}`);
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise(resolve => setTimeout(resolve, attempt * 500));
    }
  }
  throw lastError;
}

async function readAlerts(startDate, endDate, force = false) {
  const key = `${startDate}:${endDate}`;
  const stored = alertsCache.get(key);
  if (!force && stored && Date.now() - stored.at < ALERTS_CACHE_MS) return stored.payload;
  const base = 'https://consola.titania.com.ec/apiv2/devices-events';
  const query = `start_date=${encodeURIComponent(startDate)}&end_date=${encodeURIComponent(endDate)}`;
  const endpoints = {
    // This endpoint respects the selected period. A high limit lets the client
    // aggregate every returned vehicle/event pair into accurate period totals.
    vehicles: `${base}/stats/top-vehicles?limit=100000&${query}`,
    responseTimes: `${base}/stats/response-times?${query}`,
    operators: `${base}/stats/operators?${query}`,
    count: `${base}/count`
  };
  const entries = await Promise.all(Object.entries(endpoints).map(async ([name, endpoint]) => {
    const started = Date.now();
    try {
      const result = await fetchJsonWithRetry(endpoint);
      return [name, { ok: true, latencyMs: Date.now() - started, data: result.data ?? result }];
    } catch (error) {
      return [name, { ok: false, latencyMs: Date.now() - started, error: error.message, data: null }];
    }
  }));
  const sources = Object.fromEntries(entries);
  const payload = { startDate, endDate, sources, updatedAt: new Date().toISOString() };
  if (Object.values(sources).some(source => source.ok)) alertsCache.set(key, { at: Date.now(), payload });
  else if (stored) return { ...stored.payload, warning: 'Se conservó la última lectura válida' };
  return payload;
}

function serveFile(res, pathname) {
  const requested = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = path.normalize(path.join(PUBLIC_DIR, requested));
  if (!file.startsWith(PUBLIC_DIR)) return sendJson(res, 403, { error: 'Ruta no permitida' });
  fs.readFile(file, (error, data) => {
    if (error) return sendJson(res, 404, { error: 'No encontrado' });
    const ext = path.extname(file);
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
    res.writeHead(200, { 'Content-Type': `${types[ext] || 'application/octet-stream'}; charset=utf-8`, 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname === '/api/health') return sendJson(res, 200, { ok: true, module: 'llamadas-entrantes' });
  if (url.pathname === '/api/detractor-notes' && req.method === 'GET') {
    const phone = String(url.searchParams.get('phone') || '').trim();
    const notes = readDetractorNotes().filter(note => !phone || note.phone === phone);
    return sendJson(res, 200, { notes });
  }
  if (url.pathname === '/api/detractor-notes' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const phone = String(body.phone || '').trim(), text = String(body.text || '').trim();
      if (!phone || !text) return sendJson(res, 400, { error: 'El contacto y la novedad son obligatorios' });
      const allowed = ['Pendiente', 'En gestión', 'Contactado', 'Cerrado'];
      const note = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`, phone, text: text.slice(0, 3000), author: String(body.author || 'Supervisor').trim().slice(0, 100) || 'Supervisor', status: allowed.includes(body.status) ? body.status : 'En gestión', createdAt: new Date().toISOString() };
      const notes = readDetractorNotes(); notes.push(note); saveDetractorNotes(notes);
      return sendJson(res, 201, { note });
    } catch (error) { return sendJson(res, 400, { error: error.message }); }
  }
  if (url.pathname === '/api/abandoned-notes' && req.method === 'GET') {
    const caseId = String(url.searchParams.get('caseId') || '').trim();
    const notes = readAbandonedNotes().filter(note => !caseId || note.caseId === caseId);
    return sendJson(res, 200, { notes });
  }
  if (url.pathname === '/api/abandoned-notes' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const caseId = String(body.caseId || '').trim(), phone = String(body.phone || '').trim(), text = String(body.text || '').trim();
      if (!caseId || !phone || !text) return sendJson(res, 400, { error: 'El caso, el contacto y la novedad son obligatorios' });
      const allowed = ['Pendiente', 'En gestión', 'Contactado', 'Cerrado'];
      const note = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`, caseId, phone, text: text.slice(0, 3000), author: String(body.author || 'Supervisor').trim().slice(0, 100) || 'Supervisor', status: allowed.includes(body.status) ? body.status : 'En gestión', createdAt: new Date().toISOString() };
      const notes = readAbandonedNotes(); notes.push(note); saveAbandonedNotes(notes);
      return sendJson(res, 201, { note });
    } catch (error) { return sendJson(res, 400, { error: error.message }); }
  }
  if (url.pathname === '/api/abandoned-calls' && req.method === 'GET') {
    try { return sendJson(res, 200, await readAbandonedCalls(url.searchParams.get('refresh') === '1')); }
    catch (error) { return sendJson(res, 502, { error: error.message }); }
  }
  if (url.pathname === '/api/alerts') {
    const datePattern = /^\d{4}-\d{2}-\d{2}$/;
    const today = new Date(), fallbackEnd = today.toISOString().slice(0, 10), fallbackStart = new Date(today.getTime() - 29 * 86400000).toISOString().slice(0, 10);
    const startDate = datePattern.test(url.searchParams.get('start_date') || '') ? url.searchParams.get('start_date') : fallbackStart;
    const endDate = datePattern.test(url.searchParams.get('end_date') || '') ? url.searchParams.get('end_date') : fallbackEnd;
    return sendJson(res, 200, await readAlerts(startDate, endDate, url.searchParams.get('refresh') === '1'));
  }
  if (url.pathname === '/api/calls') {
    const requestedDirection = url.searchParams.get('direction');
    const direction = requestedDirection === 'chatRatings' ? 'chatRatings' : requestedDirection === 'npsIncoming' ? 'npsIncoming' : requestedDirection === 'chat' ? 'chat' : requestedDirection === 'outgoing' ? 'outgoing' : 'incoming';
    return sendJson(res, 200, await readSheet(direction, url.searchParams.get('refresh') === '1'));
  }
  if (url.pathname === '/api/monitoring-schedule') {
    try { return sendJson(res, 200, await readMonitoringSchedule(url.searchParams.get('refresh') === '1')); }
    catch (error) { return sendJson(res, 502, { error: error.message }); }
  }
  serveFile(res, decodeURIComponent(url.pathname));
});

server.listen(PORT, () => console.log(`Titania disponible en http://localhost:${PORT}`));
