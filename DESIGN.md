# DESIGN.md — 设计规范

本文件供 AI 遵守。生成或修改 UI 前必须阅读；新增/变更视觉规则时，先更新本文件，再改组件。
违反本文件 = 设计系统缺陷，不是风格偏好。
视觉 Token 来源：ZCode（Apache-2.0，https://github.com/zai-org/ZCode，packages/ui/src/styles.css）。

## 0. 产品气质

本项目是 管理型（AI 运维行动与治理工作台） 界面。设计基调：冷静、紧凑、可读，而非装饰性。

- Design for：长会话 / 高信息密度 / 键盘驱动 / 明暗双主题 / 中文与长文本 / 技术类内容突出
- Avoid：营销式大留白 / 默认渐变 / 大面积品牌填充 / 背景-卡片-浮层层级含糊

## 1. 字号与字体（共用）

```css
:root { --ui-font-size: 14px; } /* 界面字号基准，改字号只改这一个变量 */
@theme {
  --text-ui-xl: calc(var(--ui-font-size) + 4px);      /* 18px: h1 */
  --text-ui-lg: calc(var(--ui-font-size) + 2px);      /* 16px: h2 */
  --text-ui-base: var(--ui-font-size);                /* 14px: 正文/按钮/区块标题 */
  --text-ui-caption: calc(var(--ui-font-size) - 1px); /* 13px: 紧凑辅助文案 */
  --text-ui-sm: calc(var(--ui-font-size) - 2px);      /* 12px: 次要文案/tooltip */
  --text-ui-xs: calc(var(--ui-font-size) - 4px);      /* 10px: 徽章/快捷键/计数器 */
  --text-ui-2xs: calc(var(--ui-font-size) - 5px);     /* 9px: 仅图表轴线，禁用正文 */
  --font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas,
    "Liberation Mono", "Courier New", "Microsoft YaHei UI", "Microsoft YaHei",
    "PingFang SC", "Noto Sans CJK SC", monospace;
}
```

- 界面字号只用 text-ui-* 刻度；禁止 Tailwind 内置 text-base/sm/xs、禁止 text-[13px]、禁止内联 font-size
- 改界面字号只改 --ui-font-size，禁止改根 html 字号；命令/路径/代码/哈希用 font-mono

## 2. 颜色 Token

### 2.1 亮色主题（默认）

```css
.theme-light {
  --color-brand: #000000;
  --color-primary: #000000; --color-primary-foreground: #ffffff;
  --color-secondary: #e6e6e6;
  --color-background: #f8f8f8;
  --color-background-alt: color-mix(in oklab, var(--color-background) 70%, transparent);
  --color-background-win-alt: #ececee;
  --color-header: #ffffff; --color-panel: #ffffff; --color-sidebar: #f0f0f0;
  --color-surface: rgba(13, 13, 13, 0.03); --color-surface-hover: rgba(13, 13, 13, 0.05);
  --color-card: #ffffff; --color-card-selected: #ffffff; --color-card-border: var(--color-border);
  --color-popover: #ffffff; --color-popover-header: #f8f8f8; --color-popover-border: var(--color-border);
  --color-input: #ffffff; --color-input-focused: #ffffff;
  --color-menu: #ffffff; --color-menu-hover: #f0f0f0;
  --color-border: rgba(13, 13, 13, 0.1); --color-border-hover: rgba(13, 13, 13, 0.15);
  --color-input-border: var(--color-border); --color-input-border-hover: var(--color-border-hover);
  --color-input-border-focused: var(--color-border-hover);
  --color-hover: rgba(13, 13, 13, 0.05); --color-selected: rgba(13, 13, 13, 0.05);
  --color-accent: #ebf4ff; --color-tab: #f0f0f0; --color-tab-active: #ffffff;
  --color-foreground: #262626;
  --color-foreground-subtle: color-mix(in oklab, var(--color-neutral-800) 60%, transparent);
  --color-foreground-subtlest: color-mix(in oklab, var(--color-neutral-800) 40%, transparent);
  --color-foreground-inverse: #ffffff;
  --color-success: #1e8a3e; --color-success-foreground: #ffffff;
  --color-warning: #e07b00; --color-warning-foreground: #ffffff;
  --color-destructive: #e03131; --color-destructive-foreground: #ffffff;
  --color-diff-added: #1e8a3e; --color-diff-added-foreground: #ffffff;
  --color-diff-removed: #e03131; --color-diff-removed-foreground: #ffffff;
  --color-idle-task: #9e77ed; --color-idle-task-surface: #f5f3ff;
  --color-toast: #ffffff; --color-tooltip: #f0f0f0; --color-tooltip-foreground: #0d0d0d;
  --color-tooltip-tag: #e6e6e6; --color-tooltip-tag-foreground: #5c5c5c; --color-tag: #e6e6e6;
  --color-usage-chart-1: #0b7fff; --color-usage-chart-2: #1e8a3e; --color-usage-chart-3: #9e77ed;
  --color-usage-chart-4: #e03131; --color-usage-chart-5: #e07b00; --color-usage-chart-6: #0aa7a7;
}
```

### 2.2 暗色主题

