/**
 * Fixed HTML renderer for research reports. Pure and dependency-free on
 * purpose: every model-authored string is escaped, the only markup that can
 * appear comes from the tiny markdown converter below, and the document
 * embeds zero scripts and zero external resources — it must be safe inside
 * a fully sandboxed iframe and as a standalone file.
 */

export interface ResearchReportSection {
  heading: string
  markdown: string
  /** Source numbers (1-based) this section leans on; index report.sources. */
  citations: number[]
}

export interface ResearchReportSource {
  id: number
  url: string
  title: string | null
  /** og:image from the visit step; optional so pre-P2-8 reports still render. */
  imageUrl?: string | null
}

export interface ResearchReport {
  title: string
  sections: ResearchReportSection[]
  sources: ResearchReportSource[]
}

export interface ReportMeta {
  question: string
  /** Unix ms. */
  generatedAt: number
}

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
}

// NUL delimits renderInline's placeholder tokens; model text can smuggle it in
// via JSON "\u0000" escapes, so it must never survive into the escaped text.
const escapeHtml = (text: string): string =>
  text.replace(/\u0000/g, '').replace(/[&<>"']/g, (c) => ESCAPES[c])

/**
 * Inline markdown over ALREADY-ESCAPED text: code, bold, italic, links,
 * [n] citation anchors. Link hrefs stay escaped (&amp; is correct inside an
 * attribute) and only http(s) targets become anchors. Generated code and link
 * spans are stashed behind \u0000-delimited placeholders so later passes never
 * rewrite their contents — code stays literal, and the [n] citation pass
 * cannot mangle hrefs containing bracketed numbers (escapeHtml strips NUL, so
 * placeholders are collision-free).
 */
const renderInline = (escaped: string, validCitations: ReadonlySet<number>): string => {
  const stash: string[] = []
  const keep = (html: string): string => `\u0000${stash.push(html) - 1}\u0000`
  let html = escaped
    .replace(/`([^`]+)`/g, (_m, code: string) => keep(`<code>${code}</code>`))
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*\s][^*]*)\*/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_m, text: string, url: string) =>
      // target=_blank: in the sandboxed iframe a plain click would navigate
      // the frame itself (blank white); _blank routes through the window-open
      // handler, which opens the system browser.
      keep(`<a href="${url}" target="_blank" rel="noreferrer">${text}</a>`)
    )
    .replace(/\[(\d{1,3})\]/g, (match, n: string) =>
      validCitations.has(Number(n)) ? `<sup><a class="cite" href="#src-${n}">[${n}]</a></sup>` : match
    )
  // A stashed link can carry a stashed code span in its text — restore until done.
  while (/\u0000\d+\u0000/.test(html)) {
    html = html.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => stash[Number(i)] ?? '')
  }
  return html
}

/** Block-level pass: headings, bullet/numbered lists, paragraphs. */
const renderMarkdown = (markdown: string, validCitations: ReadonlySet<number>): string => {
  const blocks = markdown.replace(/\r\n/g, '\n').split(/\n{2,}/)
  const html: string[] = []
  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.trim().length > 0)
    if (lines.length === 0) continue
    const inline = (line: string): string => renderInline(escapeHtml(line), validCitations)

    if (lines.every((l) => /^\s*[-*]\s+/.test(l))) {
      const items = lines.map((l) => `<li>${inline(l.replace(/^\s*[-*]\s+/, ''))}</li>`)
      html.push(`<ul>${items.join('')}</ul>`)
    } else if (lines.every((l) => /^\s*\d+[.)]\s+/.test(l))) {
      const items = lines.map((l) => `<li>${inline(l.replace(/^\s*\d+[.)]\s+/, ''))}</li>`)
      html.push(`<ol>${items.join('')}</ol>`)
    } else if (/^#{1,6}\s+/.test(lines[0]) && lines.length === 1) {
      html.push(`<h3>${inline(lines[0].replace(/^#{1,6}\s+/, ''))}</h3>`)
    } else {
      html.push(`<p>${lines.map(inline).join('<br>')}</p>`)
    }
  }
  return html.join('\n')
}

const CSS = `
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 40px 24px 64px;
    background: #101013; color: #e4e4e7;
    font: 15px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
  }
  main { max-width: 760px; margin: 0 auto; }
  h1 { font-size: 26px; line-height: 1.25; margin: 0 0 6px; color: #fafafa; }
  .meta { color: #8d8d93; font-size: 13px; margin: 0 0 28px; }
  section { margin: 0 0 28px; }
  h2 { font-size: 18px; margin: 0 0 10px; color: #f4f4f5; border-bottom: 1px solid #27272a; padding-bottom: 6px; }
  h3 { font-size: 15px; margin: 16px 0 6px; color: #f4f4f5; }
  p { margin: 0 0 10px; }
  ul, ol { margin: 0 0 10px; padding-left: 22px; }
  li { margin: 2px 0; }
  a { color: #93b8f8; text-decoration: none; }
  a:hover { text-decoration: underline; }
  sup { line-height: 0; }
  a.cite { color: #8d8d93; font-size: 11px; }
  code {
    background: #1c1c21; border: 1px solid #2a2a30; border-radius: 4px;
    padding: 1px 5px; font: 12.5px/1.5 "SF Mono", ui-monospace, Menlo, monospace;
  }
  .section-cites { color: #8d8d93; font-size: 12px; margin-top: 6px; }
  .hero {
    display: block; width: 100%; max-height: 300px; object-fit: cover;
    border-radius: 12px; margin: 0 0 24px; background: #1c1c21;
  }
  .sources { border-top: 1px solid #27272a; padding-top: 18px; }
  .sources h2 { border: none; padding: 0; }
  .sources ol { padding-left: 26px; }
  .sources li { margin: 6px 0; font-size: 13.5px; overflow: hidden; }
  .src-thumb {
    float: left; width: 64px; height: 44px; object-fit: cover;
    border-radius: 6px; margin: 2px 10px 2px 0; background: #1c1c21;
  }
  .src-url { display: block; color: #8d8d93; font-size: 12px; word-break: break-all; }
  @media print {
    :root { color-scheme: light; }
    body { background: #ffffff; color: #18181b; }
    h1, h2, h3 { color: #09090b; }
    h2, .sources { border-color: #d4d4d8; }
    a { color: #1d4ed8; }
    code { background: #f4f4f5; border-color: #e4e4e7; color: #18181b; }
    .meta, .section-cites, a.cite, .src-url { color: #52525b; }
  }
`

/** https-only image url, escaped for an attribute; null filters everything else. */
const imageSrc = (raw: string | null | undefined): string | null =>
  raw && /^https:\/\//i.test(raw) ? escapeHtml(raw) : null

/** Render the whole report document. Everything model-authored goes through escapeHtml. */
export function renderReportHtml(report: ResearchReport, meta: ReportMeta): string {
  const valid = new Set(report.sources.map((s) => s.id))

  // Hero: the first CITED source carrying an og:image. No scripts run in the
  // sandboxed iframe, so a broken url shows as an empty CSS-bounded box.
  const citedIds = new Set(report.sections.flatMap((s) => s.citations))
  const heroSrc = imageSrc(
    report.sources.find((s) => citedIds.has(s.id) && imageSrc(s.imageUrl))?.imageUrl
  )
  const hero = heroSrc ? `<img class="hero" src="${heroSrc}" alt="" loading="lazy">` : ''

  const sections = report.sections
    .map((section) => {
      const cites = section.citations.filter((n) => valid.has(n))
      const citeLine =
        cites.length > 0
          ? `<div class="section-cites">Sources: ${cites
              .map((n) => `<a class="cite" href="#src-${n}">[${n}]</a>`)
              .join(' ')}</div>`
          : ''
      return [
        '<section>',
        `<h2>${renderInline(escapeHtml(section.heading), valid)}</h2>`,
        renderMarkdown(section.markdown, valid),
        citeLine,
        '</section>'
      ].join('\n')
    })
    .join('\n')

  const sources = report.sources
    .map((src) => {
      const href = /^https?:\/\//.test(src.url) ? escapeHtml(src.url) : null
      const label = escapeHtml(src.title?.trim() || src.url)
      const urlLine = href ? `<span class="src-url">${href}</span>` : ''
      const thumbSrc = imageSrc(src.imageUrl)
      const thumb = thumbSrc ? `<img class="src-thumb" src="${thumbSrc}" alt="" loading="lazy">` : ''
      return `<li id="src-${src.id}" value="${src.id}">${thumb}${
        href ? `<a href="${href}" target="_blank" rel="noreferrer">${label}</a>` : label
      }${urlLine}</li>`
    })
    .join('\n')

  const generated = new Date(meta.generatedAt).toLocaleString()

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(report.title)}</title>
<style>${CSS}</style>
</head>
<body>
<main>
<h1>${escapeHtml(report.title)}</h1>
<p class="meta">${escapeHtml(meta.question)} · ${escapeHtml(generated)}</p>
${hero}
${sections}
<section class="sources">
<h2>Sources</h2>
<ol>
${sources}
</ol>
</section>
</main>
</body>
</html>
`
}
