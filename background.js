const STORAGE_KEY = "doubao_source_records";

function normalizeUrl(url) {
  try {
    return new URL(url).toString();
  } catch {
    return url || "";
  }
}

function getHostname(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function sanitize(value) {
  return String(value || "").trim();
}

function dedupeSources(sources) {
  const seen = new Set();
  const result = [];
  for (const source of sources || []) {
    const url = normalizeUrl(source.sourceUrl);
    const key = url || `${source.sourceTitle}|${source.sourceContext}`;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push({
      sourceTitle: sanitize(source.sourceTitle),
      sourceWebsite: sanitize(source.sourceWebsite),
      sourceAuthor: sanitize(source.sourceAuthor),
      sourceDate: sanitize(source.sourceDate),
      sourceUrl: url,
      sourceContext: sanitize(source.sourceContext),
      sourceBlock: sanitize(source.sourceBlock)
    });
  }
  return result;
}

function parseMeta(html, url) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const pick = (selectors) => {
    for (const selector of selectors) {
      const node = doc.querySelector(selector);
      const content = sanitize(node?.getAttribute("content") || node?.textContent || "");
      if (content) return content;
    }
    return "";
  };

  const title = pick(["meta[property='og:title']", "meta[name='twitter:title']", "title"]);
  const author = pick([
    "meta[name='author']",
    "meta[property='article:author']",
    "meta[name='byl']",
    "meta[property='og:article:author']"
  ]);
  const date = pick([
    "meta[property='article:published_time']",
    "meta[property='og:updated_time']",
    "meta[name='publishdate']",
    "meta[name='pubdate']",
    "time[datetime]"
  ]);
  const site = pick(["meta[property='og:site_name']", "meta[name='application-name']"]);
  return { title, author, date, site };
}

async function fetchWithTimeout(url, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: "follow" });
    const html = await response.text();
    return { ok: response.ok, html };
  } finally {
    clearTimeout(timer);
  }
}

async function enrichSource(source) {
  const url = normalizeUrl(source.sourceUrl);
  if (!url) return source;
  try {
    const { html } = await fetchWithTimeout(url);
    const meta = parseMeta(html, url);
    return {
      ...source,
      sourceTitle: source.sourceTitle && source.sourceTitle !== "新对话" ? source.sourceTitle : meta.title || source.sourceTitle,
      sourceWebsite: source.sourceWebsite || meta.site || getHostname(url),
      sourceAuthor: source.sourceAuthor || meta.author,
      sourceDate: source.sourceDate || meta.date
    };
  } catch {
    return {
      ...source,
      sourceWebsite: source.sourceWebsite || getHostname(url)
    };
  }
}

async function enrichRecord(record) {
  const sources = [];
  for (const source of record.sources || []) {
    sources.push(await enrichSource(source));
  }
  return {
    ...record,
    sources: dedupeSources(sources)
  };
}

function dedupeBlocks(blocks) {
  const seen = new Set();
  const result = [];
  for (const block of blocks || []) {
    const heading = sanitize(block.heading);
    const links = [];
    for (const link of block.links || []) {
      const key = normalizeUrl(link.url) || `${link.title}|${link.sourceText}`;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      links.push({
        title: sanitize(link.title),
        url: normalizeUrl(link.url),
        sourceText: sanitize(link.sourceText),
        sourceWebsite: sanitize(link.sourceWebsite),
        sourceAuthor: sanitize(link.sourceAuthor),
        sourceDate: sanitize(link.sourceDate)
      });
    }
    if (links.length) {
      result.push({ heading, links });
    }
  }
  return result;
}

async function getRecords() {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  return Array.isArray(result[STORAGE_KEY]) ? result[STORAGE_KEY] : [];
}

async function setRecords(records) {
  await chrome.storage.local.set({ [STORAGE_KEY]: records.slice(0, 500) });
}

function csvEscape(value) {
  return `"${String(value || "").replaceAll('"', '""')}"`;
}