```css
.theme-dark {
  --color-brand: #ffffff;
  --color-primary: #ffffff; --color-primary-foreground: #000000;
  --color-secondary: #363636;
  --color-background: #161616;
  --color-background-alt: color-mix(in oklab, var(--color-background-win-alt) 60%, transparent);
  --color-background-win-alt: #2b2b2b;
  --color-header: #202020; --color-panel: #202020; --color-sidebar: #161616;
  --color-surface: rgba(255, 255, 255, 0.05); --color-surface-hover: rgba(255, 255, 255, 0.1);
  --color-card: #2b2b2b; --color-card-selected: var(--color-input); --color-card-border: var(--color-border);
  --color-popover: #2b2b2b; --color-popover-header: #202020; --color-popover-border: var(--color-border);
  --color-input: #2b2b2b; --color-input-focused: var(--color-input);
  --color-menu: #2b2b2b; --color-menu-hover: #363636;
  --color-border: rgba(255, 255, 255, 0.1); --color-border-hover: rgba(255, 255, 255, 0.15);
  --color-input-border: var(--color-border); --color-input-border-hover: var(--color-border-hover);
  --color-input-border-focused: var(--color-border-hover);
  --color-hover: rgba(255, 255, 255, 0.05); --color-selected: rgba(255, 255, 255, 0.1);
  --color-accent: #001d3d; --color-tab: #202020; --color-tab-active: #161616;
  --color-foreground: #d1d5db;
  --color-foreground-subtle: color-mix(in oklab, var(--color-neutral-300) 60%, transparent);
  --color-foreground-subtlest: color-mix(in oklab, var(--color-neutral-300) 30%, transparent);
  --color-foreground-inverse: #000000;
  --color-success: #46bf72; --color-success-foreground: #000000;
  --color-warning: #ff8a30; --color-warning-foreground: #000000;
  --color-destructive: #ff5c5c; --color-destructive-foreground: #ffffff;
  --color-diff-added: #46bf72; --color-diff-added-foreground: #000000;
  --color-diff-removed: #ff5c5c; --color-diff-removed-foreground: #000000;
  --color-idle-task: #7b5ce5; --color-idle-task-surface: #160d38;
  --color-toast: #2b2b2b; --color-tooltip: #2b2b2b; --color-tooltip-foreground: #f8f8f8;
  --color-tooltip-tag: #363636; --color-tooltip-tag-foreground: #adadad; --color-tag: #363636;
  --color-usage-chart-1: #4099ff; --color-usage-chart-2: #46bf72; --color-usage-chart-3: #7b5ce5;
  --color-usage-chart-4: #ff5c5c; --color-usage-chart-5: #ff8a30; --color-usage-chart-6: #42c8c8;
}
```

### 2.3 颜色使用规则

- 用语义 token，禁止 raw 一次性色值；禁止 text-white/60、border-white/10 这类临时值
- 页面根用 bg-background + text-foreground；内容容器 bg-card / bg-surface；浮层 bg-popover / bg-menu
- hover 用 bg-hover，选中用 bg-selected；主按钮 bg-primary text-primary-foreground
- 品牌色克制使用，禁止全页背景；层级靠背景对比 + 边框表达
- 语义色只在真实语义状态使用

## 3. 间距 / 圆角 / 阴影

### 3.1 间距（基准 4px）

- 4px 图标/文本紧间距 · 8px 控件内边距 · 12px 密集列表行 · 16px 标准卡片 · 20-24px 大区块
- 偏好小集合的重复间距，禁止任意值；flex 带文本加 min-w-0；嵌套滚动加 min-h-0；优先 w-full + max-w-*

### 3.2 圆角（跟随可见容器嵌套层级）

- 第一层可见圆角容器从 rounded-xl 开始，嵌套递减 xl → lg → md → sm（最小）
- 基础控件默认 rounded-lg：父级 xl+ → lg；父级 lg → md；父级 md/sm → sm
- Dialog 壳 rounded-2xl；菜单/下拉/选择面板 rounded-lg；选项行 hover rounded-md
- rounded-full 仅限刻意药丸/圆形；禁止任意圆角值和裸 rounded

### 3.3 阴影（克制）

- Base 无阴影（靠背景对比）· Surface 靠边框 · Overlay shadow-md（菜单/弹层/对话框）· Attention shadow-lg（仅 Toast）
- 不为普通布局用大软阴影；背景分层比阴影强度更重要

## 4. 组件策略

- 组件体系：shadcn 基础组件 + Radix 无头原语 + cva 变体；业务组件只拼装，不手写样式
- 按钮：Primary bg-primary text-primary-foreground / Outline 边框型 / Secondary bg-secondary / Ghost 透明 / Destructive 语义红 / Link 文字型
- 输入框：bg-input border-input-border text-foreground；hover/focus 走对应边框 token；普通表单默认 rounded-lg
- 卡片：bg-card border-card-border；选中卡 bg-card-selected；菜单：紧凑行、rounded-lg、shadow-md、bg-menu
- 命令/路径/代码/哈希用 font-mono
- 键盘导航是头等交互；语义状态色必须配可读文本，绝不只靠颜色

## 5. Do / Don't

- Do：一致使用语义色 token / 保持背景-卡片-浮层层级 / 控件紧凑 / 用文本层级表达密度 / 技术值用等宽字体 / 支持明暗双主题
- Don't：普通 UI 用 raw 颜色 / 大面积品牌色填充 / 任意圆角阴影宽高 / 菜单对话框松垮 / 语义色装饰性借用 / 只为单一主题好看
