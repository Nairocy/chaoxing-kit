# chaoxing-kit

超星学习通（xuexitong / chaoxing）课程自动化工具包。**真实 1x 播放、不伪造进度上报**，通过 Chrome DevTools Protocol 直接操控真实页面。

提供两种入口，共用同一套 core：

- **CLI**：`chaoxing scan / run / status / doc / quiz / score`
- **MCP server**：把同样的能力暴露成 MCP tools，供 Claude Desktop / Cursor / Hermes 等 agent 调用

## 设计原则

1. **不碰协议层**：`multimedia/log` 心跳里的 `enc` 是页面 JS 现算的签名、`isdrag` 是防拖拽标记 —— 一律不动，让真播放器自己发。这是它能长时间稳定跑的原因。
2. **完成判定读服务端**：视频播完只是本地结束，还要回读右栏 `.icon_Completed`；任务点是否记账则看 `knowledge/cards` 里对应卡片有没有 `ans-job-finished`、`mArg.attachments[].isPassed`。**目录的 ✅ 可能骗人**（只反映节点访问过）。
3. **零依赖**：不用 puppeteer / playwright，自带 200 行 CDP 客户端，只依赖 node 内置模块。

## 前置要求

| 项 | 说明 |
|---|---|
| Node.js | ≥ 18（用内置 fetch / ESM） |
| 浏览器 | Edge 或任意 Chromium 内核（`CX_BROWSER` 指定路径；默认 Windows 的 Edge） |
| 视觉能力 LLM | **测验环节必需**：超星有字体混淆（DOM 文本是乱码），题目只能靠截图 + 视觉模型读。本工具只负责截图与点选，读题交给调用方（如 DeepSeek 4.1 系列、Qwen-VL、Claude 等） |

## 安装

```bash
git clone https://github.com/Nairocy/chaoxing-kit.git
cd chaoxing-kit
node src/cli.mjs --help
# 或全局： npm link
```

## 快速开始

```bash
# 1. 登录（弹有头 Edge，扫码；登录态存 profile，后续无头复用）
chaoxing login

# 2. 找到课程参数：courseId / clazzId（课程页 URL 里就有）
#    例：.../mycourse/studentstudy?courseId=266987706&clazzid=154444476&cpi=568614919
chaoxing scan --course 266987706/154444476 --cpi 568614919 --start 0 --limit 18

# 3. 跑视频（真实播放，播完回读核验）
chaoxing run --course 266987706/154444476 --cpi 568614919 --start 1.1 --max 8

# 4. 看进度 / 判阶段
chaoxing status --course ...
chaoxing stage  --course ...

# 5. 文档任务点（滚到末页触发记账；多文档节点会逐个 iframe 处理）
chaoxing doc 9.1 --course ... --kid <knowledgeId>

# 6. 测验：先截图 → 视觉模型读题 → 按行索引点选 → 提交 → 读分
chaoxing quiz 4.2 --course ... --shots
chaoxing quiz 4.2 --course ... --perq "4,4,2" --ans "1:B,2:AC,3:A" --submit
chaoxing score --course ...
```

## MCP 接入

```json
{
  "mcpServers": {
    "chaoxing": {
      "command": "node",
      "args": ["/absolute/path/to/chaoxing-kit/src/mcp.mjs"]
    }
  }
}
```

工具列表：

| tool | 作用 |
|---|---|
| `cx_login` | 有头浏览器扫码登录 |
| `cx_scan` | 扫描课程结构（任务点类型/时长/完成态） |
| `cx_run` | 跑视频（`mil` / `skipWork` / `force` 等模式） |
| `cx_status` | 目录完成度 + `cnt` 欠账分布 |
| `cx_stage` | 阶段判定（PLAYING / VIDEOS_DONE / VIDEOS_LEFT / BUSY） |
| `cx_doc` | 文档任务点滚动记账 |
| `cx_quiz_shots` | 测验分段截图（返回路径，交给视觉模型） |
| `cx_quiz_answer` | 按行索引点选 / 提交 |
| `cx_score` | 读成绩页逐题得分 |

典型 agent 流程：`cx_scan` → `cx_run(mil:true)` 刷完视频 → `cx_stage` 确认 `VIDEOS_DONE` → 逐节 `cx_quiz_shots` → 视觉模型出答案 → `cx_quiz_answer` → `cx_score` 核验。

## 关键概念

**`cnt`（任务点欠账数）**：右栏目录每个节点带一个 `jobUnfinishCount`

- `2` = 视频 + 测验都欠
- `1` = 只欠测验（视频已记账）
- 空 = 无任务点（空壳父节点 / 阅读 / 问卷）

**课型 → 跑法**

| 课型 | 特征 | 跑法 |
|---|---|---|
| A 纯视频 | 节点只有 video | 普通模式 |
| B 内嵌测验 | 每节 = 视频 + 章节测验（`cnt=2`） | `--mil`：先刷光视频，测验另做 |
| C 复合任务点 | 每节挂 document + video + workid | `--mil` + `doc` 逐节滚文档 |
| D 独立测试题 | 章末单独一个 work 节点 | `--skip-work` 跳过测验节点 |

**测验为什么按「第几行」点**：超星开了字体混淆，DOM 文本是乱码，只能按 `a.fl.after` 的行位置索引。`--perq` 给每题选项数（累加算 base），`--ans` 给 `题号:字母`。判断题 2 项；排序题的下拉框不在 `a.fl.after` 里，首项要写 `0`；图片选项同样占行。

**目录假完成**：目录 ✅ 只代表节点被访问过，不代表任务点记账。遇到「目录完成但卡片没有 `ans-job-finished`」的节点，用 `--force <节号>` 强制补课。

## 限制

- **只能 1x 实时**：这是真实播放的必然代价，21 小时的课就是 21 小时
- **测验不能全自动**：需要视觉模型读题；填空题（自定义 div 编辑器）无法程序化填入
- **单实例**：一个浏览器调试端口 + 一个 profile，跑课期间同账号别在手机/其它浏览器进章节页（会触发「多终端登录」风控）
- **题库不可靠**：外部题库答案键经常错位，必须按题干逐字对位，不要盲抄

## 免责声明

本项目仅用于学习 Chrome DevTools Protocol 自动化与个人学习记录管理。使用它可能违反超星用户协议及所在学校的学习纪律，由此产生的后果由使用者自负。请勿用于商业代刷或成绩作弊。
