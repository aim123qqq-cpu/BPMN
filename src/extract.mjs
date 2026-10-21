// Извлечение текста из документации (.md/.txt/.docx/.pdf) в структуру разделов
// с устойчивыми якорями (S3.2 = пункт 3.2), на которые ссылаются source.section в моделях.
import { readFile } from 'node:fs/promises';
import { extname, basename } from 'node:path';

export async function extractDocument(file) {
  const ext = extname(file).toLowerCase();
  let markdown;
  if (ext === '.md' || ext === '.txt') {
    markdown = await readFile(file, 'utf8');
  } else if (ext === '.docx') {
    const mammoth = (await import('mammoth')).default;
    const { value: html } = await mammoth.convertToHtml({ path: file });
    markdown = htmlToMarkdown(html);
  } else if (ext === '.pdf') {
    const { PDFParse } = await import('pdf-parse');
    const parser = new PDFParse({ data: await readFile(file) });
    try {
      markdown = (await parser.getText()).text;
    } finally {
      await parser.destroy();
    }
  } else {
    throw new Error(`Неподдерживаемый формат: ${ext} (поддерживаются .md, .txt, .docx, .pdf)`);
  }
  const sections = splitSections(markdown);
  return { doc: basename(file), sections };
}

const NUMBERED = /^(\d+(?:\.\d+){0,5})\.?\s+(\S.*)$/;
const HEADING = /^(#{1,6})\s+(.*)$/;

export function splitSections(markdown) {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const sections = [];
  const headingPath = [];
  const usedIds = new Set();
  let current = null;
  let seq = 0;

  const uniqueId = (base) => {
    let id = base;
    for (let i = 2; usedIds.has(id); i++) id = `${base}_${i}`;
    usedIds.add(id);
    return id;
  };
  const open = (id, title, line, depth) => {
    current = { id: uniqueId(id), title: title.slice(0, 120), depth, path: headingPath.map((h) => h.title), line, text: [] };
    sections.push(current);
  };

  lines.forEach((raw, i) => {
    const line = raw.trim();
    const h = HEADING.exec(line);
    const n = h ? NUMBERED.exec(h[2].trim()) : NUMBERED.exec(line);
    if (h) {
      const depth = h[1].length;
      while (headingPath.length && headingPath.at(-1).depth >= depth) headingPath.pop();
      const title = h[2].trim();
      const app = /^(?:Приложение|Appendix)\s+(\w+)/i.exec(title);
      open(n ? `S${n[1]}` : app ? `A${app[1]}` : `S${++seq}h`, title, i + 1, depth);
      headingPath.push({ depth, title });
      return;
    }
    if (n && !/^\d{1,2}\.\d{1,2}\.\d{2,4}/.test(line)) {
      // нумерованный пункт регламента — отдельный якорь (даты вида 01.02.2026 не считаются)
      open(`S${n[1]}`, line, i + 1, 7);
      current.text.push(line);
      return;
    }
    if (!current) open('S0', '(преамбула)', i + 1, 0);
    current.text.push(raw.replace(/\s+$/, ''));
  });

  return sections
    .map((s) => ({ ...s, text: s.text.join('\n').trim() }))
    .filter((s) => s.text || s.depth < 7);
}

// Markdown для чтения агентом: каждый раздел помечен [§id].
export function toAnnotatedMarkdown({ doc, sections }) {
  const out = [`<!-- doc: ${doc} | разделы помечены [§id] — используйте id в source.section -->`, ''];
  for (const s of sections) {
    if (s.depth >= 1 && s.depth <= 6) out.push(`${'#'.repeat(s.depth)} [§${s.id}] ${s.title}`);
    if (s.text) out.push(s.depth === 7 ? `[§${s.id}] ${s.text}` : s.text);
    out.push('');
  }
  return out.join('\n');
}

export function htmlToMarkdown(html) {
  const decode = (s) =>
    s
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ')
      .trim();
  return html
    .replace(/<table[^>]*>([\s\S]*?)<\/table>/g, (_, body) =>
      '\n' +
      [...body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)]
        .map((r) => '| ' + [...r[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((c) => decode(c[1])).join(' | ') + ' |')
        .join('\n') +
      '\n'
    )
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/g, (_, d, t) => `\n${'#'.repeat(+d)} ${decode(t)}\n`)
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/g, (_, t) => `\n- ${decode(t)}`)
    .replace(/<p[^>]*>([\s\S]*?)<\/p>/g, (_, t) => `\n${decode(t)}\n`)
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Проверка цитат: есть ли quote дословно (с точностью до пробелов/регистра/кавычек) в документе.
const norm = (s) => s.toLowerCase().replace(/[«»"“”„]/g, '"').replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();

export function findQuote(extracted, quote, sectionId) {
  const q = norm(quote);
  const hit = extracted.sections.find((s) => norm(`${s.title}\n${s.text}`).includes(q));
  if (!hit) return { found: false };
  return { found: true, section: hit.id, sectionMatches: !sectionId || hit.id === sectionId };
}
