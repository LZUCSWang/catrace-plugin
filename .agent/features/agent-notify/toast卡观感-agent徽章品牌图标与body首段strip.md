# Toast 卡观感：agent 徽章品牌图标从哪来、body 首段与 strip

`agent-notify/ui.mjs` 的卡片视觉约定与图标资产来源。改观感前先对照宿主原生卡（主仓 `src/components/SdkToastCard.vue`），分清「宿主惯例」和「插件自创」。

## agent 徽章

- 规范：**2rem 圆角方块**（border-radius 0.625rem），白字/白色 glyph，与标题**垂直居中**（`header-left` align-items: center），hover 出全名（原生 title 属性）。
- 渲染优先级：**`img`（PNG data URL）> `icon`（SVG path）> `label`（字母兜底）**——加新 agent 时能拿到真图标就放前两级，拿不到就字母。
- 品牌色定义在 `ui.mjs` 的 `AGENT_BADGES` 表：Claude 珊瑚橙 #D97757、ZCode 深灰 #1C1C1E、Codex 绿 #10A37F、Gemini 蓝 #4285F4、Kimi 深灰蓝 #334155。

### 图标资产从哪来

| agent | 来源 | 形态 |
|-------|------|------|
| Claude / Codex / Gemini / Kimi | simple-icons（`cdn.jsdelivr.net/npm/simple-icons/icons/<name>.svg`，kimi 已收录） | 24×24 单路径 SVG，把 `d` 内联进 `icon` 字段，白色 fill |
| ZCode | 桌面端安装目录 `D:\Apps\ZCode\resources\icon.png`（1024²） | PowerShell System.Drawing 缩到 96px → base64 data URL 内联进 `img` 字段 |

为什么 ZCode 不用官方 logo.svg：chat.z.ai 的 favicon.svg 是 HTML 壳，真身 `z-cdn.chatglm.cn/z-ai/static/logo.svg` 是 Illustrator 导出的 15KB 多层文件（渐变+描边+透明度层，浅灰底设计），塞进小徽章既脏又脆。等 simple-icons 收录后一行换上。

**换图标/重生成流程**：重新下载 SVG 或重缩 PNG → 更新 `AGENT_BADGES` 对应条目 → `node --check ui.mjs` → 重载插件。图标是内联的冻结副本，官方换了不会自动跟。

## body：首段 + strip

Stop 卡的 body 来自 `last_assistant_message`——assistant 回复的 markdown 原文。直接排会 `**`、反引号裸奔，还会从句子中间截断。`bodyPreview()` 的两步：

1. **取首个自然段**（按空行切），不搞句中截断；
2. **`stripMarkdown()` 只剥渲染层**：加粗/下划线记号、行内反引号、行首 `#`、链接括号。数据层 `entry.message` 保留原文，调试面板「原始」视图仍能看到完整 markdown。

只做轻量 strip、不渲染完整 markdown：宿主没给插件 markdown 渲染器，自己写 mini renderer 成本不匹配收益。

## 其他观感决策（用户拍板）

- **状态卡呼吸点已移除**：「任务完成/失败」这类终态卡还在呼吸是伪动态。权限审批卡的琥珀色呼吸点**保留**——「卡住等你操作」是有效信号。
- **「点击前往会话」提示行常驻**（用户明确选了不 hover 化）。
- 调试字段面板是用户按需开的调试工具（`debugView: common/raw`），默认 off；批评观感前先分默认态和用户自开配置。
