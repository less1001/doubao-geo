const STORAGE_KEY = "doubao_source_records";

const statusEl = document.getElementById("status");
const previewEl = document.getElementById("preview");
const captureBtn = document.getElementById("captureBtn");
const exportJsonBtn = document.getElementById("exportJsonBtn");
const exportCsvBtn = document.getElementById("exportCsvBtn");
const exportMdBtn = document.getElementById("exportMdBtn");
const clearBtn = document.getElementById("clearBtn");

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function csvEscape(value) {
  return `"${String(value || "").replaceAll('"', '""')}"`;
}

async function activeTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0];
}

async function doubaoTab() {
  const tabs = await chrome.tabs.query({
    url: ["https://www.doubao.com/chat/*", "https://doubao.com/chat/*"]
  });
  return tabs[0] || null;
}

async function getRecords() {
  const { [STORAGE_KEY]: records = [] } = await chrome.storage.local.get(STORAGE_KEY);
  return Array.isArray(records) ? records : [];
}

async function setRecords(records) {
  await chrome.storage.local.set({ [STORAGE_KEY]: records.slice(0, 500) });
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
    "sourceContext"
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
          source.sourceContext
        ].map(csvEscape).join(",")
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
      const context = normalize((el.closest("article, section, li, div") || el.parentElement || el).innerText || el.textContent || "");
      sources.push({
        sourceTitle: text,
        sourceWebsite: host || "",
        sourceAuthor: "",
        sourceDate: "",
        sourceUrl: href,
        sourceContext: context
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

async function fetchMetaForSource(source) {
  try {
    const response = await fetch(source.sourceUrl, { redirect: "follow" });
    const html = await response.text();
    const doc = new DOMParser().parseFromString(html, "text/html");
    const pick = (selectors) => {
      for (const selector of selectors) {
        const node = doc.querySelector(selector);
        const content = normalizeText(node?.getAttribute("content") || node?.textContent || "");
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
    return {
      ...source,
      sourceTitle: source.sourceTitle || title,
      sourceWebsite: source.sourceWebsite || site || new URL(source.sourceUrl).hostname.replace(/^www\./, ""),
      sourceAuthor: source.sourceAuthor || author,
      sourceDate: source.sourceDate || date
    };
  } catch {
    return source;
  }
}

async function enrichSources(sources) {
  const result = [];
  const seen = new Set();
  for (const source of sources || []) {
    const url = new URL(source.sourceUrl).toString();
    if (seen.has(url)) continue;
    seen.add(url);
    result.push(await fetchMetaForSource(source));
  }
  return result;
}

async function saveSnapshot(snapshot) {
  const records = await getRecords();
  const payload = {
    id: crypto.randomUUID(),
    capturedAt: new Date().toISOString(),
    pageUrl: snapshot.pageUrl,
    pageTitle: snapshot.pageTitle,
    reason: "manual",
    question: snapshot.question,
    answer: snapshot.answer,
    sources: await enrichSources(snapshot.sources || [])
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

  if (sameAsLatest) {
    return { ok: true, saved: false, skipped: true, count: records.length };
  }

  records.unshift(payload);
  await setRecords(records);
  return { ok: true, saved: true, skipped: false, count: records.length };
}

async function withDebugger(tabId, fn) {
  const target = { tabId };
  await chrome.debugger.attach(target, "1.3");
  try {
    await chrome.debugger.sendCommand(target, "Runtime.enable");
    await chrome.debugger.sendCommand(target, "DOM.enable");
    await chrome.debugger.sendCommand(target, "Page.enable");
    return await fn(target);
  } finally {
    try {
      await chrome.debugger.detach(target);
    } catch {}
  }
}

async function captureCurrentPage() {
  try {
    statusEl.textContent = "正在抓取当前页...";
    const result = await chrome.runtime.sendMessage({ type: "CAPTURE_DOUBAO_TAB" });
    if (!result?.ok) {
      statusEl.textContent = `抓取失败：${result?.error || "未知错误"}`;
      await refresh();
      return;
    }
    if (result.saved) {
      statusEl.textContent = "已抓取当前页";
    } else if (result.skipped) {
      statusEl.textContent = "已经保存过相同内容";
    } else {
      statusEl.textContent = "没有可保存的数据";
    }
    await refresh();
  } catch (error) {
    statusEl.textContent = `抓取失败：${String(error).slice(0, 120)}`;
    await refresh();
  }
}

async function refresh() {
  const records = await getRecords();
  const latest = records[0];
  statusEl.textContent = `已保存 ${records.length} 条记录`;
  previewEl.textContent = latest
    ? JSON.stringify(latest, null, 2)
    : "暂无记录，先去豆包页面提问一次，或点“当前页抓取”。";
}

captureBtn.addEventListener("click", captureCurrentPage);
exportJsonBtn.addEventListener("click", async () => {
  const records = await getRecords();
  const url = toDataUrl(JSON.stringify(records, null, 2), "application/json");
  await chrome.downloads.download({ url, filename: "doubao-source-records.json", saveAs: true });
});
exportCsvBtn.addEventListener("click", async () => {
  const records = await getRecords();
  const url = toDataUrl(toCsv(records), "text/csv");
  await chrome.downloads.download({ url, filename: "doubao-source-records.csv", saveAs: true });
});
exportMdBtn.addEventListener("click", async () => {
  const records = await getRecords();
  const url = toDataUrl(toMarkdown(records), "text/markdown");
  await chrome.downloads.download({ url, filename: "doubao-source-records.md", saveAs: true });
});
clearBtn.addEventListener("click", async () => {
  await setRecords([]);
  await refresh();
});

refresh();
