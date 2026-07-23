const STATE_KEY = "__doubaoSourceState";
const TIMER_KEY = "__doubaoSourceTimer";
const SAVE_KEYWORDS = ["参考", "来源", "资料", "搜索", "引用", "网页", "文章", "网站"];
const DATE_PATTERNS = [
  /\b(20\d{2})[年/-](\d{1,2})[月/-](\d{1,2})日?\b/,
  /\b(20\d{2})[./-](\d{1,2})[./-](\d{1,2})\b/,
  /\b(20\d{2})年\b/,
  /\b(20\d{2})\b/
];

function normalizeText(value) {
  return (value || "").replace(/\s+/g, " ").trim();
}

function getText(node) {
  return normalizeText(node?.innerText || node?.textContent || "");
}

function normalizeUrl(url) {
  if (!url) return "";
  try {
    return new URL(url, location.href).toString();
  } catch {
    return "";
  }
}

function shortText(value, max = 200) {
  return normalizeText(value).slice(0, max);
}

function isVisible(el) {
  if (!el || !el.getBoundingClientRect) return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 40 && rect.height > 16;
}

function inMainColumn(el) {
  const rect = el.getBoundingClientRect();
  return rect.left > 180 && rect.width > 320 && rect.top > 40;
}

function unique(items, keyFn) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    const key = keyFn(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function looksLikeSourceArea(text) {
  return SAVE_KEYWORDS.some((keyword) => text.includes(keyword));
}

function guessWebsiteFromUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function extractDate(text) {
  const normalized = normalizeText(text);
  for (const pattern of DATE_PATTERNS) {
    const match = normalized.match(pattern);
    if (match) {
      if (match.length >= 4 && match[2] && match[3]) {
        const year = match[1];
        const month = String(match[2]).padStart(2, "0");
        const day = String(match[3]).padStart(2, "0");
        return `${year}-${month}-${day}`;
      }
      return match[0];
    }
  }
  return "";
}

function extractAuthor(text) {
  const patterns = [
    /作者[:：]\s*([^\s，。；;]{2,20})/,
    /编辑[:：]\s*([^\s，。；;]{2,20})/,
    /来源[:：]\s*([^\s，。；;]{2,20})/
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return match[1].trim();
  }
  return "";
}

function extractLinks(root) {
  const anchors = [...root.querySelectorAll("a[href]")];
  return unique(
    anchors.map((a) => {
      const href = normalizeUrl(a.getAttribute("href"));
      const title = shortText(getText(a), 180);
      if (!href || !title) return null;
      const context = shortText(getText(a.closest("article, section, li, div") || a.parentElement || a), 320);
      return {
        title,
        url: href,
        sourceText: context,
        sourceWebsite: guessWebsiteFromUrl(href),
        sourceAuthor: extractAuthor(context),
        sourceDate: extractDate(context)
      };
    }).filter(Boolean),
    (item) => item.url || `${item.title}|${item.sourceText}`
  );
}

function getMainContentRoot() {
  const candidates = [...document.querySelectorAll("main, article, [role='main'], section, div")].filter((el) => {
    if (!isVisible(el) || !inMainColumn(el)) return false;
    const t = getText(el);
    return t.length > 200;
  });

  const ranked = candidates
    .map((el) => {
      const rect = el.getBoundingClientRect();
      const text = getText(el);
      const score = text.length + Math.max(0, 1200 - rect.left) + Math.max(0, 900 - rect.top);
      return { el, score };
    })
    .sort((a, b) => b.score - a.score);

  return ranked[0]?.el || document.body;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clickSourceExpanders() {
  const nodes = [...document.querySelectorAll("button, a, div, span")];
  const targets = nodes.filter((el) => {
    if (!isVisible(el) || !inMainColumn(el)) return false;
    const t = getText(el);
    return /参考\s*\d*\s*篇资料|参考资料|来源\s*\d*|搜索\s*\d*个关键词/.test(t);
  });

  for (const el of targets.slice(0, 5)) {
    try {
      el.click();
    } catch {
      // noop
    }
  }
}

function ensureBadge(message) {
  let badge = document.getElementById("__doubao_source_badge");
  if (!badge) {
    badge = document.createElement("div");
    badge.id = "__doubao_source_badge";
    badge.style.cssText = [
      "position:fixed",
      "right:16px",
      "bottom:16px",
      "z-index:2147483647",
      "background:rgba(0,0,0,0.85)",
      "color:#fff",
      "font-size:12px",
      "padding:8px 10px",
      "border-radius:8px",
      "max-width:280px",
      "line-height:1.4",
      "pointer-events:none"
    ].join(";");
    document.documentElement.appendChild(badge);
  }
  badge.textContent = message;
}

function collectSourceBlocks() {
  const blocks = [];
  const root = getMainContentRoot();
  const candidates = [...root.querySelectorAll("*")].filter((el) => {
    const t = getText(el);
    return t.length >= 6 && isVisible(el) && inMainColumn(el);
  });

  for (const el of candidates.slice(0, 20)) {
    const links = extractLinks(el);
    if (!links.length) continue;
    const text = getText(el);
    if (!looksLikeSourceArea(text) && !/参考\s*\d+\s*篇资料|搜索\s*\d+\s*个关键词|参考\s*\d+\s*篇/.test(text)) continue;
    blocks.push({
      heading: shortText(text, 160),
      links
    });
  }

  if (!blocks.length) {
    const fallback = extractLinks(root).filter((item) => !/^(豆包|AI 创作|云盘|新对话|主对话)$/.test(item.title)).slice(0, 20);
    if (fallback.length) {
      blocks.push({
        heading: shortText(document.title || "豆包来源"),
        links: fallback
      });
    }
  }

  return blocks;
}

function collectTextBlocks() {
  const blocks = [];
  const root = getMainContentRoot();
  const nodes = [...root.querySelectorAll("*")];
  for (const el of nodes) {
    if (!isVisible(el) || !inMainColumn(el)) continue;
    const t = getText(el);
    if (t.length < 8 || t.length > 1600) continue;
    if (looksLikeSourceArea(t)) continue;
    const rect = el.getBoundingClientRect();
    blocks.push({
      el,
      text: t,
      top: rect.top,
      left: rect.left,
      width: rect.width,
      height: rect.height
    });
  }
  return unique(blocks, (item) => `${item.text}|${Math.round(item.top)}|${Math.round(item.left)}`);
}

function guessQuestion() {
  const blocks = collectTextBlocks()
    .filter((item) => item.text.length <= 260)
    .filter((item) => /[？?]/.test(item.text) || item.text.includes("推荐") || item.text.includes("怎么") || item.text.includes("如何") || item.text.includes("哪"))
    .sort((a, b) => a.top - b.top);
  return shortText(blocks[0]?.text || "", 240);
}

function guessAnswer() {
  const blocks = collectTextBlocks()
    .filter((item) => item.text.length >= 20)
    .sort((a, b) => a.top - b.top);
  const question = guessQuestion();
  const likely = blocks
    .filter((item) => item.text !== question)
    .map((item) => {
      const score = item.text.length + Math.max(0, 900 - item.top) + (item.text.includes("AI生成") ? -120 : 0);
      return { text: item.text, score };
    })
    .sort((a, b) => b.score - a.score);
  return shortText(likely[0]?.text || "", 1200);
}

async function buildRecord(reason = "auto") {
  clickSourceExpanders();
  await sleep(800);
  clickSourceExpanders();
  await sleep(500);
  const blocks = collectSourceBlocks();
  if (!blocks.length) return null;

  const question = guessQuestion();
  const answer = guessAnswer();
  const sources = blocks.flatMap((block) =>
    block.links.map((link) => ({
      sourceTitle: link.title,
      sourceWebsite: link.sourceWebsite || guessWebsiteFromUrl(link.url),
      sourceAuthor: link.sourceAuthor || "",
      sourceDate: link.sourceDate || "",
      sourceUrl: link.url,
      sourceContext: link.sourceText,
      sourceBlock: block.heading
    }))
  );

  return {
    id: crypto.randomUUID(),
    capturedAt: new Date().toISOString(),
    pageUrl: location.href,
    pageTitle: document.title,
    reason,
    question,
    answer,
    sources,
    blocks
  };
}

async function saveSnapshot(reason = "auto") {
  const resolvedPayload = await buildRecord(reason);
  if (!resolvedPayload) {
    ensureBadge("扩展已注入，但这页没有识别到可保存的来源块。");
    return { ok: false, saved: false, reason: "no_blocks" };
  }
  const response = await chrome.runtime.sendMessage({
    type: "SAVE_RECORD",
    payload: resolvedPayload
  });
  ensureBadge(`已抓取：${resolvedPayload.sources.length} 条来源`);
  return { ok: true, saved: true, count: response?.count || 0, skipped: response?.skipped || false };
}

function scheduleCapture() {
  clearTimeout(window[TIMER_KEY]);
  window[TIMER_KEY] = setTimeout(() => {
    saveSnapshot("mutation").catch(() => {});
  }, 1200);
}

if (!window[STATE_KEY]) {
  window[STATE_KEY] = true;

  const observer = new MutationObserver(scheduleCapture);
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true
  });

  document.addEventListener(
    "click",
    (event) => {
      const target = event.target;
      if (target && target.closest && target.closest("button, a")) {
        scheduleCapture();
      }
    },
    true
  );

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === "CAPTURE_NOW") {
      saveSnapshot("manual")
        .then((result) => sendResponse(result))
        .catch((error) => sendResponse({ ok: false, error: String(error) }));
      return true;
    }

    if (message?.type === "PING") {
      sendResponse({ ok: true, url: location.href, title: document.title });
      return false;
    }
  });

  saveSnapshot("initial").catch(() => {});
}
