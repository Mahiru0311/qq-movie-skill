---
name: qq-movie-search
description: 为官方 QQ 机器人接入「/电影」搜片功能：调用清和 API（api.qhsou.com）搜片，用户回序号逐级选片、选线路、选集，机器人发出可点击的播放链接（群聊 Markdown 链接 / 私聊 Ark 大图卡），并在每步作答后自动撤回上一条提示。当需要给 QQ 机器人添加电影搜索/点播选集功能，或复用本模块的 play_url 解析、选片状态机、卡片构造与答后撤回编排时使用。
---

# QQ 机器人 /电影 搜片（qq-movie-search）

## 快速接入（第一次见到这个包的 agent 先读这里）

**① 这是什么、什么时候用**
给官方 QQ 机器人（WebSocket 网关）加一个 `/电影 <片名>` 命令：搜片 → 编号选片 → 多线路先选线路 → 选集 → 发出可点击的播放链接，并自动撤回中间步骤的提示消息，让聊天框里最后只留结果。实现全在 `movie.mjs` 单文件里（零第三方依赖），宿主只需提供「发消息」和「撤回消息」两个平台能力。

**② 宿主必须提供的 sender 接口（签名清单）**

| 方法 | 入参 | 返回值 | 说明 |
| --- | --- | --- | --- |
| `sendText` | `(target, text)` | `Promise<{ id}>` | 发纯文本；`id` 为平台返回的消息 id |
| `sendImage` | `(target, { buffer}, { content}?)` | `Promise<{ message: { id}}>` | 发图片（可带配文）；**id 在 `message.id`**，与官方 SDK 一致 |
| `sendMarkdown` | `(target, content)` | `Promise<{ id}>` | 发 Markdown（msg_type=2） |
| `send` | `({ target, msgType: 3, ark})` | `Promise<{ id}>` | 通用发送口，`deliverMovieFinal` 私聊 Ark 路径用它发模板 37 卡片 |
| `recallMessage` | `(target, messageId)` | `Promise<void>` | 撤回机器人自己发的消息；宿主在 `settleMovieStep` 的 recall 回调里接它 |

形状约定：`msg = { kind: "group" | "c2c", groupOpenid, senderId, senderName, replyTarget}`；`target = { scope: "group" | "c2c", targetId}`。
审计日志经 `setMovieLogger(fn)` 注入，`fn(line)` 收到的行文本与生产审计同格式（不含时间戳，宿主自行添加）；不注入则静默。

**③ 最小接入步骤**

1. 先自检：`node smoke-test.mjs` 全绿（28 项离线断言），再 `node example-host.mjs` 看一遍假 sender 的完整干跑输出。
2. 从 `movie.mjs` import：`parseCommand, findCommand, handleMoviePick, hasMovieSession, deliverMovieFinal, noteMoviePromptId, peekMoviePromptId, settleMovieStep, setMovieLogger`；启动时 `setMovieLogger(你的审计函数)`。
3. 消息路由按此顺序挂（完整可运行版见 `example-host.mjs`）：
- 入口先 `parseCommand(rawText)`（内部已做占位符剥离、空白折叠、无空格命令拆分），用返回的 `clean` 做后续判定；
- **选片拦截**：`hasMovieSession(msg)` 且 `clean` 为纯数字时 → `prevPromptId = peekMoviePromptId(msg)`（必须在下一步之前取）→ `pick = await handleMoviePick(msg, clean)` → `{ via, sentId} = await deliverMovieFinal(sender, msg.replyTarget, pick)` → `await settleMovieStep(msg, { prevPromptId, sentId, advanced:!!pick.advanced, final:!!pick.final, who}, (id) => sender.recallMessage(msg.replyTarget, id))`；
- **命令**：`findCommand(parsed.head)` 命中 → `result = await cmd.run({ msg, args: parsed.args})` → 按 `result.error / result.text / result.image` 发送 → 若命令是 `/电影` 且发送成功，用发送返回的 id 调 `noteMoviePromptId(msg, id)` 登记待撤回提示。
4. 限流、黑名单、关键词、聊天兜底等都是宿主策略，本模块不管。

**④ 常见坑（一句话索引）**

