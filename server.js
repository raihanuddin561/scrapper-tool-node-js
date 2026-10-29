'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const ExcelJS = require('exceljs');
const { scrapeGoogleMaps, crawlLeadEmails } = require('./scraper');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const jobs = new Map();
const subscribers = new Map();

app.disable('x-powered-by');
app.use(express.json({ limit: '16kb' }));
app.use(express.static(path.join(__dirname, 'public'), {
  extensions: ['html'],
  maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0,
}));

function publish(jobId, event) {
  const job = jobs.get(jobId);
  if (job) job.events.push({ ...event, at: new Date().toISOString() });
  for (const response of subscribers.get(jobId) || []) {
    response.write(`data: ${JSON.stringify(event)}\n\n`);
  }
}

function sanitizeText(value, maxLength) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

app.get('/api/events/:id', (request, response) => {
  const job = jobs.get(request.params.id);
  if (!job) {
    response.status(404).json({ error: 'Job not found' });
    return;
  }

  response.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  response.flushHeaders();
  const listeners = subscribers.get(job.id) || new Set();
  listeners.add(response);
  subscribers.set(job.id, listeners);

  for (const event of job.events) response.write(`data: ${JSON.stringify(event)}\n\n`);
  const keepAlive = setInterval(() => response.write(': keep-alive\n\n'), 15000);
  request.on('close', () => {
    clearInterval(keepAlive);
    listeners.delete(response);
  });
});

app.post('/api/scrape', (request, response) => {
  const query = sanitizeText(request.body?.query, 300);
  const limit = Number(request.body?.limit);
  const format = sanitizeText(request.body?.format, 5).toLowerCase();
  if (!query) return response.status(400).json({ error: 'A search query is required.' });
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    return response.status(400).json({ error: 'Limit must be a whole number between 1 and 200.' });
  }
  if (!['xlsx', 'csv'].includes(format)) {
    return response.status(400).json({ error: 'Format must be XLSX or CSV.' });
  }

  const id = crypto.randomUUID();
  const controller = new AbortController();
  jobs.set(id, { id, query, limit, format, status: 'running', rows: [], events: [], controller });
  response.status(202).json({ id, eventsUrl: `/api/events/${id}` });

  setImmediate(async () => {
    const job = jobs.get(id);
    try {
      const { signal } = controller;
      const places = await scrapeGoogleMaps(query, limit, event => publish(id, event), { signal });
      if (signal.aborted) throw new Error('Scraping stopped by user.');
      job.rows = places.map(place => ({ ...place, Emails: 'N/A' }));
      job.status = 'crawling';
      publish(id, {
        type: 'status',
        message: `Found ${places.length} places. Email lookups are continuing; a current export is ready.`,
        phase: 'crawl',
        downloadUrl: places.length ? `/api/export/${id}` : undefined,
        downloadLabel: 'Download current results',
        count: places.length,
      });
      const crawledRows = await crawlLeadEmails(places, event => {
        if (event.type === 'row') job.rows[event.index] = event.row;
        publish(id, event);
      }, { signal });
      if (signal.aborted) throw new Error('Scraping stopped by user.');
      job.rows = crawledRows;
      job.status = 'complete';
      publish(id, { type: 'complete', message: 'Scraping complete.', downloadUrl: `/api/export/${id}`, count: job.rows.length });
    } catch (error) {
      if (controller.signal.aborted || error.name === 'AbortError') {
        job.status = 'cancelled';
        publish(id, { type: 'cancelled', message: 'Scraping stopped. You can download the results collected so far.' });
      } else {
        job.status = 'failed';
        publish(id, { type: 'error', message: error.message || 'Scraping failed.' });
      }
    } finally {
      setTimeout(() => {
        jobs.delete(id);
        subscribers.delete(id);
      }, 30 * 60 * 1000);
    }
  });
});

app.post('/api/stop/:id', (request, response) => {
  const job = jobs.get(request.params.id);
  if (!job) return response.status(404).json({ error: 'Job not found or expired.' });
  if (!['running', 'crawling'].includes(job.status)) {
    return response.status(409).json({ error: 'This job is no longer running.' });
  }
  job.controller.abort();
  job.status = 'cancelled';
  publish(job.id, { type: 'cancelled', message: 'Stopping scrape and cancelling active requests...' });
  return response.json({ message: 'Stop requested.' });
});

async function generateWorkbook(rows) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Local Google Maps Lead Scraper';
  workbook.created = new Date();
  const sheet = workbook.addWorksheet('Leads', { views: [{ state: 'frozen', ySplit: 1 }] });
  sheet.columns = [
    { header: 'Google Maps URL', key: 'googleSearchUrl', width: 60 },
    { header: 'Name', key: 'Name', width: 32 },
    { header: 'Address', key: 'Address', width: 52 },
    { header: 'Contact', key: 'Contact', width: 22 },
    { header: 'Website', key: 'Website', width: 38 },
    { header: 'Domain', key: 'domain', width: 30 },
    { header: 'Plus Code', key: 'Plus Code', width: 34 },
    { header: 'Emails', key: 'Emails', width: 52 },
  ];
  sheet.getRow(1).font = { bold: true };
  sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8ECFF' } };
  sheet.getRow(1).alignment = { vertical: 'middle' };
  rows.forEach(row => sheet.addRow(row));
  sheet.autoFilter = { from: 'A1', to: 'H1' };
  return workbook;
}

app.get('/api/export/:id', async (request, response, next) => {
  const job = jobs.get(request.params.id);
  if (!job) return response.status(404).json({ error: 'Export is unavailable or expired.' });
  if (!job.rows.length || job.status === 'running') {
    return response.status(409).json({ error: 'Results are not ready to export yet.' });
  }

  try {
    const workbook = await generateWorkbook(job.rows);
    const safeName = job.query.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'google-maps-leads';
    if (job.format === 'csv') {
      const buffer = await workbook.csv.writeBuffer();
      response.set({
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${safeName}.csv"`,
        'Cache-Control': 'no-store',
      });
      return response.end(buffer);
    }

    const buffer = await workbook.xlsx.writeBuffer();
    response.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${safeName}.xlsx"`,
      'Cache-Control': 'no-store',
    });
    return response.end(buffer);
  } catch (error) {
    return next(error);
  }
});

app.use((error, request, response, next) => {
  console.error(error);
  response.status(500).json({ error: 'The server could not complete the request.' });
});

const server = app.listen(PORT, HOST, () => {
  console.log(`Lead scraper running at http://${HOST}:${PORT}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => server.close(() => process.exit(0)));
}

module.exports = app;
