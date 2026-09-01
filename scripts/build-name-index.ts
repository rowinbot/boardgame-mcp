/**
 * Regenerates the committed data files in `data/`.
 *
 * These are checked in on purpose. recommend.games caps every list endpoint at
 * 25 rows, so pulling the 192 mechanics and 84 categories costs 12 sequential
 * requests against a service that falls over at around five — and its `search=`
 * parameter is permanently broken, so names cannot be resolved over the network
 * at all. Building the index once, offline, is both faster and kinder.
 *
 * Run: npm run build-index
 */
import { writeFileSync } from 'node:fs';
import { HttpClient } from '../src/lib/http.js';
import { USER_AGENT } from '../src/lib/http.js';

const RANKING_CSV = (date: string) =>
  `https://raw.githubusercontent.com/beefsack/bgg-ranking-historicals/master/${date}.csv`;

/** Splits one CSV line, honouring quoted fields. Game names contain commas. */
function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (quoted) {
      if (char === '"') {
        if (line[i + 1] === '"') { current += '"'; i += 1; } else { quoted = false; }
      } else current += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') { fields.push(current); current = ''; }
    else current += char;
  }
  fields.push(current);
  return fields;
}

async function latestRankingCsv(): Promise<{ date: string; body: string }> {
  // The repo publishes one file per day. Walk back from today until one exists.
  for (let back = 0; back < 7; back += 1) {
    const day = new Date(Date.now() - back * 86_400_000).toISOString().slice(0, 10);
    const response = await fetch(RANKING_CSV(day), { headers: { 'user-agent': USER_AGENT } });
    if (response.ok) return { date: day, body: await response.text() };
  }
  throw new Error('No BGG ranking CSV found in the last 7 days');
}

async function fetchAllPages(http: HttpClient, endpoint: string): Promise<{ bgg_id: number; name: string; count: number }[]> {
  const all: { bgg_id: number; name: string; count: number }[] = [];
  for (let page = 1; page <= 20; page += 1) {
    const url = `https://recommend.games/api/${endpoint}/?format=json&page_size=25&page=${page}`;
    const body = await http.getJson<{ next: string | null; results: { bgg_id: number; name: string; count?: number }[] }>(url);
    for (const row of body.results) all.push({ bgg_id: row.bgg_id, name: row.name, count: row.count ?? 0 });
    if (!body.next) break;
  }
  return all;
}

async function main(): Promise<void> {
  const http = new HttpClient();

  console.error('Fetching BGG ranking CSV…');
  const { date, body } = await latestRankingCsv();
  const lines = body.split('\n');
  const rows: string[] = [];
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const fields = splitCsvLine(line);
    const [id, name, year, rank] = fields;
    if (!id || !name) continue;
    // Tabs are the delimiter, so they must not survive inside a field.
    rows.push([id, name.replace(/\t/g, ' '), year ?? '', rank ?? ''].join('\t'));
  }
  writeFileSync(
    'data/name-index.tsv',
    `# BGG ranked games, from beefsack/bgg-ranking-historicals ${date}.csv\n` +
      `# bgg_id\tname\tyear\trank\n${rows.join('\n')}\n`,
  );
  console.error(`Wrote data/name-index.tsv (${rows.length} games)`);

  console.error('Fetching mechanics…');
  const mechanics = await fetchAllPages(http, 'mechanics');
  writeFileSync('data/mechanics.json', `${JSON.stringify(mechanics, null, 1)}\n`);
  console.error(`Wrote data/mechanics.json (${mechanics.length})`);

  console.error('Fetching categories…');
  const categories = await fetchAllPages(http, 'categories');
  writeFileSync('data/categories.json', `${JSON.stringify(categories, null, 1)}\n`);
  console.error(`Wrote data/categories.json (${categories.length})`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