- 群聊里 Ark 卡片发送成功但用户看不到 → 群聊最终步不用 Ark，见「展示与发送」第 1 条。
- 群消息开头带着 `<@一串十六进制>`、命令死活不命中 → 那是 GROUP_MESSAGE_CREATE 的提及占位符，见「命令解析与归一化」。
- 撤回只能撤自己发的、且只有 2 分钟窗口 → 编排细节见「答后撤回编排」。
- m3u8 链接在 QQ 内置浏览器里播不了 → 跳转优先同片分享页，见「展示与发送」第 3 条。
- 用户发 `/电影蜘蛛侠`（没空格）→ 前缀拆分兜底，见「命令解析与归一化」。

## 功能流程

1. 用户发 `/电影 <片名>` → 回编号选片列表（最多 10 条；第一条结果有海报时图+文一起发）；搜不到回「没搜到《片名》，换个名字试试」。
2. 回序号选片 → 解析该片 `vod_play_url`：
- 总集数 ≤ 12 → 短列表：逐条列出全部条目（多线路时每条带 `` 标注），回序号直接出最终链接；
- 总集数 > 12 且多线路 → **只列线路**（`1. 线路1`、`2. 线路2`……），先选线路；
- 总集数 > 12 且单线路 → 跳过选线，直接给集数范围。
3. 回线路号 → 回该线集数范围，如 `线路1：163 集（第01集～第163集），回集数拿链接`。
4. 回集数 → 发最终消息（形态见「展示与发送」），会话清除。

会话规则：按（场景 kind + 群 openid + 发送者 senderId）隔离，进程内存保存，5 分钟过期（过期回复超时提示）；每步只认纯数字，选错回报错文案并**保留会话**（报错不刷新过期时间）；群聊每条提示（含报错）末尾自动追加「（下一步请 @我 再回序号，不 @ 我收不到）」，私聊不加——官方群聊只把 @ 机器人的消息推给机器人，不提醒用户就会以为机器人卡死。

## 数据接口：清和 API

### 请求格式

```
GET https://api.qhsou.com/api/movie.php?wd=<URL 编码后的片名>
```

免 key，公开接口。`searchMovies(name)` 即按此请求：片名经 `encodeURIComponent` 编码，20 秒超时，HTTP 非 200 抛错；上层命令把它转成「片源服务开小差了：…」的报错文案。

### 成功返回样例（真实结构脱敏截取：域名、ID、名单已替换/截断）

```json
{
"code": 1,
"msg": "获取成功",
"total": 11,
"list": [
{
"vod_id": "00000",
"vod_name": "蜘蛛侠：崭新之日",
"vod_sub": "蜘蛛侠：英雄重生(港),蜘蛛侠4,Spider-Man 4",
"vod_pic": "https://img.example.com/upload/vod/poster.jpg",
"vod_actor": "汤姆·霍兰德,赞达亚",
"vod_director": "德斯汀·丹尼尔·克雷顿",
"vod_area": "美国",
"vod_year": "2026",
"type_name": "动作片",
"vod_class": "动作,科幻,奇幻",
"vod_blurb": "&amp;amp;nbsp;彼得·帕克（汤姆·霍兰德 饰）自愿让全世界遗忘自己，转眼已是四年……",
"vod_content": "&lt;p&gt;&amp;nbsp;彼得·帕克……&lt;/p&gt;",
"vod_play_url": "HD中字$https://share.example.com/share/demo-page$$$HD中字$https://cdn.example.com/2026/00000/index.m3u8"
}
]
}
```

### 查无此片时的返回（实测形态）

```json
{ "code": 0, "msg": "数据列表", "list": []}
```

注意：空结果**没有 `total` 字段**。`searchMovies` 对此已处理：`list` 缺失或非数组按空数组，`total` 缺省取 `list.length`；命令层据空列表回「没搜到」文案，不会抛错。

### 字段契约（本功能实际使用的）

| 字段 | 用途 |
| --- | --- |
| `vod_name` | 片名（经 `cleanHtml` 清理后展示） |
| `vod_pic` | 海报图 URL：搜片列表取第一条下载做配图；最终卡片作封面；下载走 SSRF 防护（见集成契约） |
| `vod_year` / `type_name` | 选片列表里的年份与类型标注 |
| `vod_actor` | 主演（接口返回，本功能当前未展示） |
| `vod_blurb` | 简介：混有 HTML 实体且常为**双重编码**（如 `&amp;amp;nbsp;`），必须经 `cleanHtml` 多轮解码+剥标签后才能展示；`vod_content` 是带标签的长简介，本功能未使用 |
| `vod_play_url` | 播放地址串，文法见下 |

### vod_play_url 文法

