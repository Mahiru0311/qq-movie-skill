/**
 * movie.mjs —— /电影 搜片功能（独立抽取版）
 *
 * 本文件自 QQ 机器人 commands.mjs 原样抽取电影相关代码（逻辑一字不改），
 * 仅做必要的解耦，使其可独立于原机器人运行/复用：
 *  1. 原文件的 audit() 写死审计文件 → 这里改为可注入的 log 回调：
 *     宿主调用 setMovieLogger(fn) 注入（fn 收到与原审计完全相同的行文本，
 *     时间戳/落盘由宿主负责）；未注入时静默。settleMovieStep 内部仍以
 *     audit(...) 形式调用，函数体与原文一致。
 *  2. 命令注册表只保留 /电影 本命令：parseCommand / splitGluedCommand /
 *     findCommand 的算法与原文一致，只是候选触发词来自本文件内的 COMMANDS。
 *  3. 不 import 原机器人目录下的任何文件；仅依赖 node:dns/promises
 *     （海报下载的 SSRF 防护用）。凭证与本模块无关，模块内不含任何凭证。
 *
 * 宿主需要提供的运行时形状（详见 SKILL.md 的「宿主集成契约」）：
 *  - msg：{ kind: "group"|"c2c", groupOpenid, senderId, senderName }
 *  - target（replyTarget）：{ scope: "group"|"c2c", targetId }
 *  - sender：send({target, msgType, ark}) / sendMarkdown(target, content) /
 *    sendText(target, text)，均返回带 id 的发送结果
 *  - recall：(messageId) => Promise，由宿主在 settleMovieStep 调用时注入
 */
import { lookup } from "node:dns/promises";

// ── 可注入审计 logger（解耦点 1） ────────────────────────
let _movieLogger = () => {};
export function setMovieLogger(fn) {
  _movieLogger = typeof fn === "function" ? fn : () => {};
}
function audit(line) {
  _movieLogger(line);
}

// ── HTML 清理：清和 API 的简介混着 HTML 实体/标签，且有双重编码 ──
export function cleanHtml(s) {
  let t = String(s || "");
  for (let i = 0; i < 3; i++) {
    t = t.replace(/<[^>]*>/g, "");
    const next = t
      .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&nbsp;|&#160;/g, " ")
      .replace(/&quot;/g, '"')
      .replace(/&#39;|&#x27;/g, "'")
      .replace(/&#(\d+);/g, (_, n) => {
        try { return String.fromCharCode(Number(n)); } catch { return ""; }
      })
      .replace(/&amp;/g, "&");
    if (next === t) break;
    t = next;
  }
  return t.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
}

// ── SSRF 防护 ─────────────────────────────────────────
function isPrivateIP(ip) {
  ip = ip.toLowerCase();
  if (ip.includes(":")) { // IPv6
    const first = ip.split(":")[0];
    return ip === "::1" || first.startsWith("fc") || first.startsWith("fd") || first.startsWith("fe80");
  }
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return true; // 解析异常按危险处理
  return (
    p[0] === 0 || p[0] === 10 || p[0] === 127 ||
    (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
    (p[0] === 192 && p[1] === 168) ||
    (p[0] === 169 && p[1] === 254)
  );
}

/** 安全下载：逐跳校验 DNS，内网地址直接拒绝；返回 { buffer, contentType } */
export async function safeFetchBuffer(url, { maxBytes, timeoutMs = 30000 }) {
  let current = url;
  for (let hop = 0; hop < 6; hop++) {
    let u;
    try { u = new URL(current); }
    catch { throw new Error("链接格式无效"); }
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("只支持 http/https 链接");
    let addrs;
    try { addrs = await lookup(u.hostname, { all: true }); }
    catch { throw new Error("域名解析失败"); }
    if (addrs.some((a) => isPrivateIP(a.address))) throw new Error("禁止访问内网/保留地址");
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(current, {
        redirect: "manual",
        signal: ctrl.signal,
        headers: { "User-Agent": "qq-bridge/1.0" },
      });
    } catch (e) {
      clearTimeout(timer);
      throw new Error(e.name === "AbortError" ? "下载超时（30秒）" : `网络错误：${e.message}`);
    }
    clearTimeout(timer);
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.get("location");
      if (!loc) throw new Error("重定向无目标地址");
      current = new URL(loc, current).href;
      continue;
    }
    if (!res.ok) throw new Error(`下载失败：HTTP ${res.status}`);
    const declared = Number(res.headers.get("content-length") || 0);
    if (declared > maxBytes) throw new Error(`文件太大（约 ${(declared / 1048576).toFixed(1)}MB），上限 ${maxBytes / 1048576}MB`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) throw new Error(`文件太大（约 ${(buf.length / 1048576).toFixed(1)}MB），上限 ${maxBytes / 1048576}MB`);
    if (buf.length === 0) throw new Error("下载到空文件");
    return { buffer: buf, contentType: res.headers.get("content-type") || "" };
  }
  throw new Error("重定向次数过多");
}

