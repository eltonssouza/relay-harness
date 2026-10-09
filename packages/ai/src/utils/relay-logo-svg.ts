// Inline assets/relay-model.svg so OAuth pages also work in npm packages and standalone binaries.
export const RELAY_LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 240" width="960" height="240">
  <defs>
    <!-- Background Card Gradient -->
    <linearGradient id="m2-cardBg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#0c232e"/>
      <stop offset="45%" stop-color="#071720"/>
      <stop offset="100%" stop-color="#03080b"/>
    </linearGradient>

    <!-- Border Gradient -->
    <linearGradient id="m2-borderGrad" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#1b5a68" stop-opacity="0.9"/>
      <stop offset="35%" stop-color="#3ce6dc" stop-opacity="0.7"/>
      <stop offset="70%" stop-color="#164d57" stop-opacity="0.4"/>
      <stop offset="100%" stop-color="#0a2830" stop-opacity="0.3"/>
    </linearGradient>

    <!-- Divider Line Gradient -->
    <linearGradient id="m2-dividerGrad" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#144d57" stop-opacity="0"/>
      <stop offset="30%" stop-color="#3ee4da" stop-opacity="0.9"/>
      <stop offset="70%" stop-color="#179ea8" stop-opacity="0.9"/>
      <stop offset="100%" stop-color="#0a323a" stop-opacity="0"/>
    </linearGradient>

    <!-- Scanline Pattern -->
    <pattern id="m2-scanlines" width="100" height="4" patternUnits="userSpaceOnUse">
      <line x1="0" y1="0" x2="100" y2="0" stroke="#000000" stroke-opacity="0.25" stroke-width="1.2"/>
    </pattern>

    <!-- Seamless Aura Gradient -->
    <radialGradient id="m2-aura" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#00f7ff" stop-opacity="0.32"/>
      <stop offset="45%" stop-color="#00d2df" stop-opacity="0.14"/>
      <stop offset="80%" stop-color="#00838f" stop-opacity="0.03"/>
      <stop offset="100%" stop-color="#00838f" stop-opacity="0"/>
    </radialGradient>

    <!-- Neon Glow Filter -->
    <filter id="m2-neonGlow" x="-60%" y="-60%" width="220%" height="220%">
      <feGaussianBlur in="SourceGraphic" stdDeviation="16" result="blur2"/>
      <feGaussianBlur in="SourceGraphic" stdDeviation="6" result="blur1"/>
      <feGaussianBlur in="SourceGraphic" stdDeviation="2" result="sharp"/>
      <feMerge>
        <feMergeNode in="blur2"/>
        <feMergeNode in="blur1"/>
        <feMergeNode in="sharp"/>
        <feMergeNode in="SourceGraphic"/>
      </feMerge>
    </filter>

    <linearGradient id="m2-topArmGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#7bf5ea"/>
      <stop offset="50%" stop-color="#41e5da"/>
      <stop offset="100%" stop-color="#20c2bd"/>
    </linearGradient>

    <linearGradient id="m2-lowArmGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#2bd8cf"/>
      <stop offset="60%" stop-color="#19adb1"/>
      <stop offset="100%" stop-color="#0f7a84"/>
    </linearGradient>

    <linearGradient id="m2-armInnerShadow" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#127883"/>
      <stop offset="100%" stop-color="#094c54"/>
    </linearGradient>

    <linearGradient id="m2-bottomBevelGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#106b77"/>
      <stop offset="100%" stop-color="#052f36"/>
    </linearGradient>

    <linearGradient id="m2-slashFrontGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#7df9ef"/>
      <stop offset="45%" stop-color="#3de2d7"/>
      <stop offset="100%" stop-color="#1bbbbd"/>
    </linearGradient>

    <linearGradient id="m2-slashBevelGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#137480"/>
      <stop offset="100%" stop-color="#073a42"/>
    </linearGradient>
  </defs>

  <!-- Card Background with Neon Border -->
  <rect x="2" y="2" width="956" height="236" rx="20" fill="url(#m2-cardBg)" stroke="url(#m2-borderGrad)" stroke-width="1.8"/>
  <rect x="2" y="2" width="956" height="236" rx="20" fill="url(#m2-scanlines)"/>

  <!-- Left Side: Symbol Group -->
  <g transform="translate(180, 120)">
    <!-- Seamless Aura behind symbol -->
    <ellipse cx="0" cy="0" rx="220" ry="140" fill="url(#m2-aura)"/>

    <!-- Scaled 3D Mark -->
    <g transform="scale(0.64)" filter="url(#m2-neonGlow)">
      <!-- Left Chevron -->
      <g transform="translate(-145, 0)">
        <path d="M -75,2 L 22,72 L 22,85 L -72,15 Z" fill="url(#m2-bottomBevelGrad)"/>
        <polygon points="22,72 22,85 25,83 25,72" fill="#04262c"/>
        <polygon points="22,-51 22,-40 -40,3 -48,0" fill="url(#m2-armInnerShadow)"/>
        <polygon points="22,-77 22,-51 -48,0 -75,-2" fill="url(#m2-topArmGrad)"/>
        <polygon points="-75,-2 -48,0 22,51 22,72 -75,2" fill="url(#m2-lowArmGrad)"/>
        <path d="M 22,-77 L -75,-2 L 22,72" fill="none" stroke="#9cfef7" stroke-width="2.8" stroke-linejoin="round" opacity="0.95"/>
        <path d="M 22,-51 L -48,0 L 22,51" fill="none" stroke="#42e6dc" stroke-width="2.1" stroke-linejoin="round" opacity="0.8"/>
        <line x1="-75" y1="-2" x2="-48" y2="0" stroke="#b0fffa" stroke-width="2" opacity="0.95"/>
      </g>

      <!-- Slash -->
      <g transform="translate(0, 0)">
        <polygon points="21,-77 29,-71 4,81 -4,77" fill="url(#m2-slashBevelGrad)"/>
        <polygon points="-4,77 4,81 4,84 -4,80" fill="#052b31"/>
        <polygon points="4,-77 21,-77 -4,77 -21,77" fill="url(#m2-slashFrontGrad)"/>
        <line x1="4" y1="-77" x2="-21" y2="77" stroke="#b8fffa" stroke-width="2.6" opacity="0.95"/>
        <line x1="21" y1="-77" x2="-4" y2="77" stroke="#26d1c9" stroke-width="2.1" opacity="0.85"/>
        <line x1="4" y1="-77" x2="21" y2="-77" stroke="#cffffb" stroke-width="1.6" opacity="0.8"/>
        <line x1="-21" y1="77" x2="-4" y2="77" stroke="#1da8af" stroke-width="1.6" opacity="0.8"/>
      </g>

      <!-- Right Chevron -->
      <g transform="translate(145, 0)">
        <path d="M 75,2 L -22,72 L -22,85 L 72,15 Z" fill="url(#m2-bottomBevelGrad)"/>
        <polygon points="-22,72 -22,85 -25,83 -25,72" fill="#04262c"/>
        <polygon points="-22,-51 -22,-40 40,3 48,0" fill="url(#m2-armInnerShadow)"/>
        <polygon points="-22,-77 -22,-51 48,0 75,-2" fill="url(#m2-topArmGrad)"/>
        <polygon points="75,-2 48,0 -22,51 -22,72 75,2" fill="url(#m2-lowArmGrad)"/>
        <path d="M -22,-77 L 75,-2 L -22,72" fill="none" stroke="#9cfef7" stroke-width="2.8" stroke-linejoin="round" opacity="0.95"/>
        <path d="M -22,-51 L 48,0 L -22,51" fill="none" stroke="#42e6dc" stroke-width="2.1" stroke-linejoin="round" opacity="0.8"/>
        <line x1="75" y1="-2" x2="48" y2="0" stroke="#b0fffa" stroke-width="2" opacity="0.95"/>
      </g>
    </g>
  </g>

  <!-- Glowing Vertical Divider Line -->
  <line x1="330" y1="36" x2="330" y2="204" stroke="url(#m2-dividerGrad)" stroke-width="2.2"/>

  <!-- Right Side: Brand Wordmark -->
  <g transform="translate(370, 130)">
    <!-- Main Logotype: 're' in pure crisp white, 'lay' in vibrant glowing cyan -->
    <text font-family="system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif" font-size="82" font-weight="900" letter-spacing="1">
      <tspan fill="#ffffff">re</tspan><tspan fill="#3cf1e6">lay</tspan>
    </text>

    <!-- Subtitle: HARNESS -->
    <text x="4" y="38"
          font-family="system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
          font-size="16"
          font-weight="600"
          letter-spacing="10"
          fill="#8eb6c0"
          opacity="0.95">HARNESS</text>
  </g>

  <!-- Right End Badge / Terminal Tag -->
  <g transform="translate(875, 45)">
    <rect x="-42" y="-12" width="84" height="24" rx="12" fill="#061c24" stroke="#165b67" stroke-width="1.2"/>
    <text x="0" y="4"
          text-anchor="middle"
          font-family="Consolas, monospace"
          font-size="11"
          font-weight="700"
          letter-spacing="1.5"
          fill="#3de2d7">v0.1.0</text>
  </g>
</svg>`;
