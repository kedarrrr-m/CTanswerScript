// popup.js — Controls the popup UI state and bridges to background.js

const states = ['invalid', 'ready', 'progress', 'error', 'done'];
const PDF_GENERATION_TIMEOUT_MS = 120000; // 2 minutes timeout
const PDF_PREFETCH_TIMEOUT_MS = 15000; // 15 seconds for prefetch
const MAX_PDF_SIZE = 50 * 1024 * 1024; // 50MB limit

function showState(name) {
  states.forEach(s => {
    document.getElementById(`state-${s}`).classList.toggle('active', s === name);
  });
}

function setProgress(pct, stepText) {
  document.getElementById('progress-fill').style.width = `${pct}%`;
  document.getElementById('progress-step').textContent = stepText;
}

function showError(msg) {
  document.getElementById('error-msg').textContent = msg;
  showState('error');
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// ── Inject extraction function into the page (MAIN world) ──
async function extractFromPage(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: async () => {
      // Validate testSummary structure
      const ts = window.testSummary;
      if (!ts || typeof ts !== 'object') return null;
      
      // Validate required properties exist
      if (typeof ts.userMarks === 'undefined' || typeof ts.totalMarks === 'undefined') return null;

      // Safely validate qidVsPageNum
      const qidVsPageNum = (window.qidVsPageNum && typeof window.qidVsPageNum === 'object') ? window.qidVsPageNum : {};

      const examData = {
        examTitle: document.querySelector('.card-header.bg-dark h5 span')?.innerText?.trim() || 'Unknown Exam',
        studentInfo: (() => {
          const spans = document.querySelectorAll('.card-header.bg-dark h5 span');
          return spans[spans.length - 1]?.innerText?.trim() || '';
        })(),
        testStartTime: document.getElementById('testStartTime')?.innerText?.trim() || '',
        marksScored: ts.userMarks,
        totalMarks: ts.totalMarks,
        totalTime: ts.totalTime,
        answerPdfUrl: ts.uploadedFileDetails?.s3path || null,
        answerPdfBase64: null,
        qidVsPageNum,
        sections: []
      };

      const sectionCards = document.querySelectorAll('.userScore.card.border-info.m-2');
      for (const sCard of sectionCards) {
        const sectionName = sCard.querySelector('.userScore.card-header.bg-info span.pull-left')?.innerText?.trim() || '';
        const badges = sCard.querySelectorAll('.badge.label-info');
        const marksPerQ = badges[0]?.innerText?.trim() || '';
        const marksScored = badges[badges.length - 1]?.innerText?.trim() || '';

        const sectionData = { sectionName, marksPerQ, marksScored, questions: [] };

        const qCards = sCard.querySelectorAll('.card.m-1');
        for (const card of qCards) {
          const qNumber = card.querySelector('.col-1.col-lg-1.text-left.p-0')?.innerText?.trim();
          if (!qNumber || !/^\d+$/.test(qNumber)) continue;

          const btn = card.querySelector('[data-qid]');
          const qid = btn?.getAttribute('data-qid') || '';

          const marksEl = card.querySelectorAll('.col-2.col-lg-2.text-center.p-0 span');
          const marks = marksEl[marksEl.length - 1]?.innerText?.trim() || '';

          const statusIcon = card.querySelector('.userScore.fa');
          let status = 'pending';
          if (statusIcon) {
            if (statusIcon.classList.contains('fa-check')) status = 'correct';
            else if (statusIcon.classList.contains('fa-times')) status = 'incorrect';
            else if (statusIcon.classList.contains('fa-minus')) status = 'skipped';
          }

          const qBody = card.querySelector('.questionText.ql-editor');
          // Validate and filter image URLs
          const imageUrls = qBody ? [...qBody.querySelectorAll('img')]
            .map(i => i.src)
            .filter(src => {
              try {
                const url = new URL(src);
                return url.protocol === 'https:' && !src.startsWith('data:');
              } catch (_) {
                return false;
              }
            }) : [];
          const questionText = qBody?.innerText?.trim() || '';

          // Safely extract maxMarks with validation
          let maxMarks = '?';
          if (ts.questionPaper && typeof ts.questionPaper === 'object') {
            const qMap = ts.questionPaper.questionsMap;
            if (qMap && typeof qMap === 'object' && qid in qMap && qMap[qid]?.marks) {
              maxMarks = qMap[qid].marks;
            } else {
              const sMap = ts.questionPaper.sectionsMap;
              if (sMap && typeof sMap === 'object') {
                const section = Object.values(sMap).find(s => 
                  s?.questionIdsArr && Array.isArray(s.questionIdsArr) && s.questionIdsArr.includes(qid)
                );
                if (section?.marksPerQuestion) {
                  maxMarks = section.marksPerQuestion;
                }
              }
            }
          }

          const evaluatorComments = document.getElementById(`comments-${qid}`)?.value?.trim() || '';
          const answerPages = qidVsPageNum[qid] || [];

          sectionData.questions.push({
            questionNumber: qNumber, qid, marks, maxMarks,
            status, imageUrls, questionText, evaluatorComments, answerPages
          });
        }
        examData.sections.push(sectionData);
      }

      // Pre-fetch the answer PDF from the page context.
      // Running inside the page means the signed S3 URL is fetched with the
      // same origin/cookies as the page itself — no CORS issues.
      const pdfUrl = ts.uploadedFileDetails?.s3path;
      if (pdfUrl && typeof pdfUrl === 'string') {
        try {
          // Add timeout to prefetch (15 seconds)
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), PDF_PREFETCH_TIMEOUT_MS);
          
          const res = await fetch(pdfUrl, { signal: controller.signal });
          clearTimeout(timeoutId);
          
          if (res.ok) {
            const buf   = await res.arrayBuffer();
            const u8    = new Uint8Array(buf);
            
            // Size check
            if (u8.length > MAX_PDF_SIZE) {
              console.warn('CT Exporter: PDF too large, skipping prefetch');
            } else {
              let binary  = '';
              const chunk = 8192;
              for (let i = 0; i < u8.length; i += chunk) {
                binary += String.fromCharCode(...u8.subarray(i, Math.min(i + chunk, u8.length)));
              }
              examData.answerPdfBase64 = btoa(binary);
            }
          }
        } catch (e) {
          console.warn('CT Exporter: could not pre-fetch answer PDF:', e.message);
        }
      }

      return examData;
    }
  });
  return results?.[0]?.result ?? null;
}

