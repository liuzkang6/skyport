# DESIGN.md — skyport 设计规范

本文件供 AI 遵守。生成或修改 UI 前必须阅读；新增/变更视觉规则时，先更新本文件，再改组件。
违反本文件 = 设计系统缺陷，不是风格偏好。
视觉 Token 数值来源：ZCode packages/ui/src/styles.css（Apache-2.0，https://github.com/zai-org/ZCode）；
体系结构（角色映射/例外白名单/尺寸基线/动效/响应式/无障碍）借鉴其 DESIGN.md，按 skyport 治理场景改写。

## 0. 最高优先级约束

界面排版**必须**使用 `text-ui-*` 刻度：`text-ui-xl / lg / base / caption / sm / xs / 2xs`。

- 禁止 Tailwind 内置 `text-base/sm/xs`；禁止 `text-[13px]`；禁止内联 font-size
- 唯一的内容级例外：代码 / Diff / 终端渲染走各自的独立字号设置（其周边控件仍用 text-ui-*）
- 改界面字号只改 `--ui-font-size`，禁止改根 html 字号；图标/间距/圆角等几何不随字号缩放

## 1. 产品气质

skyport 是 管理型（AI 运维行动与治理工作台） 界面。设计基调：冷静、紧凑、可读，而非装饰性。

- Design for：长会话值守 / 高信息密度 / 键盘驱动 / 明暗双主题 / 中文与长文本 / 技术类内容（命令/路径/哈希）突出 / 审批决策要素一眼可读
- Avoid：营销式大留白 / 默认渐变 / 大面积品牌填充 / 背景-卡片-浮层层级含糊

## 2. 字体系统

### 2.1 字号 token（数值为设计系统定义）

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

### 2.2 角色映射（选 token 先问内容角色，不问视觉偏好）

| Token | 适用角色 |
| --- | --- |
| text-ui-xl | 一级标题（页面唯一主标题） |
| text-ui-lg | 二级标题（区块/面板标题） |
| text-ui-base | 正文、按钮、表单、行动命令展示、审计时间戳的默认档 |
| text-ui-caption | 需稳定比正文小一档的紧凑说明（新功能公告类） |
| text-ui-sm | 次要信息、辅助说明、tooltip 正文、内联代码 |
| text-ui-xs | 徽章、快捷键提示、计数器、极弱元数据 |
| text-ui-2xs | 仅图表轴线刻度/单位，任何内容性文字禁用 |

- h3-h6 共用 text-ui-base，靠字重分层（h3-h4 semibold / h5 medium / h6 normal）
- 字号层级与颜色层级是**独立决策**：次要文案配 foreground-subtle，弱元数据配 foreground-subtlest
- **命令 / 路径 / 代码 / 哈希 / 资产地址 / 行动 ID 一律 font-mono**（通常配 text-ui-base，内联代码用 text-ui-sm）
- i18n 余量：不硬编码只适配短英文标签的布局；不以极端截断作为组件存活的唯一手段

## 3. 颜色系统

### 3.1 亮色主题（默认）

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

### 3.2 暗色主题

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

### 3.3 角色→token 用法索引

- 页面根 `bg-background + text-foreground`；软分区 `bg-background-alt`；结构面（header/panel/sidebar）只作布局，**不复用为卡片色**
- 内容容器 `bg-card`（或低强调 `bg-surface`）；选中卡 `bg-card-selected`；浮层 `bg-popover` / 菜单 `bg-menu`
- hover 用 `bg-hover`，选中用 `bg-selected`；主按钮 `bg-primary text-primary-foreground`
- 文本三级：正文 foreground / 次要 subtle / 弱提示 subtlest；反色文本 foreground-inverse
- 语义色（success/warning/destructive）只在真实语义状态使用，禁止借用制造视觉强度；Diff 必须用 diff-added/removed，不与 success/destructive 混用
- **治理状态色域（feature-scoped，功能落地时启用）**：行动状态（pending/approved/executing/success/failed/rejected/cancelled）与风险等级（low/medium/high）建立独立色族 `--color-gov-*`，从语义色派生但独立命名——避免"待审批借用 warning 色"这类语义漂移；与 CLI 现行符号（○ ● ✕ ⟳ ⊘ –）一一对应
- 禁止 raw 一次性色值；禁止 `text-white/60`、`border-white/10` 类临时透明度拼凑

## 4. 间距 / 圆角 / 阴影 / 尺寸

### 4.1 间距（基准 4px）

- 4px 图标/文本紧间距 · 8px 控件内边距 · 12px 密集列表行 · 16px 标准卡片 · 20-24px 大区块
- 偏好小集合的重复间距，禁止任意值；flex 带文本加 `min-w-0`；嵌套滚动加 `min-h-0`；优先 `w-full + max-w-*`

### 4.2 圆角（跟随可见容器嵌套层级，白名单例外制）