function isImageBuffer(buf) {
  if (buf.length < 12) return false;
  const png = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  const jpg = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  const gif = buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46;
  const webp = buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
               buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50;
  const bmp = buf[0] === 0x42 && buf[1] === 0x4d;
  return png || jpg || gif || webp || bmp;
}

// ── 命令解析：先剥掉开头的 <@...> 提及，再做命令归一化 ────
// 归一化（用户 2026-10-20 要求）：全角斜杠 ／ → /；"/ 电影" 这类斜杠后带空格
// （含全角空格）→ "/电影"，避免 "/ 电影 蜘蛛侠" 掉进聊天被模型编借口。
/**
 * 入口文本归一化：GROUP_MESSAGE_CREATE 的原始串自带 `<@openid>` 提及占位符
 * （十六进制 openid，非纯数字），并且可能带多余空白。
 * 归一化：剥掉任意位置的占位符、折叠全部空白（含全角空格/制表）为单空格、去首尾。
 * 在 bot.mjs 消息入口对 content 调用；parseCommand 内部也走它。
 */
export function normalizeIncomingText(text) {
  return String(text || "")
    .replace(/<@[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeCommandText(text) {
  let clean = normalizeIncomingText(text);
  clean = clean.replace(/／/g, "/");
  clean = clean.replace(/^\/\s+/, "/");
  return clean;
}
export function parseCommand(text) {
  const clean = normalizeCommandText(text);
  const m = clean.match(/^(\S+)\s*([\s\S]*)$/);
  if (!m) return null;
  let head = m[1];
  let args = (m[2] || "").trim();
  // 无空格命令前缀拆分（2026-10-20 实测：「/电影蜘蛛侠」按空白切 head 是整串、
  // 匹配不到触发词，会掉进聊天被模型乱答）。整词匹配不到时：若 head 以某个触发词
  // （及其带/不带斜杠变体）开头、且余下部分 ≥ 2 字，拆成 head=触发词、args=余下
  // 部分（+ 原 args）。余下 < 2 字不拆，防「/电影院」误拆成搜「院」。
  if (!findCommand(head)) {
    const split = splitGluedCommand(head);
    if (split) {
      head = split.head;
      args = (split.rest + (args ? ` ${args}` : "")).trim();
    }
  }
  return { head, args, clean };
}

/**
 * 无空格命令拆分：head 以触发词开头且余下 ≥ 2 字时返回 { head: 触发词, rest }，
 * 否则返回 null。候选含触发词的带/不带斜杠两种形态，按长度降序优先匹配最长。
 * （余下 1 字不拆：如「/电影院」不许拆成搜「院」；纯数字占位符类不变）
 */
export function splitGluedCommand(head) {
  if (!head) return null;
  const candidates = new Set();
  for (const c of COMMANDS) {
    for (const t of c.triggers) {
      candidates.add(t);
      candidates.add(t.startsWith("/") ? t.slice(1) : `/${t}`);
    }
  }
  for (const t of [...candidates].sort((a, b) => b.length - a.length)) {
    if (head.startsWith(t) && head.length - t.length >= 2) {
      return { head: t, rest: head.slice(t.length) };
    }
  }
  return null;
}

// ── 命令注册表（解耦点 2：独立版只注册 /电影 本命令，条目与原文一致） ──
export const COMMANDS = [
  {
    triggers: ["/电影"],
    adminOnly: false,
    help: "/电影 <名称> —— 搜片（回序号选片，再回序号选集，比如：/电影 哪吒）",
    async run({ msg, args }) {
      const name = (args || "").trim().slice(0, 40);
      if (!name) return { error: "用法：/电影 <名称>，比如：/电影 哪吒" };
      let data;
      try {
        data = await searchMovies(name);
      } catch (e) {
        return { error: `片源服务开小差了：${e.name === "AbortError" ? "超时" : (e.message || e)}` };
      }
      const { list, total } = data;
      if (!list.length) return { text: `没搜到《${name}》，换个名字试试` };
      const shown = list.slice(0, MOVIE_MAX_PICK);
      _movieSessions.set(movieSessionKey(msg), { stage: "pick", list: shown, ts: Date.now(), promptId: null });
      const rows = shown.map((v, i) =>
        `${i + 1}. ${cleanHtml(v.vod_name || "?")}` +
        (v.vod_year ? `（${cleanHtml(v.vod_year)}）` : "") +
        (v.type_name ? ` · ${cleanHtml(v.type_name)}` : ""));
      const more = list.length > shown.length ? `（只列前 ${shown.length} 部）` : "";
      const text = withGroupHint(msg, [
        `🎬 搜「${cleanHtml(name)}」共 ${total || list.length} 部${more}，回序号选片（5分钟内有效）：`,
        ...rows,
      ].join("\n").slice(0, 1500));
      // 海报：取第一条结果的 vod_pic，走安全下载（SSRF 防护），成功就图+文一起发，失败只发文
      const pic = String(shown[0]?.vod_pic || "").trim();
      if (/^https?:\/\//.test(pic)) {
        try {
          const { buffer } = await safeFetchBuffer(pic, { maxBytes: 5 * 1048576 });
          if (isImageBuffer(buffer)) return { image: { buffer }, caption: text };
        } catch {}
      }
      return { text };
    },
  },
];

// ── /电影 选片/选集：搜索（选片）→ 选集 → 链接，对齐 iOS 快捷方式 ──
// 会话按（群/私聊 + 发送者）缓存，内存，5 分钟过期
// stage:"pick" 选片 | "ep" 短列表逐条选（总集数 ≤ MOVIE_FLAT_MAX，保持旧格式）
// stage:"line" 多线路长剧先选线路（只给线路列表，不带集数）
// stage:"range" 线路已锁定（或单线路），只按集数范围选集
export const MOVIE_TTL_MS = 5 * 60 * 1000;
export const MOVIE_MAX_PICK = 10; // 搜索结果最多缓存/展示 10 部
export const MOVIE_FLAT_MAX = 12; // 总集数 ≤ 12 走逐条编号列表；超过走范围选集
const _movieSessions = new Map(); // key -> { stage, list, picked, eps|lines, lineIdx, ts }

export function movieSessionKey(msg) {
  const kind = msg?.kind || "c2c";
  const scope = msg?.groupOpenid || "-";
  return `${kind}:${scope}:${msg?.senderId || "anon"}`;
}

// 群聊里机器人只能收到 @ 它的消息：/电影 每一步提示（选片/选线/选集/报错）在群里
// 都要提醒「下一步 @我 再回序号」，否则用户裸回数字机器人根本收不到、误以为卡死
// （2026-10-20 用户实测）。私聊（C2C）不加。
const GROUP_PICK_HINT = "（下一步请 @我 再回序号，不 @ 我收不到）";
function withGroupHint(msg, text) {
  return msg?.kind === "group" ? `${text}\n${GROUP_PICK_HINT}` : text;
}

/** 清和 API 搜索：返回 { list, total }（list 为原始条目数组） */
export async function searchMovies(name) {
  const res = await fetch(`https://api.qhsou.com/api/movie.php?wd=${encodeURIComponent(name)}`, {
    headers: { "User-Agent": "qq-bridge/1.0" },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  const list = Array.isArray(json?.list) ? json.list : [];
  return { list, total: Number(json?.total || list.length) };
}

/**
 * vod_play_url 解析：$$$ 分线路组 → # 分集 → $ 拆 [集名, 链接]（取第一个 $ 分隔）。
 * 返回 [{ line, name, url, kind }]，kind 为 "m3u8" 或 "分享页"。
 */
export function parsePlayUrl(playUrl) {
  const eps = [];
  let lineNo = 0;
  for (const g of String(playUrl || "").split("$$$")) {
    const group = g.trim();
    if (!group) continue;
    lineNo++;
    for (const part of group.split("#")) {
      const p = part.trim();
      if (!p) continue;
      const i = p.indexOf("$");
      let name, url;
      if (i >= 0) { name = p.slice(0, i).trim(); url = p.slice(i + 1).trim(); }
      else { name = ""; url = p; }
      if (!/^https?:\/\//.test(url)) continue;
      eps.push({
        line: lineNo,
        name: name || `集${eps.length + 1}`,
        url,
        kind: /\.m3u8(\?|$)/i.test(url) ? "m3u8" : "分享页",
      });
    }
  }
  return eps;
}

/** parsePlayUrl 的平铺结果按线路分组：返回 [[ep...], [ep...]]（下标+1 = 线路号） */
export function groupEpisodes(eps) {
  const lines = [];
  for (const e of eps || []) (lines[e.line - 1] ||= []).push(e);
  return lines.filter((l) => l && l.length);
}

/** parsePlayUrl + groupEpisodes 的组合：直接从 vod_play_url 得到按线路分组的集列表 */
export function parsePlayGroups(playUrl) {
  return groupEpisodes(parsePlayUrl(playUrl));
}

/** 一条线路的范围标签：首尾集名原文，如 第1集～第150集 */
function epRangeLabel(eps) {
  const first = cleanHtml(eps[0]?.name || "");
  const last = cleanHtml(eps[eps.length - 1]?.name || "");
  return eps.length === 1 ? first : `${first}～${last}`;
}

// ── /电影 最终链接的卡片包装 ──────────────────────────
// 目标：最终一条消息里不出现裸 URL 文本（避开把链接设成违禁词的群）。
// 首选 Ark 模板 37（大图卡）：官方内置模板、免审核，群聊 GROUP_AT 与私聊 C2C 均可发
// （官方 wiki：server-inter/message/type/ark.md 模板 37，字段 #PROMPT#/#METATITLE#/
// #METASUBTITLE#/#METACOVER#/#METAURL#；发送端点 v2/groups|users/.../messages 的
// msg_type=3）。跳转 URL 若是 m3u8 直链，QQ 内置浏览器打开只是播放列表文本、播不了，
// 故优先用同片的「分享页」链接当跳转（清和 API 里通常另一个线路组就是分享页）；
// 没有分享页才直跳 m3u8，并在副标题注明「点开后用浏览器/播放器打开」。
// 无海报 URL 时模板 37 用不了 → 降级 Markdown 锚文本链接（bot 侧发送）；
// 两者都失败时 bot 再用纯文本兜底（下方 text 字段，仅兜底用）。

/** 在全部集里为选中集找「分享页」跳转：选中本身是分享页直接用；否则同名集优先，其次同序号对位，最后任一分享页 */
export function findShareJumpUrl(allEps, ep) {
  if (!ep) return null;
  if (ep.kind === "分享页") return ep.url;
  const shares = (allEps || []).filter((e) => e.kind === "分享页");
  if (!shares.length) return null;
  const sameName = shares.find((e) => e.name === ep.name);
  if (sameName) return sameName.url;
  const myLine = (allEps || []).filter((e) => e.line === ep.line);
  const idx = myLine.indexOf(ep);
  if (idx >= 0) {
    for (const l of groupEpisodes(shares)) if (l[idx]) return l[idx].url;
  }
  return shares[0].url;
}

/**
 * 组装最终卡片数据。返回 {
 *   title, epLabel, jumpUrl, viaShare, needsPlayerNote, subtitle,
 *   ark: 模板37载荷 | null（无海报时）, markdown: 私聊锚文本兜底,
 *   groupMarkdown: 群聊最终步专用 Markdown 链接
 * }
 * 可见文本字段（#PROMPT#/#METATITLE#/#METASUBTITLE#、锚文本）里不含裸 URL；
 * URL 只出现在 #METAURL# / 锚文本目标里。
 */
export function buildMovieCard({ title, epLabel, ep, allEps, pic }) {
  const share = findShareJumpUrl(allEps, ep);
  const viaShare = !!share && share !== ep.url;
  const jumpUrl = share || ep.url;
  const needsPlayerNote = !share && ep.kind === "m3u8";
  const subtitle = [
    epLabel,
    viaShare ? "点卡片打开播放页" : needsPlayerNote ? "点开后用浏览器/播放器打开" : "点卡片播放",
  ].join(" · ");
  const cover = /^https?:\/\//.test(String(pic || "")) ? String(pic) : "";
  const ark = cover ? {
    template_id: 37,
    kv: [
      { key: "#PROMPT#", value: `🎬 《${title}》${epLabel}`.slice(0, 60) },
      { key: "#METATITLE#", value: `《${title}》`.slice(0, 40) },
      { key: "#METASUBTITLE#", value: subtitle.slice(0, 60) },
      { key: "#METACOVER#", value: cover },
      { key: "#METAURL#", value: jumpUrl },
    ],
  } : null;
  const markdown =
    `[▶ 《${title}》${epLabel}](${jumpUrl})` +
    (needsPlayerNote ? "\n（m3u8 直链，点开后用浏览器/播放器打开）" : "");
  // 群聊专用：Ark 在群里发送回 200 但客户端不渲染，群聊最终步改发这种
  // 「标题行 + 播放锚文本」Markdown（jumpUrl 与卡片同一个，分享页优先逻辑不变）
  const groupMarkdown =
    `🎬 《${title}》\n[▶ 点我播放：${epLabel}](${jumpUrl})` +
    (needsPlayerNote ? "\n（m3u8 直链，点开后用浏览器/播放器打开）" : "");
  return { title, epLabel, jumpUrl, viaShare, needsPlayerNote, subtitle, ark, markdown, groupMarkdown };
}

/** 最终一步的统一返回：{ text（纯文本兜底）, card, final }（final 标记流程完成，供答后撤回编排） */
function movieFinalResult(s, ep, epLabel) {
  const title = cleanHtml(s.picked?.vod_name || "");
  const allEps = s.eps && s.eps.length ? s.eps : s.lines ? s.lines.flat() : [ep];
  const card = buildMovieCard({
    title, epLabel, ep, allEps,
    pic: String(s.picked?.vod_pic || "").trim(),
  });
  return { text: `🎬 《${title}》\n${epLabel}\n${ep.url}`, card, final: true };
}

/**
 * /电影 每一步（含最终步）的实际发送编排，sender 注入以便离线自测 mock：
 * sender 需提供 send（Ark）/ sendMarkdown / sendText 三个方法（bot.mjs 传真实 bot）。
 * 按场景分流（用户 2026-10-20 两次实测：Ark 群聊发送回 200 但客户端不渲染，
 * 文字/Markdown 群里可见；私聊 Ark 正常）：
 *  - 群聊（target.scope === "group"）：跳过 Ark，直接发 card.groupMarkdown
 *    （标题行 + 播放锚文本，跳转仍是分享页优先的 jumpUrl）；失败降级纯文本
 *    （标题 + 集名 + 跳转裸链接）。
 *  - 私聊：维持原降级链 Ark 37 → Markdown 锚文本 → 纯文本。
 * 中间步（无 card）两边都只是纯文本。返回 { via（实际通道）, sentId }，
 * 与 bot.mjs 的 settleMovieStep/撤回编排契约不变。
 * onDowngrade(msg, err) 供 bot.mjs 记日志，缺省静默。
 */
export async function deliverMovieFinal(sender, target, pick, onDowngrade = () => {}) {
  const card = pick?.card;
  if (target?.scope === "group") {
    if (card?.groupMarkdown) {
      try {
        const sent = await sender.sendMarkdown(target, card.groupMarkdown);
        return { via: "Markdown链接", sentId: sent?.id || null };
      } catch (e) {
        onDowngrade("群聊 Markdown 发送失败，降级纯文本：", e);
      }
      const fallback =
        `🎬 《${card.title}》\n${card.epLabel}\n${card.jumpUrl}` +
        (card.needsPlayerNote ? "\n（m3u8 直链，点开后用浏览器/播放器打开）" : "");
      const sent = await sender.sendText(target, fallback);
      return { via: "纯文本兜底", sentId: sent?.id || null };
    }
    const sent = await sender.sendText(target, pick?.text || "完成");
    return { via: card ? "纯文本兜底" : "", sentId: sent?.id || null };
  }
  if (card?.ark) {
    try {
      const sent = await sender.send({ target, msgType: 3, ark: card.ark });
      return { via: "Ark卡片", sentId: sent?.id || null };
    } catch (e) {
      onDowngrade("Ark 卡片发送失败，降级 Markdown：", e);
    }
  }
  if (card?.markdown) {
    try {
      const sent = await sender.sendMarkdown(target, card.markdown);
      return { via: "Markdown锚文本", sentId: sent?.id || null };
    } catch (e) {
      onDowngrade("Markdown 发送失败，降级纯文本：", e);
    }
  }
  const sent = await sender.sendText(target, pick?.text || "完成");
  return { via: card ? "纯文本兜底" : "", sentId: sent?.id || null };
}

export function hasMovieSession(msg) {
  return _movieSessions.has(movieSessionKey(msg));
}

// ── 答后撤回上一条提示（用户 2026-10-20 定）：流程走完聊天框只留最终卡片 ──
// 每一步提示消息发出后，bot 侧把返回的 message_id 登记进会话（noteMoviePromptId）；
// 下一步用户作答成功后，先发新内容、再撤回上一步提示（settleMovieStep）。
// 选错序号的报错提示不触发撤回；撤回失败只记审计、绝不阻塞流程。
// 平台限制：消息发出 2 分钟内才可撤回（流程每步间隔远小于此）。
export function noteMoviePromptId(msg, id) {
const s = _movieSessions.get(movieSessionKey(msg));
if (s && id) s.promptId = String(id);
}

export function peekMoviePromptId(msg) {
return _movieSessions.get(movieSessionKey(msg))?.promptId || null;
}

/**
* 一步走完的收尾：在 handleMoviePick 之前 peek 出 prevPromptId，发送新内容拿到
* sentId 后调用本函数。非 final 步把 sentId 记为新的待撤回提示；成功推进
* （advanced/final）且有 prevPromptId 时执行 recall 回调撤回上一步提示。
* 返回实际撤回的 id 或 null（撤回失败也返回 null，不抛错）。
*/
export async function settleMovieStep(msg, { prevPromptId, sentId, advanced, final, who}, recall) {
// 只登记「成功推进的中间步」发出的新提示；报错提示不登记——它只是临时消息，
// 登记了会顶替真正的当前提示，导致该被撤的提示永远撤不掉
if (advanced &&!final && sentId) noteMoviePromptId(msg, sentId);
if (!(advanced || final) ||!prevPromptId) return null;
try {
await recall(prevPromptId);
audit(`${who || "?"} 电影撤回上一条提示 ${prevPromptId} -> 成功`);
return prevPromptId;
} catch (e) {
const emsg = (e && e.message) || String(e);
audit(`${who || "?"} 电影撤回上一条提示 ${prevPromptId} -> 失败：${emsg.slice(0, 120)}`);
return null;
}
}

/**
* 选片/选集接应：序号类消息 → 按会话阶段处理（input 可为字符串或数字）。
* 返回 null 表示无会话/不接管；否则返回 { text}（每步只发 1 条消息）。
*/
export async function handleMoviePick(msg, input) {
const key = movieSessionKey(msg);
const s = _movieSessions.get(key);
if (!s) return null;
if (Date.now() - s.ts > MOVIE_TTL_MS) {
_movieSessions.delete(key);
return { text: "⌛ 选片超时了，重新发 /电影 <名称> 搜吧"};
}
const raw = String(input?? "").trim();
const digit = /^\d+$/.test(raw)? parseInt(raw, 10): NaN;

// ── stage "pick"：选片 ──
if (s.stage === "pick") {
if (Number.isNaN(digit)) return { text: withGroupHint(msg, `没有这个选项，回 1~${s.list.length} 的数字选片`)};
if (digit < 1 || digit > s.list.length) return { text: withGroupHint(msg, `没有第 ${digit} 个，回 1~${s.list.length} 的数字`)};
const v = s.list[digit - 1];
const title = cleanHtml(v.vod_name || "");
const allEps = parsePlayUrl(v.vod_play_url); // 完整集列表进会话缓存，只是不全打印
if (!allEps.length) {
_movieSessions.delete(key);
return { text: `《${title}》暂时没有可用的播放链接`};
}
s.picked = v; s.ts = Date.now();
if (allEps.length <= MOVIE_FLAT_MAX) {
// 短列表：保持旧逐条编号格式，选号即出链接
s.stage = "ep"; s.eps = allEps;
const multi = allEps.some((e) => e.line > 1);
      const rows = allEps.map((e, i) =>
        `${i + 1}. ${multi ? `【线路${e.line}】` : ""}${cleanHtml(e.name)}（${e.kind}）`);
return {
advanced: true,
text: withGroupHint(msg, [
`🎬 《${title}》选集，回序号拿链接（5分钟内有效）：`,
...rows,
].join("\n").slice(0, 2500)),
};
}
// 长剧：严格分步——先选线路，选完线路才出集数（用户 2026-10-20 实测定的流程，
// 不再把多线路范围挤在一条里、也不接受「线路号-集数」一步输入）
s.lines = groupEpisodes(allEps);
const pickedLines = s.lines;
if (pickedLines.length === 1) {
// 单线路多集：不走线路步，直接给范围等集数
s.stage = "range"; s.lineIdx = 0;
return { advanced: true, text: withGroupHint(msg, `🎬 《${title}》共 ${pickedLines[0].length} 集（${epRangeLabel(pickedLines[0])}）\n回集数拿链接，如 1（5分钟内有效）`)};
}
s.stage = "line"; s.lineIdx = null;
const rows = pickedLines.map((_, i) => `${i + 1}. 线路${i + 1}`);
return {
advanced: true,
text: withGroupHint(msg, [
`🎬 《${title}》共 ${pickedLines.length} 条线路，回线路号选线路（5分钟内有效）：`,
...rows,
].join("\n")),
};
}

// ── stage "ep"：短列表逐条选 ──
if (s.stage === "ep") {
if (Number.isNaN(digit)) return { text: withGroupHint(msg, `没有这个选项，回 1~${s.eps.length} 的数字`)};
if (digit < 1 || digit > s.eps.length) return { text: withGroupHint(msg, `没有第 ${digit} 个，回 1~${s.eps.length} 的数字`)};
const ep = s.eps[digit - 1];
_movieSessions.delete(key);
return movieFinalResult(s, ep, cleanHtml(ep.name));
}

// ── stage "line"：多线路先选线路（只认 1~线路数 的纯数字，其他一律报错并保留会话）──
if (s.stage === "line") {
const lines = s.lines || [];
if (Number.isNaN(digit)) return { text: withGroupHint(msg, `看不懂，回线路号（1~${lines.length} 的数字）`)};
if (digit < 1 || digit > lines.length) return { text: withGroupHint(msg, `没有线路 ${digit}，共 ${lines.length} 条线路，回 1~${lines.length} 选线路`)};
s.lineIdx = digit - 1; s.stage = "range"; s.ts = Date.now();
const eps = lines[digit - 1];
return { advanced: true, text: withGroupHint(msg, `线路${digit}：${eps.length} 集（${epRangeLabel(eps)}），回集数拿链接（5分钟内有效）`)};
}

// ── stage "range"：线路已锁定，只按集数选（只认 1~该线集数 的纯数字）──
const lines = s.lines || [];
const lineIdx = s.lineIdx?? 0;
const eps = lines[lineIdx] || [];
const title = cleanHtml(s.picked?.vod_name || "");
if (Number.isNaN(digit)) return { text: withGroupHint(msg, `看不懂，直接回集数（1~${eps.length} 的数字）`)};
if (digit < 1 || digit > eps.length) {
return { text: withGroupHint(msg, lines.length > 1
? `线路${lineIdx + 1} 没有第 ${digit} 集（共 ${eps.length} 集：${epRangeLabel(eps)}），重新回集数`
: `没有第 ${digit} 集，这部共 ${eps.length} 集（${epRangeLabel(eps)}），重新回集数`)};
}
const ep = eps[digit - 1];
_movieSessions.delete(key);
const lineLabel = lines.length > 1? `线路${lineIdx + 1} · `: "";
return movieFinalResult(s, ep, `${lineLabel}${cleanHtml(ep.name)}`);
}

// 仅供测试：直接种一个选片会话（stage=pick，list 只含给定条目）
export function __test_seedMovieSession(msg, item) {
_movieSessions.set(movieSessionKey(msg), { stage: "pick", list: [item], ts: Date.now()});
}

// 仅供测试：把指定会话时间戳往回拨（验证过期逻辑）
export function __test_backdateMovieSession(msg, msAgo) {
const s = _movieSessions.get(movieSessionKey(msg));
if (s) s.ts -= msAgo;
}

export function findCommand(head) {
if (!head) return undefined;
// 带不带斜杠都认："/电影" 的触发词是 "/电影"，裸 "电影" 也能命中（消息以「电影 <名>」开头当命令）；
// 反之 "/天气" 也能命中裸触发词 "天气"。/help 等同样受益。
const variants = head.startsWith("/")? [head, head.slice(1)]: [head, `/${head}`];
return COMMANDS.find((c) => variants.some((v) => c.triggers.includes(v)));
}