```
整串:= 线路组 ("$$$" 线路组)*
线路组:= 条目 ("#" 条目)*
条目:= 集名 "$" 链接 （以第一个 "$" 切分；无 "$" 时整条按链接处理）
链接:= http(s) URL （非 http(s) 条目被丢弃）
```

一个线路组 = 一条线路。链接按后缀分两类：以 `.m3u8` 结尾（可带查询串）为 `m3u8`，其余为 `分享页`。`parsePlayUrl` 输出平铺数组 `[{ line, name, url, kind}]`（line 从 1 起），`groupEpisodes` / `parsePlayGroups` 再按线路分组。实测注意：同一部片的不同线路组常常是「同一内容的分享页版与 m3u8 版」（如上例），选集逻辑据此做分享页优先跳转。

## 命令解析与归一化

- `normalizeIncomingText`：剥掉任意位置的 `<@...>` 提及占位符，折叠全部空白（含全角空格、制表符）为单空格，去首尾。**坑**：GROUP_MESSAGE_CREATE 事件给的原始 content 带 `<@openid>` 占位符，且 openid 是十六进制串不是纯数字——早期只剥纯数字占位符，群里 `/电影` 完全不命中、请求掉进聊天被模型乱答（2026-10-20 实测事故）。
- `normalizeCommandText`：全角斜杠 `／` → `/`；行首 `/ `（斜杠后空格）→ `/`，即 `/ 电影 蜘蛛侠` 也认。
- `parseCommand`：先归一化，再按空白切 `head / args`；整词不命中触发词时走 `splitGluedCommand` 前缀拆分：head 以某触发词（带/不带斜杠两种形态，最长优先）开头且**余下部分 ≥ 2 字**才拆，如 `/电影蜘蛛侠` → head=`/电影`、args=`蜘蛛侠`；余下 1 字不拆，防 `/电影院` 被误拆成搜「院」。
- `findCommand`：head 带不带斜杠互认，裸 `电影 <片名>` 开头同样命中 `/电影` 命令。

## 选片状态机

会话对象 `{ stage, list, picked, eps | lines, lineIdx, ts, promptId}`，stage 流转：

| stage | 含义 | 合法输入 | 成功后 |
| --- | --- | --- | --- |
| `pick` | 选片 | 1~列表长度 | 集数 ≤12 → `ep`；>12 多线 → `line`；>12 单线 → `range` |
| `ep` | 短列表选集 | 1~总条数 | 出最终消息、清会话 |
| `line` | 选线路 | 1~线路数 | 锁定线路 → `range`，回该线集数范围 |
| `range` | 按集数选集 | 1~该线集数 | 出最终消息、清会话 |

`handleMoviePick(msg, input)` 返回 `{ text}`（中间步/报错）或 `{ text, card, final: true}`（最终步）或带 `advanced: true`（成功推进的中间步，供撤回编排判断）；无会话返回 `null`。集数范围文案只给首尾集名（如 `第01集～第163集`），集数多时不要逐条列——会刷屏且超消息长度。

## 展示与发送（平台实测结论）

1. **群聊 Ark 卡片不渲染**：Ark 模板 37 在群里发送接口回 HTTP 200，但客户端不显示（2026-10-20 两次实测复现；私聊正常）。因此 `deliverMovieFinal` 按 `target.scope` 分流：**群聊跳过 Ark，直接发 Markdown 链接**（`groupMarkdown`：`🎬 《片名》` 换行 `[▶ 点我播放：<集名>](<jumpUrl>)`），Markdown 失败再降级纯文本（标题+集名+裸链接）；**私聊走 Ark 37 → Markdown 锚文本 → 纯文本**三级降级。
2. Ark 模板 37 为官方内置模板、免审核，字段：`#PROMPT#`（通知栏提示）、`#METATITLE#`（标题）、`#METASUBTITLE#`（副标题）、`#METACOVER#`（封面图 URL）、`#METAURL#`（点击跳转）；发送走 msg_type=3。没有海报 URL 时模板用不了，`buildMovieCard` 返回 `ark: null`。
3. **m3u8 在 QQ 内置浏览器里播不了**（打开只是播放列表文本）。故最终跳转地址优先同片**分享页**：`findShareJumpUrl` 优先级 = 选中本身即分享页 → 同名集的分享页 → 同序号对位分享页 → 任一分享页；实在没有分享页才直跳 m3u8，并在副标题/说明行注明「点开后用浏览器/播放器打开」。
4. 卡片与 Markdown 锚文本让聊天正文里不出现裸 URL（避开把链接设成违禁词的群）；只有纯文本兜底形态会出现裸链接。注意：平台审核侧仍能看到跳转 URL，卡片不是绕审核手段。
5. 中间步（选片/选线/范围/报错）一律纯文本一条，不发图不发卡。