- 布局区域与普通包裹层不计入圆角层级；第一个可见圆角容器从 `rounded-xl` 起，嵌套递减 xl → lg → md → sm（sm 为最小）；数最近的**实际圆角容器**而非 DOM 包裹层；同级同级同值
- **2xl 例外白名单**（仅下列可用，禁止以"大/重要"类推）：Dialog 壳 `rounded-2xl`（对话框壳不计入其内容的层级计数，内容从 xl 重新起算）；Toast 壳。目前清单仅此两项，新增例外必须先改本节
- 基础控件默认 `rounded-lg`：父级 xl+ → lg；父级 lg → md；父级 md/sm → sm。控件尺寸与主次不单独改变圆角
- 菜单/下拉/选择面板壳 `rounded-lg`；选项行 hover `rounded-md`；**浮层圆角不继承触发器的父级层级**；子菜单独立从 lg 重起
- `rounded-full` 仅限刻意药丸/圆形；禁止任意圆角值和裸 `rounded`

### 4.3 阴影（克制）

- Base 无阴影（靠背景对比）· Surface 靠边框 · Overlay `shadow-md`（菜单/弹层/对话框）· Attention `shadow-lg`（仅 Toast）
- 层级主要靠背景对比 + 边框 + 圆角表达，不依赖大软阴影

### 4.4 尺寸基线

- 图标：`size-3 / 3.5 / 4 / 5 / 6`，默认 `size-4`
- 控件高度：`h-6 / h-7 / h-8 / h-9`；方形图标按钮 `size-6~9` 保持正方形
- 复用既有按钮尺寸体系，不新建高度系统；固定宽度仅用于菜单/浮层/对话框/稳定侧栏，业务 UI 禁止任意 `w-[...] h-[...]`

## 5. 组件策略

- 体系：shadcn 基础组件 + Radix 无头原语 + cva 变体；业务组件只拼装，不手写样式
- 按钮：Primary `bg-primary text-primary-foreground` / Outline / Secondary / Ghost / Destructive / Link；尺寸 xs / sm / default / lg / icon；不把所有动作升为 Primary，面板内保持动作层级；图标按钮保持正方形
- 输入框：`bg-input border-input-border text-foreground`；hover/focus 走对应边框 token；默认 `rounded-lg` 按父级递减；输入默认安静不发光，错误态仅用于真实校验问题
- 卡片：`bg-card border-card-border`，圆角随容器层级从 xl 起；16px 横向内边距；卡片明确低于浮层、高于页面背景；同视图不混用多种卡片底色除非编码真实层级
- 菜单/浮层操作规则（实战守则）：紧凑行（固定 2px 行距）、`rounded-lg` 壳 + `shadow-md` + `border-popover-border`；**tooltip 永不遮盖活动中的交互浮层**；菜单阴影从首帧保持到失焦；选中态优先勾选/单选指示而非整行强填充；禁用项保留布局仅降文本色；主操作+下拉用分段触发器（左主右箭头）；菜单对齐触发器前缘、偏移小而一致；下拉/右键/选择面板共享同一菜单语言
- Tabs：非活动态中性；活动态靠表面对比而非品牌填充块

## 6. 动效

- 快速、低戏剧性：浮层用轻微 fade / zoom / 方向性 slide
- 动效只澄清状态变化，不做装饰；主工作区禁长弹簧/俏皮动画
- 行动状态迁移可用极短过渡（pending→executing），但**不得用动画替代状态标识**

## 7. 响应式

- 桌面优先，小屏必须可用：从稳定基础布局起步，断点只做布局/宽度/可见性/密度调整
- 断点不改变组件语义；优先改 max-width/grid/flex/visibility 而非更换组件
- 所有断点保留主操作；核心审批流不得只存在于桌面交互

## 8. 无障碍与国际化

- 键盘导航一等公民（对齐 CLI 的方向键值守交互）；保留可见焦点样式
- **状态永不只靠颜色表达**：风险等级 low/medium/high、行动状态、资产 up/down 必须颜色+文字/符号双编码（CLI 已用 ● ○ ✕ 符号体系，UI 保持一致）
- 明暗双主题下对比度均需安全；布局容忍更长翻译；图标不是唯一含义载体；语义色配可读文本

## 9. 实施指引

- 先复用语义 token 与 `src/components/ui/` 原语，再造新 token/组件
- 新 UI 需求先判断属于 **structure（结构）/ surface（表面）/ interaction（交互）/ state（状态）** 哪一类，再按类选 token：结构 → 布局面色与边框；表面 → card/surface/popover；交互 → hover/selected/primary；状态 → 语义色与治理色域
- 拿不准时：更安静的 UI + 更强的信息层级

## 10. Do / Don't

- Do：一致使用语义色 token / 保持背景-卡片-浮层层级 / 控件紧凑 / 用文本层级表达密度 / 技术值用等宽字体 / 明暗双主题皆验证 / 状态颜色+文字双编码 / 为长翻译留余量
- Don't：普通 UI 用 raw 颜色 / 大面积品牌色填充 / 任意圆角阴影宽高（无系统理由）/ 菜单对话框松垮 / 语义色装饰性借用 / 只为单一主题好看 / 用动画替代状态标识 / 只靠颜色区分风险与状态
