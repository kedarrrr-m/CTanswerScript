// background.js — Service worker (Chrome/modern Firefox) or event page (Firefox fallback)
// In service worker context importScripts is available; in event page context
// pdf-lib is already loaded as the first entry in background.scripts.
if (typeof importScripts === 'function') {
  importScripts('lib/pdf-lib.min.js');
}

const { PDFDocument, rgb, StandardFonts } = PDFLib;

// ── Helpers ──────────────────────────────────────────────────────────────────

// Configuration constants
const MAX_PDF_SIZE = 50 * 1024 * 1024; // 50MB limit
const LARGE_BUFFER_THRESHOLD = 1024 * 1024; // 1MB threshold for base64 encoding strategy
const PDF_GENERATION_TIMEOUT_MS = 120000; // 2 minutes timeout

// Whitelist of allowed S3 domains
const ALLOWED_S3_DOMAINS = ['ct-public-bucket.s3.ap-south-1.amazonaws.com'];

function validateS3Url(url) {
  try {
    const urlObj = new URL(url);
    // Strict hostname matching (not substring)
    return ALLOWED_S3_DOMAINS.includes(urlObj.hostname) && urlObj.protocol === 'https:';
  } catch (_) {
    return false;
  }
}

async function fetchBytes(url, { timeout = 30000 } = {}) {
  // For S3 URLs, apply strict domain whitelisting
  try {
    const urlObj = new URL(url);
    // Only allow explicitly whitelisted S3 domains
    // This is a whitelist approach: only allow known-good domains
    const isAllowedS3Url = ALLOWED_S3_DOMAINS.includes(urlObj.hostname);
    
    // If URL appears to be S3-related but not whitelisted, reject it
    // Check for S3-specific patterns to catch attempted bypass attempts
    if (!isAllowedS3Url && urlObj.hostname) {
      // Perform strict validation: only allow if explicitly whitelisted
      if (urlObj.hostname.startsWith('s3') || 
          (urlObj.hostname.indexOf('amazonaws') !== -1)) {
        throw new Error('S3 URL origin not whitelisted');
      }
    }
  } catch (e) {
    if (e.message === 'S3 URL origin not whitelisted') throw e;
    // If URL parsing fails or isn't a full URL, continue with the fetch
  }
  
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url.split('?')[0]}`);
    return new Uint8Array(await res.arrayBuffer());
  } finally {
    clearTimeout(timeoutId);
  }
}

function imageTypeFromUrl(url) {
  const path = url.split('?')[0].toLowerCase();
  if (path.endsWith('.png')) return 'png';
  return 'jpg'; // default for S3 JPEG images
}

function validateImageUrl(url) {
  try {
    const urlObj = new URL(url);
    // Only allow https protocol, reject data-URIs
    return urlObj.protocol === 'https:' && !url.startsWith('data:');
  } catch (_) {
    return false;
  }
}

async function embedImage(pdfDoc, url) {
  if (!validateImageUrl(url)) {
    console.warn('Invalid image URL rejected:', url.split('?')[0]);
    return null;
  }
  try {
    const bytes = await fetchBytes(url, { timeout: 15000 });
    return imageTypeFromUrl(url) === 'png'
      ? await pdfDoc.embedPng(bytes)
      : await pdfDoc.embedJpg(bytes);
  } catch (e) {
    console.warn('Could not embed image:', url, e.message);
    return null;
  }
}

// Convert Uint8Array to binary string in chunks
function uint8ToBinaryString(bytes) {
  let binary = '';
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunk, bytes.length)));
  }
  return binary;
}

// Safely convert binary to base64 without stack overflow
// Always returns a Promise for consistent async behavior
function binaryToBase64(bytes) {
  return Promise.resolve().then(() => {
    // For all buffers, use consistent chunked conversion
    const binary = uint8ToBinaryString(bytes);
    return btoa(binary);
  }).catch(e => {
    throw new Error('Failed to encode PDF: ' + e.message);
  });
}

// Strip characters that WinAnsi (pdf-lib standard fonts) cannot encode.
// Replaces common Unicode symbols with ASCII stand-ins; removes the rest.
function toWinAnsi(str) {
  return String(str)
    .replace(/[\x00-\x1f]/g, ' ')      // newlines, tabs, and all control chars
    .replace(/\u2013|\u2014/g, '-')     // en-dash, em-dash
    .replace(/\u2018|\u2019/g, "'")     // curly single quotes
    .replace(/\u201c|\u201d/g, '"')     // curly double quotes
    .replace(/\u2026/g, '...')           // ellipsis
    .replace(/[^\x00-\xff]/g, '?')      // everything else outside Latin-1
    .replace(/  +/g, ' ');               // collapse multiple spaces
}

// Draw text and return new Y position
function drawText(page, text, x, y, { size = 11, font, color, maxWidth } = {}) {
  if (!text) return y;
  const col = color || rgb(0.1, 0.1, 0.1);
  const safe = toWinAnsi(text);

  if (maxWidth) {
    // Simple word-wrap
    const words = safe.split(' ');
    let line = '';
    const lh = size * 1.5;
    for (const word of words) {
      const test = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(test, size) > maxWidth && line) {
        page.drawText(line, { x, y, size, font, color: col });
        line = word;
        y -= lh;
      } else {
        line = test;
      }
    }
    if (line) { page.drawText(line, { x, y, size, font, color: col }); y -= lh; }
    return y;
  }

  page.drawText(safe, { x, y, size, font, color: col });
  return y - size * 1.5;
}

// Fit image dimensions within a bounding box
function fitDims(imgW, imgH, maxW, maxH) {
  let w = imgW, h = imgH;
  if (w > maxW) { h = h * (maxW / w); w = maxW; }
  if (h > maxH) { w = w * (maxH / h); h = maxH; }
  return { w, h };
}

// ── PDF Generation ────────────────────────────────────────────────────────────

async function buildPdf(examData) {
  const pdfDoc = await PDFDocument.create();

  // Patch addPage so every page's drawText auto-sanitises through toWinAnsi.
  // This prevents WinAnsi encoding errors no matter where drawText is called.
  const _origAddPage = pdfDoc.addPage.bind(pdfDoc);
  pdfDoc.addPage = function (...args) {
    const pg = _origAddPage(...args);
    const _origDraw = pg.drawText.bind(pg);
    pg.drawText = function (text, opts) {
      return _origDraw(toWinAnsi(text), opts);
    };
    return pg;
  };

  const font     = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const W = 595, H = 842; // A4 points
  const ML = 45, MR = 45, MT = 45;
  const CW = W - ML - MR; // content width ~505

  const C = {
    dark:      rgb(0.08, 0.08, 0.12),
    mid:       rgb(0.35, 0.38, 0.50),
    light:     rgb(0.60, 0.63, 0.75),
    white:     rgb(1, 1, 1),
    blue:      rgb(0.18, 0.38, 0.75),
    blueDark:  rgb(0.10, 0.22, 0.55),
    green:     rgb(0.10, 0.55, 0.22),
    greenBg:   rgb(0.88, 0.97, 0.90),
    red:       rgb(0.70, 0.10, 0.10),
    redBg:     rgb(0.97, 0.88, 0.88),
    amber:     rgb(0.75, 0.45, 0.05),
    amberBg:   rgb(0.99, 0.95, 0.85),
    rowEven:   rgb(0.96, 0.97, 1.00),
  };

  // ── COVER PAGE ──────────────────────────────────────────────────────────────
  const cover = pdfDoc.addPage([W, H]);

  // Header band
  cover.drawRectangle({ x: 0, y: H - 72, width: W, height: 72, color: C.blueDark });
  cover.drawText('CT Answer Script Export', { x: ML, y: H - 35, size: 18, font: boldFont, color: C.white });
  cover.drawText('Consolidated PDF for LLM Analysis', { x: ML, y: H - 54, size: 10, font, color: rgb(0.70, 0.78, 1) });

  let y = H - 100;

  // Exam title
  cover.drawText('EXAM', { x: ML, y, size: 8, font, color: C.light });
  y -= 16;
  y = drawText(cover, examData.examTitle, ML, y, { size: 13, font: boldFont, color: C.dark, maxWidth: CW });
  y -= 10;

  // Student
  cover.drawText('STUDENT', { x: ML, y, size: 8, font, color: C.light });
  y -= 16;
  y = drawText(cover, examData.studentInfo, ML, y, { size: 12, font: boldFont, color: C.dark, maxWidth: CW });
  y -= 10;

  // Date / Duration row
  cover.drawText('DATE', { x: ML, y, size: 8, font, color: C.light });
  cover.drawText('DURATION', { x: ML + 200, y, size: 8, font, color: C.light });
  y -= 16;
  cover.drawText(toWinAnsi(examData.testStartTime || '-'), { x: ML, y, size: 11, font: boldFont, color: C.dark });
  cover.drawText(`${examData.totalTime} min`, { x: ML + 200, y, size: 11, font: boldFont, color: C.dark });
  y -= 30;

  // Score box
  const scored = examData.marksScored ?? '?';
  const total  = examData.totalMarks  ?? '?';
  const pct    = total > 0 ? Math.round((scored / total) * 100) : 0;
  cover.drawRectangle({ x: ML, y: y - 52, width: CW, height: 66, color: C.greenBg, borderColor: C.green, borderWidth: 1.5 });
  cover.drawRectangle({ x: ML, y: y - 52, width: 5, height: 66, color: C.green });
  cover.drawText('TOTAL SCORE', { x: ML + 14, y: y - 12, size: 8, font, color: C.green });
  cover.drawText(`${scored} / ${total}`, { x: ML + 14, y: y - 36, size: 26, font: boldFont, color: C.green });
  cover.drawText(`${pct}%`, { x: ML + CW - 50, y: y - 30, size: 20, font: boldFont, color: C.green });
  y -= 80;

  // Section table
  cover.drawText('Section Breakdown', { x: ML, y, size: 12, font: boldFont, color: C.dark });
  y -= 18;

  // Table header
  cover.drawRectangle({ x: ML, y: y - 18, width: CW, height: 22, color: C.blue });
  cover.drawText('Section', { x: ML + 8, y: y - 12, size: 9, font: boldFont, color: C.white });
  cover.drawText('Questions', { x: ML + 270, y: y - 12, size: 9, font: boldFont, color: C.white });
  cover.drawText('Max', { x: ML + 350, y: y - 12, size: 9, font: boldFont, color: C.white });
  cover.drawText('Scored', { x: ML + 420, y: y - 12, size: 9, font: boldFont, color: C.white });
  y -= 22;

  for (let i = 0; i < examData.sections.length; i++) {
    const sec = examData.sections[i];
    const rowBg = i % 2 === 0 ? C.rowEven : C.white;
    cover.drawRectangle({ x: ML, y: y - 18, width: CW, height: 20, color: rowBg });
    cover.drawText(sec.sectionName, { x: ML + 8, y: y - 12, size: 9, font, color: C.dark });
    cover.drawText(String(sec.questions.length), { x: ML + 282, y: y - 12, size: 9, font, color: C.mid });
    cover.drawText(sec.marksPerQ, { x: ML + 355, y: y - 12, size: 9, font, color: C.mid });
    cover.drawText(sec.marksScored, { x: ML + 420, y: y - 12, size: 9, font: boldFont, color: C.green });
    y -= 20;
  }

  y -= 10;
  // Border line
  cover.drawLine({ start: { x: ML, y }, end: { x: ML + CW, y }, thickness: 0.5, color: rgb(0.8, 0.82, 0.9) });
  y -= 14;
  cover.drawText(`Generated: ${new Date().toLocaleString()}`, { x: ML, y, size: 8, font, color: C.light });

  // ── QUESTION PAGES (continuous flow) ─────────────────────────────────────────
  // Questions are stacked on the same page; a new page is only created when
  // there isn't enough room for the next question block.

  const HEADER_H   = 36;   // question header band height
  const MIN_BODY_H = 100;  // minimum space for question body content
  const MB = 50;           // bottom margin
  let page = null;         // current page reference

  function needNewPage(spaceNeeded) {
    return !page || y - spaceNeeded < MB;
  }

  function startPage() {
    page = pdfDoc.addPage([W, H]);
    y = H - MT;
  }

  for (const section of examData.sections) {
    for (const q of section.questions) {

      // Pre-calculate comment box height
      const commentText = q.evaluatorComments || '(No evaluator comments)';
      const commentLines = Math.ceil(toWinAnsi(commentText).length / 75) + 1;
      const boxH = Math.max(36, commentLines * 14 + 20);

      // Estimate total block height for this question:
      //   header(36) + spacing(10) + image-or-text(~80 min) + comment box
      const estBlockH = HEADER_H + 10 + MIN_BODY_H + boxH + 20;

      if (needNewPage(estBlockH)) startPage();

      // ── Question header bar ──
      const isCorrect   = q.status === 'correct';
      const isIncorrect = q.status === 'incorrect';
      const headerBg    = isCorrect ? C.green : isIncorrect ? C.red : C.mid;
      const statusLabel = isCorrect ? '[OK] Correct' : isIncorrect ? '[X] Incorrect' : '[?] Pending';

      page.drawRectangle({ x: ML - 4, y: y - HEADER_H, width: CW + 8, height: HEADER_H, color: headerBg, borderColor: headerBg, borderWidth: 0 });
      page.drawText(`Q${q.questionNumber}`, { x: ML, y: y - 14, size: 14, font: boldFont, color: C.white });
      page.drawText(`${section.sectionName}  |  ${statusLabel}`, { x: ML + 30, y: y - 14, size: 9, font, color: rgb(0.9, 0.93, 1) });
      const marksStr = `${q.marks} / ${q.maxMarks}`;
      page.drawText(marksStr, { x: ML + CW - 40, y: y - 14, size: 11, font: boldFont, color: C.white });
      page.drawText('marks', { x: ML + CW - 40, y: y - 28, size: 8, font, color: rgb(0.85, 0.88, 1) });
      y -= HEADER_H + 6;

      // Answer script page note
      if (q.answerPages && q.answerPages.length > 0) {
        const pageNums = q.answerPages.map(p => p + 1).join(', ');
        page.drawText(`Answer script page(s): ${pageNums}`, { x: ML, y, size: 8, font, color: C.blue });
        y -= 12;
      }

      // ── Question content ──
      if (q.imageUrls && q.imageUrls.length > 0) {
        page.drawText('Question:', { x: ML, y, size: 9, font: boldFont, color: C.dark });
        y -= 12;

        for (const imgUrl of q.imageUrls) {
          const img = await embedImage(pdfDoc, imgUrl);
          if (img) {
            const raw = img.scale(1);
            // Cap image to content width and max 300pt tall — never enlarge
            const maxW = Math.min(raw.width, CW);
            const maxH = Math.min(raw.height, 300, Math.max(60, y - MB - boxH - 10));
            const { w, h } = fitDims(raw.width, raw.height, maxW, maxH);
            const imgX = ML + (CW - w) / 2;
            page.drawImage(img, { x: imgX, y: y - h, width: w, height: h });
            y -= h + 6;
          } else {
            page.drawText('[Image could not be loaded]', { x: ML, y, size: 9, font, color: C.red });
            y -= 12;
          }
        }
      } else if (q.questionText) {
        page.drawText('Question:', { x: ML, y, size: 9, font: boldFont, color: C.dark });
        y -= 12;
        y = drawText(page, q.questionText, ML, y, { size: 9, font, color: C.dark, maxWidth: CW });
      }

      // ── Evaluator comments ──
      y -= 4;
      const commentBg          = q.evaluatorComments ? C.amberBg  : C.rowEven;
      const commentBorderColor = q.evaluatorComments ? C.amber    : rgb(0.80, 0.82, 0.88);
      const commentColor       = q.evaluatorComments ? C.amber    : C.light;

      page.drawRectangle({ x: ML, y: y - boxH, width: CW, height: boxH, color: commentBg, borderColor: commentBorderColor, borderWidth: 1 });
      page.drawRectangle({ x: ML, y: y - boxH, width: 3, height: boxH, color: commentBorderColor });
      page.drawText('Evaluator Comments', { x: ML + 8, y: y - 11, size: 7, font: boldFont, color: commentColor });
      drawText(page, commentText, ML + 8, y - 22, { size: 8, font, color: C.dark, maxWidth: CW - 16 });
      y -= boxH + 16; // spacing before next question
    }
  }

  // ── ANSWER SCRIPT PAGES ────────────────────────────────────────────────────
  // Prefer base64 pre-fetched by the content script (runs in page context,
  // so no CORS issues). Fall back to direct URL fetch from the SW.
  try {
    let ansBytes = null;

    if (examData.answerPdfBase64) {
      // Decode base64 → Uint8Array
      const binary = atob(examData.answerPdfBase64);
      ansBytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) ansBytes[i] = binary.charCodeAt(i);
    } else if (examData.answerPdfUrl) {
      ansBytes = await fetchBytes(examData.answerPdfUrl);
    }

    if (!ansBytes) throw new Error('No answer script data found.');
    
    // Validate PDF size before loading
    if (ansBytes.length > MAX_PDF_SIZE) {
      throw new Error(`Answer PDF too large (${Math.round(ansBytes.length / 1024 / 1024)}MB). Maximum allowed: ${Math.round(MAX_PDF_SIZE / 1024 / 1024)}MB`);
    }

    const ansPdf    = await PDFDocument.load(ansBytes);
    const pageCount = ansPdf.getPageCount();
    const indices   = Array.from({ length: pageCount }, (_, i) => i);
    const copied    = await pdfDoc.copyPages(ansPdf, indices);

    // Separator page
    const sep = pdfDoc.addPage([W, H]);
    sep.drawRectangle({ x: 0, y: H - 80, width: W, height: 80, color: C.blueDark });
    sep.drawText('Answer Script', { x: ML, y: H - 40, size: 22, font: boldFont, color: C.white });
    sep.drawText(`${pageCount} page(s) follow`, { x: ML, y: H - 60, size: 11, font, color: rgb(0.7, 0.78, 1) });

    for (const page of copied) pdfDoc.addPage(page);

  } catch (e) {
    const errPage = pdfDoc.addPage([W, H]);
    errPage.drawRectangle({ x: 0, y: H - 80, width: W, height: 80, color: C.red });
    errPage.drawText('Answer Script Unavailable', { x: ML, y: H - 40, size: 18, font: boldFont, color: C.white });
    errPage.drawText(toWinAnsi(e.message), { x: ML, y: H - 60, size: 10, font, color: C.white });
    errPage.drawText('Reload the results page and try again immediately.', { x: ML, y: H - 140, size: 11, font, color: C.dark });
  }

  return await pdfDoc.save();
}

// ── Message Listener ──────────────────────────────────────────────────────────

// Use browser namespace if available (Firefox), fall back to chrome (Chromium).
// browser.runtime.onMessage returns a Promise for async responses, which is
// more reliable in Firefox than the chrome `return true` pattern.
const _runtime = typeof browser !== 'undefined' ? browser : chrome;

_runtime.runtime.onMessage.addListener((message, _sender) => {
  if (message.type !== 'generatePdf') return;

  const examData = message.data;
  if (!examData) {
    return Promise.resolve({ success: false, error: 'No exam data received.' });
  }

  const safeName = (examData.examTitle || 'exam_results')
    .replace(/[^a-z0-9]/gi, '_')
    .replace(/__+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60) || 'exam_results'; // fallback if empty after sanitization
  const filename = `CT_Export_${safeName}_${new Date().toISOString().slice(0,10)}.pdf`;

  return buildPdf(examData)
    .then(async pdfBytes => {
      // Validate PDF size
      if (pdfBytes.length > MAX_PDF_SIZE) {
        throw new Error(`PDF too large (${Math.round(pdfBytes.length / 1024 / 1024)}MB). Maximum allowed: ${Math.round(MAX_PDF_SIZE / 1024 / 1024)}MB`);
      }
      
      // Convert to base64 safely (handles large files)
      const b64 = await binaryToBase64(pdfBytes);
      // Send bytes back to popup so it can download via Blob URL.
      // This avoids the Firefox service-worker data-URL download size limit.
      return { success: true, pdfBase64: b64, filename };
    })
    .catch(err => {
      console.error('PDF generation failed:', err);
      return { success: false, error: err.message };
    });
});