## 答后撤回编排

- **官方有撤回接口**（早期误传「官方无撤回」已纠正）：群聊 `delete_group_message`、单聊 `delete_private_message`，只能撤回**机器人自己发的**消息，且须在**发送后 2 分钟内**。SDK 侧对应 `recallMessage(target, messageId)`。
- 编排（`noteMoviePromptId / peekMoviePromptId / settleMovieStep`）：每步提示发出后把 message id 登记进会话；用户下一步作答成功时**先发新内容、再撤回上一步提示**，全程走完聊天里只留最终消息；最终消息永不撤回。
- 顺序要点：`peekMoviePromptId` 必须在 `handleMoviePick` **之前**调用（最终步会清会话，之后取不到）。
- **报错消息既不登记也不触发撤回**：把报错 id 登记为待撤回会顶替真正的当前提示，导致该撤的提示永远撤不掉（实测修过的坑）；`settleMovieStep` 只在 `advanced || final` 时执行撤回，且非 final 的 advanced 步才把新 `sentId` 登记为下一待撤回。
- 撤回失败（超 2 分钟窗口、平台拒绝等）只记审计、返回 `null`，绝不阻塞流程。

## 宿主集成契约

- sender 四个发送方法与 `recallMessage` 的签名见「快速接入」②；返回值里的消息 id 是撤回编排的命脉：`sendText / sendMarkdown / send` 的 id 在返回值 `.id`，`sendImage` 的 id 在 `.message.id`，宿主取 id 时不要搞混。
- 命令 `run({ msg, args})` 返回 `{ error}`（宿主回 `❌ <error>`）或 `{ text}` 或 `{ image: { buffer}, caption}`；宿主负责实际发送、限流（如每人每 10 分钟 10 次）、审计埋点（选集成功/失败、撤回成功/失败）。
- 海报下载在模块内走 `safeFetchBuffer`：逐跳 DNS 校验、拒绝内网/保留地址、跟随重定向 ≤6 跳、上限 5MB、校验图片魔数；失败则只发文字列表，不影响搜片。
- 会话是进程内 `Map`：机器人重启即丢（5 分钟 TTL 下可接受）；多实例部署时同一用户的步骤必须落到同一实例，否则会话对不上。
- 凭证与本模块无关：模块不需要、也不接收任何机器人凭证；宿主自行保管凭证文件，仓库 `.gitignore` 已预置凭证类文件的忽略规则，不要把真实凭证提交进仓库。

## 合规须知

本 skill 仅供编程学习与技术交流。影片数据来自第三方公开接口（api.qhsou.com），该接口由其运营方公开发布，本项目与接口方无任何隶属、授权或合作关系；本项目不存储、不托管、不分发任何影片文件，全部内容版权归原权利人及合法授权方所有。使用者应遵守所在地法律法规，因使用产生的一切后果由使用者自行承担。完整声明见 [DISCLAIMER.md](./DISCLAIMER.md)。

## 文件清单

| 文件 | 内容 |
| --- | --- |
| `movie.mjs` | 功能实现（单文件，含解析/状态机/卡片/发送与撤回编排） |
| `smoke-test.mjs` | 离线自检：`node smoke-test.mjs`，28 项断言全绿才算包可用 |
| `example-host.mjs` | 最小宿主接线示例（假 sender 干跑全流程，不打真实网络） |
| `SKILL.md` | 本文件 |
| `README.md` | 一句话说明 |
| `DISCLAIMER.md` | 免责声明（中英双语，正式版） |
| `.gitignore` | 凭证、依赖、数据与日志的忽略规则 |

## 免责声明（简版）

本项目仅供编程学习与技术交流，禁止任何商业用途及二次分发牟利。影片数据来自第三方公开接口（api.qhsou.com），本项目与接口方无任何隶属、授权或合作关系；本项目不存储、不托管、不分发任何影片文件，全部内容版权归原权利人及合法授权方所有。使用者须自行遵守所在地法律法规，因使用本项目产生的一切后果由使用者自行承担，作者不承担任何责任。若权利方认为内容侵权，请通过仓库 Issue 联系，核实后立即删除。完整版见 [DISCLAIMER.md](./DISCLAIMER.md)。