function toCsv(records) {
  const header = [
    "capturedAt",
    "pageTitle",
    "pageUrl",
    "reason",
    "question",
    "answer",
    "sourceTitle",
    "sourceWebsite",
    "sourceAuthor",
    "sourceDate",
    "sourceUrl",
    "sourceContext",
    "sourceBlock"
  ];
  const rows = [header.join(",")];
  for (const record of records) {
    for (const source of record.sources || []) {
      rows.push(
        [
          record.capturedAt,
          record.pageTitle,
          record.pageUrl,
          record.reason,
          record.question,
          record.answer,
          source.sourceTitle,
          source.sourceWebsite,
          source.sourceAuthor,
          source.sourceDate,
          source.sourceUrl,
          source.sourceContext,
          source.sourceBlock
        ]
          .map(csvEscape)
          .join(",")
      );
    }
  }
  return rows.join("\n");
}

function toMarkdown(records) {
  const lines = [];
  for (const record of records) {
    lines.push(`# ${record.question || record.pageTitle || "豆包记录"}`);
    lines.push("");
    if (record.pageTitle) {
      lines.push(`页面标题：${record.pageTitle}`);
      lines.push("");
    }
    lines.push(`提问时间：${record.capturedAt}`);
    lines.push("");
    lines.push("问题");
    lines.push(record.question || "");
    lines.push("");
    lines.push("回答");
    lines.push(record.answer || "");
    lines.push("");
    lines.push("来源");
    for (const source of record.sources || []) {
      lines.push(`- ${source.sourceTitle || source.sourceUrl || "未命名来源"}`);
      if (source.sourceWebsite) lines.push(`  - 来源网站：${source.sourceWebsite}`);
      if (source.sourceAuthor) lines.push(`  - 作者：${source.sourceAuthor}`);
      if (source.sourceDate) lines.push(`  - 日期：${source.sourceDate}`);
      if (source.sourceUrl) lines.push(`  - 链接：${source.sourceUrl}`);
      if (source.sourceContext) lines.push(`  - 说明：${source.sourceContext}`);
    }
    lines.push("");
    lines.push("---");
    lines.push("");
  }
  return lines.join("\n");
}

function toDataUrl(content, mimeType) {
  const encoded = btoa(unescape(encodeURIComponent(content)));
  return `data:${mimeType};base64,${encoded}`;
}

