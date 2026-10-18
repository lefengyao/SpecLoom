import { useCallback, useState } from "react";

export const mascotGreetings = [
  "世界观、角色、关卡，慢慢来。",
  "设定理清楚了，代码就顺了。",
  "要开 Godot 吗？我在这儿。",
  "今天想先动哪一块？",
] as const;

export function greetingForHour(hour: number): string {
  if (hour >= 5 && hour < 11) return "早上好";
  if (hour >= 11 && hour < 14) return "中午好";
  if (hour >= 14 && hour < 18) return "下午好";
  if (hour >= 18 && hour < 23) return "晚上好";
  return "夜深了";
}

/**
 * 欢迎页的络络气泡。点击或键盘激活会换一句；不自动轮播，避免打断阅读。
 * 问候语按本地时段变化，其余四句围绕项目与 Godot。
 */
export function MascotSpeech() {
  const [index, setIndex] = useState(0);
  const next = useCallback(() => {
    setIndex((value) => (value + 1) % (mascotGreetings.length + 1));
  }, []);
  const words = [`${greetingForHour(new Date().getHours())}，我是络络。先给我看一眼项目？`, ...mascotGreetings];

  return (
    <button
      type="button"
      className="mascot-speech"
      onClick={next}
      title="让络络换一句问候"
    >
      <span className="mascot-speech-text" aria-live="polite">{words[index]}</span>
      <span className="mascot-speech-hint">点一下，换一句</span>
    </button>
  );
}
