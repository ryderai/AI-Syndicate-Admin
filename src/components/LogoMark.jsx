export default function LogoMark({ size = 32, animate = true, speedMs }) {
  const spinStyle = speedMs ? { transformOrigin: "50px 50px", animationDuration: `${speedMs}ms` } : { transformOrigin: "50px 50px" };
  return (
    <span
      className="logo-mark"
      style={{ width: size, height: size, display: "inline-flex", alignItems: "center", justifyContent: "center" }}
    >
      <svg viewBox="0 0 100 100" width={size} height={size} xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <defs>
          <linearGradient id="lm-spoke" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#a78bfa" />
            <stop offset="1" stopColor="#3b82f6" />
          </linearGradient>
          <radialGradient id="lm-hub" cx="0.5" cy="0.5" r="0.5">
            <stop offset="0" stopColor="#c4b5fd" />
            <stop offset="0.5" stopColor="#8b5cf6" />
            <stop offset="1" stopColor="#4338ca" />
          </radialGradient>
          <linearGradient id="lm-node" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#a78bfa" />
            <stop offset="1" stopColor="#3b82f6" />
          </linearGradient>
        </defs>
        <g className={animate ? "lm-rotate" : ""} style={spinStyle}>
          {[0, 45, 90, 135, 180, 225, 270, 315].map((deg, i) => {
            const r = 32;
            const x = 50 + Math.cos(((deg - 90) * Math.PI) / 180) * r;
            const y = 50 + Math.sin(((deg - 90) * Math.PI) / 180) * r;
            return <line key={i} x1="50" y1="50" x2={x} y2={y} stroke="url(#lm-spoke)" strokeWidth="3" strokeLinecap="round" />;
          })}
          {[0, 45, 90, 135, 180, 225, 270, 315].map((deg, i) => {
            const r = 38;
            const x = 50 + Math.cos(((deg - 90) * Math.PI) / 180) * r;
            const y = 50 + Math.sin(((deg - 90) * Math.PI) / 180) * r;
            return (
              <circle
                key={i}
                cx={x}
                cy={y}
                r="6.5"
                fill="white"
                stroke="url(#lm-node)"
                strokeWidth="3"
                className={animate ? `lm-node lm-node-${i}` : ""}
                style={{ transformOrigin: `${x}px ${y}px` }}
              />
            );
          })}
        </g>
        <circle cx="50" cy="50" r="11" fill="url(#lm-hub)" className={animate ? "lm-hub-pulse" : ""} style={{ transformOrigin: "50px 50px" }} />
        <circle cx="50" cy="50" r="4" fill="white" opacity="0.85" />
      </svg>
    </span>
  );
}
