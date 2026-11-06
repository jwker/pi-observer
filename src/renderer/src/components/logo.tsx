/**
 * 界面里的品牌标记：应用图标的符号版。
 *
 * 与 `build/icon.svg` 同一套形状——两条对话气泡（蓝=你、灰=agent）加一颗星，
 * 只是去掉了底板和第三条气泡，因为顶栏只有 18px，细节多了会糊。
 *
 * 灰气泡用 `currentColor`，亮色 / 暗色主题下自动跟着文字色走；
 * 蓝气泡与星用固定色，和图标一致。
 */
export function Logo(): React.JSX.Element {
  return (
    <svg className="brand-mark" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {/* 第一条：用户提问（带尾巴） */}
      <rect x="1.5" y="3.5" width="12.5" height="6.5" rx="3.25" fill="#5aa9ff" />
      <path d="M4 10 L4 12.4 L6.6 10 Z" fill="#5aa9ff" />

      {/* 第二条：agent 的回答（带尾巴） */}
      <rect x="1.5" y="12.6" width="10" height="6.5" rx="3.25" fill="currentColor" fillOpacity="0.45" />
      <path d="M4 19.1 L4 21.5 L6.6 19.1 Z" fill="currentColor" fillOpacity="0.45" />

      {/* AI 标记：紧贴第一条气泡的右上角 */}
      <path
        d="M17.6 3.4 C18 5.3 18.4 5.7 20.3 6.1 C18.4 6.5 18 6.9 17.6 8.8 C17.2 6.9 16.8 6.5 14.9 6.1 C16.8 5.7 17.2 5.3 17.6 3.4 Z"
        fill="#5aa9ff"
      />
    </svg>
  );
}