async function extractPageDataScript() {
  function normalize(s) {
    return String(s || "").replace(/\s+/g, " ").trim();
  }

  function visible(el) {
    const r = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    return r.width > 20 && r.height > 12 && style.display !== "none" && style.visibility !== "hidden";
  }

  function linesFromBody() {
    return normalize(document.body?.innerText || "")
      .split(/\n+/)
      .map((line) => line.trim())
      .filter(Boolean);
  }

  function findQuestion(lines) {
    const candidates = lines.filter((line) => {
      if (line.length < 6 || line.length > 90) return false;
      return /推荐|如何|怎么|哪|什么|多少|适合|选择/.test(line);
    });
    return candidates[0] || "";
  }

  function findAnswer(lines, question) {
    const qi = question ? lines.indexOf(question) : -1;
    const start = qi >= 0 ? qi + 1 : 0;
    const stopPatterns = [/^参考\s*\d+\s*篇资料$/, /^搜索\s*\d+\s*个关键词/, /^参考资料$/];
    let stop = lines.length;
    for (let i = start; i < lines.length; i++) {
      if (stopPatterns.some((re) => re.test(lines[i]))) {
        stop = i;
        break;
      }
    }
    const answerLines = lines.slice(start, stop).filter((line) => {
      if (!line) return false;
      if (/^AI 生成可能有误/.test(line)) return false;
      if (/^新对话$|^AI 创作$|^云盘$|^更多$/.test(line)) return false;
      if (/^历史对话$/.test(line)) return false;
      return true;
    });
    return answerLines.join(" ").trim();
  }

  async function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function clickSourceTriggers() {
    const triggerRe = /参考\s*\d+\s*篇资料|参考资料|搜索\s*\d+\s*个关键词|参考\s*\d+\s*篇/;
    const elements = [...document.querySelectorAll("button, a, div, span, [role='button']")];
    const targets = elements.filter((el) => visible(el) && triggerRe.test(normalize(el.innerText || el.textContent || "")));
    for (const el of targets.slice(0, 8)) {
      try {
        el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
      } catch {}
      try {
        if (typeof el.click === "function") el.click();
      } catch {}
    }
  }

  function collectSourceLinks() {
    const seen = new Set();
    const sources = [];
    const pool = [...document.querySelectorAll("a, button, [role='link'], [role='button']")];
    for (const el of pool) {
      if (!visible(el)) continue;
      const text = normalize(el.innerText || el.textContent || "");
      const attrUrl =
        el.getAttribute("href") ||
        el.getAttribute("data-url") ||
        el.getAttribute("data-href") ||
        el.dataset?.url ||
        el.dataset?.href ||
        "";
      if (!text) continue;
      const href = attrUrl ? new URL(attrUrl, location.href).toString() : "";
      const host = href ? new URL(href).hostname.replace(/^www\./, "") : "";
      if (href && host && host.endsWith("doubao.com")) continue;
      const titleLike = /^(?:\d+\.)?\s*.+/.test(text) && text.length <= 220;
      const looksLikeSource =
        /抖音|小红书|视频|文章|笔记|知乎|b站|B站|微博|公众号|来源|资料|推荐|游泳|孩子|儿童|宝宝/.test(text) ||
        titleLike;
      if (!looksLikeSource && !href) continue;
      const key = `${href || text}|${text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      sources.push({
        sourceTitle: text,
        sourceWebsite: host || "",
        sourceAuthor: "",
        sourceDate: "",
        sourceUrl: href,
        sourceContext: normalize((el.closest("article, section, li, div") || el.parentElement || el).innerText || el.textContent || "")
      });
    }
    return sources;
  }

  function collectDebugHints() {
    const out = [];
    const pool = [...document.querySelectorAll("a, button, [role='link'], [role='button'], div, span, li")];
    for (const el of pool) {
      if (!visible(el)) continue;
      const text = normalize(el.innerText || el.textContent || "");
      if (!text) continue;
      if (!/抖音|小红书|视频|文章|笔记|知乎|b站|B站|微博|公众号|来源|资料|参考/.test(text)) continue;
      const attrs = {};
      for (const name of el.getAttributeNames().slice(0, 12)) {
        attrs[name] = el.getAttribute(name);
      }
      out.push({
        tag: el.tagName.toLowerCase(),
        text,
        attrs,
        classes: el.className || "",
        role: el.getAttribute("role") || ""
      });
      if (out.length >= 20) break;
    }
    return out;
  }

  clickSourceTriggers();
  await wait(1000);

  const lines = linesFromBody();
  const question = findQuestion(lines);
  const answer = findAnswer(lines, question);
  const sources = collectSourceLinks();

  return {
    pageUrl: location.href,
    pageTitle: document.title,
    question,
    answer,
    sources,
    debugHints: sources.length ? [] : collectDebugHints(),
    bodyText: normalize(document.body?.innerText || ""),
    lines
  };
}

function doubaoTabUrl(url) {
  return typeof url === "string" && /https?:\/\/(www\.)?doubao\.com\/chat\//.test(url);
}

async function findDoubaoTab() {
  const tabs = await chrome.tabs.query({
    url: ["https://www.doubao.com/chat/*", "https://doubao.com/chat/*"]
  });
  return tabs[0] || null;
}

const captureTimers = new Map();

async function captureTabNow(tabId, reason = "auto") {
  const target = { tabId };
  await chrome.debugger.attach(target, "1.3");
  try {
    await chrome.debugger.sendCommand(target, "Runtime.enable");
    await chrome.debugger.sendCommand(target, "DOM.enable");
    await chrome.debugger.sendCommand(target, "Page.enable");
    const response = await chrome.debugger.sendCommand(target, "Runtime.evaluate", {
      expression: `(${extractPageDataScript.toString()})()`,
      awaitPromise: true,
      returnByValue: true
    });
    const snapshot = response?.result?.value || null;
    if (!snapshot || !snapshot.sources) {
      return { ok: false, reason: "no_snapshot" };
    }
    const records = await getRecords();
    const payload = {
      id: crypto.randomUUID(),
      capturedAt: new Date().toISOString(),
      pageUrl: snapshot.pageUrl,
      pageTitle: snapshot.pageTitle,
      reason,
      question: snapshot.question,
      answer: snapshot.answer,
      sources: await Promise.all((snapshot.sources || []).map(enrichSource))
    };
    const sameAsLatest = records[0]
      ? JSON.stringify({
          pageUrl: records[0].pageUrl,
          pageTitle: records[0].pageTitle,
          question: records[0].question,
          answer: records[0].answer,
          sources: records[0].sources
        }) ===
        JSON.stringify({
          pageUrl: payload.pageUrl,
          pageTitle: payload.pageTitle,
          question: payload.question,
          answer: payload.answer,
          sources: payload.sources
        })
      : false;
    if (sameAsLatest) return { ok: true, saved: false, skipped: true };
    records.unshift(payload);
    await setRecords(records);
    return { ok: true, saved: true, skipped: false };
  } finally {
    try {
      await chrome.debugger.detach(target);
    } catch {}
  }
}

function scheduleAutoCapture(tabId, delayMs = 2200) {
  if (captureTimers.has(tabId)) clearTimeout(captureTimers.get(tabId));
  const timer = setTimeout(() => {
    captureTabNow(tabId, "auto").catch(() => {});
    captureTimers.delete(tabId);
  }, delayMs);
  captureTimers.set(tabId, timer);
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete" || !doubaoTabUrl(tab?.url || "")) return;
  scheduleAutoCapture(tabId);
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (doubaoTabUrl(tab?.url || "")) scheduleAutoCapture(tabId, 2800);
  } catch {}
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "CAPTURE_DOUBAO_TAB") {
    (async () => {
      const tab = await findDoubaoTab();
      if (!tab?.id) {
        sendResponse({ ok: false, error: "未找到豆包标签页" });
        return;
      }
      const result = await captureTabNow(tab.id, "manual");
      sendResponse({ ok: true, ...result });
    })().catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message?.type === "SAVE_RECORD") {
    (async () => {
      const records = await getRecords();
      const payload = message.payload || {};
      payload.blocks = dedupeBlocks(payload.blocks || []);
      payload.sources = dedupeSources(payload.sources || []);
      if (!payload.sources.length) {
        sendResponse({ ok: true, count: records.length, skipped: true });
        return;
      }

      const enrichedPayload = await enrichRecord(payload);

      const key = JSON.stringify({
        pageUrl: enrichedPayload.pageUrl,
        pageTitle: enrichedPayload.pageTitle,
        question: enrichedPayload.question,
        answer: enrichedPayload.answer,
        sources: enrichedPayload.sources
      });

      const last = records[0];
      const lastKey = last
        ? JSON.stringify({
            pageUrl: last.pageUrl,
            pageTitle: last.pageTitle,
            question: last.question,
            answer: last.answer,
            sources: last.sources
          })
        : "";

      if (key === lastKey) {
        sendResponse({ ok: true, count: records.length, skipped: true });
        return;
      }

      records.unshift(enrichedPayload);
      await setRecords(records);
      sendResponse({ ok: true, count: records.length, skipped: false });
    })().catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message?.type === "EXPORT_RECORDS") {
    (async () => {
      const records = await getRecords();
      const format = message.format || "json";
      const content =
        format === "csv"
          ? toCsv(records)
          : format === "md"
            ? toMarkdown(records)
            : JSON.stringify(records, null, 2);
      const mimeType =
        format === "csv" ? "text/csv" : format === "md" ? "text/markdown" : "application/json";
      const url = toDataUrl(content, mimeType);
      await chrome.downloads.download({
        url,
        filename:
          format === "csv"
            ? "doubao-source-records.csv"
            : format === "md"
              ? "doubao-source-records.md"
              : "doubao-source-records.json",
        saveAs: true
      });
      sendResponse({ ok: true, count: records.length });
    })().catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message?.type === "CLEAR_RECORDS") {
    (async () => {
      await setRecords([]);
      sendResponse({ ok: true });
    })().catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }
});