// ── Init popup ──
(async () => {
  const tab = await getActiveTab();
  if (!tab) { showState('invalid'); return; }

  // Quick check: is this a CT results page?
  let examData = null;
  try {
    examData = await extractFromPage(tab.id);
  } catch (_) { /* scripting permission might not apply on this URL */ }

  if (!examData) {
    showState('invalid');
    return;
  }

  // Populate ready state
  document.getElementById('popup-exam-title').textContent = examData.examTitle;
  document.getElementById('popup-student').textContent = examData.studentInfo;
  showState('ready');

  // ── Generate button ──
  document.getElementById('btn-generate').addEventListener('click', async () => {
    showState('progress');
    setProgress(5, 'Extracting exam data from page…');

    try {
      // Re-extract fresh (in case page updated)
      const freshData = await extractFromPage(tab.id);
      if (!freshData) throw new Error('Could not read exam data. Are you on the results page?');
      if (!freshData.answerPdfUrl) throw new Error('Answer script PDF URL not found on page.');

      setProgress(20, 'Fetching answer script PDF from page…');

      // Ask background to build the PDF (it fetches S3 resources and runs pdf-lib).
      // Use browser namespace if available (Firefox), fall back to chrome (Chromium).
      const _rt = typeof browser !== 'undefined' ? browser : chrome;
      
      // Simulate progress ticks while background works
      const progressPromise = (async () => {
        const steps = [
          [40,  'Downloading question images…'],
          [60,  'Building cover & question pages…'],
          [80,  'Merging answer script pages…'],
          [93,  'Finalising PDF…'],
        ];
        for (const [pct, label] of steps) {
          await new Promise(r => setTimeout(r, 1800));
          // Don't overwrite done/error state if already resolved
          const progressEl = document.getElementById('state-progress');
          if (progressEl && progressEl.classList.contains('active')) {
            setProgress(pct, label);
          }
        }
      })();
      
      // Use proper async/await to avoid race conditions
      const response = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error(`PDF generation timeout (exceeded ${PDF_GENERATION_TIMEOUT_MS / 1000} seconds)`));
        }, PDF_GENERATION_TIMEOUT_MS);
        
        _rt.runtime.sendMessage({ type: 'generatePdf', data: freshData })
          .then(resp => {
            clearTimeout(timeout);
            resolve(resp);
          })
          .catch(err => {
            clearTimeout(timeout);
            reject(err);
          });
      });
      
      // Wait for progress simulation to complete (won't prevent early completion)
      await progressPromise.catch(() => {}); // ignore progress errors
      
      if (!response?.success) {
        throw new Error(response?.error || 'Unknown error during PDF generation.');
      }
      
      // Trigger download via Blob URL — works cross-browser without size limits.
      const bytes = Uint8Array.from(atob(response.pdfBase64), c => c.charCodeAt(0));
      const blob = new Blob([bytes], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = response.filename;
      a.click();
      URL.revokeObjectURL(url);
      showState('done');

    } catch (err) {
      showError(err.message);
    }
  });

  // Retry button
  document.getElementById('btn-retry').addEventListener('click', () => {
    showState('ready');
  });

  // Theme Toggle
  const themeToggle = document.getElementById('theme-toggle');
  const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  let isDark = localStorage.getItem('theme') === 'dark' || (!localStorage.getItem('theme') && prefersDark);

  function applyTheme() {
    document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light');
    themeToggle.textContent = isDark ? '☀️' : '🌙';
  }

  applyTheme();

  themeToggle.addEventListener('click', () => {
    isDark = !isDark;
    localStorage.setItem('theme', isDark ? 'dark' : 'light');
    applyTheme();
  });
})();
