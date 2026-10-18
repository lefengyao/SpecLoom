# SpecLoom 品牌规范

日期：2026-10-18  
适用于桌面应用、官网、文档与后续发行物。

## 官方配色：纸墨

官网 `website/` 的纸墨配色为官方配色。应用默认外观为「纸墨」主题 + 「织绿」主题色；已有本地偏好不会被覆盖，需要在“设置 → 外观”手动切换。

| 用途 | 名称 | 色值 |
| --- | --- | --- |
| 纸面底色 | 纸白 | `#edf1e8` |
| 纸面表层 | 纸面 | `#f7f9f3` |
| 正文 / 页眉 | 墨绿 | `#14352a` |
| 主色 / CTA | 织绿 | `#1f6f54` |
| 索引 / 状态 | 赭金 | `#a9762e` |
| 吉祥物本体 | 精灵绿 | `#239d7c` |
| 吉祥物瞳孔 | 深墨 | `#254438` |

应用中的对应实现：

- 主题：`data-theme="paper"`，定义在 `src/renderer/styles.css`。
- 主题色：`accentIds` 中的 `loom`，`#1f6f54`。
- 默认值：`src/shared/preferences.ts` 中 `theme: "paper"`、`accent: "loom"`。
- 官网参考：`website/styles.css` 中的 `--paper`、`--ink`、`--green`、`--gold`。

纸墨是浅色主题；需要深色界面时使用现有「深色」主题，不将纸墨自动反转。

## 吉祥物：络络 / THREAD SPRITE

- 身份：SpecLoom 的绿色独眼精灵，中文名「络络」，英文标识 `THREAD SPRITE`。
- 形态：倒置、无侧边附件；单眼、竖向瞳孔，轮廓为柔软线团。
- 源文件：`src/renderer/public/brand/specloom.svg`。
- React 实现：`src/renderer/Mascot.tsx`，内联 SVG，每个实例使用唯一 mask / clip id。
- 使用位置：
  - 顶部品牌标识（38px，无轨道）。
  - 欢迎页主视觉（200px，含 3D 椭圆轨道；视觉精灵约 145px），下方显示“络络 / THREAD SPRITE”文字。
- 动画：
  - 眨眼：5.4s 循环；眼白与瞳孔从上下向中间合拢，完全闭合后迅速睁开。
  - 呼吸：4.8s 循环，上下 2.5px、轻微旋转 1.2°。
  - 张望：6.4s 循环，瞳孔左右上下小幅移动。
  - 视线：欢迎页 `trackPointer` 让瞳孔跟随鼠标；顶部标识保持自己的张望。
  - 环绕：欢迎页 `orbit` 画一条倾斜的虚线椭圆轨道；哑光实心织绿球 `#1f6f54`（无渐变、无高光）沿轨道做 10s 三维环绕，后半段在精灵身后、前半段在身前，前后通过缩放表现远近，并带四段实心渐隐尾迹。内置三条预设：线团（72×44，-12°）、宽摆（84×52，-22°）、高抛（54×66，-8°）；欢迎页每 20s 轮换，`orbit` 也可传 preset 名固定一条。
  - 嘴巴：只使用原有的白色笑弧，不新增第二张嘴；4.6s 循环，通过少量位移与 stroke-width 变化做开合。
  - 动画只改变 SVG 内部，不影响布局；`prefers-reduced-motion: reduce` 时全部停止，瞳孔回正。
- 欢迎页气泡：`MascotSpeech.tsx`。按时段问候（早上好 / 中午好 / 下午好 / 晚上好 / 夜深了），后接四句项目问候；点击气泡或键盘激活轮换，不自动轮播。气泡文本使用 `aria-live="polite"`，提示“点一下，换一句”。
- 文字：名字必须作为可读文本出现，不能只存在于动画或图形里。装饰性 SVG 使用 `aria-hidden="true"`。
- 禁止：拉伸变形、改色、给眼睛加高光、添加侧边附件或把瞳孔改成圆形。

## 官网

官网 `website/` 是纸墨配色的参考实现：品牌标记、FIG. 01 图纸、FIG. 02 工作区图版与络络动画共用同一套色值和名字。修改官方配色或吉祥物时，同步更新：

1. `src/renderer/styles.css` 的纸墨主题变量。
2. `src/renderer/Mascot.tsx` 与 `src/renderer/public/brand/specloom.svg`。
3. `website/styles.css`、`website/index.html` 的对应颜色和名字。
4. 本文档。
