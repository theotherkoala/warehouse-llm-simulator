const icons = {
  bot: <><rect x="4" y="7" width="16" height="13" rx="3" /><path d="M12 3v4M1 12v3m22-3v3M8 13h.01M16 13h.01m-7 3h6" /></>,
  grid: <><rect x="3" y="3" width="18" height="18" rx="3" /><path d="M3 9h18M3 15h18M9 3v18m6-18v18" /></>,
  box: <><path d="m3 7 9-4 9 4v10l-9 4-9-4zM3 7l9 4 9-4m-9 4v10M7.5 5l9 4" /></>,
  send: <><path d="m3 4 18 8-18 8 4-8zM7 12h14" /></>,
  arrow: <><path d="M5 12h14m-6-6 6 6-6 6" /></>,
  play: <path d="m8 4 12 8-12 8z" />,
  pause: <><path d="M9 5v14m6-14v14" /></>,
  reset: <><path d="M3 12a9 9 0 1 1 2.6 6.4M3 12V6m0 6h6" /></>,
  camera: <><rect x="3" y="6" width="18" height="14" rx="2" /><circle cx="12" cy="13" r="3" /><path d="m8 6 2-3h4l2 3" /></>,
  flask: <><path d="M9 3h6m-5 0v7l-5 8a2 2 0 0 0 2 3h10a2 2 0 0 0 2-3l-5-8V3m-6 12h8" /></>,
  log: <><path d="M7 3h7l4 4v14H6V3zM9 11h6m-6 4h6" /></>,
  chevron: <path d="m6 9 6 6 6-6" />,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v5m0-8h.01" /></>,
  sparkle: <><path d="M12 2c0 6 4 10 10 10-6 0-10 4-10 10 0-6-4-10-10-10 6 0 10-4 10-10z" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
}

export function Icon({ name, size = 18 }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{icons[name]}</svg>
}
