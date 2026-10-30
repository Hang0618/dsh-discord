# dsh-discord

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%5E22.19%20%7C%20%3E%3D24-brightgreen)](package.json)
[![Cordis Plugin](https://img.shields.io/badge/Cordis-plugin-8a2be2)](https://github.com/deepseek-ai/deepseek-harness)

把 DSH（DeepSeek Harness）接到 **Discord 私聊和服务器**。零依赖的 Cordis 插件：
只用 Node 自带的 `fetch` 和全局 `WebSocket`，不装 discord.js。

> **插件本身不带人设。** 你在 `AGENTS.md`（或 `systemPromptExtra`）里写成什么样，它在 Discord 里就什么样；`triggerWords` 默认是空的，群里要叫它得自己配名字。

## 它做什么

- 收消息 → 转成 DSH 的用户消息 → 交给 agent，模型边说边把字**编辑进同一条消息**（流式）
- 用一个**固定的 SessionId**，所以人设、记忆跟 GUI 那边是同一套
- 三个小命令（只认主人）：`/new`（换上下文）、`/stop`（打断）、`/status`
- **私聊和每个服务器用不同会话**：私聊跟 GUI 主会话共用记忆，每个服务器单独一套，互不串味
- 群聊会先读频道里**最近几条**聊天记录（默认 10 条，可调），不会「回第 3 句却回了最新一句」
- 两句 emoji 暗号直接固定回复，不花 token、不惊动模型

### 谁能跟它说话

| 场景 | 规则 |
|---|---|
| 私聊 | **永远只认主人**，别人私聊一律不理 |
| 服务器 · 主人 | 主人 `@` 它、话里提到 `triggerWords`（你自己配的叫法），或者 `@` 了群里某个人，都算在找它；**主人优先**：主人和别人同时说话时，先回主人再回别人 |
| 服务器 · 别人 | 必须 `@` 它；第一次会被挂到 **设置 → Discord 准入** 等主人点头 |
| 服务器 · 别人的消息 @ 了别人 | 那人在跟别人说话、又没 `@` 它 → **它不插嘴**（主人的消息例外：主人 `@` 人是在给它指人，它会看到 `@对方的显示名` 并接话） |
| 服务器 · 用「回复/引用」 | 用 Discord 的 reply 回了它某条消息，**不用 @ 也算在找它**（`referenced_message.author` 是它即可）；被引用那条的内容会一起读进上下文（「你看！」不会没头没尾），引用被删了会标一句「看不到」 |
| 服务器 · 别的机器人 | **不自动回**。它一说话就先挂到 **设置 → Discord 准入**，主人选「接收并跟它聊 / 只接收不主动回 / 拒绝」，同一个 bot 只问一次。批准「跟它聊」之后也只在它 **@ 本 bot 或引用本 bot** 时才接话——bot 之间的闲聊、点名别人，它不凑热闹 |
| 准入之后 | 选「每次都要 @」→ 以后必须 `@` 或引用它；选「不用每次 @」→ `@`/引用之外，叫它的名字（`triggerWords`）也叫得动，但**不会每句都接** |
| 群聊闲聊 | 已批准的人在群里随便说、又没叫它的名字 → 它安静待着，不插嘴 |

确认卡片在 GUI 的 **设置 → Discord 准入** 里：允许 / 允许且每次都要 @ / 拒绝，已批准的人也可以撤回。
陌生人没被批准时只会收到一句「主人还没决定要不要让它跟你聊」，不会再打扰。

机器人那栏的决定也会落盘（`botPolicy`）。选「接收并跟它聊」后，它会正常回它；为防止两个 bot
互相刷屏，同一个 bot 5 分钟内连聊最多 4 轮，中间只要有人说话就清零重算。

**引用回复（reply）**：配置 `replyToUser` 默认 `true`，它回话时会把消息引用到对面那条上，
一眼看得出在回哪句；不想要就在 `discord-bridge.json` 里写 `"replyToUser": false`。

### 会话怎么分

- **私聊**：跟 GUI 主会话共用同一个 SessionId（`sessionId`，默认 `session-discord-main`）——你在 GUI 里聊过的，私聊里它也记得。
- **服务器**：每个服务器（guild）一个独立会话，默认 id 是 `session-discord-guild-<服务器id>`（`guildSessionPrefix` 可改，也可以用 `guildSessions` 明确指定）。不同服务器之间、服务器和私聊之间，记忆不串。
- `/new` 只作废**你当前所在的那个会话**；`/status` 会显示当前用的是哪一套。
- 好处：群里的话题不会污染私聊；一个群玩嗨了，另一个群还是干净的。

### 群聊先读几条历史

群里有人叫它时，它会把频道里最近的几条消息一起读进上下文（默认 **10 条**），
这样你回第 3 句时它不会只顾着回最新一句。条数在 **设置 → Discord → 余额预算**
面板里改（`guildHistoryLimit`，0 = 不读，最大 100）。**只对服务器生效**，私聊不读历史。

### 暗号

看到这两串 emoji 时，它不经过模型、直接回一句（不花 token、不排队）：

| 你发 | 它回 |
|---|---|
| `:raised_hand::rage::raised_back_of_hand:`（🖐️😡🤚） | `token回！:raised_hand::rage::raised_back_of_hand:` |
| `:raised_hand::smiling_imp::raised_back_of_hand:`（🖐️😈🤚） | `token回！:wave: :smiling_imp::wave:` |

短码和真 emoji 都认；`emojiReplies` 可以自己改或加别的暗号。

### 怎么称呼对面

称呼跟着**当前这条消息的说话人**走，不再是一个会话一套固定叫法：

- **私聊**：照旧叫「主人」。
- **服务器里 + 别人搭话**：直接叫对方的 Discord 昵称（取 `member.nick` > `global_name` > `username`），
  绝不叫「主人」，也不把对方当主人。
- **服务器里 + 主人本人**：照旧叫「主人」（主人本人的称呼私聊、服务器都不变）。
- 实现上是给 agent 挂一条 `discord-speaker` 的 systemPrompt context（order 20000，
  排在 DSH 人设段之后才压得住全局的「主人」），换人时才刷新，
  不会每轮把系统提示词的缓存全废掉；fish-memory 里会话级的称呼也不再钉死成「主人」。

### 余额预算（两道闸门：余额线 + 花费额度）

给「全局 / 私聊 / 某个服务器」各画两类限制，触到任意一条它就自动闭嘴：
不投喂 agent、不花 token，只在该频道里提醒一次（同一作用域 10 分钟内不重复）。

1. **余额线**：账号余额跌到线以下（`<=`）就停，充值回升后自己恢复。
2. **花费额度**：这个作用域累计花掉多少钱达到额度就停，需要**清零账本或调大额度**才继续。
   - 花费按 DeepSeek 官方价折算：`缓存命中 / 缓存未命中 / 输出` 三段分别计价，北京时间
     周一~周五 9-12、14-18 是高峰价，其余空闲价；Pro 与 Flash 两套价目。
   - 记账钩子：监听 DSH 的 `session/event`，每来一条 `assistant/message` 按 `usage` 累加，
     `turn/end` 时结算到「当时说话人所在的作用域」（私聊 / 某个服务器），并落盘到配置的 `spend`。

- 余额来源：DSH 账号服务 `deepseekAccount.getBalance()`（充值钱包 + 赠金一起算，只登录客户端也读得到）；
  读不到时退回 `dsh-whale-widget` 的账本 `<DSH_HOME>/.dshw-usage.json` 的 `lastBalance`（30 分钟内的才信）。
- 两条路都失败 → **fail-open**：照常聊天，面板上标红写「余额读不到」。宁可漏停，也不因为一次网络抽风把主人关在门外。
- **只管别人**：主人自己聊天默认不卡额度（私聊、群聊都不卡），只有服务器里的其他人回复时才可能被余额线/额度拦住；开关 `budget.skipOwners`（默认 `true`，面板里有勾选框）。
- 阈值优先级：服务器专属 > 私聊专属 > 全局。
- 语义：**留空 = 跟着全局走**；**填 `0` = 这条线自己不限**（想让私聊豁免全局线，就把私聊线填 0）。
- 面板：**设置 → Discord → 余额预算**，能看当前余额、每个作用域已花多少、填线/额度/清零，都是即时生效 + 落盘。
- 通知：踩到线的时候，**DSH 页面右下角会弹一条红条**（15 秒），有桌面通知权限的还会同时弹系统通知；点一下「开启桌面通知」授权。
- `/status` 也会顺带报余额和已花。

配置长这样（也可以只在面板里改，插件自己落盘）：

```json
"budget": {
  "enabled": true,
  "global": 5,
  "dm": 0,
  "globalQuota": 20,
  "dmQuota": null,
  "guilds": {
    "123456789012345678": { "name": "某个群", "min": 3, "quota": 0.01 },
    "1111": { "name": "免检群", "min": 0 }
  }
},
"spend": {
  "guild:123456789012345678": { "spent": 0.0042, "updatedAt": 1730000000000 }
}
```

（`dm`/`min` 写 `null` 或不写 = 继承全局线；写 `0` = 该处不设限。）

## 装

要求：DSH（Desktop 版，`dsh` CLI 可用）、Node `^22.19.0 || >=24`。

**方式一：从 GitHub 直装**

```bash
dsh plugin add "https://github.com/Hang0618/dsh-discord" --profile desktop
```

**方式二：clone 到本地再装**

```bash
git clone https://github.com/Hang0618/dsh-discord.git
dsh plugin add "$PWD/dsh-discord" --profile desktop
```

`dsh plugin add` 只是把参数转发给 pnpm。装完之后还要把这个包登记进 desktop profile 的
`package.json`，让 DSH 装配它：

```json
"dsh": {
  "profile": {
    "bundles": [
      "...",
      "dsh-discord"
    ]
  }
}
```

profile 目录一般在 `<DSH_HOME>/profiles/desktop`，改完重启 DSH 即可。

## 配置

token 和 user ID **不进源码**，写在 `<DSH_HOME>/discord-bridge.json`（默认 `~/.dsh/discord-bridge.json`）：

```json
{
  "token": "MTU2...你的 bot token",
  "ownerIds": ["123456789012345678"],
  "dmOnly": true,
  "guildChat": true,
  "triggerWords": "小助手"
}
```

也可以直接用环境变量 `DISCORD_BOT_TOKEN` 和 `DISCORD_OWNER_IDS`（逗号分隔）。

| 字段 | 默认 | 说明 |
|---|---|---|
| `token` | — | Bot Token，必填 |
| `ownerIds` | `[]` | 主人名单：私聊只认他们，群里也是他们说话它才可能接 |
| `dmOnly` | `true` | `true` 时**群聊整个关掉**（只留私聊，一期行为不变） |
| `guildChat` | `false` | 群聊总开关：`true` 且 `dmOnly:false` 才在服务器里说话 |
| `allowedGuildIds` | `[]` | 群聊只在这些服务器里生效，空 = 不限 |
| `triggerWords` | 见上 | 主人没 @ 它时，话里含这些词就主动插一句 |
| `grants` | `{}` | 已批准的外部用户（GUI 里点出来的，插件自己维护，别手改） |
| `botPolicy` | `{}` | 已批准/记录过的机器人：`{ accept, chat }`（GUI 里点出来的，别手改） |
| `budget` | 见上文 | 余额预算：`{ enabled, global, dm, globalQuota, dmQuota, guilds, skipOwners }` |
| `budget.skipOwners` | `true` | 主人自己聊天不计额度（余额线/额度都跳过，只管服务器里的其他人） |
| `guildSessionPrefix` | `session-discord-guild-` | 服务器会话 id 前缀（每个服务器一套独立会话） |
| `guildSessions` | `{}` | 服务器 id → 会话 id 的显式映射（插件自动补，一般不用手改） |
| `guildHistoryLimit` | `10` | 群聊先读几条最近消息（0 = 不读，最大 100；只服务器生效） |
| `emojiReplies` | 见上文 | 暗号表：`{ "你发的": "它回的" }`，短码或真 emoji 都认 |
| `spend` | `{}` | 花费账本：`{ "<scope>": { spent, updatedAt, since } }`，由插件自己攒 |
| `guildNames` | `{}` | 见过的服务器 id → 名字（面板显示用，插件自动补） |
| `consentTimeoutMs` | `600000` | 陌生人的确认卡片等多久（超时作废，再来就再问） |
| `sessionId` | `session-discord-main` | 固定会话 id（记忆靠它对齐） |
| `seedMemory` | `true` | 首次启动把主会话记忆复制过来 |
| `seedMemoryFrom` | 空 | 从哪个会话复制（填 GUI 主会话的 id；留空 = 不预置） |
| `cwd` | 进程 cwd | agent 的工作目录 |
| `model` / `provider` | profile 默认 | 单独给 Discord 换模型 |
| `agentPreset` | `standard` | agent 用哪套 preset（人设、工具集、提示词分段） |
| `stream` | `true` | 是否流式编辑 |
| `chunkLimit` | `1900` | 单条上限（Discord 上限 2000） |
| `editIntervalMs` | `1200` | 编辑节流（别打满限流） |

## 日志

`<DSH_HOME>/discord-bridge.log`，2MB 滚动一次。token 会被自动打码。

## 已知边界

- 只认文字：图片/文件只回一句「看不懂」
- 审批/提问不会飘到 Discord（走 GUI。**例外**：陌生人的准入确认走 GUI 的「Discord 准入」页）
- 一个 bot 一个主人，不做多用户隔离；批准的人跟主人共用同一个会话上下文（权限上仍然分得清）
- 群里别人未获批时，它不会把他们的内容转给 agent
- 群聊历史只读「最近 N 条」，更早的翻不到；要它回特别老的消息时，把它回复/引用一下最稳

## 排障

**`4014 Disallowed intent(s)`** —— bot 没开「MESSAGE CONTENT」特权 intent。
去 https://discord.com/developers/applications → 你的应用 → **Bot** →
Privileged Gateway Intents → 勾上 **MESSAGE CONTENT INTENT** → Save。
开关打开后不用重启 DSH，插件会自己在 30 秒内连上。

**`50278 Cannot send messages to this user due to having no mutual guilds`**
—— bot 和你没有共同服务器，Discord 不允许私聊。先把 bot 邀请进任意一个服务器：

```
https://discord.com/api/oauth2/authorize?client_id=<应用ID>&permissions=2048&scope=bot%20applications.commands
```

**`4004`** —— token 错了，检查 `discord-bridge.json`。

## 目录

```
src/
├── index.js      # Cordis 插件入口：收消息、调度、命令
├── config.js     # 配置合并（patch < 文件 < 环境变量）
├── gateway.js    # Discord Gateway v10：IDENTIFY / HEARTBEAT / RESUME / 重连
├── rest.js       # REST v10 封装 + 限流
├── outbound.js   # 流式输出：先发一条再编辑同一条
├── chunker.js    # 1900 字切分（Markdown 感知优先按行切）
├── session.js    # 固定 SessionId、记忆过继、说话人称呼
├── consent.js    # 陌生人/机器人准入卡片
├── budget.js     # 余额 + 花费额度
├── client.js     # GUI 面板：设置 → Discord（准入 & 预算）
└── log.js        # 日志（token 打码、2MB 滚动）
```

## License

[MIT](LICENSE)

## 致谢

- 架构参考了 [tencent-connect/dsh-qqbot](https://github.com/tencent-connect/dsh-qqbot)（MIT）的 Cordis 插件组织方式
- 写给住在 DSH 里的每一个 agent 🐋
