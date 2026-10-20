/**
 * example-host.mjs —— 最小宿主接线示例（干跑：不打真实网络、不连 QQ）
 *
 * 演示一个宿主如何把 movie.mjs 挂进自己的消息循环：
 *   消息入口归一化/命令解析 → /电影 命令 run → 选片拦截 handleMoviePick
 *   → deliverMovieFinal 按场景发送 → settleMovieStep 答后撤回编排。
 * sender / recall 都是假实现（只 console.log），清和 API 请求被 stub 拦截
 * 返回内置假数据。真实宿主把 sender 换成 QQ 官方 SDK 的发送方法即可，
 * 签名对照见 SKILL.md「快速接入」。
 *
 * 运行：node example-host.mjs
 */
import {
  findCommand, parseCommand, handleMoviePick, hasMovieSession,
  deliverMovieFinal, noteMoviePromptId, peekMoviePromptId, settleMovieStep,
  setMovieLogger,
} from "./movie.mjs";

// ── 假数据 + 网络 stub（保持全离线） ─────────────────────
const epLine = (makeUrl, n) => Array.from({ length: n },
  (_, i) => `第${String(i + 1).padStart(2, "0")}集$${makeUrl(i + 1)}`).join("#");
const FAKE_LIST = [{
  vod_name: "示例长剧", vod_year: "2023", type_name: "国产动漫", vod_actor: "演员甲,演员乙",
  vod_pic: "", // 置空：跳过海报下载（真实数据有海报时 run 会走 safeFetchBuffer 下载并图+文一起发）
  vod_blurb: "&amp;amp;nbsp;示例简介，混着双重编码的 HTML 实体。",
  vod_play_url:
    epLine((i) => `https://cdn-a.example.com/a/${i}.m3u8`, 20) + "$$$" +
    epLine((i) => `https://share.example.com/s/${i}`, 20),
}];
globalThis.fetch = async (url) => {
  if (String(url).includes("api.qhsou.com/api/movie.php")) {
    return { ok: true, status: 200, json: async () => ({ code: 1, msg: "获取成功", total: FAKE_LIST.length, list: FAKE_LIST }) };
  }
  throw new Error(`example-host 禁止真实网络：${url}`);
};

// ── 假 sender / recall / 审计（真实宿主换成官方 SDK 实现） ──
let seq = 0;
const sender = {
  async sendText(target, text) {
    const id = `fake-${++seq}`;
    console.log(`[sendText → ${target.scope}:${target.targetId}] id=${id}\n${text}\n`);
    return { id };
  },
  async sendMarkdown(target, content) {
    const id = `fake-${++seq}`;
    console.log(`[sendMarkdown → ${target.scope}:${target.targetId}] id=${id}\n${content}\n`);
    return { id };
  },
  async send(opts) { // Ark 通道：deliverMovieFinal 私聊路径调用 send({ target, msgType: 3, ark })
    const id = `fake-${++seq}`;
    console.log(`[send Ark msgType=${opts.msgType} → ${opts.target.scope}:${opts.target.targetId}] id=${id} ${JSON.stringify(opts.ark)}\n`);
    return { id };
  },
  async sendImage(target, image, caption) {
    const id = `fake-${++seq}`;
    console.log(`[sendImage → ${target.scope}:${target.targetId}] id=${id} caption=${caption?.content?.slice(0, 60)}…\n`);
    return { message: { id } }; // 注意：图片发送的 id 在 message.id 里（与官方 SDK 一致）
  },
};
async function fakeRecall(target, messageId) {
  console.log(`[recall → ${target.scope}:${target.targetId}] 撤回上一条提示 ${messageId}\n`);
}
setMovieLogger((line) => console.log(`[audit] ${line}`));

// ── 宿主消息处理（对照 bot.mjs 的接线顺序简化；限流/黑名单等宿主策略不在本模块内） ──
async function onMessage(msg, rawText) {
  const parsed = parseCommand(rawText); // 内部已做占位符剥离 + 空白折叠 + 无空格命令拆分
  const text = (parsed?.clean ?? rawText).trim();

  // 1) 选片/选集拦截：有会话且是纯数字 → 先 peek 上一步提示 id，再 handleMoviePick
  if (hasMovieSession(msg) && /^\d{1,4}$/.test(text)) {
    const prevPromptId = peekMoviePromptId(msg); // 必须在 handleMoviePick 之前取（流程结束会清会话）
    const pick = await handleMoviePick(msg, text);
    if (pick?.text || pick?.card) {
      const { via, sentId } = await deliverMovieFinal(sender, msg.replyTarget, pick,
        (m, e) => console.log(m, e?.message || e));
      console.log(`[host] 选集 ${text} -> 成功${via ? `（${via}）` : ""}`);
      await settleMovieStep(msg, {
        prevPromptId, sentId,
        advanced: !!pick.advanced, final: !!pick.final,
        who: `${msg.senderName}(${msg.senderId})`,
      }, (id) => fakeRecall(msg.replyTarget, id)); // 先发后撤；报错步 advanced/final 皆假 → 不撤
    }
    return;
  }

  // 2) 命令：parseCommand + findCommand 命中才执行（白名单）
  const cmd = parsed && findCommand(parsed.head);
  if (cmd) {
    const result = await cmd.run({ msg, args: parsed.args });
    if (result.error) { await sender.sendText(msg.replyTarget, `❌ ${result.error}`); return; }
    if (result.image) {
      const sent = await sender.sendImage(msg.replyTarget, result.image,
        result.caption ? { content: result.caption } : undefined);
      if (cmd.triggers.includes("/电影")) noteMoviePromptId(msg, sent?.message?.id || null);
      return;
    }
    const sent = await sender.sendText(msg.replyTarget, result.text || "完成");
    if (cmd.triggers.includes("/电影")) noteMoviePromptId(msg, sent?.id || null);
    return;
  }

  console.log("[host] 未命中命令（真实宿主可在此接关键词/聊天/兜底）");
}

// ── 干跑剧本：群聊里走完「搜片 → 选片 → 选线路 → 选集」 ──
const groupMsg = {
  kind: "group", groupOpenid: "GROUP_OPENID_DEMO",
  senderId: "USER_OPENID_DEMO", senderName: "示例用户",
  replyTarget: { scope: "group", targetId: "GROUP_OPENID_DEMO" },
};
console.log("—— 用户发：/电影示例长剧（故意无空格，验证前缀拆分） ——");
await onMessage(groupMsg, "/电影示例长剧");
console.log("—— 用户回：1（选片） ——");
await onMessage(groupMsg, "1");
console.log("—— 用户回：1（选线路 1） ——");
await onMessage(groupMsg, "1");
console.log("—— 用户回：5（选第 5 集） ——");
await onMessage(groupMsg, "5");
console.log("干跑完成：搜片列表 / 线路列表 / 集数范围在每步作答后被依次撤回，最终只留 Markdown 播放链接。");
