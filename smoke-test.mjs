/**
* smoke-test.mjs —— qq-movie-search 离线自检（随包走）
*
* 用法：node smoke-test.mjs
* 全部离线：不打清和 API、不连 QQ。覆盖 cleanHtml 清理、play_url 解析、
* 命令解析（含无空格前缀拆分与防误伤）、选片状态机干跑（选片→选线路→
* 选集→最终卡片）、deliverMovieFinal 场景分流、答后撤回编排。
* 全绿（exit 0）才算包是好的，接入前先跑一遍。
*/
import {
cleanHtml, parsePlayUrl, groupEpisodes, parsePlayGroups, parseCommand, findCommand,
buildMovieCard, handleMoviePick, hasMovieSession, deliverMovieFinal,
noteMoviePromptId, peekMoviePromptId, settleMovieStep, setMovieLogger,
__test_seedMovieSession, __test_backdateMovieSession, MOVIE_TTL_MS,
} from "./movie.mjs";

let pass = 0, fail = 0;
function check(name, cond, extra = "") {
if (cond) { pass++; console.log(` ✔ ${name}`);}
else { fail++; console.log(` ✘ ${name} ${extra}`);}
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

console.log("== 1. cleanHtml（vod_blurb 双重编码清理） ==");
check("双重编码 &amp;amp;nbsp; 被清掉",
cleanHtml("&amp;amp;nbsp;彼得·帕克（汤姆·霍兰德 饰）自愿让全世界遗忘自己") ===
"彼得·帕克（汤姆·霍兰德 饰）自愿让全世界遗忘自己",
cleanHtml("&amp;amp;nbsp;彼得·帕克（汤姆·霍兰德 饰）自愿让全世界遗忘自己"));
check("标签 + &lt;p&gt; 编码标签都被剥掉",
cleanHtml("&lt;p&gt;你好&lt;/p&gt;<b>世界</b>") === "你好世界",
cleanHtml("&lt;p&gt;你好&lt;/p&gt;<b>世界</b>"));

console.log("== 2. play_url 解析（$$$ 线路 / # 分集 / 集名$链接） ==");
{
const play = "HD中字$https://share.example.com/share/abc$$$HD中字$https://cdn.example.com/v/index.m3u8";
const eps = parsePlayUrl(play);
check("双组各 1 集", eps.length === 2 && eps[0].line === 1 && eps[1].line === 2, JSON.stringify(eps));
check("分享页 / m3u8 类型判定", eps[0].kind === "分享页" && eps[1].kind === "m3u8");
const groups = parsePlayGroups(play);
check("parsePlayGroups 分组", groups.length === 2 && groups[0][0].url.includes("share.example.com"));
check("groupEpisodes 与 parsePlayGroups 等价", eq(groupEpisodes(eps), groups));
const junk = parsePlayUrl("坏条目$$$第1集$ftp://x/y#第2集$https://cdn.example.com/2.m3u8");
check("非 http 条目被丢弃、无 $ 条目不崩", junk.length === 1 && junk[0].name === "第2集", JSON.stringify(junk));
}

console.log("== 3. 命令解析（归一化 / 无空格拆分 / 防误伤） ==");
{
const p1 = parseCommand("<@ABC123DEF> /电影 蜘蛛侠");
check("占位符+双空格归一化", p1?.head === "/电影" && p1?.args === "蜘蛛侠" && p1?.clean === "/电影 蜘蛛侠", JSON.stringify(p1));
const p2 = parseCommand("/电影蜘蛛侠");
check("无空格命令拆分", p2?.head === "/电影" && p2?.args === "蜘蛛侠" &&!!findCommand(p2.head), JSON.stringify(p2));
const p3 = parseCommand("电影蜘蛛侠");
check("裸「电影蜘蛛侠」拆分", p3?.head === "电影" && p3?.args === "蜘蛛侠", JSON.stringify(p3));
const p4 = parseCommand("/电影院");
check("防误伤：/电影院 不拆", p4?.head === "/电影院" &&!findCommand(p4.head), JSON.stringify(p4));
const p5 = parseCommand("／电影 哪吒");
check("全角斜杠归一化", p5?.head === "/电影" && p5?.args === "哪吒", JSON.stringify(p5));
}

console.log("== 4. 状态机干跑：长剧（选片→选线路→选集） ==");
{
const mk = (host, tag) => Array.from({ length: 20},
(_, i) => `第${String(i + 1).padStart(2, "0")}集$https://${host}/${tag}/${i + 1}.m3u8`).join("#");
const item = {
vod_name: "示例长剧", vod_year: "2023", type_name: "国产动漫",
vod_pic: "https://img.example.com/poster.jpg",
vod_play_url: mk("cdn-a.example.com", "a") + "$$$" + mk("cdn-b.example.com", "b"),
};
const gmsg = { kind: "group", groupOpenid: "g-smoke", senderId: "smoke-user", senderName: "烟测"};
__test_seedMovieSession(gmsg, item);
const s1 = await handleMoviePick(gmsg, "1");
check("选片后先给线路列表", s1?.advanced === true && s1.text.includes("共 2 条线路") && s1.text.includes("（下一步请 @我 再回序号"), s1?.text);
const bad = await handleMoviePick(gmsg, "9");
check("选错线路号报错且保留会话",!bad?.advanced && bad.text.includes("没有线路 9") && hasMovieSession(gmsg), bad?.text);
const s2 = await handleMoviePick(gmsg, "2");
check("选线路后给集数范围", s2?.advanced === true && s2.text.includes("线路2：20 集（第01集～第20集）"), s2?.text);
const s3 = await handleMoviePick(gmsg, "5");
check("选集出最终卡片且清会话",
s3?.final === true && s3.card?.epLabel === "线路2 · 第05集" &&!hasMovieSession(gmsg), JSON.stringify(s3?.card));
check("无分享页时 groupMarkdown 带 m3u8 说明",
s3.card.groupMarkdown.includes("https://cdn-b.example.com/b/5.m3u8") &&
s3.card.groupMarkdown.includes("（m3u8 直链，点开后用浏览器/播放器打开）"), s3.card.groupMarkdown);
}

console.log("== 5. 状态机干跑：短列表（分享页 + m3u8 混合） ==");
{
const item = {
vod_name: "示例电影", vod_pic: "https://img.example.com/p.jpg",
vod_play_url: "HD国语$https://share.example.com/share/xyz$$$HD国语$https://cdn.example.com/f/index.m3u8",
};
const cmsg = { kind: "c2c", groupOpenid: "", senderId: "smoke-user-2", senderName: "烟测2"};
__test_seedMovieSession(cmsg, item);
const s1 = await handleMoviePick(cmsg, "1");
check("短列表逐条列出", s1?.advanced === true && s1.text.includes("【线路1】HD国语（分享页）") && s1.text.includes("【线路2】HD国语（m3u8）") && !s1.text.includes("@我"), s1?.text);
const s2 = await handleMoviePick(cmsg, "2"); // 选 m3u8 条目
check("选 m3u8 时跳转优先同片分享页",
s2?.final === true && s2.card?.jumpUrl === "https://share.example.com/share/xyz" && s2.card?.viaShare === true,
JSON.stringify(s2?.card));
check("有海报时 Ark 37 载荷齐全",
s2.card.ark?.template_id === 37 &&
s2.card.ark.kv.find((k) => k.key === "#METAURL#")?.value === "https://share.example.com/share/xyz");
}

console.log("== 6. 会话过期 ==");
{
const m = { kind: "c2c", groupOpenid: "", senderId: "smoke-user-3"};
__test_seedMovieSession(m, { vod_name: "过期剧", vod_play_url: "正片$https://cdn.example.com/x.m3u8"});
__test_backdateMovieSession(m, MOVIE_TTL_MS + 1000);
const r = await handleMoviePick(m, "1");
check("超 5 分钟回超时提示且清会话", r?.text?.includes("选片超时了") &&!hasMovieSession(m), r?.text);
}

console.log("== 7. deliverMovieFinal 场景分流（mock sender） ==");
{
function mockSender({ failMarkdown = false} = {}) {
const calls = { ark: [], markdown: [], text: []};
return {
calls,
async send(opts) { calls.ark.push(opts); return { id: "mock-ark-id"};},
async sendMarkdown(t, content) {
if (failMarkdown) throw new Error("mock markdown 500");
calls.markdown.push(content); return { id: "mock-md-id"};
},
async sendText(t, content) { calls.text.push(content); return { id: "mock-txt-id"};},
};
}
const card = buildMovieCard({
title: "示例电影", epLabel: "HD国语",
ep: { line: 1, name: "HD国语", url: "https://cdn.example.com/f/index.m3u8", kind: "m3u8"},
allEps: [
{ line: 1, name: "HD国语", url: "https://cdn.example.com/f/index.m3u8", kind: "m3u8"},
{ line: 2, name: "HD国语", url: "https://share.example.com/share/xyz", kind: "分享页"},
],
pic: "https://img.example.com/p.jpg",
});
const gs = mockSender();
const gr = await deliverMovieFinal(gs, { scope: "group", targetId: "g1"}, { text: "兜底", card, final: true});
check("群聊走 Markdown 链接、不调 Ark",
gr.via === "Markdown链接" && gs.calls.ark.length === 0 && gs.calls.markdown[0] === card.groupMarkdown, JSON.stringify(gr));
const fs = mockSender({ failMarkdown: true});
const fr = await deliverMovieFinal(fs, { scope: "group", targetId: "g1"}, { text: "兜底", card, final: true});
check("群聊 Markdown 失败降级纯文本且含跳转链接",
fr.via === "纯文本兜底" && fs.calls.text[0].includes("https://share.example.com/share/xyz"), fr.via);
const cs = mockSender();
const cr = await deliverMovieFinal(cs, { scope: "c2c", targetId: "u1"}, { text: "兜底", card, final: true});
check("私聊走 Ark 37", cr.via === "Ark卡片" && cs.calls.ark[0]?.msgType === 3 && cs.calls.ark[0]?.ark?.template_id === 37, JSON.stringify(cr));
}

console.log("== 8. 答后撤回编排（mock recall + 注入 logger） ==");
{
const logs = [];
setMovieLogger((line) => logs.push(line));
const mk = (host, tag) => Array.from({ length: 20},
(_, i) => `第${String(i + 1).padStart(2, "0")}集$https://${host}/${tag}/${i + 1}.m3u8`).join("#");
const item = { vod_name: "撤回示例剧", vod_play_url: mk("cdn-a.example.com", "a") + "$$$" + mk("cdn-b.example.com", "b")};
const msg = { kind: "group", groupOpenid: "g-smoke-recall", senderId: "smoke-user-4", senderName: "烟测4"};
const deleted = [];
const recall = async (id) => { deleted.push(id);};
async function drive(input, sendLabel) {
const prevPromptId = peekMoviePromptId(msg);
const pick = await handleMoviePick(msg, input);
await settleMovieStep(msg, {
prevPromptId, sentId: `id-${sendLabel}`,
advanced:!!pick?.advanced, final:!!pick?.final, who: "烟测4(smoke-user-4)",
}, recall);
return pick;
}
__test_seedMovieSession(msg, item);
noteMoviePromptId(msg, "id-list");
await drive("1", "line");
check("选片成功撤回搜片列表", deleted.join() === "id-list" && peekMoviePromptId(msg) === "id-line", deleted.join());
await drive("9", "err");
check("报错步不撤回、待撤 id 不被顶替", deleted.join() === "id-list" && peekMoviePromptId(msg) === "id-line", deleted.join());
await drive("2", "range");
await drive("5", "card");
check("全程共撤 3 次、最终消息不撤",
deleted.join() === "id-list,id-line,id-range" &&!hasMovieSession(msg), deleted.join());
check("审计 logger 收到 3 条撤回成功记录",
logs.filter((l) => l.includes("电影撤回上一条提示") && l.includes("-> 成功")).length === 3, logs.join(" | "));
setMovieLogger(null);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail? 1: 0);
